/**
 * The one place that decides who a signed-in email belongs to.
 *
 * This is a classifier, not a gate. The app is for the AntiNRML team AND for
 * fans, so nobody is refused for having the wrong address: fans sign in with
 * their own Google/gmail account. What changes is what they can reach (see
 * STAFF_ONLY_TOOLS in `agent/tools.ts` and the staff gate in `routes.ts`).
 *
 * Rules, in order:
 *   1. staff — the domain (text after the LAST '@') is in `staffEmailDomains`
 *              (env STAFF_EMAIL_DOMAINS, default `antinrml.com`), or in the older
 *              `allowedEmailDomains`, or the whole address is in `allowedEmails`.
 *              Those two lists keep their names and now only ever *add* staff
 *              (an address, or a second company domain), never subtract.
 *   2. role  — a staff email whose local part is one of ARTIST_HANDLES is
 *              `artist`; any other staff email is `management`.
 *   3. fan   — everything else: `{ audience: 'fan', role: null }`. Fans are
 *              allowed in.
 *
 * An address with no '@' (or nothing on either side of it) is never staff, so it
 * classifies as a fan. Sign-in refuses such a string separately, because it is
 * not an address at all; fans are never refused for being fans.
 *
 * The domain is compared with === after lowercasing, so a boundary lookalike
 * (`evil-antinrml.com`, `notantinrml.com`, `mail.antinrml.com`) is a fan and can
 * never be staff, the way a substring or endsWith check would let it through.
 */

export type Audience = 'staff' | 'fan';
export type StaffRole = 'artist' | 'management';
export type Classification = { audience: Audience; role: StaffRole | null };

export interface EmailLists {
  /** Whole addresses that are staff regardless of domain. */
  allowedEmails: string[];
  /** Extra staff domains (legacy name, still additive). */
  allowedEmailDomains: string[];
  /** The company domain(s); an address here is staff. Default `antinrml.com`. */
  staffEmailDomains: string[];
}

/**
 * The 18 AntiNRML artists, by handle. Copied from Nakama's roster
 * (`lara/nakama/apps/server/src/artist-roster.ts`, ARTISTS) — keep the two in
 * sync when an artist joins or leaves.
 */
export const ARTIST_HANDLES: readonly string[] = [
  '808bunny',
  'anangga',
  'bboogie',
  'dia',
  'jemsii',
  'josua-natanael',
  'kirohta',
  'mr-trash-dubbing',
  'naufal-syachreza',
  'naykilla',
  'ridotaka',
  'riku',
  'ryo',
  'sonmv',
  'suisei',
  'tenxi',
  'yung-caters',
  'moona',
];

/** An address we can sign in at all: one '@', nothing blank or spaced around it. */
export function isSignableEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test((email ?? '').trim());
}

const FAN: Classification = { audience: 'fan', role: null };

export function classifyEmail(email: string, lists: EmailLists): Classification {
  const address = (email ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  // No '@', or nothing on either side of it, is not an address we guess about.
  if (at <= 0 || at === address.length - 1) return FAN;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);

  // Case is irrelevant on both sides: env.ts lowercases, but a caller's list must
  // not silently stop matching because it was written in caps.
  const has = (list: string[]) => list.some((v) => v.trim().toLowerCase().replace(/^@/, '') === domain);
  const staff =
    has(lists.staffEmailDomains) ||
    has(lists.allowedEmailDomains) ||
    lists.allowedEmails.some((v) => v.trim().toLowerCase() === address);
  if (!staff) return FAN;

  return { audience: 'staff', role: ARTIST_HANDLES.includes(local) ? 'artist' : 'management' };
}
