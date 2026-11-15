/**
 * Fixed-window limiter, two pools, capped and LRU. No network, no sleeps: every
 * case injects the clock.
 *
 * The load-bearing assertions:
 *   - an `ip:*` flood must not rescue a blocked `user:*` bucket (two pools);
 *   - overflow must drop a cold key, not the active one that merely happens to be
 *     older (LRU, not FIFO);
 *   - a client cannot choose its own bucket by sending `X-Forwarded-For` (the
 *     address is read from the trusted hop at the END of the chain);
 *   - two direct clients without proxy headers get two buckets, never one shared
 *     'unknown' (that would let one caller lock out everyone).
 *
 *   node --test server/test/rate-limit.test.mjs
 */
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  MAX_KEYS,
  clientKey,
  poolSizes,
  rateLimited,
  rateLimitedUntrusted,
  resetRateLimits,
  retryAfterSeconds,
  trustedProxyHops,
} from '../src/lib/rate-limit.ts';

// 10 minutes, so a live bucket's retryAfter is ~600 and "absent" (1) is
// unambiguous. Distinguishing present-from-absent this way avoids exporting
// internals.
const LONG = 600_000;

beforeEach(() => resetRateLimits());

test('allows exactly max requests, rejects the next one', () => {
  const at = 1_000;
  assert.equal(rateLimited('user:a', 3, LONG, at), false);
  assert.equal(rateLimited('user:a', 3, LONG, at), false);
  assert.equal(rateLimited('user:a', 3, LONG, at), false);
  assert.equal(rateLimited('user:a', 3, LONG, at), true, '4th call is over a max of 3');
  assert.equal(rateLimited('user:a', 3, LONG, at), true, 'stays blocked for the rest of the window');
});

test('buckets are per key: exhausting user:a leaves user:b alone', () => {
  const at = 1_000;
  for (let i = 0; i < 5; i += 1) rateLimited('user:a', 5, LONG, at);
  assert.equal(rateLimited('user:a', 5, LONG, at), true);
  assert.equal(rateLimited('user:b', 5, LONG, at), false, 'a different user has its own budget');
});

test('pools are isolated: an ip:* flood cannot evict or reset a live user:* bucket', () => {
  const at = 1_000;

  // A real user hits the wall.
  for (let i = 0; i < 3; i += 1) rateLimited('user:victim', 3, LONG, at);
  assert.equal(rateLimited('user:victim', 3, LONG, at), true);
  const before = retryAfterSeconds('user:victim', at);

  // An unauthenticated attacker burns far more distinct IP keys than the pool cap.
  for (let i = 0; i < MAX_KEYS * 2; i += 1) {
    rateLimitedUntrusted(`ip:203.0.113.${i}`, 1, LONG, at);
  }
  assert.ok(poolSizes().untrusted <= MAX_KEYS, 'untrusted pool stays capped');
  assert.equal(poolSizes().privileged, 1, 'privileged pool untouched by the ip flood');

  // The point: the victim is still blocked and still has their original window.
  assert.equal(rateLimited('user:victim', 3, LONG, at), true, 'ip churn must not reset the block');
  assert.equal(retryAfterSeconds('user:victim', at), before, 'window unchanged');
});

test('window expiry via the injected clock lets the same key through', () => {
  const start = 10_000;
  assert.equal(rateLimited('user:a', 2, 1_000, start), false);
  assert.equal(rateLimited('user:a', 2, 1_000, start + 500), false);
  assert.equal(rateLimited('user:a', 2, 1_000, start + 900), true);
  assert.equal(rateLimited('user:a', 2, 1_000, start + 1_001), false, 'a fresh window starts over');
});

test('eviction at the cap is LRU: a recently accessed key survives, a cold one is dropped', () => {
  const at = 1_000;
  // Fill exactly to the cap; user:1 is the oldest.
  for (let i = 1; i <= MAX_KEYS; i += 1) rateLimited(`user:${i}`, 5, LONG, at);
  // Touch the oldest so it becomes the most recent.
  rateLimited('user:1', 5, LONG, at);
  // One more key forces a single eviction. Nothing is expired, so the sweep
  // reclaims nothing and the LRU order decides.
  rateLimited(`user:${MAX_KEYS + 1}`, 5, LONG, at);

  assert.equal(retryAfterSeconds('user:1', at), Math.ceil(LONG / 1000), 'the touched key survived');
  assert.equal(retryAfterSeconds('user:2', at), 1, 'the cold neighbour was the one evicted');
});

test('the privileged pool refuses an ip: key instead of trusting it', () => {
  assert.throws(() => rateLimited('ip:203.0.113.9', 5, LONG), /rateLimitedUntrusted/, 'unauthenticated traffic must not enter the user pool');
  assert.throws(() => rateLimitedUntrusted('user:a', 5, LONG), /ip:/, 'and the untrusted pool is ip-only');
});

test('the client key is the trusted hop at the END of the chain, not the first', () => {
  // A client sends a fake hop; the proxy appends the address it actually saw.
  const spoofed = new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' });
  assert.equal(clientKey(spoofed, '127.0.0.1'), '203.0.113.7', 'hop count 1 = the last entry');

  const twoProxies = new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 10.0.0.9' });
  assert.equal(clientKey(twoProxies, '127.0.0.1', 2), '203.0.113.7', 'hop count 2 walks in one more');
  assert.equal(clientKey(twoProxies, '127.0.0.1', 1), '10.0.0.9');
});

test('a rotating X-Forwarded-For cannot buy fresh buckets', () => {
  const at = 1_000;
  // The proxy always appends the real address; only the spoofed prefix changes.
  for (let i = 0; i < 12; i += 1) {
    const key = `ip:${clientKey(new Headers({ 'x-forwarded-for': `10.9.9.${i}, 203.0.113.7` }), '127.0.0.1')}`;
    rateLimitedUntrusted(key, 10, LONG, at);
  }
  const key = `ip:${clientKey(new Headers({ 'x-forwarded-for': '10.9.9.99, 203.0.113.7' }), '127.0.0.1')}`;
  assert.equal(rateLimitedUntrusted(key, 10, LONG, at), true, 'all twelve landed in one bucket');
});

test('direct clients without proxy headers get their own socket bucket', () => {
  assert.equal(clientKey(new Headers(), '10.0.0.1'), '10.0.0.1');
  assert.equal(clientKey(new Headers(), '10.0.0.2'), '10.0.0.2');
  assert.notEqual(clientKey(new Headers(), '10.0.0.1'), clientKey(new Headers(), '10.0.0.2'), 'never one shared unknown');

  const at = 1_000;
  for (let i = 0; i < 10; i += 1) rateLimitedUntrusted('ip:10.0.0.1', 10, LONG, at);
  assert.equal(rateLimitedUntrusted('ip:10.0.0.1', 10, LONG, at), true, 'the first client is over budget');
  assert.equal(rateLimitedUntrusted('ip:10.0.0.2', 10, LONG, at), false, 'and the second is unaffected');
});

test('x-real-ip is the fallback when the chain is absent', () => {
  assert.equal(clientKey(new Headers({ 'x-real-ip': '203.0.113.11' }), '127.0.0.1'), '203.0.113.11');
});

test('TRUSTED_PROXY_HOPS=0 ignores the header and uses the socket', () => {
  const headers = new Headers({ 'x-forwarded-for': '1.2.3.4' });
  assert.equal(clientKey(headers, '10.0.0.5', 0), '10.0.0.5', 'a direct deployment cannot be spoofed at all');
  assert.equal(trustedProxyHops('0'), 0);
  assert.equal(trustedProxyHops(undefined), 1);
  assert.equal(trustedProxyHops('nonsense'), 1, 'a bad value falls back, never to 0');
  assert.equal(trustedProxyHops('-1'), 1);
  assert.equal(trustedProxyHops('99'), 1);
});
