/**
 * The SPA fallback must not answer for the API.
 *
 * Measured on a real build before this test existed, with `web/dist` present:
 *
 *   /api/auth/google/callback   200  text/html   <- a deleted route, still "found"
 *   /api/definitely-not-a-route 401  application/json  (only because the auth wall ran)
 *
 * Hono carries on past a sub-app that matched nothing, so an unmatched `/api/*` path
 * reached `app.get('*')` and received `index.html`. A client calling `req()` then
 * tries `res.json()` on a page and throws a parse error where a 404 belongs, and
 * "does this route exist?" cannot be answered from outside at all.
 *
 * The fallback is exercised through `buildApp({ staticRoot })` with a temp directory:
 * CI runs `npm test` before `npm run build`, so a test that needed `web/dist` would
 * skip in the one run that matters.
 *
 *   node --test server/test/api-404.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SESSION_SECRET ??= 'test-secret';
process.env.XAI_API_KEY ??= 'test-key';
process.env.COMPOSIO_API_KEY ??= '';
process.env.WORKOS_API_KEY ??= '';
process.env.WORKOS_CLIENT_ID ??= '';
process.env.AUTH_PROVIDER ??= '';
process.env.DEV_LOGIN ??= '';
process.env.DESKTOP_MODE ??= 'disabled';
process.env.HERMES_BIN ??= '/bin/false';
process.env.APP_URL ??= 'http://localhost:5173';
process.env.SERVER_URL ??= 'http://localhost:8787';
process.env.NODE_ENV ??= '';
process.env.ALLOWED_EMAILS ??= '';
process.env.ALLOWED_EMAIL_DOMAINS ??= '';
process.env.AUTH_PASSWORD ??= '';
process.env.AUTH_PASSWORD_HASH ??= '';
process.env.DB_PATH ??= path.join(os.tmpdir(), `grokbot-api404-${process.pid}.db`);

const { buildApp } = await import('../src/app.ts');
const { db } = await import('../src/db.ts');

const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-dist-'));
fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>the app</title>');

const app = buildApp({ staticRoot });
const get = (p) => app.request('http://localhost' + p);

test('an unknown /api path is never the app page', async () => {
  // 401 from the auth wall and 404 from the catch-all are both correct answers; the
  // defect was the third one, `200 text/html`. Asserted as "JSON, and one of the two",
  // because which of them a caller sees depends on whether its path is wall-exempt.
  const res = await get('/api/definitely-not-a-route');
  assert.ok([401, 404].includes(res.status), `unexpected ${res.status}`);
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
});

test('a route deleted from routes.ts answers 404, not 200', async () => {
  // The real case that was wrong: `/auth/google/callback` reads a caller-supplied
  // account id and mints a session, so its removal had to be observable from outside.
  const res = await get('/api/auth/google/callback?attempt=login_x&connected_account_id=ca_victim');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(res.headers.get('location'), null);
  assert.equal(res.headers.get('set-cookie'), null, 'and no session is minted on the way out');
});

test('the app itself is still served: a non-API path gets the page', async () => {
  // The guard must not turn every path into a 404; that would be the same bug mirrored.
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(await res.text(), /the app/);
});

test('the CSRF gate still runs before the 404, so a cross-site POST is 403', async () => {
  // The catch-all is registered after the middleware; if it were not, this would be a
  // 404 and the gate would have been skipped for unknown paths.
  const res = await app.request('http://localhost/api/definitely-not-a-route', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
});

db.close?.();
