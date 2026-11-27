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
 */
import crypto from 'node:crypto';

const spec = JSON.parse(process.argv[2] ?? '{}');

const { api } = await import('../src/routes.ts');
const { db } = await import('../src/db.ts');

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
  const headers = { 'content-type': 'application/json', ...(action.headers ?? {}) };
  if (action.ownerKey) headers.authorization = `Bearer ${ownerKey()}`;
  const init = { method: action.method ?? 'GET', headers };
  if (action.body !== undefined) init.body = JSON.stringify(action.body);
  const res = await api.request(action.path, init);
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
