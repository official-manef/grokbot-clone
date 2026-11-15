/**
 * The one decision about `POST /api/auth/dev`, kept pure so it can be tested
 * without booting the server (and so the tested thing is what the route runs).
 *
 * Dev login mints a session from an email alone, with no credential. It is a
 * local testing shortcut, so every gate below must pass:
 *
 *   1. `DEV_LOGIN=1`               — the flag is set at all;
 *   2. the request looks local      — no `x-forwarded-for`, or a loopback peer
 *                                     as the first hop. Behind Traefik the socket
 *                                     peer is local for everyone, so the
 *                                     forwarded chain is what tells strangers
 *                                     apart from the developer;
 *   3. not a production process     — see `env.production` (SERVER_URL/APP_URL
 *                                     outside loopback, or NODE_ENV=production);
 *   4. a fan address                — a staff shortcut would be a staff-session
 *                                     factory, so staff is refused even when
 *                                     everything else permits it.
 *
 * `override` (`DEV_LOGIN_ALLOW_PRODUCTION=1`) exists so production can be opened
 * deliberately by an operator. It clears gates 2 and 3, never gate 4: an address
 * classified staff is refused no matter what.
 *
 * The production flag alone already failed once (`.env` shipped `DEV_LOGIN=1`),
 * which is why the production signal is derived rather than trusted.
 */

import type { Classification } from './email-allowlist.js';

export type DevLoginRefusal = 'disabled' | 'staff' | 'production' | 'network';

export interface DevLoginInput {
  /** `DEV_LOGIN === '1'`. */
  flag: boolean;
  /** The process looks like production (see `env.production`). */
  production: boolean;
  /** Raw `x-forwarded-for` header, or undefined when the proxy sent none. */
  forwardedFor?: string | null;
  /** `classifyEmail()` of the requested address. */
  classification: Classification;
  /** `DEV_LOGIN_ALLOW_PRODUCTION === '1'`. */
  override?: boolean;
}

export type DevLoginDecision = { allowed: true } | { allowed: false; reason: DevLoginRefusal };

const LOOPBACK = /^(::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/**
 * True when the request came from this machine. The first entry of
 * `x-forwarded-for` is the original client (`client, proxy1, proxy2`), so that is
 * the one compared. No header at all means nothing in front of us, i.e. a direct
 * local call. Anything unparseable counts as foreign.
 */
export function isLoopbackPeer(forwardedFor?: string | null): boolean {
  const raw = (forwardedFor ?? '').split(',')[0].trim().toLowerCase();
  if (!raw) return true;
  return LOOPBACK.test(raw);
}

export function devLoginAllowed(input: DevLoginInput): DevLoginDecision {
  if (!input.flag) return { allowed: false, reason: 'disabled' };
  // Staff first: no flag, network or override value may turn this into staff minting.
  if (input.classification.audience !== 'fan') return { allowed: false, reason: 'staff' };
  if (!input.override) {
    if (input.production) return { allowed: false, reason: 'production' };
    if (!isLoopbackPeer(input.forwardedFor)) return { allowed: false, reason: 'network' };
  }
  return { allowed: true };
}
