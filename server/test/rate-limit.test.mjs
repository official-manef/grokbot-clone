/**
 * The sign-in routes have a ceiling, and the ceiling belongs to one client.
 *
 * The failure this guards is not "the counter is off by one" but three real
 * ones: no limit at all (the state before this test), one shared counter that
 * lets a single address lock out everyone, and a window that never resets, so a
 * legitimate retry after five minutes is still refused.
 *
 *   node --test server/test/rate-limit.test.mjs
 *
 * (Imports TypeScript source; Node >=22.18 strips types natively. Older Node:
 *  run with `node --import tsx --test ...`.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientKey, hit, reset } from '../src/lib/rate-limit.ts';

test('allows exactly `limit` calls, then refuses', () => {
  reset();
  for (let i = 1; i <= 5; i++) assert.equal(hit('dev', 'a', 5, 60_000).ok, true, `call ${i}`);
  const sixth = hit('dev', 'a', 5, 60_000);
  assert.equal(sixth.ok, false, 'the sixth call must be refused');
  assert.ok(sixth.retryAfter >= 1 && sixth.retryAfter <= 60, `retryAfter within the window, got ${sixth.retryAfter}`);
});

test('the window resets, so a retry later is allowed again', () => {
  reset();
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) hit('link', 'b', 3, 60_000, t);
  assert.equal(hit('link', 'b', 3, 60_000, t + 1).ok, false);
  assert.equal(hit('link', 'b', 3, 60_000, t + 60_001).ok, true, 'a fresh window starts over');
});

test('one client cannot exhaust another client\'s budget', () => {
  reset();
  for (let i = 0; i < 4; i++) hit('dev', 'noisy', 3, 60_000);
  assert.equal(hit('dev', 'noisy', 3, 60_000).ok, false);
  assert.equal(hit('dev', 'quiet', 3, 60_000).ok, true, 'separate bucket per client');
});

test('buckets do not share a counter', () => {
  reset();
  for (let i = 0; i < 3; i++) hit('dev', 'c', 2, 60_000);
  assert.equal(hit('owner', 'c', 2, 60_000).ok, true, 'a different route has its own budget');
});

test('the client key prefers the proxy header, then the socket', () => {
  assert.equal(clientKey(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), '127.0.0.1'), '203.0.113.9');
  assert.equal(clientKey(new Headers(), '127.0.0.1'), '127.0.0.1');
  assert.equal(clientKey(new Headers(), undefined), 'unknown', 'never an empty string that collides');
});
