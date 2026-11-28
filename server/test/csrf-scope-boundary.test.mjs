/**
 * Which content types the CSRF gate checks, and which it deliberately lets through.
 *
 * `checkOrigin` only inspects the three types an HTML form can send. Everything else is
 * exempt because a cross-site page cannot make the request at all: the browser needs a
 * preflight, and this server grants none. That reasoning was measured in a real browser
 * (see the 2026-11-29 section of `docs/CONTINUE.md`), not assumed.
 *
 * The case this file exists for is the one nobody wrote down: `isFormContentType`
 * answers `false` for any type it does not recognise, so `application/jsonx` — a typo, or
 * a vendor type — skips the gate. That is fine while the exemption means "preflightable",
 * and wrong the moment someone reads it as "safe". Hono parses the body either way, so a
 * client that already holds a session cookie can write with `application/jsonx` and no
 * Origin check.
 *
 * No browser can do that, which is why this pins the boundary instead of demanding a
 * fix: these assertions fail if unknown types start being treated as forms, because that
 * would put every non-browser tool back behind the gate that refused them for ten days.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkOrigin, isFormContentType } from '../src/lib/origin-check.ts';

const OWN = ['https://app.example'];

const check = (over = {}) =>
  checkOrigin({ method: 'POST', path: '/api/bots', ownOrigins: OWN, ...over });

test('the three form types are checked, and a missing type is treated as a form', () => {
  for (const ct of [
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain',
    'text/plain;charset=UTF-8',
  ]) {
    assert.equal(isFormContentType(ct), true, ct);
    assert.equal(check({ contentType: ct, origin: 'https://evil.example' }).ok, false, ct);
  }
  // Absent is the unclassifiable case; treating it as safe would make it the bypass.
  assert.equal(isFormContentType(undefined), true);
  assert.equal(isFormContentType(null), true);
  assert.equal(isFormContentType(''), true);
  assert.equal(check({ contentType: undefined, origin: undefined }).ok, false);
});

test('a JSON body is exempt, because the browser cannot send it without a preflight', () => {
  assert.equal(isFormContentType('application/json'), false);
  assert.equal(check({ contentType: 'application/json', origin: 'https://evil.example' }).ok, true);
  assert.equal(check({ contentType: 'application/json; charset=utf-8', origin: 'https://evil.example' }).ok, true);
});

test('an unrecognised type is exempt too, and that is the boundary to keep an eye on', () => {
  // These are not form types, so the gate does not look at them. `application/jsonx` is
  // the interesting one: Hono still parses its body as JSON, so a caller holding a
  // session cookie can write with it and no Origin check. Recorded, not exploited --
  // no browser can set it cross-site (a page cannot choose a Content-Type without a
  // preflight this server refuses).
  for (const ct of ['application/jsonx', 'application/vnd.api+json', 'application/octet-stream', 'audio/webm']) {
    assert.equal(isFormContentType(ct), false, ct);
    assert.equal(check({ contentType: ct, origin: 'https://evil.example' }).ok, true, ct);
  }
});

test('a bearer token is exempt whatever the content type, since there is no cookie to ride', () => {
  for (const ct of ['application/json', 'text/plain', 'application/x-www-form-urlencoded']) {
    assert.equal(check({ contentType: ct, origin: undefined, authorization: 'Bearer x' }).ok, true, ct);
  }
  // An empty or whitespace header is not a credential.
  assert.equal(check({ contentType: 'text/plain', origin: undefined, authorization: '   ' }).ok, false);
});

test('a form with no Origin is refused rather than waved through', () => {
  const v = check({ contentType: 'application/x-www-form-urlencoded', origin: undefined });
  assert.deepEqual(v, { ok: false, reason: 'missing' });
});

test('/mcp is exempt by path, because it authenticates with a bearer token', () => {
  for (const path of ['/mcp', '/mcp/bot_1']) {
    const v = checkOrigin({ method: 'POST', path, origin: 'https://evil.example', contentType: 'text/plain', ownOrigins: OWN });
    assert.equal(v.ok, true, path);
  }
  // ...but a non-MCP path is not.
  assert.equal(check({ path: '/api/bots', contentType: 'text/plain', origin: 'https://evil.example' }).ok, false);
});

test('safe methods are never blocked, so navigation and SSE keep working', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
    const v = checkOrigin({ method, path: '/api/bots', origin: undefined, contentType: 'text/plain', ownOrigins: OWN });
    assert.equal(v.ok, true, method);
  }
});
