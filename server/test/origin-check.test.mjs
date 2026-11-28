/**
 * The CSRF check that replaces what `SameSite=Lax` gave for free.
 *
 * The failure this guards is not "a foreign Origin got a 403" but the two directions
 * of getting it wrong: (a) a deployment that embeds the app cannot use `Lax`, so
 * without this module every cross-site POST with the user's cookie would be accepted;
 * (b) a check strict enough to break the app's own fetches, or to reject the console
 * that frames it.
 *
 *   node --test server/test/origin-check.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkOrigin, isFormContentType, parseOrigins } from '../src/lib/origin-check.ts';

const own = ['https://grok.antinrml.com', 'http://localhost:5173'];
const check = (over = {}) => checkOrigin({ method: 'POST', path: '/api/bots', origin: null, ownOrigins: own, ...over });

test('safe methods are never blocked, so navigation and SSE keep working', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(check({ method, origin: undefined }).ok, true, method);
  }
});

test('a state-changing request from our own origin is allowed', () => {
  assert.equal(check({ origin: 'https://grok.antinrml.com', contentType: 'text/plain' }).ok, true);
  assert.equal(check({ origin: 'http://localhost:5173', contentType: 'text/plain' }).ok, true);
});

test('a foreign origin is refused', () => {
  const verdict = check({ origin: 'https://evil.example', contentType: 'text/plain' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'foreign');
});

test('a missing Origin on a form POST is refused, not waved through', () => {
  // A form POST is the one shape another site can send with the victim's cookie and no
  // preflight, so its absence of Origin is refused. A missing Content-Type counts as a
  // form here: a POST that cannot be classified must not become the bypass.
  const verdict = check({ origin: undefined, contentType: 'application/x-www-form-urlencoded' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'missing');
  assert.equal(check({ origin: '', contentType: 'multipart/form-data; boundary=x' }).ok, false);
  assert.equal(check({ origin: undefined, contentType: undefined }).ok, false, 'unclassifiable is a form');
});

test('a JSON body is not a form, so it is exempt: no preflight means no cross-site CSRF', () => {
  // This is the case that was a real bug. `scripts/sign-in-link.sh`, `gb login` and
  // `tests/e2e.mjs` are JSON clients that send no Origin, and every one of them got
  // `403 cross-site request refused`. A cross-site page cannot send JSON at all without
  // a preflight this server never grants, so refusing here protected nothing.
  assert.equal(check({ origin: undefined, contentType: 'application/json' }).ok, true);
  assert.equal(check({ origin: 'https://evil.example', contentType: 'application/json; charset=utf-8' }).ok, true);
  assert.equal(check({ origin: undefined, contentType: 'application/octet-stream' }).ok, true);
  assert.equal(check({ origin: undefined, contentType: 'audio/webm' }).ok, true);
});

test('a bearer token exempts the call whatever the body is', () => {
  // No session cookie in play means nothing to ride, and a form cannot set the header.
  assert.equal(check({ origin: undefined, contentType: 'text/plain', authorization: 'Bearer abc' }).ok, true);
  assert.equal(check({ origin: 'https://evil.example', contentType: 'text/plain', authorization: 'Bearer abc' }).ok, true);
});

test('the sandboxed-frame literal "null" is foreign, never allowed', () => {
  const verdict = check({ origin: 'null', contentType: 'text/plain' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'foreign');
});

test('the embedding console is allowed only when the operator listed it', () => {
  const console_ = 'https://mso.antinrml.com';
  assert.equal(check({ origin: console_, contentType: 'text/plain' }).ok, false, 'not allowed by default');
  assert.equal(check({ origin: console_, contentType: 'text/plain', allowedOrigins: [console_] }).ok, true);
});

test('/mcp authenticates with a bearer token, so it is exempt', () => {
  // A cross-site form cannot supply the Authorization header, so the cookie rule
  // does not apply and blocking here would break every bot.
  assert.equal(check({ path: '/mcp/bot_abc', origin: undefined }).ok, true);
  assert.equal(check({ path: '/mcp/primary', origin: 'https://evil.example' }).ok, true);
});

test('isFormContentType scopes the gate to what a page can actually send', () => {
  for (const t of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=----x', 'text/plain', 'TEXT/PLAIN']) {
    assert.equal(isFormContentType(t), true, t);
  }
  for (const t of ['application/json', 'application/json; charset=utf-8', 'application/octet-stream', 'audio/webm', 'text/html']) {
    assert.equal(isFormContentType(t), false, t);
  }
  assert.equal(isFormContentType(undefined), true, 'a body we cannot classify is treated as a form');
  assert.equal(isFormContentType(''), true);
});

test('a lookalike origin is refused: exact origin match only', () => {
  assert.equal(check({ origin: 'https://grok.antinrml.com.evil.example', contentType: 'text/plain' }).ok, false);
  assert.equal(check({ origin: 'http://grok.antinrml.com', contentType: 'text/plain' }).ok, false, 'scheme is part of the origin');
  assert.equal(check({ origin: 'https://grok.antinrml.com:8443', contentType: 'text/plain' }).ok, false, 'port is part of the origin');
});

test('origins are parsed from a list, and junk is dropped rather than guessed', () => {
  assert.deepEqual(parseOrigins('https://a.example, https://b.example'), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseOrigins('https://a.example/path'), ['https://a.example'], 'a path is a typo, normalised');
  assert.deepEqual(parseOrigins('not a url, https://ok.example'), ['https://ok.example']);
  assert.deepEqual(parseOrigins(''), []);
  assert.deepEqual(parseOrigins(undefined), []);
});
