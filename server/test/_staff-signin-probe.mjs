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
 * `path` is written as the route sees it (no `/api` prefix); the probe mounts it the
 * way the app does.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spec = JSON.parse(process.argv[2] ?? '{}');

const { buildApp } = await import('../src/app.ts');
const { db } = await import('../src/db.ts');

/**
 * The composed app, not the `api` sub-app.
 *
 * Mounting `api` bare was a false green: `/auth/google/callback` was deleted from
 * routes.ts, and the probe still answered `401` for it because it called the sub-app
 * directly, while the served build answered `200 text/html` from the SPA fallback.
 * Driving the real composition is the point of this probe.
 *
 * The static root is a temp dir with a fake `index.html` rather than `web/dist`,
 * because CI runs `npm test` before `npm run build` and would otherwise test a
 * server with no fallback at all — the shape that hid this defect.
 */
const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-static-'));
fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>spa</title>');
const app = buildApp({ staticRoot });

const counts = () => ({
  users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
  bots: db.prepare('SELECT COUNT(*) n FROM bots').get().n,
  sessions: db.prepare('SELECT COUNT(*) n FROM auth_sessions').get().n,
  attempts: db.prepare('SELECT COUNT(*) n FROM login_attempts').get().n,
});

const ownerKey = () =>
  crypto.createHmac('sha256', process.env.SESSION_SECRET ?? '').update('owner-login').digest('hex');

const results = [];
// A browser sends `Origin` on every non-GET request, and the composed app has the CSRF
// gate in front of `/api/*`. Driving the app like the browser does is the whole point
// of this probe; the gate has its own file (`origin-check.test.mjs`).
const ownOrigin = new URL(process.env.APP_URL).origin;
for (const action of spec.actions ?? []) {
  const method = action.method ?? 'GET';
  const headers = { 'content-type': 'application/json', ...(method === 'GET' ? {} : { origin: ownOrigin }), ...(action.headers ?? {}) };
  if (action.ownerKey) headers.authorization = `Bearer ${ownerKey()}`;
  const init = { method, headers };
  if (action.body !== undefined) init.body = JSON.stringify(action.body);
  const mounted = action.path.startsWith('/api/') ? action.path : '/api' + action.path;
  const res = await app.request('http://localhost' + mounted, init);
  let body = null;
  try { body = await res.clone().json(); } catch { /* not JSON */ }
  results.push({
    status: res.status,
    body,
    contentType: res.headers.get('content-type') ?? '',
    location: res.headers.get('location') ?? '',
    setCookie: (res.headers.get('set-cookie') ?? '').includes('grokbot_session='),
    counts: counts(),
  });
}

process.stdout.write('@@PROBE@@' + JSON.stringify({ results }) + '\n');
db.close();
