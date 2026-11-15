/**
 * Who the caller is, decided once.
 *
 * This module exists because two gates disagreed about it. The rate limiter read
 * the LAST hop of `x-forwarded-for` while the dev-login guard read the FIRST, so a
 * stranger could send `X-Forwarded-For: 127.0.0.1, <their address>` and pass the
 * loopback check that is supposed to keep credential-less sign-in local-only.
 *
 * One definition, one knob (`TRUSTED_PROXY_HOPS`), every caller. Pure and
 * import-free so `node --test` loads it with native type-stripping.
 *
 * `ponytail:` this trusts the hop count, not the proxy's identity. A deployment
 * where an untrusted party can reach the server directly (bypassing the proxy) has
 * to set TRUSTED_PROXY_HOPS=0 and let the socket decide; per-proxy allowlisting is
 * the upgrade path if that ever becomes a real requirement.
 */

/**
 * How many proxies sit in front of this server. Traefik/Apache/nginx APPEND the
 * address they saw, so the trustworthy hop is counted from the END of
 * `x-forwarded-for`, never from the start.
 *
 * Default 1 = exactly one trusted proxy. Behind two, set TRUSTED_PROXY_HOPS=2 or
 * every caller looks like the inner proxy. `0` ignores the header entirely, which
 * is right when the server binds a public address with nothing in front.
 */
export function trustedProxyHops(raw: string | undefined = process.env.TRUSTED_PROXY_HOPS): number {
  const n = Number(raw ?? '1');
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

/**
 * The caller's address: the trusted hop `hops` from the end of `x-forwarded-for`,
 * else `x-real-ip`, else the socket address.
 *
 * With no header and no proxy the socket address is used, so two direct clients
 * never share one bucket. Only a server with no address at all answers 'unknown',
 * which is a test harness, not a deployment.
 */
export function clientAddress(headers: Headers, remote?: string, hops = trustedProxyHops()): string {
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

const LOOPBACK = /^(::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/** True for a loopback literal (v4, v6, or a v4-mapped v6). */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  return LOOPBACK.test((address ?? '').trim().toLowerCase());
}

/**
 * True when the request came from this machine, for a gate that must not be
 * fooled by a header.
 *
 * Both facts have to hold:
 *
 *   1. the SOCKET peer is loopback — a public peer can never be local, whatever
 *      headers it sent. This is the check that closes the "no proxy in front"
 *      hole: a directly-exposed server ignores `x-forwarded-for` because nothing
 *      trustworthy appended it, so a client writing `127.0.0.1` there proves
 *      nothing.
 *   2. the trusted hop is loopback (or there is no header) — this is the check
 *      that closes the "proxy in front" hole: a stranger reaching a local proxy
 *      arrives with a foreign address in the appended hop.
 *
 * `hops <= 0` (TRUSTED_PROXY_HOPS=0, i.e. no proxy) skips (2) entirely and relies
 * on (1), which is exactly right for that deployment.
 *
 * `remote` undefined is a test harness, not a deployment: (1) is skipped there so
 * the header rules can be exercised on their own.
 */
export function isLocalRequest(
  headers: Headers | undefined,
  remote: string | undefined,
  hops = trustedProxyHops(),
): boolean {
  if (remote !== undefined && !isLoopbackAddress(remote)) return false;
  if (hops <= 0) return true;
  return isLoopbackPeer(headers?.get('x-forwarded-for') ?? undefined, hops);
}

/**
 * True when the trusted hop of `x-forwarded-for` is this machine.
 *
 * Prefer `isLocalRequest`, which also checks the socket: a header alone is
 * client-authored whenever no proxy appended it. Kept separate because the hop
 * rule is worth testing on its own.
 *
 * A chain shorter than the configured hop count was not written by our proxies, so
 * it is foreign rather than absent. No header at all means nothing is in front of
 * us and the socket peer is authoritative — `isLocalRequest` decides that part.
 */
export function isLoopbackPeer(forwardedFor?: string | null, hops = trustedProxyHops()): boolean {
  if (hops <= 0) return true; // no proxy trusted: the socket decided, not this header
  const chain = (forwardedFor ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!chain.length) return true;
  const hop = chain[chain.length - hops];
  if (!hop) return false;
  return LOOPBACK.test(hop);
}
