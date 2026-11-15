/**
 * Who the caller is, in one place.
 *
 * The bug this guards: two gates disagreed. The rate limiter read the LAST hop of
 * `x-forwarded-for`, the dev-login guard read the FIRST. A stranger could send
 * `X-Forwarded-For: 127.0.0.1, <their address>` and the guard — which exists to keep
 * credential-less sign-in local-only — read `127.0.0.1` and let them mint a session.
 * Verified against the running server before the fix: 200 instead of 403.
 *
 * Both gates now call this module, so the property under test is agreement, not a
 * regex.
 *
 *   node --test server/test/client-identity.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientAddress, isLocalRequest, isLoopbackPeer, trustedProxyHops } from '../src/lib/client-identity.ts';
import { devLoginAllowed } from '../src/lib/dev-login-guard.ts';

test('the trusted hop is the last entry, not the first', () => {
  const spoofed = new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' });
  assert.equal(clientAddress(spoofed, '127.0.0.1'), '203.0.113.7');

  const two = new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 10.0.0.9' });
  assert.equal(clientAddress(two, '127.0.0.1', 2), '203.0.113.7');
  assert.equal(clientAddress(two, '127.0.0.1', 1), '10.0.0.9');
});

test('a rotating spoofed prefix cannot change the answer', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    seen.add(clientAddress(new Headers({ 'x-forwarded-for': `10.9.9.${i}, 203.0.113.7` }), '127.0.0.1'));
  }
  assert.deepEqual([...seen], ['203.0.113.7'], 'all fifty resolve to one address');
});

test('direct clients keep their own socket address', () => {
  assert.equal(clientAddress(new Headers(), '10.0.0.1'), '10.0.0.1');
  assert.equal(clientAddress(new Headers(), '10.0.0.2'), '10.0.0.2');
  assert.notEqual(clientAddress(new Headers(), '10.0.0.1'), clientAddress(new Headers(), '10.0.0.2'));
});

test('x-real-ip is the fallback when the chain is absent', () => {
  assert.equal(clientAddress(new Headers({ 'x-real-ip': '203.0.113.11' }), '127.0.0.1'), '203.0.113.11');
});

test('hops=0 ignores the header entirely', () => {
  const headers = new Headers({ 'x-forwarded-for': '1.2.3.4' });
  assert.equal(clientAddress(headers, '10.0.0.5', 0), '10.0.0.5');
  assert.equal(isLoopbackPeer('1.2.3.4', 0), true, 'with no proxy trusted the socket decides');
});

test('trustedProxyHops falls back to 1 on nonsense, never to 0', () => {
  assert.equal(trustedProxyHops(undefined), 1);
  assert.equal(trustedProxyHops('0'), 0);
  assert.equal(trustedProxyHops('2'), 2);
  assert.equal(trustedProxyHops('nonsense'), 1);
  assert.equal(trustedProxyHops('-1'), 1);
  assert.equal(trustedProxyHops('99'), 1);
  assert.equal(trustedProxyHops('1.5'), 1);
});

test('loopback is read from the trusted hop, so a spoofed loopback is foreign', () => {
  // The attack: client claims to be loopback, the proxy appends the real address.
  assert.equal(isLoopbackPeer('127.0.0.1, 203.0.113.7'), false, 'the spoofed hop must not count');
  assert.equal(isLoopbackPeer('::1, 203.0.113.7'), false);
  // The real thing: the proxy itself is local, nothing was appended by a stranger.
  assert.equal(isLoopbackPeer('127.0.0.1'), true);
  assert.equal(isLoopbackPeer('::1'), true);
  assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackPeer(undefined), true, 'no header = nothing in front of us');
  assert.equal(isLoopbackPeer(''), true);
});

test('a public socket peer is never local, whatever the header claims', () => {
  // The hole the header-only rule left: a directly-exposed server takes the header
  // from whoever connected, so "X-Forwarded-For: 127.0.0.1" proved nothing.
  const claim = new Headers({ 'x-forwarded-for': '127.0.0.1' });
  assert.equal(isLocalRequest(claim, '203.0.113.9'), false, 'a stranger cannot write itself loopback');
  assert.equal(isLocalRequest(new Headers(), '203.0.113.9'), false);
  // And a genuinely local socket still passes.
  assert.equal(isLocalRequest(claim, '127.0.0.1'), true);
  assert.equal(isLocalRequest(new Headers(), '::1'), true);
});

test('a local proxy with a foreign client is not local', () => {
  // The other shape: a real proxy on loopback appends the foreign address it saw.
  // One entry = the proxy's own observation, nothing prepended by the client.
  assert.equal(isLocalRequest(new Headers({ 'x-forwarded-for': '203.0.113.7' }), '127.0.0.1'), false);
  // Client prepends a fake loopback; the proxy's observed address is still last.
  assert.equal(isLocalRequest(new Headers({ 'x-forwarded-for': '127.0.0.1, 203.0.113.7' }), '127.0.0.1'), false);
  // Proxy sees a genuinely local client.
  assert.equal(isLocalRequest(new Headers({ 'x-forwarded-for': '127.0.0.1' }), '127.0.0.1'), true);
});

test('a chain shorter than the configured hop count was not written by our proxies', () => {
  // TRUSTED_PROXY_HOPS=2 but only one entry: the "proxy" that should have appended
  // is missing, so the value is client-authored.
  assert.equal(isLoopbackPeer('127.0.0.1', 2), false);
  assert.equal(isLoopbackPeer('127.0.0.1, 127.0.0.1', 2), true);
});

test('the dev-login gate now refuses the spoofed-loopback attack end to end', () => {
  const base = { flag: true, production: false, staff: true };
  // Shape 1: stranger behind a local proxy, claiming to be loopback.
  const attack = devLoginAllowed({ ...base, forwardedFor: '127.0.0.1, 203.0.113.7', remote: '127.0.0.1' });
  assert.equal(attack.allowed, false, 'a stranger must not inherit the loopback exemption');
  assert.equal(attack.reason, 'network');

  // Shape 2: stranger connecting directly to an exposed server, claiming to be
  // loopback. No proxy appended anything, so the header is theirs alone.
  const direct = devLoginAllowed({ ...base, forwardedFor: '127.0.0.1', remote: '203.0.113.7' });
  assert.equal(direct.allowed, false, 'the socket peer decides when nothing is in front');

  // The legitimate local cases still work.
  assert.equal(devLoginAllowed({ ...base, forwardedFor: '127.0.0.1', remote: '127.0.0.1' }).allowed, true);
  assert.equal(devLoginAllowed({ ...base, forwardedFor: undefined, remote: '::1' }).allowed, true);
  // And a harness with no socket still exercises the header rule on its own.
  assert.equal(devLoginAllowed({ ...base, forwardedFor: '127.0.0.1', remote: undefined }).allowed, true);
});

test('the two gates agree about the caller for every header shape', async () => {
  const { clientKey } = await import('../src/lib/rate-limit.ts');
  const cases = [
    '203.0.113.7',
    '127.0.0.1, 203.0.113.7',
    '10.9.9.9, 10.9.9.8, 203.0.113.7',
    '',
  ];
  for (const raw of cases) {
    const headers = new Headers(raw ? { 'x-forwarded-for': raw } : {});
    const address = clientKey(headers, '127.0.0.1');
    const loopback = isLoopbackPeer(raw || undefined);
    // Agreement means: an address that reads as loopback is exactly one the
    // dev-login gate would accept, and vice versa.
    assert.equal(loopback, address === '127.0.0.1', `disagreement on "${raw}" -> ${address}`);
  }
});
