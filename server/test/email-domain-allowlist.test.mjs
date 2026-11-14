/**
 * The sign-in predicate is a classifier now (see signin-audience.test.mjs), so the
 * old "may this address sign in" cases live on as "which audience does this address
 * belong to". The bug this guards is still the boundary one: a staff-domain rule for
 * `antinrml.com` must not also admit `evil-antinrml.com`, because staff here means
 * the host shell and the management surfaces.
 *
 *   node --test server/test/email-domain-allowlist.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEmail } from '../src/lib/email-allowlist.ts';

const only = (domains) => ({ allowedEmails: [], allowedEmailDomains: domains, staffEmailDomains: [] });
const both = (emails, domains) => ({ allowedEmails: emails, allowedEmailDomains: domains, staffEmailDomains: [] });
const staff = (email, lists) => classifyEmail(email, lists).audience === 'staff';

test('domain list: an address on that domain is staff', () => {
  assert.equal(staff('anyone@antinrml.com', only(['antinrml.com'])), true);
});

test('domain list: a lookalike that merely ends with the name is not staff', () => {
  assert.equal(staff('x@evil-antinrml.com', only(['antinrml.com'])), false, 'endsWith on the address would let this through');
  assert.equal(staff('x@notantinrml.com', only(['antinrml.com'])), false, 'substring matching would let this through');
  assert.equal(staff('x@antinrml.com.evil.com', only(['antinrml.com'])), false);
});

test('domain list: a subdomain is not the listed domain', () => {
  assert.equal(staff('x@mail.antinrml.com', only(['antinrml.com'])), false);
});

test('exact email still works, alone and next to a domain list', () => {
  assert.equal(staff('boss@elsewhere.io', { allowedEmails: ['boss@elsewhere.io'], allowedEmailDomains: [], staffEmailDomains: [] }), true);
  assert.equal(staff('boss@elsewhere.io', both(['boss@elsewhere.io'], ['antinrml.com'])), true, 'or, not and');
  assert.equal(staff('other@antinrml.com', both(['boss@elsewhere.io'], ['antinrml.com'])), true);
  assert.equal(staff('other@elsewhere.io', both(['boss@elsewhere.io'], ['antinrml.com'])), false);
});

test('with no lists set, nobody is staff (fans are still allowed in)', () => {
  assert.deepEqual(classifyEmail('whoever@wherever.test', both([], [])), { audience: 'fan', role: null });
});

test('only an email list set is exact-match only', () => {
  assert.equal(staff('boss@antinrml.com', { allowedEmails: ['boss@antinrml.com'], allowedEmailDomains: [], staffEmailDomains: [] }), true);
  assert.equal(staff('other@antinrml.com', { allowedEmails: ['boss@antinrml.com'], allowedEmailDomains: [], staffEmailDomains: [] }), false);
});

test('case is irrelevant on both sides', () => {
  assert.equal(staff('Foo@ANTINRML.COM', only(['antinrml.com'])), true);
  assert.equal(staff('Foo@ANTINRML.COM', { allowedEmails: ['foo@antinrml.com'], allowedEmailDomains: [], staffEmailDomains: [] }), true);
  assert.equal(staff('boss@elsewhere.io', both(['boss@elsewhere.io'], ['ANTINRML.COM'])), true);
});

test('an address with no domain is never staff, not guessed', () => {
  assert.equal(staff('nobody', only(['antinrml.com'])), false);
  assert.equal(staff('nobody@', only(['antinrml.com'])), false);
  assert.equal(staff('@antinrml.com', only(['antinrml.com'])), false);
  assert.equal(staff('', only(['antinrml.com'])), false);
});

test('the domain is taken after the LAST @, so a quoted local part cannot relocate it', () => {
  assert.equal(staff('"a@antinrml.com"@evil.com', only(['antinrml.com'])), false);
});
