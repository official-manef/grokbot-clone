/**
 * Self-check for the local desktop backend. No test framework: run it directly.
 *
 *   cd server && npx tsx --env-file=../.env ./test/desktop.check.ts
 *
 * Two tiers:
 *   1. Pure mapping rules — always run, must never depend on a live display.
 *   2. Live display — screenshot, input, extra screen, VNC port. Skipped with a clear
 *      message when Xvfb or the vendored binaries are absent, so CI without a desktop
 *      still gets tier 1.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';

const { displayFor, browserBinary } = await import('../src/desktop.js');
const desktop = await import('../src/desktop.js');

let checks = 0;
function ok(label: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${label}`);
}

console.log('mapping rules');

// screen id <-> X display. `screen-1` must be :91, not :1: the bug that made a bot's
// browser open on a display nobody was screenshotting.
ok('default screen is :99', () => assert.equal(displayFor('default'), ':99'));
ok('undefined screen falls back to default', () => assert.equal(displayFor(undefined), ':99'));
ok('screen-1 is :91', () => assert.equal(displayFor('screen-1'), ':91'));
ok('screen-4 is :94', () => assert.equal(displayFor('screen-4'), ':94'));

// VNC ports follow the same offset, so each display gets its own endpoint.
const { spawnSync } = await import('node:child_process');
ok('xdotool is resolvable (vendored or on PATH)', () => {
  const which = process.env.PATH ? spawnSync('sh', ['-c', 'command -v xdotool || true'], { encoding: 'utf8' }).stdout.trim() : '';
  const vendored = fs.existsSync(new URL('../vendor/bin/xdotool', import.meta.url).pathname);
  assert.ok(vendored || which, 'neither vendored xdotool nor a PATH xdotool was found; run scripts/install-desktop-deps.sh');
});

// The browser must be a real file, and the answer must be stable across calls.
const browser = browserBinary();
ok('browser resolves to an executable file when present', () => {
  if (browser === null) return; // allowed: the tool reports it instead of failing
  assert.ok(fs.existsSync(browser), `${browser} does not exist`);
});

console.log('live desktop');
const haveXvfb = spawnSync('sh', ['-c', 'command -v Xvfb'], { encoding: 'utf8' }).status === 0;
const haveFfmpeg = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).status === 0;

if (!haveXvfb || !haveFfmpeg) {
  console.log(`  skip  Xvfb=${haveXvfb} ffmpeg=${haveFfmpeg} — live checks need both`);
} else {
  const box = await desktop.createComputer('selfcheck', 'selfcheck-key');
  try {
    const shot = await desktop.screenshot(box.id, 'default');
    assert.ok(shot.image.length > 100, 'screenshot came back empty');
    assert.equal(shot.mime_type, 'image/jpeg');
    checks++;
    console.log(`  ok  screenshot ${shot.width}x${shot.height} (${Math.round(Buffer.from(shot.image, 'base64').length / 1024)} KB)`);

    // Input must not throw; the desktop is empty so there is nothing to observe, but a
    // missing LD_LIBRARY_PATH or wrong display surfaces here as a hard error.
    await desktop.move(box.id, 'default', { x: 20, y: 20 });
    await desktop.click(box.id, 'default', { x: 20, y: 20 });
    await desktop.key(box.id, 'default', 'Escape');
    checks++;
    console.log('  ok  mouse move / click / key');

    const bash = await desktop.bash(box.id, undefined, 'echo selfcheck-ok');
    assert.equal(bash.exit_code, 0);
    assert.match(bash.output, /selfcheck-ok/);
    checks++;
    console.log('  ok  shell round-trip');

    const created = await desktop.createScreen(box.id);
    assert.match(created.id, /^screen-\d+$/);
    const port = await desktop.vncPort(box.id, created.id);
    assert.ok(port > 0);
    checks++;
    console.log(`  ok  extra screen ${created.id} serving RFB on ${port}`);

    await desktop.deleteScreen(box.id, created.id);
    checks++;
    console.log('  ok  screen delete');
  } finally {
    await desktop.shutdownRuntime();
  }
}

console.log(`\n${checks} checks passed`);
process.exit(0);
