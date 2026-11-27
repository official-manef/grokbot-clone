/**
 * Staff-only policy: the app is internal (artists and management). The reason is not
 * cosmetic — a signed-in session here reaches tools that read and write the host
 * (`shell`, `computer_*`, file tools), so a fan must never hold one. Fans belong in
 * the game / antinrml.com, which uses Google OAuth separately.
 *
 *   node --test server/test/staff-only.test.mjs
 *
 * Two halves: the pure predicate, and the routes driven in a child process (env.ts
 * resolves once per process, so the allowlist cannot change mid-run). No network:
 * `/auth/google/start` builds its AuthKit URL locally, and the password/dev/owner
 * routes answer from config and SQLite.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isEmailAllowed } from '../src/lib/email-allowlist.ts';

const STAFF = { allowedEmails: [], allowedEmailDomains: ['antinrml.com'] };

// ---------- the predicate ----------

test('empty allowlist denies (fail closed), for any address', () => {
  assert.equal(isEmailAllowed('whoever@wherever.test', { allowedEmails: [], allowedEmailDomains: [] }), false);
  assert.equal(isEmailAllowed('boss@antinrml.com', { allowedEmails: [], allowedEmailDomains: [] }), false, 'a staff-looking domain is not a default');
});

test('an @antinrml.com address is allowed; a gmail.com address is refused', () => {
  assert.equal(isEmailAllowed('artist@antinrml.com', STAFF), true);
  assert.equal(isEmailAllowed('fan@gmail.com', STAFF), false);
});

test('lookalike and subdomain boundaries hold', () => {
  assert.equal(isEmailAllowed('x@evil-antinrml.com', STAFF), false, 'endsWith would let this through');
  assert.equal(isEmailAllowed('x@sub.antinrml.com', STAFF), false, 'a subdomain is not the listed domain');
  assert.equal(isEmailAllowed('x@notantinrml.com', STAFF), false);
  assert.equal(isEmailAllowed('x@antinrml.com.evil.com', STAFF), false);
});

test('an exact address still works alone and beside a domain list', () => {
  assert.equal(isEmailAllowed('boss@elsewhere.io', { allowedEmails: ['boss@elsewhere.io'], allowedEmailDomains: [] }), true);
  assert.equal(isEmailAllowed('boss@elsewhere.io', { allowedEmails: ['boss@elsewhere.io'], allowedEmailDomains: ['antinrml.com'] }), true);
  assert.equal(isEmailAllowed('fan@elsewhere.io', { allowedEmails: ['boss@elsewhere.io'], allowedEmailDomains: ['antinrml.com'] }), false);
});

// ---------- the routes ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_staff-signin-probe.mjs');
const PASSWORD = 'correct horse battery staple';

/** Run a batch of actions in a fresh process + fresh database, and return each one's outcome. */
function run(actions, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, JSON.stringify({ actions })],
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
          DB_PATH: path.join(os.tmpdir(), `grokbot-staff-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
          ...env,
        },
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stderr}`));
        const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe output\n${stdout}\n${stderr}`));
        resolve(JSON.parse(line.slice('@@PROBE@@'.length)).results);
      },
    );
  });
}

const empty = { users: 0, bots: 0, sessions: 0, attempts: 0 };

test('an unconfigured allowlist refuses every sign-in path, with no rows written', async () => {
  const [start, password, dev] = await run(
    [
      { path: '/auth/google/start' },
      { method: 'POST', path: '/auth/password', body: { email: 'artist@antinrml.com', password: PASSWORD } },
      { method: 'POST', path: '/auth/dev', body: { email: 'artist@antinrml.com' } },
    ],
    { WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_test', AUTH_PASSWORD: PASSWORD, DEV_LOGIN: '1' },
  );
  // Refused before the identity provider: no redirect into a flow that can never finish.
  assert.equal(start.status, 302);
  assert.match(start.location, /login=refused/);
  assert.ok(!start.location.includes('api.workos.com'), 'nobody is sent to AuthKit while nobody can be admitted');
  assert.equal(password.status, 403);
  assert.deepEqual(password.counts, empty);
  assert.equal(dev.status, 403);
  assert.deepEqual(dev.counts, empty);
});

test('a refused sign-in creates no user row and no session (gmail behind a live provider)', async () => {
  const [password, dev, owner] = await run(
    [
      { method: 'POST', path: '/auth/password', body: { email: 'fan@gmail.com', password: PASSWORD } },
      { method: 'POST', path: '/auth/dev', body: { email: 'fan@gmail.com' } },
      { method: 'POST', path: '/auth/owner', body: { email: 'fan@gmail.com' }, ownerKey: true },
    ],
    {
      WORKOS_API_KEY: 'sk_test',
      WORKOS_CLIENT_ID: 'client_test',
      AUTH_PASSWORD: PASSWORD,
      DEV_LOGIN: '1',
      ALLOWED_EMAIL_DOMAINS: 'antinrml.com',
    },
  );
  for (const [name, r] of [['password', password], ['dev', dev], ['owner', owner]]) {
    assert.equal(r.status, 403, `${name} refuses`);
    assert.deepEqual(r.counts.users, 0, `${name}: no user row`);
    assert.deepEqual(r.counts.bots, 0, `${name}: no Bot`);
    assert.deepEqual(r.counts.sessions, 0, `${name}: no session`);
    assert.equal(r.setCookie, false, `${name}: no session cookie`);
    assert.equal(r.body.error, 'This app is for the AntiNRML team.', `${name}: plain refusal, no reason`);
  }
});

test('an allowed sign-in still works end to end', async () => {
  const [password, wrong, dev] = await run(
    [
      { method: 'POST', path: '/auth/password', body: { email: 'artist@antinrml.com', password: PASSWORD } },
      { method: 'POST', path: '/auth/password', body: { email: 'artist@antinrml.com', password: 'nope' } },
      { method: 'POST', path: '/auth/dev', body: { email: 'artist@antinrml.com' } },
    ],
    { WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_test', AUTH_PASSWORD: PASSWORD, DEV_LOGIN: '1', ALLOWED_EMAIL_DOMAINS: 'antinrml.com' },
  );
  assert.equal(password.status, 200);
  assert.deepEqual(password.body, { ok: true });
  assert.equal(password.setCookie, true, 'a real session cookie');
  assert.equal(password.counts.users, 1);
  assert.equal(password.counts.bots, 1, 'the first Bot comes with the row');
  assert.equal(password.counts.sessions, 1);

  // A wrong password for an allowed address still fails, and adds nothing.
  assert.equal(wrong.status, 403);
  assert.equal(wrong.counts.sessions, 1);

  // Dev login, locally, with the flag on and the address allowlisted: a second session, same user.
  assert.equal(dev.status, 200);
  assert.equal(dev.counts.users, 1, 'no duplicate row for a known address');
  assert.equal(dev.counts.sessions, 2);
});

test('/auth/dev refuses an allowlisted address when the production signal is set', async () => {
  const [r] = await run(
    [{ method: 'POST', path: '/auth/dev', body: { email: 'artist@antinrml.com' } }],
    // Derived production signal: the URLs this process advertises are not loopback.
    { DEV_LOGIN: '1', ALLOWED_EMAIL_DOMAINS: 'antinrml.com', APP_URL: 'https://grok.antinrml.com' },
  );
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'disabled');
  assert.deepEqual(r.counts, empty);
});

test('/auth/dev refuses a foreign peer even when the flag is on and the address is staff', async () => {
  const [r] = await run(
    [{ method: 'POST', path: '/auth/dev', headers: { 'x-forwarded-for': '203.0.113.9' }, body: { email: 'artist@antinrml.com' } }],
    { DEV_LOGIN: '1', ALLOWED_EMAIL_DOMAINS: 'antinrml.com' },
  );
  assert.equal(r.status, 403);
  assert.deepEqual(r.counts, empty);
});

test('with a staff allowlist, /auth/google/start goes to AuthKit (staff transport, allowlist wall)', async () => {
  const [r] = await run([{ path: '/auth/google/start' }], {
    WORKOS_API_KEY: 'sk_test_do_not_leak',
    WORKOS_CLIENT_ID: 'client_test',
    ALLOWED_EMAIL_DOMAINS: 'antinrml.com',
    SERVER_URL: 'https://grok.antinrml.com',
  });
  assert.equal(r.status, 302);
  const url = new URL(r.location);
  assert.equal(url.origin + url.pathname, 'https://api.workos.com/user_management/authorize');
  assert.equal(url.searchParams.get('provider'), 'authkit');
  assert.ok(!r.location.includes('sk_test_do_not_leak'), 'the secret never reaches the browser');
  assert.equal(r.counts.attempts, 1, 'one live login attempt, no user row yet');
  assert.equal(r.counts.users, 0, 'a row is created only after a successful, allowlisted sign-in');
});

test('/auth/workos/callback refuses an allowlisted-but-unfinished attempt only at the wall', async () => {
  // No state/code: refused before any exchange, nothing written.
  const [r] = await run([{ path: '/auth/workos/callback' }], { WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_test', ALLOWED_EMAIL_DOMAINS: 'antinrml.com' });
  assert.equal(r.status, 302);
  assert.match(r.location, /login=failed/);
  assert.deepEqual(r.counts, empty);
});

test('/auth/google/callback is gone, not merely inert', async () => {
  // Its start half was deleted, so nothing could create the attempt row it read, and
  // it trusted `connected_account_id` from the query string with no TTL and no cookie
  // binding. A caller who has their own live attempt and a victim's Composio account
  // id could name both and be signed in as the victim, so the route had to go, not
  // just stay unreachable.
  //
  // 404 with a JSON body is the proof it is not mounted: every `/auth/*` route sits
  // above the auth wall in routes.ts, so a mounted callback answers 302
  // `?login=failed`. A 404 here can only come from the `/api/*` catch-all in `app.ts`.
  //
  // The status alone was not enough. This case used to assert 401, which was true of
  // the `api` sub-app the probe drove and false of the served build: the mounted app
  // answered `200 text/html` for this path, because an unmatched `/api/*` request fell
  // through to the SPA fallback. A response status that cannot be distinguished from
  // the app's own page does not prove a route is gone, so the body's type is asserted
  // as well.
  const [r] = await run(
    [{ path: '/auth/google/callback?attempt=login_x&connected_account_id=ca_victim' }],
    { WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_test', ALLOWED_EMAIL_DOMAINS: 'antinrml.com', COMPOSIO_API_KEY: 'test-key' },
  );
  assert.equal(r.status, 404, 'the route does not exist, so no query string is read');
  assert.match(r.contentType, /^application\/json/, 'an unknown API path is not a page');
  assert.equal(r.body?.error, 'not found');
  assert.equal(r.location, '');
  assert.equal(r.setCookie, false, 'and no session is minted from a caller-supplied id');
  assert.deepEqual(r.counts, empty, 'nor is anything written on the way out');
});
