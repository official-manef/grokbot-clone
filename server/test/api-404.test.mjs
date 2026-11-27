/**
 * An unmatched `/api/*` path must answer 404 JSON, not the SPA page.
 *
 * This is not cosmetic. Three measured consequences of the old behaviour: `req()` in
 * `web/src/lib/api.ts` calls `res.json()` on whatever comes back, so an unknown API
 * path threw a parse error instead of reporting "not found"; a removed route
 * (`/api/auth/google/callback`) answered `200`, which makes "does this route exist?"
 * unanswerable from outside; and `staff-only.test.mjs` proves that route is gone by
 * asserting a status, which is only meaningful if a fallen-through request cannot be
 * answered by a page.
 *
 * The app under test is `createApp()` — the same function `index.ts` serves. A probe
 * that rebuilt `app.route('/api', api)` by hand would pass whether or not production
 * ever mounted the 404, which is the defect this file exists to catch.
 *
 *   node --test server/test/api-404.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_api-404-probe.mjs');

/** A built-web-app-shaped directory, so the SPA fallback in `createApp` is live. */
function makeWebDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-webdist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>spa</body></html>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("app")');
  return dir;
}

function run(webDist) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, webDist],
      {
        cwd: path.join(here, '..'),
        env: {
          ...process.env,
          SESSION_SECRET: 'test-secret',
          XAI_API_KEY: 'test-key',
          COMPOSIO_API_KEY: '',
          WORKOS_API_KEY: '',
          WORKOS_CLIENT_ID: '',
          AUTH_PROVIDER: '',
          DEV_LOGIN: '',
          DESKTOP_MODE: 'disabled',
          HERMES_BIN: '/bin/false',
          APP_URL: 'http://localhost:5173',
          SERVER_URL: 'http://localhost:8787',
          NODE_ENV: '',
          ALLOWED_EMAILS: '',
          ALLOWED_EMAIL_DOMAINS: '',
          AUTH_PASSWORD: '',
          AUTH_PASSWORD_HASH: '',
          DB_PATH: path.join(os.tmpdir(), `grokbot-api404-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
        },
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stderr}`));
        const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe output\n${stdout}\n${stderr}`));
        const { results } = JSON.parse(line.slice('@@PROBE@@'.length));
        resolve(Object.fromEntries(results.map((r) => [r.path, r])));
      },
    );
  });
}

const webDist = makeWebDist();
const byPath = await run(webDist);

test('the SPA fallback still serves the app shell at / and a missing asset 404s or serves the shell', () => {
  assert.equal(byPath['/'].status, 200);
  assert.match(byPath['/'].body, /spa/, 'the real index.html, not an error body');
});

test('an unmatched /api/* path answers JSON, never the SPA page', () => {
  // Two shapes, because two different things can refuse first:
  //  - `/api/auth/*` is exempt from the session wall, so it reaches the 404;
  //  - `/api/bots/...` is behind the wall and answers 401 (a refusal too).
  // What must never happen is the app shell, which is what the old stack served for
  // every one of these once a caller was signed in.
  for (const p of ['/api/definitely-not-a-route', '/api/auth/google/callback', '/api/bots/not-a-bot/nope']) {
    const r = byPath[p];
    assert.ok(r.status === 404 || r.status === 401, `${p} answered ${r.status}`);
    assert.match(r.contentType, /application\/json/, `${p} answers JSON: a client parsing it must not get HTML`);
    assert.doesNotMatch(r.body, /spa/, `${p} does not serve the app shell`);
  }
  const gone = byPath['/api/auth/google/callback'];
  assert.equal(gone.status, 404, 'the removed route is not found, not "no session" and not a page');
  assert.match(gone.body, /not found/);
});

test('a real route past the same mounting still answers', () => {
  // 503 is readiness (no backend configured in this probe), not a missing route; the
  // point is that the handler ran instead of the catch-all below it.
  const health = byPath['/api/health'];
  assert.notEqual(health.status, 404, 'the 404 does not shadow routes registered before it');
  assert.match(health.contentType, /application\/json/);
});

test.after(() => fs.rmSync(webDist, { recursive: true, force: true }));
