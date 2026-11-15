/**
 * Per-user token + request budget: the cost control that fans made necessary.
 *
 * Fans can now self-register, so the model API key is reachable by anyone with a
 * Google account. A per-minute request limit does not cover that (one chat turn can
 * be 100k tokens), so the unit here is tokens per UTC day, per user, plus a plain
 * request count as a cheap second wall.
 *
 * This module is the *decision* logic only. The integrator calls:
 *   - `checkQuota(...)` before a model turn — read-only, returns allow/deny;
 *   - `bumpUsage(...)` after it — one upsert on `usage_daily`.
 *
 * Nothing here imports `env.ts` or `db.ts`, so `node --test` loads it with native
 * type-stripping, no network, and no need for SESSION_SECRET/XAI_API_KEY. Config is
 * read lazily from `process.env`, same as `lib/workos.ts`, which also lets a test
 * change the limits without a child process.
 *
 * Fail-closed rule: a *missing* row means we have never seen this user today, so
 * allow. A row we cannot *read* means we cannot know the spend, so deny. A quota
 * read error must never silently grant unlimited spend.
 */

import type { Audience } from './email-allowlist.js';

/**
 * The slice of `better-sqlite3` this module uses. Structural, so the test can pass a
 * stub that throws (the read-error case) and production passes the real `db`.
 */
export type DbLike = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
};

/**
 * One row per user per UTC day. `day` is 'YYYY-MM-DD' so the day boundary is a string
 * comparison and the row is self-describing in the DB (no timestamp arithmetic).
 *
 * Mirrors Nakama's `llm_usage_stats` (packages/db/sql/schema.sql) minus the org/model
 * breakdown and the derived `estimated_cost_usd`: a per-user daily wall needs three
 * counters, and cost is a function of the model price, which is not ours to store.
 * No `REFERENCES users(id)`: a usage row must survive a deleted user (that spend still
 * happened), and it is written after the fact, not on the user's behalf.
 *
 * Exported so `db.ts` creates the table from this one string and the tests cannot
 * drift from production schema.
 */
export const USAGE_DAILY_DDL = `
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`;

/**
 * ponytail: these four numbers are PROVISIONAL, not a price model. They are a wall
 * tall enough that no single fan account can drain the key overnight, not a claim
 * about what a fan *should* get. Rahman sets the real ceiling per env:
 *   GROKBOT_QUOTA_FAN_TOKENS_PER_DAY,  GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY,
 *   GROKBOT_QUOTA_STAFF_TOKENS_PER_DAY, GROKBOT_QUOTA_STAFF_REQUESTS_PER_DAY
 * Fan is deliberately tight; staff is loose enough that a working artist never meets
 * it. Both staff roles (artist, management) share the same ceiling on purpose: nothing
 * observed so far justifies splitting them, and an invented split would be noise.
 *
 * The token counter is input+output combined, so a 100k-token *answer* cannot slip
 * past an input-only cap.
 */
const FAN_TOKENS_PER_DAY = 50_000;
const FAN_REQUESTS_PER_DAY = 200;
const STAFF_TOKENS_PER_DAY = 2_000_000;
const STAFF_REQUESTS_PER_DAY = 2_000;

export type Quota = {
  /** Total tokens (input + output) allowed in one UTC day. */
  dailyTokens: number;
  /** Model turns allowed in one UTC day. */
  dailyRequests: number;
};

/** Why a turn was refused. `unavailable` = we could not read the spend, so we deny. */
export type QuotaReason = 'tokens' | 'requests' | 'unavailable';

export type QuotaCheck = {
  allowed: boolean;
  reason?: QuotaReason;
  remainingTokens: number;
  remainingRequests: number;
};

/** A non-negative integer from env, or the fallback. Bad values fall back, never to NaN. */
function limit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** UTC day key, 'YYYY-MM-DD'. `now` is milliseconds, injectable for tests. */
export function dayOf(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The budget for one user. An unknown/absent audience is treated as a fan: a caller
 * that lost the classification gets the tight wall, not the loose one.
 */
export function quotaFor(audience: Audience | null | undefined, _role: string | null = null): Quota {
  if (audience === 'staff') {
    return {
      dailyTokens: limit('GROKBOT_QUOTA_STAFF_TOKENS_PER_DAY', STAFF_TOKENS_PER_DAY),
      dailyRequests: limit('GROKBOT_QUOTA_STAFF_REQUESTS_PER_DAY', STAFF_REQUESTS_PER_DAY),
    };
  }
  return {
    dailyTokens: limit('GROKBOT_QUOTA_FAN_TOKENS_PER_DAY', FAN_TOKENS_PER_DAY),
    dailyRequests: limit('GROKBOT_QUOTA_FAN_REQUESTS_PER_DAY', FAN_REQUESTS_PER_DAY),
  };
}

type UsageRow = { requests: number; input_tokens: number; output_tokens: number };

function readRow(db: DbLike, userId: string, day: string): UsageRow | null {
  const row = db
    .prepare('SELECT requests, input_tokens, output_tokens FROM usage_daily WHERE user_id = ? AND day = ?')
    .get(userId, day) as UsageRow | undefined;
  return row ?? null;
}

/**
 * Read-only: may this user start another turn? Call before spending tokens.
 *
 * - no row today  -> allowed (new user; nothing spent yet)
 * - row unreadable -> denied with `reason: 'unavailable'`
 */
export function checkQuota(
  db: DbLike,
  userId: string,
  audience: Audience | null | undefined,
  role: string | null = null,
  now: number = Date.now(),
): QuotaCheck {
  const quota = quotaFor(audience, role);

  let row: UsageRow | null;
  try {
    row = readRow(db, userId, dayOf(now));
  } catch {
    // We cannot know the spend, so we cannot allow it.
    return { allowed: false, reason: 'unavailable', remainingTokens: 0, remainingRequests: 0 };
  }

  const used = row ? row.input_tokens + row.output_tokens : 0;
  const requests = row ? row.requests : 0;
  const remainingTokens = Math.max(0, quota.dailyTokens - used);
  const remainingRequests = Math.max(0, quota.dailyRequests - requests);

  if (used >= quota.dailyTokens) return { allowed: false, reason: 'tokens', remainingTokens: 0, remainingRequests };
  if (requests >= quota.dailyRequests) return { allowed: false, reason: 'requests', remainingTokens, remainingRequests: 0 };
  return { allowed: true, remainingTokens, remainingRequests };
}

/** A token count we are willing to write: non-negative integer, bad input becomes 0. */
const count = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Record one finished model turn. Single upsert, so it is safe to call on every turn
 * (and inside the same statement the counters cannot interleave).
 *
 * `now` is injectable for the day-boundary test; production omits it.
 */
export function bumpUsage(
  db: DbLike,
  userId: string,
  usage: { inputTokens?: number; outputTokens?: number },
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO usage_daily (user_id, day, requests, input_tokens, output_tokens)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET
       requests = requests + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  ).run(userId, dayOf(now), count(usage.inputTokens), count(usage.outputTokens));
}
