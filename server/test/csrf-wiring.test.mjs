/**
 * The CSRF gate at the seam that was actually broken: `createApp()`, driven by the
 * requests this repo's own tooling sends.
 *
 * `origin-check.test.mjs` drives the pure decision. This file drives the wiring, because
 * the decision was right in the abstract and wrong in the app: for ten days every
 * non-browser client the repo ships answered `403 cross-site request refused`.
 *
 * Measured before the fix, on a real build:
 *
 *   curl -X POST localhost:PORT/api/auth/dev -H 'content-type: application/json' -d ...
 *   {"error":"cross-site request refused"}   status=403
 *   $ node tests/e2e.mjs http://localhost:8895
 *   Error: dev login failed: 403
 *
 * Neither `bin/gb login`, nor `tests/e2e.mjs`, nor `scripts/sign-in-link.sh` sends an
 * `Origin` — none of them is a browser — and the gate required one on every unsafe
 * request. The gate is now scoped to the content types a cross-site form can send.
 *
 *   node --test server/test/csrf-wiring.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_csrf-wiring-probe.mjs');

const byName = await new Promise((resolve, reject) => {
  execFile(
    process.execPath,
    ['--import', 'tsx', probe],
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
        DEV_LOGIN: '1',
        DESKTOP_MODE: 'disabled',
        HERMES_BIN: '/bin/false',
        APP_URL: 'http://localhost:5173',
        SERVER_URL: 'http://localhost:8787',
        NODE_ENV: '',
        ALLOWED_EMAILS: 'dev@local',
        ALLOWED_EMAIL_DOMAINS: '',
        AUTH_PASSWORD: '',
        AUTH_PASSWORD_HASH: '',
        DB_PATH: path.join(os.tmpdir(), `grokbot-csrf-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
      },
      timeout: 60_000,
    },
    (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
      if (!line) return reject(new Error(`no probe output\n${stdout}\n${stderr}`));
      const { results } = JSON.parse(line.slice('@@PROBE@@'.length));
      resolve(Object.fromEntries(results.map((r) => [r.name, r])));
    },
  );
});

const refused = (r) => r.status === 403 && /cross-site request refused/.test(r.body);

test('a JSON client with no Origin reaches the route instead of being refused as cross-site', () => {
  // `bin/gb login` and `tests/e2e.mjs` are exactly this request. They must not be 403.
  const gb = byName['gb login / e2e (JSON, no Origin)'];
  assert.equal(refused(gb), false, `gb/e2e was refused: ${gb.status} ${gb.body}`);
  assert.equal(gb.status, 200, 'the dev sign-in ran');
});

test('the documented fallback sign-in (owner key + JSON, no Origin) still works', () => {
  // `scripts/sign-in-link.sh` posts exactly this. Before the fix it was refused before
  // the owner key was ever checked, so the fallback sign-in was dead.
  const link = byName['sign-in-link.sh (JSON + bearer, no Origin)'];
  assert.equal(refused(link), false, `sign-in-link.sh was refused: ${link.status} ${link.body}`);
  // The key in the probe is a dummy, so 403 "forbidden" is the correct answer — it means
  // the request passed the gate and reached the route, which is the property under test.
  assert.equal(link.status, 403);
  assert.match(link.body, /forbidden/, 'refused by the owner-key check, not by the CSRF gate');
});

test('the shape a cross-site page can send is still refused', () => {
  // A urlencoded form with the victim's cookie and no Origin: no preflight involved, so
  // this is the one request the gate exists for.
  const form = byName['cross-site form POST'];
  assert.equal(refused(form), true, `a form POST with no Origin answered ${form.status} ${form.body}`);

  const foreign = byName['cross-site form POST, foreign Origin'];
  assert.equal(refused(foreign), true, `a form POST from a foreign origin answered ${foreign.status}`);

  const multipart = byName['multipart form POST'];
  assert.equal(refused(multipart), true, `a multipart POST with no Origin answered ${multipart.status}`);
});
