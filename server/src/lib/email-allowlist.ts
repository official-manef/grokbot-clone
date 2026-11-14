/**
 * The one place that decides whether an email may sign in.
 *
 * Semantics (all four cases, deliberately):
 *   - both lists empty            -> anyone (unchanged: the app is open)
 *   - only allowedEmails set      -> exact address match only (unchanged)
 *   - only allowedEmailDomains set-> any address on those domains
 *   - both set                    -> exact match OR domain match
 *
 * The domain is the text after the LAST '@', compared with === so a boundary
 * lookalike (`evil-antinrml.com`, `notantinrml.com`) cannot slip through the way
 * a substring or endsWith check on the whole address would let it.
 */
export function isEmailAllowed(
  email: string,
  lists: { allowedEmails: string[]; allowedEmailDomains: string[] },
): boolean {
  const { allowedEmails, allowedEmailDomains } = lists;
  if (!allowedEmails.length && !allowedEmailDomains.length) return true;

  const address = (email ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  // No '@', or nothing on either side of it, is not an address we guess about.
  if (at <= 0 || at === address.length - 1) return false;
  const domain = address.slice(at + 1);

  return allowedEmails.includes(address) || allowedEmailDomains.includes(domain);
}
