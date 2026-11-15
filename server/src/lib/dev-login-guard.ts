/**
 * The one decision about `POST /api/auth/dev`, kept pure so it can be tested
 * without booting the server (and so the tested thing is what the route runs).
 *
 * Dev login mints a session from an email alone, with no credential. On this app a
 * session can reach `shell` and the file tools on the host, so this shortcut has to
 * be shut for anyone who could be a stranger. Every gate must pass:
 *
 *   1. `DEV_LOGIN=1`             — the flag is set at all;
 *   2. not a production process  — `env.production` (NODE_ENV, or an APP_URL /
 *                                  SERVER_URL outside loopback). Derived, never
 *                                  trusted from the flag: `.env` shipped
 *                                  `DEV_LOGIN=1` once already;
 *   3. the request looks local    — no `x-forwarded-for`, or a loopback first hop.
 *                                  Behind a proxy the socket peer is local for
 *                                  everyone, so the forwarded chain is the signal;
 *   4. a staff-allowlisted address — the same fail-closed predicate every other
 *                                  path uses, so dev login cannot become a way to
 *                                  mint a session for somebody the allowlist
 *                                  refuses (which would be the whole wall undone).
 *
 * There is deliberately no override env var: this app is internal, and a flag that
 * reopens credential-less sign-in in production is not a knob worth having.
 * `ponytail:` add one if a staging host ever needs it.
 *
 * Not imported by tests only: `routes.ts` runs this exact function.
 */

import { isLocalRequest, isLoopbackPeer as loopbackPeer } from './client-identity.js';

export type DevLoginRefusal = 'disabled' | 'production' | 'network' | 'not-staff';

export interface DevLoginInput {
  /** `DEV_LOGIN === '1'`. */
  flag: boolean;
  /** This process looks deployed (see `env.production`). */
  production: boolean;
  /** Raw `x-forwarded-for` header, or undefined when the proxy sent none. */
  forwardedFor?: string | null;
  /**
   * The socket peer's address. Required for a real decision: a header alone cannot
   * prove the request is local, because with no proxy in front the caller wrote it.
   * Undefined means a test harness, where only the header rule is exercised.
   */
  remote?: string;
  /** `isEmailAllowed()` of the requested address. */
  staff: boolean;
}

export type DevLoginDecision = { allowed: true } | { allowed: false; reason: DevLoginRefusal };

/**
 * True when the request came from this machine. Re-exported from
 * `client-identity.ts`, which owns the hop rule: proxies append, so a
 * client-written `127.0.0.1` lands before the real address and must not count.
 */
export const isLoopbackPeer = loopbackPeer;

export function devLoginAllowed(input: DevLoginInput): DevLoginDecision {
  if (!input.flag) return { allowed: false, reason: 'disabled' };
  if (!input.staff) return { allowed: false, reason: 'not-staff' };
  if (input.production) return { allowed: false, reason: 'production' };
  // Both facts, not either: a loopback socket AND a loopback trusted hop. The
  // socket check is what makes a directly-exposed server ignore a header the
  // client wrote; the hop check is what makes a proxied server ignore one the
  // client wrote in front of the proxy's appended address.
  const headers = input.forwardedFor ? new Headers({ 'x-forwarded-for': input.forwardedFor }) : undefined;
  if (!isLocalRequest(headers, input.remote)) return { allowed: false, reason: 'network' };
  return { allowed: true };
}
