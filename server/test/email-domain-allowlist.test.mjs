/**
 * Who may sign in is one predicate, so it is tested directly rather than through
 * a live server. The bug this guards is a boundary one: an allow-list for
 * `antinrml.com` must not also admit `evil-antinrml.com`.
 *
 *   node --test server/test/email-domain-allowlist.test.mjs
 *
 * (Imports TypeScript source; Node >=22.18 strips types natively. Older Node:
 *  run with `node --import tsx --test ...`.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isEmailAllowed } from '../src/lib/email-allowlist.ts';

const only = (domains) => ({ allowedEmails: [], allowedEmailDomains: domains });
const both = (emails, domains) => ({ allowedEmails: emails, allowedEmailDomains: domains });

test('domain list: an address on that domain is allowed', () => {
  assert.equal(isEmailAllowed('anyone@antinrml.com', only(['antinrml.com'])), true);
});

test('domain list: a lookalike that merely ends with the name is refused', () => {
  assert.equal(isEmailAllowed('x@evil-antinrml.com', only(['antinrml.com'])), false, 'endsWith on the address would let this through');
  assert.equal(isEmailAllowed('x@notantinrml.com', only(['antinrml.com'])), false, 'substring matching would let this through');
  assert.equal(isEmailAllowed('x@antinrml.com.evil.com', only(['antinrml.com'])), false);
});

test('domain list: a subdomain is not the listed domain', () => {
  assert.equal(isEmailAllowed('x@mail.antinrml.com', only(['antinrml.com'])), false);
});

test('exact email still works, alone and next to a domain list', () => {
  assert.equal(isEmailAllowed('boss@elsewhere.io', { allowedEmails: ['boss@elsewhere.io'], allowedEmailDomains: [] }), true);
  assert.equal(isEmailAllowed('boss@elsewhere.io', both(['boss@elsewhere.io'], ['antinrml.com'])), true, 'or, not and');
  assert.equal(isEmailAllowed('other@antinrml.com', both(['boss@elsewhere.io'], ['antinrml.com'])), true);
  assert.equal(isEmailAllowed('other@elsewhere.io', both(['boss@elsewhere.io'], ['antinrml.com'])), false);
});

test('both lists empty denies: an unconfigured allowlist cannot mean "anyone"', () => {
  // This test used to assert `true` — "the documented open default". That default is
  // what let anyone into an app whose session can reach `shell` and the host's files,
  // so it was changed to fail closed. The empty case is now a refusal, everywhere.
  assert.equal(isEmailAllowed('whoever@wherever.test', both([], [])), false);
  assert.equal(isEmailAllowed('boss@antinrml.com', both([], [])), false, 'no list, no entry — even for a staff-looking domain');
});

test('only an email list set is exact-match only, unchanged', () => {
  assert.equal(isEmailAllowed('boss@antinrml.com', { allowedEmails: ['boss@antinrml.com'], allowedEmailDomains: [] }), true);
  assert.equal(isEmailAllowed('other@antinrml.com', { allowedEmails: ['boss@antinrml.com'], allowedEmailDomains: [] }), false);
});

test('case is irrelevant on both sides', () => {
  assert.equal(isEmailAllowed('Foo@ANTINRML.COM', only(['antinrml.com'])), true);
  assert.equal(isEmailAllowed('Foo@ANTINRML.COM', { allowedEmails: ['foo@antinrml.com'], allowedEmailDomains: [] }), true);
  assert.equal(isEmailAllowed('boss@elsewhere.io', both(['boss@elsewhere.io'], ['ANTINRML.COM'])), true);
});

test('an address with no domain is refused, not guessed', () => {
  assert.equal(isEmailAllowed('nobody', only(['antinrml.com'])), false);
  assert.equal(isEmailAllowed('nobody@', only(['antinrml.com'])), false);
  assert.equal(isEmailAllowed('@antinrml.com', only(['antinrml.com'])), false);
  assert.equal(isEmailAllowed('', only(['antinrml.com'])), false);
});

test('the domain is taken after the LAST @, so a quoted local part cannot relocate it', () => {
  assert.equal(isEmailAllowed('"a@antinrml.com"@evil.com', only(['antinrml.com'])), false);
});
