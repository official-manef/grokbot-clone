/**
 * Cookie scope is a deployment decision with one hard constraint.
 *
 * `SESSION_COOKIE_SAMESITE=none` is what lets a console frame this app on another
 * site, and a browser silently drops `SameSite=None` without `Secure`. So a
 * half-configured embed must fail at boot rather than render a permanently signed-out
 * frame that looks like a login bug.
 *
 * Each case runs in its own process because env.ts resolves once, exactly as at boot.
 *
 *   node --test server/test/cookie-scope.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envModule = path.join(here, '../src/env.ts');

/** Load env.ts with the given variables and report the resolved cookie scope. */
function resolve(env) {
  // env.ts writes its boot notes to stdout, so a marker keeps the JSON unambiguous.
  const script = `const m = await import(${JSON.stringify(envModule)}); console.log('@@ENV@@' + JSON.stringify({ sameSite: m.env.cookieSameSite, embed: m.env.embedAllowedOrigins }));`;
  return new Promise((resolvePromise) => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, ...env }, timeout: 30_000 },
      (err, stdout, stderr) => resolvePromise({ code: err?.code ?? 0, stdout, stderr }));
  });
}

/** The marked JSON line, or a clear failure. */
function parse(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('@@ENV@@'));
  assert.ok(line, `no env output: ${stdout.slice(0, 300)}`);
  return JSON.parse(line.slice('@@ENV@@'.length));
}

test('lax is the default, so an ordinary deployment is unchanged', async () => {
  const r = await resolve({ APP_URL: 'http://localhost:5173', SERVER_URL: 'http://localhost:8787' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(parse(r.stdout).sameSite, 'lax');
});

test('none is accepted over https, because that is the embedded deployment', async () => {
  const r = await resolve({
    APP_URL: 'https://grok.antinrml.com',
    SERVER_URL: 'https://grok.antinrml.com',
    SESSION_COOKIE_SAMESITE: 'none',
    EMBED_ALLOWED_ORIGINS: 'https://mso.antinrml.com',
  });
  assert.equal(r.code, 0, r.stderr);
  const parsed = parse(r.stdout);
  assert.equal(parsed.sameSite, 'none');
  assert.deepEqual(parsed.embed, ['https://mso.antinrml.com']);
});

test('none over http fails at boot instead of silently signing everyone out', async () => {
  const r = await resolve({ APP_URL: 'http://localhost:5173', SERVER_URL: 'http://localhost:8787', SESSION_COOKIE_SAMESITE: 'none' });
  assert.notEqual(r.code, 0, 'a browser would drop the cookie, so this must not start');
  assert.match(r.stderr, /SESSION_COOKIE_SAMESITE=none needs APP_URL to be https/);
});

test('a nonsense value is refused rather than defaulted', async () => {
  const r = await resolve({ SESSION_COOKIE_SAMESITE: 'sometimes' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /SESSION_COOKIE_SAMESITE must be/);
});

test('the embed allowlist is empty unless configured', async () => {
  const r = await resolve({ EMBED_ALLOWED_ORIGINS: '' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(parse(r.stdout).embed, []);
});
