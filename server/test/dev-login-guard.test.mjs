/**
 * Dev login (`POST /api/auth/dev`) mints a session from an email alone, no
 * credential. It shipped enabled in production once, and any stranger who knew an
 * `@antinrml.com` handle became an artist with staff surfaces. The decision is a
 * pure predicate (`devLoginAllowed`) and the route calls it, so these cases are
 * the ones that actually run in production.
 *
 * Also here: the owner is staff through the additive `ALLOWED_EMAILS` path, and
 * only through it — an empty allowlist leaves a gmail address a fan, because the
 * rule is "listed address", not "this specific person".
 *
 *   node --test server/test/dev-login-guard.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEmail } from '../src/lib/email-allowlist.ts';
import { devLoginAllowed, isLoopbackPeer } from '../src/lib/dev-login-guard.ts';

const lists = (over = {}) => ({ allowedEmails: [], allowedEmailDomains: [], staffEmailDomains: ['antinrml.com'], ...over });
const fan = { audience: 'fan', role: null };
const staff = { audience: 'staff', role: 'artist' };

/** Everything permits it: flag on, local, not production, a fan. */
const allow = (over = {}) => devLoginAllowed({ flag: true, production: false, forwardedFor: undefined, classification: fan, override: false, ...over });

// ---------- the developer path stays alive ----------

test('a fan from loopback is allowed when everything permits it', () => {
  assert.deepEqual(allow(), { allowed: true });
  assert.deepEqual(allow({ forwardedFor: '127.0.0.1' }), { allowed: true }, 'a proxy that forwards a loopback peer is still local');
  assert.deepEqual(allow({ forwardedFor: '::1' }), { allowed: true });
  assert.deepEqual(allow({ forwardedFor: '::ffff:127.0.0.1' }), { allowed: true });
  assert.deepEqual(allow({ forwardedFor: '127.0.0.1, 10.1.2.3' }), { allowed: true }, 'only the first hop is the client');
});

// ---------- 1. the flag off ----------

test('the flag off refuses, always', () => {
  assert.deepEqual(allow({ flag: false }), { allowed: false, reason: 'disabled' });
  assert.deepEqual(allow({ flag: false, override: true }), { allowed: false, reason: 'disabled' }, 'the override is not a way to turn the flag on');
});

// ---------- 2. staff is never minted by a shortcut ----------

test('a staff address is refused even with the flag on and an override set', () => {
  assert.deepEqual(allow({ classification: staff }), { allowed: false, reason: 'staff' });
  assert.deepEqual(allow({ classification: staff, override: true }), { allowed: false, reason: 'staff' });
  assert.deepEqual(allow({ classification: { audience: 'staff', role: 'management' } }), { allowed: false, reason: 'staff' });
  // The real classification of a company address, not a hand-written object.
  const moona = classifyEmail('moona@antinrml.com', lists());
  assert.deepEqual(allow({ classification: moona }), { allowed: false, reason: 'staff' }, 'moona@antinrml.com was the live exploit address');
});

// ---------- 3. production signal ----------

test('a production process refuses, even with the flag on', () => {
  assert.deepEqual(allow({ production: true }), { allowed: false, reason: 'production' });
});

test('the explicit override is the only way to open production, and never for staff', () => {
  assert.deepEqual(allow({ production: true, override: true }), { allowed: true });
  assert.deepEqual(allow({ production: true, override: true, forwardedFor: '203.0.113.9' }), { allowed: true }, 'the override also clears the network gate');
  assert.deepEqual(allow({ production: true, override: true, classification: staff }), { allowed: false, reason: 'staff' });
});

// ---------- 4. forwarded peer ----------

test('a public forwarded peer is refused when production is not even signalled', () => {
  assert.deepEqual(allow({ forwardedFor: '203.0.113.9' }), { allowed: false, reason: 'network' });
  assert.deepEqual(allow({ forwardedFor: '203.0.113.9, 127.0.0.1' }), { allowed: false, reason: 'network' }, 'the first hop is the stranger');
  assert.deepEqual(allow({ forwardedFor: 'not-an-ip' }), { allowed: false, reason: 'network' }, 'unparseable counts as foreign');
});

test('loopback peer parsing', () => {
  for (const v of [undefined, null, '', '127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', ' 127.0.0.1 , 10.0.0.1']) {
    assert.equal(isLoopbackPeer(v), true, `${JSON.stringify(v)} is local`);
  }
  for (const v of ['203.0.113.9', '10.1.2.3', '192.168.1.5', 'evil.test', '127.0.0.1.evil.com']) {
    assert.equal(isLoopbackPeer(v), false, `${JSON.stringify(v)} is not loopback`);
  }
});

// ---------- the owner is staff through the allowlist ----------

test('the owner address in allowedEmails is staff + management', () => {
  const owner = 'antinrml33@gmail.com';
  assert.deepEqual(classifyEmail(owner, lists()), { audience: 'fan', role: null }, 'with an empty allowlist a gmail address is a fan');
  assert.deepEqual(classifyEmail(owner, lists({ allowedEmails: [owner] })), { audience: 'staff', role: 'management' });
  assert.deepEqual(classifyEmail('ANTINRML33@Gmail.com', lists({ allowedEmails: [owner] })), { audience: 'staff', role: 'management' }, 'case is irrelevant');
});

test('the rule is "a listed address", not "the owner"', () => {
  const someoneElse = 'someone.else@gmail.com';
  assert.equal(classifyEmail(someoneElse, lists({ allowedEmails: ['antinrml33@gmail.com'] })).audience, 'fan', 'one listed address does not make every gmail staff');
  assert.equal(classifyEmail(someoneElse, lists({ allowedEmails: [someoneElse] })).audience, 'staff');
});

test('a boundary lookalike is still a fan', () => {
  assert.deepEqual(classifyEmail('x@evil-antinrml.com', lists()), { audience: 'fan', role: null });
  assert.deepEqual(classifyEmail('x@evil-antinrml.com', lists({ allowedEmails: ['antinrml33@gmail.com'] })), { audience: 'fan', role: null });
  assert.deepEqual(classifyEmail('antinrml33@gmail.com.evil.com', lists({ allowedEmails: ['antinrml33@gmail.com'] })), { audience: 'fan', role: null }, 'a longer address is not the listed one');
});
