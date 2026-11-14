import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { token } from './ids.js';
import { classifyEmail, type Audience, type StaffRole } from './email-allowlist.js';
import type { User } from '../types.js';

const COOKIE = 'grokbot_session';
const TTL_MS = 30 * 24 * 3600 * 1000;

export type AuthVars = { Variables: { user: User } };

export function createSession(c: Context, userId: string) {
  const t = token();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(t, userId, now(), now() + TTL_MS);
  setCookie(c, COOKIE, t, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: TTL_MS / 1000 });
}

export function destroySession(c: Context) {
  const t = getCookie(c, COOKIE);
  if (t) db.prepare('DELETE FROM auth_sessions WHERE token=?').run(t);
  deleteCookie(c, COOKIE, { path: '/' });
}

export function userFromToken(t: string | undefined): User | null {
  if (!t) return null;
  const r = db
    .prepare('SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?')
    .get(t, now()) as any;
  if (!r) return null;
  // Rows that predate the classifier have no audience. Classify them on first sight
  // rather than defaulting to the least-privileged one, so a deploy does not silently
  // downgrade staff who are already signed in. Sign-in re-classifies anyway.
  let audience: Audience = r.audience === 'staff' ? 'staff' : r.audience === 'fan' ? 'fan' : 'fan';
  let role: StaffRole | null = r.role === 'artist' || r.role === 'management' ? r.role : null;
  if (r.audience !== 'staff' && r.audience !== 'fan') {
    const c = classifyEmail(r.email, {
      allowedEmails: env.allowedEmails,
      allowedEmailDomains: env.allowedEmailDomains,
      staffEmailDomains: env.staffEmailDomains,
    });
    audience = c.audience;
    role = c.role;
    db.prepare('UPDATE users SET audience=?, role=? WHERE id=?').run(audience, role, r.id);
  }
  return { id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url, audience, role };
}

export function userFromCookieHeader(cookieHeader: string | undefined): User | null {
  const m = cookieHeader?.split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`));
  return userFromToken(m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : undefined);
}

export const requireUser: MiddlewareHandler<AuthVars> = async (c, next) => {
  const u = userFromToken(getCookie(c, COOKIE));
  if (!u) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', u);
  await next();
};
