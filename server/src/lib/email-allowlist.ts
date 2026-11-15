/**
 * The one place that decides whether an email may sign in.
 *
 * This app is staff only: artists and management. Fans do not sign in here at all.
 * The reason is not politeness — a session on this app reaches tools that read and
 * write the host directly (`shell`, `computer_*`, the file tools), so a "fan with
 * chat only" boundary would be too thin. Fans belong in the game / antinrml.com,
 * which will use Google OAuth separately.
 *
 * Semantics (all four cases, deliberately):
 *   - both lists empty            -> nobody. Fail closed: an unconfigured allowlist
 *                                    cannot be read as "open", because the same
 *                                    session can touch the host.
 *   - only allowedEmails set      -> exact address match only
 *   - only allowedEmailDomains set-> any address on those domains
 *   - both set                    -> exact match OR domain match
 *
 * The domain is the text after the LAST '@', compared with === so a boundary
 * lookalike (`evil-antinrml.com`, `notantinrml.com`) cannot slip through the way
 * a substring or endsWith check on the whole address would let it.
 *
 * Pure and signature-stable on purpose: every sign-in route calls this same
 * predicate, so there is one rule and no path around it.
 */

/**
 * Who a signed-in person is to us. This app only admits staff, so in practice
 * everything that reaches a turn is `staff`. `fan` stays defined (and its numbers
 * stay conservative in lib/usage-quota.ts) because the game and antinrml.com will
 * reuse this module for the people who sign in there.
 */
export type Audience = 'staff' | 'fan';
export function isEmailAllowed(
  email: string,
  lists: { allowedEmails: string[]; allowedEmailDomains: string[] },
): boolean {
  const { allowedEmails, allowedEmailDomains } = lists;
  if (!allowedEmails.length && !allowedEmailDomains.length) return false;

  const address = (email ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  // No '@', or nothing on either side of it, is not an address we guess about.
  if (at <= 0 || at === address.length - 1) return false;
  const domain = address.slice(at + 1);

  return allowedEmails.includes(address) || allowedEmailDomains.includes(domain);
}
