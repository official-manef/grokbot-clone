/**
 * CSRF defence for a cookie that can now be sent cross-site.
 *
 * With `SameSite=Lax` the browser refuses to attach the session cookie to a
 * cross-site POST, so that setting WAS the CSRF defence. A deployment that embeds
 * this app in another site's frame needs `SameSite=None`, which removes exactly
 * that. This module puts a defence back: a state-changing request must carry an
 * `Origin` we expect.
 *
 * Rules:
 *   - only unsafe methods are checked; GET/HEAD/OPTIONS change nothing here.
 *   - `Origin` must be present AND allowed. A missing Origin on a POST is refused
 *     rather than waved through: every browser sends it, so its absence means a
 *     non-browser client, which is not what this check is for.
 *   - allowed = this app's own origin, this server's origin, and any origin the
 *     operator listed in `EMBED_ALLOWED_ORIGINS` (the console framing the app).
 *   - `/mcp/*` is exempt: those calls authenticate with a bearer token, not the
 *     session cookie, so a cross-site form cannot reach them with credentials.
 *
 * Pure and import-free so `node --test` loads it with native type-stripping.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Parse an origin list; an entry that is not a URL is dropped, not guessed at. */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        const url = new URL(value);
        // `https://host/path` is normalised to its origin rather than rejected:
        // an operator writing a path is a typo, not a request for looser policy.
        return url.origin === 'null' ? [] : [url.origin];
      } catch {
        return [];
      }
    });
}

export interface OriginCheckInput {
  method: string;
  path: string;
  /** The request's `Origin` header, or undefined when it sent none. */
  origin?: string | null;
  /** Origins that are always acceptable: this app and this server. */
  ownOrigins: string[];
  /** Extra origins allowed to drive the app, e.g. a console embedding it. */
  allowedOrigins?: string[];
}

export type OriginVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'foreign' };

/**
 * Decide whether a state-changing request came from somewhere we expect.
 *
 * `reason` is for the operator's log; the client gets a plain 403 that says nothing
 * about which list refused.
 */
export function checkOrigin(input: OriginCheckInput): OriginVerdict {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  // Bearer-token calls, not cookie calls: a cross-site form cannot supply one.
  if (input.path.startsWith('/mcp/') || input.path === '/mcp') return { ok: true };

  const given = (input.origin ?? '').trim();
  if (!given) return { ok: false, reason: 'missing' };

  let origin: string;
  try {
    const url = new URL(given);
    // A sandboxed frame sends the literal string "null". That is not an origin we
    // can verify, so it is foreign rather than absent.
    origin = url.origin;
  } catch {
    return { ok: false, reason: 'foreign' };
  }
  if (origin === 'null') return { ok: false, reason: 'foreign' };

  const allowed = new Set([...input.ownOrigins, ...(input.allowedOrigins ?? [])].filter(Boolean));
  return allowed.has(origin) ? { ok: true } : { ok: false, reason: 'foreign' };
}
