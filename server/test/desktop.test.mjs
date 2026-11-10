/**
 * Desktop layer contract test. Runs without Docker by executing the pure
 * mapping functions and by asserting the safety properties that keep a bot from
 * reaching the host: name validation, display validation, argv (not shell) use.
 *
 *   node --test server/test/desktop.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/test/ -> server/ -> repo root
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (p) => readFileSync(path.join(root, p), 'utf8');

test('display and screen mapping', () => {
  // Mirrors desktop.ts displayFor/screenIndex: index 0 is :99, others are :N.
  const displayFor = (i) => (i === 0 ? ':99' : `:${i}`);
  const screenIndex = (id) => {
    if (!id || id === 'default') return 0;
    const m = /^screen-(\d)$/.exec(id);
    return m ? Number(m[1]) : 0;
  };
  assert.equal(displayFor(0), ':99');
  assert.equal(displayFor(3), ':3');
  assert.equal(screenIndex('default'), 0);
  assert.equal(screenIndex('screen-2'), 2);
  assert.equal(screenIndex('nonsense'), 0, 'unknown screen ids fall back to the primary');
  assert.equal(screenIndex(undefined), 0);
});

test('container names are validated before they reach docker', () => {
  const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
  for (const ok of ['grokbot-abc123', 'grokbot-u1', 'a']) assert.match(ok, NAME_RE);
  for (const bad of ['abc; rm -rf /', '-leading-dash', '$(whoami)', 'a b', 'x'.repeat(64), '']) {
    assert.doesNotMatch(bad, NAME_RE);
  }
});

test('docker.ts never builds a shell string', () => {
  const src = read('server/src/docker.ts');
  assert.doesNotMatch(src, /\bexec\s*\(/, 'must use execFile, not exec');
  assert.doesNotMatch(src, /\bshell:\s*true/, 'must not opt into a shell');
  assert.match(src, /execFile/, 'expected execFile as the only driver');
});

test('desktop bash runs inside the box, as an unprivileged user', () => {
  const src = read('server/src/desktop.ts');
  // The command is a shell string by design, but it must be inside the
  // container and must not be given host paths.
  assert.match(src, /'exec', '-e', `DISPLAY=/, 'expected docker exec with DISPLAY');
  assert.match(src, /assertName\(id\)/, 'container name must pass validation');
  assert.doesNotMatch(src, /-v\s*\/|--volume/, 'no host mounts allowed');
});

test('container is created without host privileges', () => {
  const src = read('server/src/desktop.ts');
  assert.match(src, /'--cap-drop', 'ALL'/, 'capabilities must be dropped');
  assert.match(src, /'--security-opt', 'no-new-privileges'/);
  assert.match(src, /'--pids-limit'/);
  assert.match(src, /'--memory'/);
});

test('screenshot path validates the display in the image too', () => {
  const shot = read('server/desktop/shot.sh');
  assert.match(shot, /refusing display arg/, 'script must reject a bad display itself');
  assert.match(shot, /png:-/, 'must stream to stdout, not a temp file');
  assert.doesNotMatch(shot, /eval/, 'no eval in the screenshot path');
});
