// SERVER-ONLY. Small fixed-window rate limiter, in memory. Process-local: a
// restart clears every counter. That is the intended ceiling — one process, one
// host, so no Redis and no dependency. Add shared state only if this ever runs
// multi-process.
//
// Two pools, never mixed:
//   rateLimited(key, ...)          -> authenticated keys, `user:{id}`
//   rateLimitedUntrusted(key, ...) -> pre-auth keys, `ip:*`
// An attacker can mint IP keys without logging in (and proxy IP attribution is
// best-effort), so untrusted traffic gets its own Map and its own cap. Sharing
// one Map would let `ip:*` churn evict — or reset — a real user's bucket, which
// turns a flood into a free way to clear a rate limit.
type Bucket = { count: number; resetAt: number };

const privilegedBuckets = new Map<string, Bucket>();
const untrustedBuckets = new Map<string, Bucket>();

/** Per-pool key cap. A flood of distinct keys must not grow the process unbounded. */
export const MAX_KEYS = 4096;

function limit(
  buckets: Map<string, Bucket>,
  key: string,
  max: number,
  windowMs: number,
  now: number
): boolean {
  const b = buckets.get(key);

  if (b && now <= b.resetAt) {
    // LRU, not FIFO: re-inserting on access keeps insertion order pointing at
    // recency, so an overflow evicts a genuinely cold key rather than an active
    // bucket that merely happens to be older. A rejected request still counts as
    // an access — the bucket is hot either way.
    buckets.delete(key);
    buckets.set(key, b);
    if (b.count >= max) return true;
    b.count += 1;
    return false;
  }

  if (b) buckets.delete(key);

  if (buckets.size >= MAX_KEYS) {
    // Reclaim expired buckets first; only then evict the coldest live one.
    for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
    while (buckets.size >= MAX_KEYS) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  buckets.set(key, { count: 1, resetAt: now + windowMs });
  return false;
}

/**
 * Authenticated/session/owner-action limits. Key with `user:{id}`.
 * Returns true when the caller is over budget and should get a 429.
 * Never pass a raw unauthenticated IP key here — use rateLimitedUntrusted.
 */
export function rateLimited(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now()
): boolean {
  return limit(privilegedBuckets, key, max, windowMs, now);
}

/**
 * Public/pre-auth limits. Key with `ip:*`.
 * Physically separate pool, so spoofed-IP churn cannot evict or reset a blocked
 * credential bucket.
 */
export function rateLimitedUntrusted(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now()
): boolean {
  return limit(untrustedBuckets, key, max, windowMs, now);
}

/**
 * Whole seconds until the key's window resets, at least 1 — for a `Retry-After`
 * header. A key only ever lives in one pool (the keys are namespaced `user:` /
 * `ip:`), so both are checked rather than making the caller pass a pool.
 */
export function retryAfterSeconds(key: string, now: number = Date.now()): number {
  const b = privilegedBuckets.get(key) ?? untrustedBuckets.get(key);
  if (!b || now > b.resetAt) return 1;
  return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
}

/** Live bucket counts per pool. Diagnostics only. */
export function poolSizes(): { privileged: number; untrusted: number } {
  return { privileged: privilegedBuckets.size, untrusted: untrustedBuckets.size };
}

/** Clear both pools. Tests only. */
export function resetRateLimits(): void {
  privilegedBuckets.clear();
  untrustedBuckets.clear();
}
