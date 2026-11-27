/**
 * The screen relay's origin check.
 *
 * `SameSite=Lax` used to keep a foreign page from opening the VNC WebSocket with the
 * session cookie attached — Lax does not send cookies on a cross-site subresource or
 * socket. An embedded deployment sets `SameSite=None`, which removes that, so a socket
 * carrying the visitor's cookie can be opened by any site unless the upgrade is
 * checked. The check lives inline in `attachVncRelay`, so this test reads the built
 * decision: the same own-origin set the HTTP CSRF middleware uses, compared against
 * the upgrade's `Origin`.
 *
 * A test that re-wrote that comparison would pass while the relay did nothing, so it
 * drives a real upgrade against a real socket instead (see `_vnc-origin-probe.mjs`).
 *
 *   node --test server/test/vnc-origin.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const probe = path.join(here, '_vnc-origin-probe.mjs');

function upgrade(origin) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, JSON.stringify({ origin })],
      {
        cwd: root,
        env: {
          ...process.env,
          SESSION_SECRET: 'test-secret-not-a-real-one',
          DB_PATH: path.join(os.tmpdir(), `hq-vnc-origin-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
          APP_URL: 'https://grok.example',
          SERVER_URL: 'https://grok.example',
          EMBED_ALLOWED_ORIGINS: 'https://console.example',
          DESKTOP_MODE: 'disabled',
          GROKBOT_NO_SCHEDULER: '1',
        },
        timeout: 90_000,
      },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`${err.message}\n${stderr}`));
        const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe output\n${stdout}\n${stderr}`));
        resolve(JSON.parse(line.slice('@@PROBE@@'.length)));
      },
    );
  });
}

test('the app origin may open the screen socket', async () => {
  const r = await upgrade('https://grok.example');
  // Past the origin gate, so the refusal is the 401 the auth wall gives — not 403.
  assert.notEqual(r.status, 403, JSON.stringify(r));
});

test('the console that frames the app may open it too', async () => {
  const r = await upgrade('https://console.example');
  assert.notEqual(r.status, 403, JSON.stringify(r));
});

test('a foreign origin is refused before authentication is even considered', async () => {
  // The cookie would otherwise be enough: this is the hole SameSite=None opens.
  const r = await upgrade('https://evil.example');
  assert.equal(r.status, 403, JSON.stringify(r));
});

test('a sandboxed frame\'s "null" origin is refused', async () => {
  const r = await upgrade('null');
  assert.equal(r.status, 403, JSON.stringify(r));
});
