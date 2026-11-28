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
 *   - only the three content types a **form** can send are checked:
 *     `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`.
 *     Those are the requests a cross-site page can make with the victim's cookie
 *     attached and no preflight. A JSON or `application/octet-stream` body needs a
 *     preflight this server never grants, so it cannot be a CSRF vector.
 *   - for those, `Origin` must be present AND allowed. Allowed = this app's own
 *     origin, this server's origin, and any origin the operator listed in
 *     `EMBED_ALLOWED_ORIGINS` (the console framing the app).
 *   - any request carrying an `Authorization` header is exempt: it authenticates
 *     with a bearer token, not the session cookie, so there is no cookie to ride.
 *
 * The content-type scope is not an optimisation. The first version of this module
 * required `Origin` on *every* unsafe request, and that refused every non-browser
 * client the repo ships: `bash scripts/sign-in-link.sh` (the documented fallback
 * sign-in, owner key + JSON), `gb login`, and `node tests/e2e.mjs` all answered
 * `403 cross-site request refused`. None of them was a CSRF victim — none sends a
 * victim's cookie, and none can be conjured from another page — so the refusal was a
 * bug in this gate, not a defence. Scoping to form content types keeps the browser
 * case covered and lets the operator tools work.
 *
 * Measured in a real browser, not assumed: a page on `localhost:9999` aimed four
 * cross-site writes at `127.0.0.1:9998`, and every one of them arrived as a form type.
 * `fetch(..., {mode:'no-cors', headers:{'content-type':'application/json'}})` and
 * `sendBeacon(url, new Blob([json], {type:'application/json'}))` both landed as
 * `text/plain;charset=UTF-8`; a form submit landed as
 * `application/x-www-form-urlencoded`; the blob beacon carried no content-type at all,
 * which `isFormContentType(undefined) === true` treats as a form. So the exempt branch
 * is unreachable from a cross-site page — the browser downgrades the header, and the
 * server never grants the preflight that would stop it doing so.
 *
 * Pure and import-free so `node --test` loads it with native type-stripping.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The three content types an HTML form can send. Everything else needs a CORS
 * preflight, and this server grants none, so a cross-site page cannot send it at all.
 */
const FORM_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
];

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
  /** The request's `Content-Type` header. Only form types are checked at all. */
  contentType?: string | null;
  /** Origins that are always acceptable: this app and this server. */
  ownOrigins: string[];
  /** Extra origins allowed to drive the app, e.g. a console embedding it. */
  allowedOrigins?: string[];
  /** The request's `Authorization` header, or undefined. Presence exempts the call. */
  authorization?: string | null;
}

export type OriginVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'foreign' };

/** True for the content types an HTML form can send, i.e. the ones with no preflight. */
export function isFormContentType(raw: string | null | undefined): boolean {
  // A missing Content-Type is not exempt either: a form POST always carries one, and
  // treating absence as safe would turn the one case we cannot classify into a bypass.
  const value = (raw ?? '').split(';')[0].trim().toLowerCase();
  return !value || FORM_CONTENT_TYPES.includes(value);
}

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
  // Same exemption by credential rather than path: there is no session cookie to ride
  // on, so this request is not a CSRF attempt whatever its Origin says.
  if ((input.authorization ?? '').trim()) return { ok: true };
  // A preflighted body cannot come from a cross-site page. Checked after the two
  // exemptions above so a JSON call with a bearer token stays exempt anyway.
  if (!isFormContentType(input.contentType)) return { ok: true };

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
