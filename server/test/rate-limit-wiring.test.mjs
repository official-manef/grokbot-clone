/**
 * The limiter *as the routes run it* — not just the pure helper. Each case runs in
 * a child process because env.ts and the db handle resolve once per process.
 *
 * The four defects `d87a297` fixed, proven at the route boundary:
 *
 *   1. no shared 'unknown' bucket  -> two clients with no forwarding header and
 *      different sockets get different counters (helper-level, see
 *      rate-limit.test.mjs; the route passes the socket through clientKey);
 *   2. the key is the LAST trusted hop -> a rotating first hop cannot evade the
 *      limit (drive `/auth/link/:token` with `127.0.0.i, 203.0.113.7`);
 *   3. the key map has a ceiling -> `/auth/link` traffic from more distinct hops
 *      than MAX_KEYS leaves the pool at MAX_KEYS, not n;
 *   4. `/bots/:id/messages` is limited -> the 61st turn in a minute is 429.
 *
 * No network: the turn route is limited before the bot is loaded, so nothing is
 * enqueued and no model is called.
 *
 *   node --test server/test/rate-limit-wiring.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_rate-limit-wiring-probe.mjs');

function run(mode, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, mode],
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
          GROKBOT_NO_SCHEDULER: '1',
          APP_URL: 'http://localhost:5173',
          SERVER_URL: 'http://localhost:8787',
          NODE_ENV: '',
          ALLOWED_EMAILS: '',
          ALLOWED_EMAIL_DOMAINS: 'antinrml.com',
          AUTH_PASSWORD: '',
          AUTH_PASSWORD_HASH: '',
          TRUSTED_PROXY_HOPS: '1',
          DB_PATH: path.join(os.tmpdir(), `grokbot-rl-wiring-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
          ...env,
        },
        timeout: 120_000,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stderr}`));
        const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe output\n${stdout}\n${stderr}`));
        resolve(JSON.parse(line.slice('@@PROBE@@'.length)));
      },
    );
  });
}

test('/bots/:id/messages is rate limited: the 61st turn in a minute is 429', async () => {
  const out = await run('turns');
  assert.equal(out.signInStatus, 200, 'the probe has a real session');
  const refused = out.statuses.filter((s) => s === 429);
  assert.equal(refused.length, 2, `expected the last two of 62 to be 429, got ${JSON.stringify(out.statuses)}`);
  assert.deepEqual(out.statuses.slice(0, 60).every((s) => s !== 429), true, 'the first 60 stay under the wall');
});

test('the client key is the last trusted hop: a rotating first hop cannot evade the limit', async () => {
  const out = await run('rotating-hop');
  // `/auth/link/:token` allows 20 per window, so all 21 land in one bucket.
  assert.equal(out.statuses[20], 429, `a rotating first hop must not buy a fresh bucket: ${JSON.stringify(out.statuses)}`);
  assert.equal(out.statuses.filter((s) => s === 429).length, 1, 'exactly one refusal, at the 21st call');
});

test('the key map has a ceiling: more distinct hops than MAX_KEYS do not grow it', async () => {
  const out = await run('ceiling');
  assert.equal(out.maxKeys, 4096, 'the documented cap');
  assert.ok(out.requested > out.maxKeys, 'the probe asked for more keys than the cap');
  assert.ok(
    out.pool.untrusted <= out.maxKeys,
    `untrusted pool must stay at or under the cap, was ${out.pool.untrusted} after ${out.requested} distinct keys`,
  );
  assert.equal(out.pool.privileged, 0, 'no privileged bucket was touched by the ip flood');
});

test('no shared bucket: two direct clients with no chain get separate counters', async () => {
  const out = await run('direct-clients');
  assert.equal(out.statuses[20], 429, `the first client hits its own wall: ${JSON.stringify(out.statuses)}`);
  assert.notEqual(out.other, 429, 'a different direct client is unaffected by the first one');
});

test('/auth/password shares the same key rule: a rotating first hop cannot buy guesses', async () => {
  const out = await run('password-hop', { AUTH_PASSWORD: 'correct horse battery staple' });
  // Five failures per address per window, so the sixth wrong password is 429 even
  // though every call sent a different spoofed first hop.
  assert.equal(out.statuses[5], 429, `all six guesses landed in one bucket: ${JSON.stringify(out.statuses)}`);
  assert.equal(out.statuses.filter((s) => s === 429).length, 2, 'and they stay refused');
});
