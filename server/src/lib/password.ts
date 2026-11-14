import crypto from 'node:crypto';

/**
 * Password sign-in, for the one person who runs this server.
 *
 * Two ways to configure it, and only one of them puts a usable secret on disk:
 *
 * - AUTH_PASSWORD_HASH: `scrypt$N$r$p$salt$hash`, made by `gb passwd`. The
 *   plaintext is never stored and never enters the process.
 * - AUTH_PASSWORD: the plaintext itself, for sharing one password with another
 *   service on the same machine (MSO does exactly this with OS_LOGIN_PASSWORD).
 *   It is hashed once at boot and then only the hash is used.
 *
 * scrypt rather than bcrypt or argon2 because it is in Node's standard library:
 * a password has no business adding a dependency, and scrypt is memory-hard.
 */

const N = 16384; // 2^14, ~16 MB at r=8. Enough that guessing is not free.
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

function scrypt(password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$salt$hash`, both parts base64. */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error('password must not be empty');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Verify against a stored hash. Returns false for a malformed hash rather than
 * throwing: a broken AUTH_PASSWORD_HASH must read as "wrong password", never as
 * a 500 that tells an attacker the hash exists but is invalid.
 */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd work factors: a tampered hash must not become a CPU bomb.
  if (n < 1024 || n > 1 << 22 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let salt: Buffer;
  let want: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    want = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (!salt.length || !want.length) return false;
  const got = await scrypt(password, salt, want.length, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * What the running server uses. The plaintext is accepted only to be hashed
 * immediately; callers verify against `hash` and never see the input again.
 */
export interface PasswordAuth {
  /** True when a password is configured at all. */
  enabled: boolean;
  /** The stored hash, or '' when disabled. */
  hash: string;
  /** Where the value came from, for the boot log. Never the value itself. */
  source: 'AUTH_PASSWORD_HASH' | 'AUTH_PASSWORD' | '';
}

let cached: PasswordAuth | null = null;

/** Resolve once at boot: a plaintext env var is hashed here and not kept. */
export async function passwordAuth(): Promise<PasswordAuth> {
  if (cached) return cached;
  const hash = process.env.AUTH_PASSWORD_HASH?.trim();
  if (hash) {
    cached = { enabled: true, hash, source: 'AUTH_PASSWORD_HASH' };
    return cached;
  }
  const plain = process.env.AUTH_PASSWORD ?? '';
  if (plain) {
    cached = { enabled: true, hash: await hashPassword(plain), source: 'AUTH_PASSWORD' };
    return cached;
  }
  cached = { enabled: false, hash: '', source: '' };
  return cached;
}

export async function checkPassword(password: string): Promise<boolean> {
  const auth = await passwordAuth();
  if (!auth.enabled) return false;
  if (typeof password !== 'string' || !password) return false;
  return verifyPasswordHash(password, auth.hash);
}

/** Test seam: forget the resolved value so a test can change the environment. */
export function resetPasswordAuth() {
  cached = null;
}
