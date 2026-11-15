/**
 * SERVER-ONLY. Fixed-window rate limiter, in memory. Process-local: a restart
 * clears every counter. That is the intended ceiling — one process, one host, so
 * no Redis and no dependency. Add shared state only if this ever runs
 * multi-process.
 *
 * Two pools, never mixed:
 *   rateLimited(key, ...)          -> authenticated keys, `user:` / `bot:`
 *   rateLimitedUntrusted(key, ...) -> pre-auth keys, `ip:`
 * An attacker can mint IP keys without logging in, so untrusted traffic gets its
 * own Map and its own cap. Sharing one Map would let `ip:*` churn evict — or
 * reset — a real user's bucket, which turns a flood into a free way to clear a
 * rate limit.
 *
 * Every pool is capped at MAX_KEYS and evicts least-recently-used, so a flood of
 * distinct keys cannot grow the process without bound.
 *
 * `ponytail:` state is per process and per key, which stops a script but not a
 * botnet on distinct addresses. Move to a shared store when this runs on more
 * than one process; add a reputation feed when a botnet is the actual threat.
 */

type Bucket = { count: number; resetAt: number };

const privilegedBuckets = new Map<string, Bucket>();
const untrustedBuckets = new Map<string, Bucket>();

/** Per-pool key cap. A flood of distinct keys must not grow the process unbounded. */
export const MAX_KEYS = 4096;

/**
 * How many proxies sit in front of this server. Traefik/Apache/nginx APPEND the
 * address they saw, so the trustworthy hop is counted from the END of
 * `x-forwarded-for`, never from the start: a client that sends
 * `X-Forwarded-For: 1.2.3.4` gets its real address appended after it, and reading
 * the first hop would hand the caller a free, self-chosen bucket.
 *
 * Default 1 = exactly one trusted proxy. Behind two, set TRUSTED_PROXY_HOPS=2 or
 * every caller looks like the inner proxy. `0` ignores the header entirely, which
 * is right when the server binds a public address with nothing in front.
 */
export function trustedProxyHops(raw = process.env.TRUSTED_PROXY_HOPS): number {
  const n = Number(raw ?? '1');
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

/**
 * Identity for the limiter: the client hop `trustedProxyHops()` from the end of
 * `x-forwarded-for`, else `x-real-ip`, else the socket address.
 *
 * The socket is the last resort and it is NOT shared: two direct clients on
 * different addresses stay in different buckets. Only a server with no address at
 * all (a test harness) answers 'unknown', and that one bucket is deliberately
 * shared — it is a bug to run that way, not a deployment.
 */
export function clientKey(headers: Headers, remote?: string, hops = trustedProxyHops()): string {
  if (hops > 0) {
    const chain = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    // chain[length - hops] is the address the outermost trusted proxy saw.
    const hop = chain[chain.length - hops];
    if (hop) return hop;
    const realIp = headers.get('x-real-ip')?.trim();
    if (realIp) return realIp;
  }
  return remote || 'unknown';
}

function limit(buckets: Map<string, Bucket>, key: string, max: number, windowMs: number, now: number): boolean {
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
 * Authenticated / session / token-bearing limits. Key with `user:{id}` or
 * `bot:{id}`. Returns true when the caller is over budget and should get a 429.
 * Throws on an `ip:` key: that traffic is unauthenticated, and letting it into
 * this pool would let IP churn evict a real user's bucket.
 */
export function rateLimited(key: string, max: number, windowMs: number, now: number = Date.now()): boolean {
  if (key.startsWith('ip:')) throw new Error('rateLimited() refuses ip: keys; use rateLimitedUntrusted()');
  return limit(privilegedBuckets, key, max, windowMs, now);
}

/**
 * Public / pre-auth limits. Key with `ip:*`.
 * Physically separate pool, so spoofed-IP churn cannot evict or reset a blocked
 * credential bucket.
 */
export function rateLimitedUntrusted(key: string, max: number, windowMs: number, now: number = Date.now()): boolean {
  if (!key.startsWith('ip:')) throw new Error('rateLimitedUntrusted() requires an ip: key');
  return limit(untrustedBuckets, key, max, windowMs, now);
}

/**
 * Whole seconds until the key's window resets, at least 1 — for a `Retry-After`
 * header. A key only ever lives in one pool (the keys are namespaced `user:` /
 * `bot:` / `ip:`), so both are checked rather than making the caller pass a pool.
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
