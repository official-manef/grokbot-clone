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
import { checkOrigin, parseOrigins } from '../src/lib/origin-check.ts';

const own = ['https://grok.antinrml.com', 'http://localhost:5173'];
const check = (over = {}) => checkOrigin({ method: 'POST', path: '/api/bots', origin: null, ownOrigins: own, ...over });

test('safe methods are never blocked, so navigation and SSE keep working', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(check({ method, origin: undefined }).ok, true, method);
  }
});

test('a state-changing request from our own origin is allowed', () => {
  assert.equal(check({ origin: 'https://grok.antinrml.com' }).ok, true);
  assert.equal(check({ origin: 'http://localhost:5173' }).ok, true);
});

test('a foreign origin is refused', () => {
  const verdict = check({ origin: 'https://evil.example' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'foreign');
});

test('a missing Origin on a POST is refused, not waved through', () => {
  // Every browser sends Origin on a state-changing request. Its absence is a
  // non-browser client, and the point of this check is the browser case.
  const verdict = check({ origin: undefined });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'missing');
  assert.equal(check({ origin: '' }).ok, false);
});

test('the sandboxed-frame literal "null" is foreign, never allowed', () => {
  const verdict = check({ origin: 'null' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'foreign');
});

test('the embedding console is allowed only when the operator listed it', () => {
  const console_ = 'https://mso.antinrml.com';
  assert.equal(check({ origin: console_ }).ok, false, 'not allowed by default');
  assert.equal(check({ origin: console_, allowedOrigins: [console_] }).ok, true);
});

test('/mcp authenticates with a bearer token, so it is exempt', () => {
  // A cross-site form cannot supply the Authorization header, so the cookie rule
  // does not apply and blocking here would break every bot.
  assert.equal(check({ path: '/mcp/bot_abc', origin: undefined }).ok, true);
  assert.equal(check({ path: '/mcp/primary', origin: 'https://evil.example' }).ok, true);
});

test('a lookalike origin is refused: exact origin match only', () => {
  assert.equal(check({ origin: 'https://grok.antinrml.com.evil.example' }).ok, false);
  assert.equal(check({ origin: 'http://grok.antinrml.com' }).ok, false, 'scheme is part of the origin');
  assert.equal(check({ origin: 'https://grok.antinrml.com:8443' }).ok, false, 'port is part of the origin');
});

test('origins are parsed from a list, and junk is dropped rather than guessed', () => {
  assert.deepEqual(parseOrigins('https://a.example, https://b.example'), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseOrigins('https://a.example/path'), ['https://a.example'], 'a path is a typo, normalised');
  assert.deepEqual(parseOrigins('not a url, https://ok.example'), ['https://ok.example']);
  assert.deepEqual(parseOrigins(''), []);
  assert.deepEqual(parseOrigins(undefined), []);
});
