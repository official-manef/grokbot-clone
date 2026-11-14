/**
 * Password sign-in contract.
 *
 * The point of these checks is that a wrong password can never read as right:
 * the hash format is parsed strictly, a tampered work factor is refused rather
 * than executed, and comparison is constant-time.
 *
 *   npx tsx --test server/test/password.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashPassword,
  verifyPasswordHash,
  checkPassword,
  resetPasswordAuth,
  passwordAuth,
} from '../src/lib/password.ts';

test('a hash verifies its own password and nothing else', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
  assert.equal(await verifyPasswordHash('correct horse battery staple', hash), true);
  assert.equal(await verifyPasswordHash('correct horse battery stapl', hash), false);
  assert.equal(await verifyPasswordHash('', hash), false);
  assert.equal(await verifyPasswordHash('CORRECT HORSE BATTERY STAPLE', hash), false);
});

test('the same password hashes differently each time (salted)', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b, 'two salts must not produce the same hash');
  assert.equal(await verifyPasswordHash('same-password', a), true);
  assert.equal(await verifyPasswordHash('same-password', b), true);
});

test('a malformed hash is a wrong password, never an exception', async () => {
  for (const bad of ['', 'plaintext', 'scrypt$16384$8$1$onlyfourparts', 'bcrypt$16384$8$1$aa$bb',
                     'scrypt$notanumber$8$1$aa$bb', 'scrypt$16384$8$1$$', 'scrypt$16384$8$1$aa$']) {
    assert.equal(await verifyPasswordHash('anything', bad), false, `should reject: ${bad}`);
  }
});

test('a tampered work factor is refused instead of executed', async () => {
  const hash = await hashPassword('pw');
  const parts = hash.split('$');
  // N is the second field. 2^30 with r=8 would be tens of GB and pin a core.
  parts[1] = String(1 << 30);
  assert.equal(await verifyPasswordHash('pw', parts.join('$')), false);
  // And a too-small N, which would make guessing cheap.
  parts[1] = '16';
  assert.equal(await verifyPasswordHash('pw', parts.join('$')), false);
});

test('unicode normalises so a composed and decomposed password match', async () => {
  const composed = 'café-password';
  const decomposed = composed.normalize('NFD');
  assert.notEqual(composed, decomposed, 'the two strings differ byte-wise');
  const hash = await hashPassword(composed);
  assert.equal(await verifyPasswordHash(decomposed, hash), true);
});

test('nothing is configured: checkPassword is false, not an error', async () => {
  delete process.env.AUTH_PASSWORD;
  delete process.env.AUTH_PASSWORD_HASH;
  resetPasswordAuth();
  const auth = await passwordAuth();
  assert.equal(auth.enabled, false);
  assert.equal(await checkPassword('anything'), false);
  assert.equal(await checkPassword(''), false);
});

test('AUTH_PASSWORD plaintext is hashed at boot and the plaintext is not kept', async () => {
  delete process.env.AUTH_PASSWORD_HASH;
  process.env.AUTH_PASSWORD = 'shared-with-mso';
  resetPasswordAuth();
  const auth = await passwordAuth();
  assert.equal(auth.enabled, true);
  assert.equal(auth.source, 'AUTH_PASSWORD');
  assert.match(auth.hash, /^scrypt\$/);
  assert.ok(!auth.hash.includes('shared-with-mso'), 'the plaintext must not survive in the hash');
  assert.equal(await checkPassword('shared-with-mso'), true);
  assert.equal(await checkPassword('wrong'), false);
  delete process.env.AUTH_PASSWORD;
  resetPasswordAuth();
});

test('AUTH_PASSWORD_HASH wins over AUTH_PASSWORD', async () => {
  const hash = await hashPassword('from-the-hash');
  process.env.AUTH_PASSWORD_HASH = hash;
  process.env.AUTH_PASSWORD = 'from-the-plaintext';
  resetPasswordAuth();
  const auth = await passwordAuth();
  assert.equal(auth.source, 'AUTH_PASSWORD_HASH');
  assert.equal(await checkPassword('from-the-hash'), true);
  assert.equal(await checkPassword('from-the-plaintext'), false);
  delete process.env.AUTH_PASSWORD_HASH;
  delete process.env.AUTH_PASSWORD;
  resetPasswordAuth();
});
