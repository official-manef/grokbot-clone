/**
 * Drives the sign-in routes in a child process (env.ts resolves once per process,
 * so the allowlist cannot be changed mid-run) and prints what happened plus row
 * counts after each action. No network: every route exercised here answers from
 * configuration and SQLite.
 *
 *   node --import tsx server/test/_staff-signin-probe.mjs '<json actions>'
 *
 * Action: { method?, path, body?, headers?, ownerKey? }. `ownerKey: true` adds the
 * Authorization header derived from SESSION_SECRET (same HMAC isOwnerKey checks).
 *
 * Mounts `createApp()` — the app `index.ts` actually serves — rather than `api` on
 * its own. A bare mount answers `404` where production answers `401`, and served the
 * app shell for a removed route where production now answers `404`: both directions
 * of that mismatch once made a test green about a stack nobody runs.
 */
import crypto from 'node:crypto';

const spec = JSON.parse(process.argv[2] ?? '{}');

const { createApp } = await import('../src/app.ts');
const { db } = await import('../src/db.ts');

// No SPA fallback: this probe is about API answers, and a live fallback would only
// hide a path that fell through the router.
const app = createApp({ webDist: '/nonexistent-web-dist' });

const counts = () => ({
  users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
  bots: db.prepare('SELECT COUNT(*) n FROM bots').get().n,
  sessions: db.prepare('SELECT COUNT(*) n FROM auth_sessions').get().n,
  attempts: db.prepare('SELECT COUNT(*) n FROM login_attempts').get().n,
});

const ownerKey = () =>
  crypto.createHmac('sha256', process.env.SESSION_SECRET ?? '').update('owner-login').digest('hex');

const results = [];
for (const action of spec.actions ?? []) {
  // `createApp` mounts every route under `/api` and puts the CSRF gate in front, so the
  // probe supplies both instead of every call site repeating them: the action paths are
  // written relative to that mount, and non-GET actions carry this app's own origin
  // (the gate has its own file, `origin-check.test.mjs`, for the refusal direction).
  const path = action.path.startsWith('/api/') ? action.path : '/api' + action.path;
  const method = action.method ?? 'GET';
  const headers = { 'content-type': 'application/json', ...(action.headers ?? {}) };
  if (method !== 'GET' && !headers.origin) headers.origin = process.env.APP_URL ?? 'http://localhost:5173';
  if (action.ownerKey) headers.authorization = `Bearer ${ownerKey()}`;
  const init = { method, headers };
  if (action.body !== undefined) init.body = JSON.stringify(action.body);
  const res = await app.request('http://localhost' + path, init);
  let body = null;
  try { body = await res.clone().json(); } catch { /* not JSON */ }
  results.push({
    status: res.status,
    body,
    location: res.headers.get('location') ?? '',
    setCookie: (res.headers.get('set-cookie') ?? '').includes('grokbot_session='),
    counts: counts(),
  });
}

process.stdout.write('@@PROBE@@' + JSON.stringify({ results }) + '\n');
db.close();
