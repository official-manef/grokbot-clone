/**
 * The fan budget: the only thing standing between one self-registered Google account
 * and the whole XAI_API_KEY.
 *
 * What is actually tested here is the *decision* — allowed, and if not, why — because
 * a limit that quietly allows on error is worse than no limit at all: it looks like
 * protection while spending. So the last case feeds `checkQuota` a db that throws and
 * asserts a deny.
 *
 *   node --test server/test/usage-quota.test.mjs
 *
 * The DB is a throwaway file under os.tmpdir(), never `data/grokbot.db`: this branch
 * runs production in its worktree. Env limits are set per test and restored, because
 * `lib/usage-quota.ts` reads `process.env` lazily (same trick as `lib/workos.ts`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { bumpUsage, checkQuota, quotaFor, dayOf, USAGE_DAILY_DDL } from '../src/lib/usage-quota.ts';

const LIMIT_VARS = [
  'GROKBOT_QUOTA_FAN_TOKENS_PER_DAY',
  'GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY',
  'GROKBOT_QUOTA_STAFF_TOKENS_PER_DAY',
  'GROKBOT_QUOTA_STAFF_REQUESTS_PER_DAY',
];

/** A fresh temp DB with the real table, plus cleanup of the file and its -wal/-shm. */
function tempDb(t) {
  const file = path.join(os.tmpdir(), `grokbot-usage-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(file);
  db.exec(USAGE_DAILY_DDL);
  t.after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  });
  return db;
}

/** Pin the limits for one test; restored afterwards so tests cannot leak into each other. */
function withLimits(t, limits) {
  const saved = Object.fromEntries(LIMIT_VARS.map((v) => [v, process.env[v]]));
  for (const [name, value] of Object.entries(limits)) process.env[name] = String(value);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

// A fixed midday UTC so nothing depends on the machine's clock or timezone.
const DAY = Date.UTC(2026, 0, 15, 12, 0, 0);
const NEXT_DAY = DAY + 24 * 60 * 60 * 1000;

test('a user under budget is allowed, and the remaining budget is reported', (t) => {
  const db = tempDb(t);
  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: 1000, GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY: 10 });

  bumpUsage(db, 'fan_1', { inputTokens: 100, outputTokens: 50 }, DAY);

  const check = checkQuota(db, 'fan_1', 'fan', null, DAY);
  assert.equal(check.allowed, true);
  assert.equal(check.reason, undefined);
  assert.equal(check.remainingTokens, 850, 'input+output both count');
  assert.equal(check.remainingRequests, 9);
});

test('a user who has never spent today is allowed (new-user path, no row)', (t) => {
  const db = tempDb(t);
  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: 1000, GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY: 10 });

  const check = checkQuota(db, 'brand_new', 'fan', null, DAY);
  assert.equal(check.allowed, true);
  assert.equal(check.remainingTokens, 1000);
  assert.equal(check.remainingRequests, 10);
});

test('at the token ceiling the turn is denied with reason tokens', (t) => {
  const db = tempDb(t);
  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: 1000, GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY: 10 });

  // Exactly at the ceiling must deny: the *next* turn is what would overspend.
  bumpUsage(db, 'fan_1', { inputTokens: 900, outputTokens: 100 }, DAY);

  const check = checkQuota(db, 'fan_1', 'fan', null, DAY);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'tokens');
  assert.equal(check.remainingTokens, 0);
});

test('one 100k-token answer blows past an input-only cap: output counts too', (t) => {
  const db = tempDb(t);
  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: 50_000, GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY: 200 });

  // Nothing spent on input, a big answer: the whole point of the token wall.
  bumpUsage(db, 'fan_1', { inputTokens: 10, outputTokens: 100_000 }, DAY);

  assert.equal(checkQuota(db, 'fan_1', 'fan', null, DAY).reason, 'tokens');
});

test('at the request ceiling the turn is denied with reason requests', (t) => {
  const db = tempDb(t);
  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: 1_000_000, GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY: 3 });

  for (let i = 0; i < 3; i++) bumpUsage(db, 'fan_1', { inputTokens: 1, outputTokens: 1 }, DAY);

  const check = checkQuota(db, 'fan_1', 'fan', null, DAY);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'requests', 'tokens are plentiful, the request wall is what stopped it');
  assert.equal(check.remainingRequests, 0);
});

test('staff has a strictly larger budget than a fan (both walls)', () => {
  const fan = quotaFor('fan', null);
  const artist = quotaFor('staff', 'artist');
  const management = quotaFor('staff', 'management');

  assert.ok(artist.dailyTokens > fan.dailyTokens, 'staff tokens must exceed fan tokens');
  assert.ok(artist.dailyRequests > fan.dailyRequests, 'staff requests must exceed fan requests');
  assert.ok(management.dailyTokens > fan.dailyTokens);
  assert.ok(management.dailyRequests > fan.dailyRequests);
});

test('an unclassified audience gets the fan wall, not the staff one', () => {
  assert.deepEqual(quotaFor(null, null), quotaFor('fan', null));
  assert.deepEqual(quotaFor(undefined, null), quotaFor('fan', null));
});

test('bumpUsage accumulates across calls in one day and starts fresh on a new day', (t) => {
  const db = tempDb(t);
  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: 10_000, GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY: 100 });

  bumpUsage(db, 'fan_1', { inputTokens: 100, outputTokens: 50 }, DAY);
  bumpUsage(db, 'fan_1', { inputTokens: 200, outputTokens: 25 }, DAY + 60_000);
  bumpUsage(db, 'fan_1', { inputTokens: 1, outputTokens: 1 }, DAY + 3_600_000);

  const row = db.prepare('SELECT requests, input_tokens, output_tokens FROM usage_daily WHERE user_id = ? AND day = ?')
    .get('fan_1', dayOf(DAY));
  assert.deepEqual({ ...row }, { requests: 3, input_tokens: 301, output_tokens: 76 });

  // Same day, still one row and still accumulating.
  assert.equal(checkQuota(db, 'fan_1', 'fan', null, DAY).remainingTokens, 10_000 - 377);

  // Crossing UTC midnight: yesterday's spend is gone from today's budget.
  const tomorrow = checkQuota(db, 'fan_1', 'fan', null, NEXT_DAY);
  assert.equal(tomorrow.allowed, true);
  assert.equal(tomorrow.remainingTokens, 10_000);
  assert.equal(tomorrow.remainingRequests, 100);
  assert.notEqual(dayOf(DAY), dayOf(NEXT_DAY));

  // And a bump after midnight lands in a second row, leaving yesterday intact.
  bumpUsage(db, 'fan_1', { inputTokens: 10, outputTokens: 0 }, NEXT_DAY);
  const days = db.prepare('SELECT day, requests FROM usage_daily WHERE user_id = ? ORDER BY day').all('fan_1');
  assert.deepEqual(days.map((r) => ({ ...r })), [
    { day: dayOf(DAY), requests: 3 },
    { day: dayOf(NEXT_DAY), requests: 1 },
  ]);
});

test('two users do not share a budget', (t) => {
  const db = tempDb(t);
  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: 1000, GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY: 2 });

  bumpUsage(db, 'fan_1', { inputTokens: 300, outputTokens: 0 }, DAY);
  bumpUsage(db, 'fan_1', { inputTokens: 300, outputTokens: 0 }, DAY);
  // fan_1 is now out of requests and halfway out of tokens.
  assert.equal(checkQuota(db, 'fan_1', 'fan', null, DAY).reason, 'requests');

  const other = checkQuota(db, 'fan_2', 'fan', null, DAY);
  assert.equal(other.allowed, true, 'a fan must not be limited by another fan');
  assert.equal(other.remainingTokens, 1000);
  assert.equal(other.remainingRequests, 2);

  // Same day, same table, different user: still independent.
  bumpUsage(db, 'fan_2', { inputTokens: 10, outputTokens: 0 }, DAY);
  assert.equal(checkQuota(db, 'fan_1', 'fan', null, DAY).remainingTokens, 400);
  assert.equal(checkQuota(db, 'fan_2', 'fan', null, DAY).remainingTokens, 990);
});

test('fail closed: a quota read that throws denies, it does not allow unlimited spend', (t) => {
  const broken = {
    prepare() {
      throw new Error('SQLITE_BUSY: database is locked');
    },
  };

  const check = checkQuota(broken, 'fan_1', 'fan', null, DAY);
  assert.equal(check.allowed, false, 'an unreadable counter must never mean "spend freely"');
  assert.equal(check.reason, 'unavailable');
  assert.equal(check.remainingTokens, 0);
  assert.equal(check.remainingRequests, 0);

  // A db whose prepare returns a getter that throws is the same path (and the one
  // a corrupted/locked row actually takes in production).
  const throwsOnRead = { prepare: () => ({ get() { throw new Error('I/O error'); }, run() {} }) };
  assert.equal(checkQuota(throwsOnRead, 'fan_1', 'staff', 'artist', DAY).allowed, false);
});

test('bad usage input is clamped, never written as NaN or negative', (t) => {
  const db = tempDb(t);
  bumpUsage(db, 'fan_1', { inputTokens: -500, outputTokens: Number.NaN }, DAY);
  bumpUsage(db, 'fan_1', {}, DAY);
  const row = db.prepare('SELECT requests, input_tokens, output_tokens FROM usage_daily WHERE user_id = ? AND day = ?')
    .get('fan_1', dayOf(DAY));
  assert.deepEqual({ ...row }, { requests: 2, input_tokens: 0, output_tokens: 0 });
});

test('an empty or junk limit env value falls back to the default, never to NaN', (t) => {
  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: '' });
  assert.equal(quotaFor('fan', null).dailyTokens, 50_000);

  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: 'not-a-number' });
  assert.equal(quotaFor('fan', null).dailyTokens, 50_000);

  withLimits(t, { GROKBOT_QUOTA_FAN_TOKENS_PER_DAY: '12345' });
  assert.equal(quotaFor('fan', null).dailyTokens, 12_345, 'a real override must actually apply');
});
