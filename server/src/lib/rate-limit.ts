/**
 * A fixed-window counter, in memory, per (bucket, client).
 *
 * It exists because the sign-in routes had no ceiling at all: an unauthenticated
 * endpoint that reads the database and sets a cookie is a brute-force surface,
 * and DEV_LOGIN=1 turns it into "become any email you like", quickly.
 *
 * Deliberate limits: state is per process, so a restart forgives everyone, and
 * it is per IP as the proxy reports it. That is enough to stop a script; it is
 * not a defence against a botnet. `ponytail:` move to a shared store (Redis) if
 * this ever runs as more than one process.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();
let lastSweep = 0;

/**
 * Identity for the limiter. Behind a proxy every request arrives from the proxy,
 * so the left-most X-Forwarded-For hop is the client; without one, the socket
 * address. An unknown value is its own bucket, never a shared one.
 */
export function clientKey(headers: Headers, remote?: string): string {
  const fwd = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || remote || 'unknown';
}

export interface LimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets; 0 when the call is allowed. */
  retryAfter: number;
}

/** Count one hit for `bucket`+`client`. `limit` hits per `windowMs`. */
export function hit(bucket: string, client: string, limit: number, windowMs: number, now = Date.now()): LimitResult {
  // Sweep expired windows occasionally so a long-lived process does not grow.
  if (now - lastSweep > 60_000) {
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    lastSweep = now;
  }
  const key = `${bucket}\u0000${client}`;
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }
  w.count += 1;
  if (w.count > limit) return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  return { ok: true, remaining: limit - w.count, retryAfter: 0 };
}

/** Tests only: forget every window. */
export function reset(): void {
  windows.clear();
  lastSweep = 0;
}
