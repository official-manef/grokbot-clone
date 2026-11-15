/**
 * Fixed-window limiter, no network, no sleeps: every case injects the clock.
 *
 * The load-bearing assertions are the two-pool one (an `ip:*` flood must not
 * rescue a blocked `user:*` bucket) and the LRU one (overflow must drop a cold
 * key, not the active one that merely happens to be older). FIFO passes the
 * first fill and fails the second.
 *
 *   node --test server/test/rate-limit.test.mjs
 */
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  MAX_KEYS,
  poolSizes,
  rateLimited,
  rateLimitedUntrusted,
  resetRateLimits,
  retryAfterSeconds,
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
  assert.equal(rateLimited('user:a', 2, 1_000, start), false);
  assert.equal(rateLimited('user:a', 2, 1_000, start), true);

  // resetAt = start + 1000, and the window is inclusive of its last ms.
  assert.equal(rateLimited('user:a', 2, 1_000, start + 999), true, 'still inside the window');
  assert.equal(rateLimited('user:a', 2, 1_000, start + 1_000), true, 'last ms still counts');
  assert.equal(rateLimited('user:a', 2, 1_000, start + 1_001), false, 'one ms past reset is a fresh window');
  assert.equal(rateLimited('user:a', 2, 1_000, start + 1_001), false, 'fresh window has a full budget');
  assert.equal(rateLimited('user:a', 2, 1_000, start + 1_001), true);
});

test('retryAfterSeconds counts down and never reports 0', () => {
  const start = 5_000;
  const windowMs = 10_000;
  rateLimitedUntrusted('ip:198.51.100.7', 1, windowMs, start);
  const resetAt = start + windowMs;

  assert.equal(retryAfterSeconds('ip:198.51.100.7', start), 10, 'whole window remaining');
  assert.equal(retryAfterSeconds('ip:198.51.100.7', start + 5_000), 5);
  assert.equal(retryAfterSeconds('ip:198.51.100.7', resetAt - 1), 1, 'sub-second remainder rounds up to 1');
  assert.equal(retryAfterSeconds('ip:198.51.100.7', resetAt), 1, 'expired or not, never 0');
  assert.equal(retryAfterSeconds('ip:198.51.100.7', resetAt + 60_000), 1);
  assert.equal(retryAfterSeconds('ip:unknown', start), 1, 'unknown key still yields a usable header');

  const counts = [start, start + 1, start + 9_999, resetAt, resetAt + 1].map((t) =>
    retryAfterSeconds('ip:198.51.100.7', t)
  );
  assert.ok(counts.every((s) => s >= 1 && Number.isInteger(s)), `all whole and >= 1: ${counts}`);
  assert.equal(counts[0] > counts[1] || counts[0] === counts[1], true);
});

test('eviction at the cap is LRU: a recently accessed key survives, a cold one is dropped', () => {
  const at = 1_000;

  // Fill one pool to exactly the cap, in order k0..k{MAX_KEYS-1}.
  for (let i = 0; i < MAX_KEYS; i += 1) {
    assert.equal(rateLimited(`user:${i}`, 5, LONG, at), false);
  }
  assert.equal(poolSizes().privileged, MAX_KEYS);

  // Touch the oldest key. Under FIFO it is still the next to go; under LRU this
  // access makes it the most recent.
  assert.equal(rateLimited('user:0', 5, LONG, at), false);

  // One more key forces a single eviction. Nothing is expired, so the sweep
  // reclaims nothing and recency decides.
  assert.equal(rateLimited(`user:${MAX_KEYS}`, 5, LONG, at), false);

  assert.equal(poolSizes().privileged, MAX_KEYS, 'cap holds at MAX_KEYS');

  assert.ok(retryAfterSeconds('user:0', at) > 1, 'recently accessed key survived');
  assert.equal(rateLimited('user:0', 5, LONG, at), false, 'and kept its counter, so the bucket is really the same one');
  assert.equal(retryAfterSeconds('user:1', at), 1, 'the cold neighbour was the one evicted');

  // The cap must hold on untrusted too, and both pools must stay separate.
  for (let i = 0; i < MAX_KEYS + 10; i += 1) rateLimitedUntrusted(`ip:${i}`, 5, LONG, at);
  assert.equal(poolSizes().untrusted, MAX_KEYS);
  assert.equal(poolSizes().privileged, MAX_KEYS, 'filling untrusted never touched privileged');
});
