/**
 * The `/apps/callback` page: the one HTML document an unauthenticated caller can make
 * this server print, because an OAuth popup comes back with no fetch headers we set.
 *
 * Two defects, both real before this test existed:
 *
 *   1. `slug` was reflected into an inline `<script>` verbatim, so
 *      `?slug=</script><img src=x onerror=alert(1)>` ran script on our origin.
 *   2. The `postMessage` was addressed to `'*'`, so any window that opened the popup
 *      received the payload.
 *
 * The case drives the route (child process, because env.ts resolves once per process)
 * and reads back what a browser would receive, rather than restating the escaping.
 *
 *   node --test server/test/apps-callback.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_apps-callback-probe.mjs');

/** The origin the page is told to address its postMessage to; the probe's APP_URL. */
const APP_ORIGIN = 'https://grok.example';

function run(slug, status = 'ok') {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, slug, status],
      {
        cwd: path.join(here, '..'),
        env: {
          ...process.env,
          SESSION_SECRET: 'test-secret',
          XAI_API_KEY: 'test-key',
          DB_PATH: path.join(os.tmpdir(), `grokbot-callback-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
          APP_URL: APP_ORIGIN,
          DESKTOP_MODE: 'disabled',
          GROKBOT_NO_SCHEDULER: '1',
        },
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stdout}\n${stderr}`));
        const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe output\n${stdout}\n${stderr}`));
        resolve(JSON.parse(line.slice('@@PROBE@@'.length)));
      },
    );
  });
}

/** Pull `postMessage(<payload>,<target>)` back out of the page as data. */
function postMessageCall(body) {
  const m = /postMessage\((.*?)},\s*("(?:[^"\\]|\\.)*")\)\}/.exec(body);
  assert.ok(m, `no postMessage call in: ${body}`);
  return { payload: JSON.parse(`${m[1]}}`), target: JSON.parse(m[2]) };
}

test('a hostile slug cannot close the script tag', async () => {
  const hostile = '</script><img src=x onerror=alert(1)>';
  const r = await run(hostile);
  assert.equal(r.status, 200);
  // The literal tag never reaches the browser.
  assert.ok(!r.body.includes('<img src=x'), `reflected markup: ${r.body}`);
  assert.ok(!r.body.includes('onerror=alert'), `reflected markup: ${r.body}`);
  // A rejected slug is dropped rather than echoed.
  assert.equal(postMessageCall(r.body).payload.slug, '');
});

test('the page addresses postMessage to our origin, not to every window', async () => {
  const r = await run('gmail');
  assert.equal(r.status, 200);
  const { payload, target } = postMessageCall(r.body);
  assert.equal(payload.type, 'grokbot-connected');
  assert.equal(payload.slug, 'gmail');
  assert.equal(payload.ok, true);
  assert.equal(target, APP_ORIGIN);
});

test('the page is not cacheable and not sniffable', async () => {
  const r = await run('gmail');
  assert.equal(r.cacheControl, 'no-store');
  assert.equal(r.nosniff, 'nosniff');
});

test('a failed connection says so and reports ok:false', async () => {
  const r = await run('gmail', 'failed');
  assert.equal(r.status, 200);
  assert.match(r.body, /Connection failed/);
  assert.equal(postMessageCall(r.body).payload.ok, false);
});
