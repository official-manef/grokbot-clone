/**
 * WorkOS AuthKit sign-in: URL shape, config detection, and the code exchange.
 *
 * No network: `exchangeCode` is pointed at a local HTTP server on 127.0.0.1, and
 * `authorizationUrl` is pure string building.
 *
 *   node --test server/test/workos-auth.test.mjs
 *
 * Imports TypeScript source; Node >=22.18 strips types natively. The env vars env.ts
 * requires are set before the import, because env.ts resolves once per process.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.SESSION_SECRET ??= 'test-secret';
process.env.XAI_API_KEY ??= 'test-key';
process.env.DB_PATH ??= path.join(os.tmpdir(), `grokbot-workos-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

const { authorizationUrl, exchangeCode, workosConfigured } = await import('../src/lib/workos.ts');

const KEY = 'sk_test_do_not_leak_0123456789';
const CLIENT = 'client_test_abc';

/** A throwaway HTTP server that answers like the WorkOS authenticate endpoint. */
function fakeWorkos(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      await handler(req, res, body);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ---------- configuration ----------

test('workosConfigured is false when either half of the credentials is missing', () => {
  assert.equal(workosConfigured({ apiKey: KEY, clientId: CLIENT }), true);
  assert.equal(workosConfigured({ apiKey: '', clientId: CLIENT }), false);
  assert.equal(workosConfigured({ apiKey: KEY, clientId: '' }), false);
  assert.equal(workosConfigured({ apiKey: '', clientId: '' }), false);
});

// ---------- authorize URL ----------

test('the authorize URL carries every AuthKit parameter, and the state we passed', () => {
  const url = new URL(authorizationUrl({ redirectUri: 'https://grok.antinrml.com/api/auth/workos/callback', state: 'state_abc123', apiKey: KEY, clientId: CLIENT }));
  assert.equal(url.origin + url.pathname, 'https://api.workos.com/user_management/authorize');
  assert.equal(url.searchParams.get('client_id'), CLIENT);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://grok.antinrml.com/api/auth/workos/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('provider'), 'authkit');
  assert.equal(url.searchParams.get('state'), 'state_abc123');
  assert.ok(!url.href.includes(KEY), 'the secret key never appears in a browser redirect');
});

test('the redirect URI is percent-encoded, not concatenated', () => {
  const redirectUri = 'https://grok.antinrml.com/api/auth/workos/callback?a=1&state=evil';
  const href = authorizationUrl({ redirectUri, state: 'state_x', apiKey: KEY, clientId: CLIENT });
  assert.ok(!href.includes('?a=1&state=evil'), 'a raw & from the redirect URI would start a new outer parameter');
  assert.ok(href.includes('redirect_uri=https%3A%2F%2Fgrok.antinrml.com%2Fapi%2Fauth%2Fworkos%2Fcallback%3Fa%3D1%26state%3Devil'));
  const url = new URL(href);
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri, 'round-trips as one argument');
  assert.equal(url.searchParams.get('state'), 'state_x', 'the outer state is still ours');
});

// ---------- code exchange ----------

test('exchangeCode maps a good response to { email, name }', async () => {
  const fake = await fakeWorkos((req, res, body) => {
    const parsed = JSON.parse(body);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/user_management/authenticate');
    assert.equal(parsed.client_id, CLIENT);
    assert.equal(parsed.client_secret, KEY);
    assert.equal(parsed.grant_type, 'authorization_code');
    assert.equal(parsed.code, 'code_123');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user: { email: 'riku@antinrml.com', first_name: 'Riku', last_name: 'Nakamura', email_verified: true } }));
  });
  try {
    const profile = await exchangeCode('code_123', { apiKey: KEY, clientId: CLIENT, baseUrl: fake.baseUrl });
    assert.equal(profile.email, 'riku@antinrml.com');
    assert.equal(profile.name, 'Riku Nakamura');
    assert.equal(profile.emailVerified, true);
  } finally {
    await fake.close();
  }
});

test('exchangeCode rejects on a non-2xx and never leaks the api key', async () => {
  const fake = await fakeWorkos((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    // A hostile-but-plausible body: the server echoing the key back must not reach the error.
    res.end(JSON.stringify({ message: 'invalid_client', client_secret: KEY }));
  });
  try {
    await assert.rejects(
      () => exchangeCode('code_123', { apiKey: KEY, clientId: CLIENT, baseUrl: fake.baseUrl }),
      (err) => {
        assert.match(err.message, /401/, 'the status is in the message');
        assert.match(err.message, /invalid_client/, 'the upstream message is in the message');
        assert.ok(!err.message.includes(KEY), 'the api key must be redacted');
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('exchangeCode times out instead of hanging on a stalled upstream', async () => {
  const fake = await fakeWorkos(() => {
    /* never responds */
  });
  try {
    await assert.rejects(() => exchangeCode('code_123', { apiKey: KEY, clientId: CLIENT, baseUrl: fake.baseUrl, timeoutMs: 200 }), /request failed|Timeout/i);
  } finally {
    await fake.close();
  }
});

// ---------- the route: 503, never 500 ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_signin-start-probe.mjs');

function startRoute(vars) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, vars.mode ?? 'unconfigured'],
      {
        cwd: path.join(here, '..'),
        env: {
          ...process.env,
          SESSION_SECRET: 'test-secret',
          XAI_API_KEY: 'test-key',
          COMPOSIO_API_KEY: '',
          WORKOS_API_KEY: '',
          WORKOS_CLIENT_ID: '',
          DB_PATH: path.join(os.tmpdir(), `grokbot-start-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
          ...vars.env,
        },
        timeout: 60_000,
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

test('with nothing configured, /auth/google/start answers 503 rather than 500', async () => {
  const r = await startRoute({ mode: 'unconfigured' });
  assert.equal(r.status, 503, `expected 503, got ${r.status}`);
  assert.deepEqual(r.body, { error: 'sign-in not configured' });
  assert.equal(r.location, '', 'no redirect into a flow that cannot work');
});

test('with WorkOS configured, /auth/google/start redirects to AuthKit with a live state', async () => {
  // The allowlist is now half of "sign-in configured": with it empty, the route
  // refuses before redirecting (asserted below). This case is staff transport.
  const r = await startRoute({
    mode: 'workos',
    env: { WORKOS_API_KEY: KEY, WORKOS_CLIENT_ID: CLIENT, SERVER_URL: 'https://grok.antinrml.com', ALLOWED_EMAIL_DOMAINS: 'antinrml.com' },
  });
  assert.equal(r.authProvider, 'workos', 'WorkOS is the default once both vars are present');
  assert.equal(r.status, 302);
  const url = new URL(r.location);
  assert.equal(url.origin + url.pathname, 'https://api.workos.com/user_management/authorize');
  assert.equal(url.searchParams.get('client_id'), CLIENT);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://grok.antinrml.com/api/auth/workos/callback');
  assert.equal(url.searchParams.get('provider'), 'authkit');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), r.state);
  assert.match(r.state, /^state_[A-Za-z0-9_-]{12,}$/, 'state is an unguessable random token, not a counter');
  assert.equal(r.stateIsLive, true, 'state is a live login_attempts row');
  assert.ok(!r.location.includes(KEY), 'the secret key never leaves the server');
});

test('with WorkOS configured but an empty allowlist, /auth/google/start refuses before Google', async () => {
  // Fail closed: no allowlist entry means nobody can be admitted, so sending a
  // browser to the identity provider would only advertise a sign-up that can never
  // finish. Updated from the old expectation, which redirected regardless.
  const r = await startRoute({ mode: 'workos', env: { WORKOS_API_KEY: KEY, WORKOS_CLIENT_ID: CLIENT, SERVER_URL: 'https://grok.antinrml.com' } });
  assert.equal(r.status, 302);
  assert.match(r.location, /login=refused/, 'the plain "for the AntiNRML team" landing');
  assert.ok(!r.location.includes('workos.com'), 'nobody is sent to the identity provider');
  assert.equal(r.state, '');
  assert.equal(r.stateIsLive, false, 'no login attempt row is written either');
});
