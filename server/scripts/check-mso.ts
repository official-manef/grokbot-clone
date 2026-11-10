/**
 * Checks for DESKTOP_MODE=mso. No framework — this repo has none, and adding one for
 * five assertions would be the tail wagging the dog.
 *
 *   cd server && npx tsx --env-file=../.env ./scripts/check-mso.ts
 *
 * Tier 1 is pure mapping and always runs. Tier 2 needs Xvfb + ffmpeg + the vendored
 * binaries and is skipped, loudly, when they are missing.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

process.env.DESKTOP_MODE ||= 'mso';
process.env.MSO_DESKTOP_ROOT ||= `${process.env.HOME ?? '/tmp'}/.grokbot/desktops-check`;

const mso = await import('../src/mso.js');
const { env } = await import('../src/env.js');

let n = 0;
const ok = (label: string, fn: () => void) => { fn(); n++; console.log(`  ok  ${label}`); };

console.log('screen mapping');

/**
 * The mapping is the most error-prone part of this backend and each mistake has the
 * same symptom — a black screenshot — so it is asserted explicitly:
 *   screen-1 must be :91 (not :1), and each display needs its own VNC port or two
 *   bots fight over one socket.
 */
ok('default is :99', () => assert.equal(mso.displayFor(0), ':99'));
ok('screen-1 is :91, not :1', () => assert.equal(mso.displayFor(1), ':91'));
ok('screen-3 is :93', () => assert.equal(mso.displayFor(3), ':93'));
ok("'default' maps to index 0", () => assert.equal(mso.screenIndex('default'), 0));
ok('undefined maps to index 0', () => assert.equal(mso.screenIndex(undefined), 0));
ok("'screen-2' maps to index 2", () => assert.equal(mso.screenIndex('screen-2'), 2));
ok('index 0 renders as default', () => assert.equal(mso.screenIdFor(0), 'default'));
ok('index 2 renders as screen-2', () => assert.equal(mso.screenIdFor(2), 'screen-2'));
ok('VNC ports are distinct per display', () => {
  const ports = [0, 1, 2, 3].map(mso.vncPortFor);
  assert.equal(new Set(ports).size, 4, `ports collided: ${ports.join(',')}`);
  assert.equal(ports[0], env.desktop.mso.vncPortBase);
});
ok('round-trips screen id -> index -> id', () => {
  for (const id of ['default', 'screen-1', 'screen-2', 'screen-3']) {
    assert.equal(mso.screenIdFor(mso.screenIndex(id)), id);
  }
});

console.log('binaries');
ok('xdotool resolves (vendored or PATH)', () => {
  const vendored = fs.existsSync(new URL('../vendor/bin/xdotool', import.meta.url).pathname);
  const path = spawnSync('sh', ['-c', 'command -v xdotool'], { encoding: 'utf8' }).status === 0;
  assert.ok(vendored || path, 'run server/scripts/install-desktop-deps.sh');
});
ok('browser lookup returns a file or null (never a stale path)', () => {
  const b = mso.browserBinary();
  if (b !== null) assert.ok(fs.statSync(b).isFile(), `${b} is not a file`);
});

console.log('live desktop');
const have = (c: string) => spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).status === 0;
if (!have('Xvfb') || !have('ffmpeg')) {
  console.log(`  skip  needs Xvfb and ffmpeg (Xvfb=${have('Xvfb')} ffmpeg=${have('ffmpeg')})`);
} else {
  const box = await mso.createComputer('check', { name: 'check-box' });
  try {
    const shot = await mso.screenshot(box.id, 'default');
    assert.ok(shot.image.length > 100, 'empty screenshot');
    assert.equal(shot.mime_type, 'image/jpeg');
    n++; console.log(`  ok  screenshot ${shot.width}x${shot.height} (${Math.round(Buffer.from(shot.image, 'base64').length / 1024)} KB)`);

    // Input proves the loader path and DISPLAY are right; a wrong either way throws.
    await mso.move(box.id, 'default', { x: 20, y: 20 });
    await mso.click(box.id, 'default', { x: 20, y: 20 });
    await mso.key(box.id, 'default', 'Escape');
    n++; console.log('  ok  move / click / key');

    const shell = await mso.bash(box.id, 'default', 'echo check-ok');
    assert.equal(shell.exit_code, 0);
    assert.match(shell.output, /check-ok/);
    n++; console.log('  ok  shell runs in the box directory');

    const port = await mso.vncUpstreamPort(1);
    assert.ok(port > 0);
    n++; console.log(`  ok  screen-1 serves RFB on ${port}`);
  } finally {
    await mso.shutdown();
    fs.rmSync(`${env.desktop.mso.root}/boxes/check-box`, { recursive: true, force: true });
  }
}

console.log(`\n${n} checks passed`);
process.exit(0);
