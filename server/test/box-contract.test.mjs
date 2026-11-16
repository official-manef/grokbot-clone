/**
 * BoxRuntime port contract and Docker adapter tests.
 *
 * Verifies that the extracted Docker adapter operates purely over an injected
 * `(command, args, timeoutMs)` runner, preserves every container hardening flag
 * from `desktop.ts`, rejects hostile container names before invoking `run()`,
 * rejects non-digit screen characters, and passes exact argv arrays for
 * lifecycle operations.
 *
 *   npx tsx --test server/test/box-contract.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MAX_SCREENS } from '../src/box/contract.ts';
import {
  LABEL,
  NAME_RE,
  SCREEN_RE,
  assertName,
  createDockerBoxRuntime,
  displayFor,
  parseScreenIndex,
  screenIndex,
} from '../src/box/adapters/docker.ts';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const TEST_CONFIG = {
  image: 'grokbot-desktop:test',
  ramGb: 4,
  cpu: 2,
  resolution: '1280x800x24',
  socketPath: '/var/run/docker.sock',
  maxScreens: MAX_SCREENS,
};

/** The display-readiness probe create/start/restart issue: `docker exec <name> sh -c ...` */
const isReadyProbe = (args) => args[0] === 'exec' && args.includes('sh') && args.some((a) => String(a).includes('xdpyinfo'));

function createRecordingRunner(overrides = () => undefined) {
  const calls = [];
  const run = async (command, args, timeoutMs) => {
    calls.push({ command, args: [...args], timeoutMs });
    const custom = overrides(command, args, timeoutMs);
    if (custom) return custom;
    if (args[0] === 'inspect') {
      return {
        code: 0,
        stdout: JSON.stringify([{ Name: `/${args[1]}`, State: { Status: 'running' } }]),
        stderr: '',
      };
    }
    // A real box answers the readiness probe once its Xvfb displays are up. The
    // probe asks per display and expects the ones that answered on stdout.
    if (isReadyProbe(args)) {
      const probe = String(args[args.length - 1]);
      const displays = [...probe.matchAll(/xdpyinfo -display (:\d+)/g)].map((m) => m[1]);
      return { code: 0, stdout: displays.join('\n'), stderr: '' };
    }
    return { code: 0, stdout: 'ok\n', stderr: '' };
  };
  return { calls, run };
}

test('contract and docker adapter never import process, env, fs, or child_process and never build a shell string', async () => {
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const contractSrc = stripComments(read('server/src/box/contract.ts'));
  const adapterSrc = stripComments(read('server/src/box/adapters/docker.ts'));

  for (const [label, src] of [
    ['contract.ts', contractSrc],
    ['adapters/docker.ts', adapterSrc],
  ]) {
    assert.doesNotMatch(src, /process\.env/, `${label} must not read process.env`);
    assert.doesNotMatch(src, /node:child_process|child_process/, `${label} must not import child_process`);
    assert.doesNotMatch(src, /node:fs|from ['"]fs['"]/, `${label} must not import fs`);
    // `SCREEN_RE.exec(...)` is a regex call, not a shell. Only a bare, non-regex
    // `exec(` would be the child_process form this gate is about.
    assert.doesNotMatch(src, /(?<![.\w])exec\s*\(/, `${label} must not call exec()`);
    assert.doesNotMatch(src, /\bshell:\s*true/, `${label} must not enable shell mode`);
  }

  const { calls, run } = createRecordingRunner();
  const box = createDockerBoxRuntime(run, TEST_CONFIG);
  await box.type('grokbot-u1', 'default', 'hello; rm -rf / && $(whoami)');
  await box.key('grokbot-u1', 'screen-1', 'ctrl+shift+t');

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, 'docker');
    assert.ok(Array.isArray(call.args), 'runner must receive an argv array');
  }
  assert.deepEqual(calls[0].args, [
    'exec',
    '-e',
    'DISPLAY=:99',
    'grokbot-u1',
    'xdotool',
    'type',
    '--delay',
    '12',
    '--clearmodifiers',
    '--',
    'hello; rm -rf / && $(whoami)',
  ]);
  assert.deepEqual(calls[1].args, [
    'exec',
    '-e',
    'DISPLAY=:1',
    'grokbot-u1',
    'xdotool',
    'key',
    '--clearmodifiers',
    'ctrl+shift+t',
  ]);
});

test('create passes enable_icc=false network and cap-drop/no-new-privileges/memory/cpu flags in argv', async () => {
  const { calls, run } = createRecordingRunner();
  const box = createDockerBoxRuntime(run, TEST_CONFIG);

  const created = await box.create('user-123');
  assert.equal(created.id, 'grokbot-user123');
  assert.equal(created.status, 'running');
  assert.equal(created.resolution, '1280x800x24');

  assert.equal(calls.length, 4, 'network create, docker run, readiness probe, inspect');
  assert.deepEqual(calls[0].args, [
    'network',
    'create',
    '--opt',
    'com.docker.network.bridge.enable_icc=false',
    'grokbot-user123-net',
  ]);

  const runArgs = calls[1].args;
  assert.equal(runArgs[0], 'run');
  assert.equal(runArgs[1], '-d');

  const pair = (flag, value) => {
    const idx = runArgs.indexOf(flag);
    assert.notEqual(idx, -1, `missing flag ${flag}`);
    assert.equal(runArgs[idx + 1], value, `unexpected value for ${flag}`);
  };

  pair('--name', 'grokbot-user123');
  pair('--cap-drop', 'ALL');
  pair('--security-opt', 'no-new-privileges');
  pair('--memory', '4g');
  pair('--memory-swap', '4g');
  pair('--cpus', '2');
  pair('--pids-limit', '2048');
  pair('--shm-size', '512m');
  pair('--network', 'grokbot-user123-net');
  assert.ok(runArgs.includes(LABEL), 'must include grokbot.desktop=1 label');
  assert.ok(runArgs.includes('GROKBOT_SCREENS=4'), 'must pass GROKBOT_SCREENS env');
  assert.ok(runArgs.includes('GROKBOT_RESOLUTION=1280x800x24'), 'must pass GROKBOT_RESOLUTION env');
  assert.equal(runArgs.at(-1), 'grokbot-desktop:test');
});

test('hostile container names are rejected before any run() call', async () => {
  const { calls, run } = createRecordingRunner();
  const box = createDockerBoxRuntime(run, TEST_CONFIG);

  const hostileNames = [
    'abc; rm -rf /',
    '-leading-dash',
    '$(whoami)',
    'bad name',
    '../escape',
    'x'.repeat(64),
    '',
  ];

  for (const bad of hostileNames) {
    assert.doesNotMatch(bad, NAME_RE);
    assert.throws(() => assertName(bad), /invalid container name/);
    await assert.rejects(() => box.create(bad), /invalid container name/);
    await assert.rejects(() => box.create('valid-user', { name: bad }), /invalid container name/);
    await assert.rejects(() => box.get(bad), /invalid container name/);
    await assert.rejects(() => box.start(bad), /invalid container name/);
    await assert.rejects(() => box.stop(bad), /invalid container name/);
    await assert.rejects(() => box.suspend(bad), /invalid container name/);
    await assert.rejects(() => box.restart(bad), /invalid container name/);
    await assert.rejects(() => box.remove(bad), /invalid container name/);
    await assert.rejects(() => box.screenshot(bad), /invalid container name/);
    await assert.rejects(() => box.click(bad, 'default', { x: 10, y: 10 }), /invalid container name/);
    await assert.rejects(() => box.bash(bad, 'default', 'echo hi'), /invalid container name/);
    await assert.rejects(() => box.readFile(bad, '/etc/hostname'), /invalid container name/);
  }

  assert.equal(calls.length, 0, 'run() must never be invoked when container name is invalid');
});

test('screen parsing rejects single characters that are not digits', async () => {
  const { run } = createRecordingRunner();
  const box = createDockerBoxRuntime(run, TEST_CONFIG);

  assert.equal(screenIndex(undefined), 0);
  assert.equal(screenIndex('default'), 0);
  assert.equal(screenIndex('screen-0'), 0);
  assert.equal(screenIndex('screen-3'), 3);
  assert.equal(parseScreenIndex('screen-2'), 2);

  for (const nonDigit of ['a', 'x', ';', '-', '_', '/', ':', ' ']) {
    const candidate = `screen-${nonDigit}`;
    assert.doesNotMatch(candidate, SCREEN_RE, `SCREEN_RE must reject ${candidate}`);
    assert.doesNotMatch(nonDigit, SCREEN_RE, `SCREEN_RE must reject bare ${nonDigit}`);
    assert.throws(() => parseScreenIndex(candidate), /invalid screen id/);
    assert.throws(() => parseScreenIndex(nonDigit), /invalid screen id/);
    assert.equal(screenIndex(candidate), 0, `screenIndex(${candidate}) must fall back to 0`);
    assert.equal(displayFor(screenIndex(candidate)), ':99');
    await assert.rejects(() => box.getScreen('grokbot-u1', candidate), /No such screen/);
    await assert.rejects(() => box.getScreen('grokbot-u1', nonDigit), /No such screen/);
  }
});

test('injected runner receives exact argv arrays for start, stop, suspend, and restart', async () => {
  const { calls, run } = createRecordingRunner();
  const box = createDockerBoxRuntime(run, TEST_CONFIG);

  await box.start('grokbot-u1');
  await box.stop('grokbot-u1');
  await box.suspend('grokbot-u1');
  await box.restart('grokbot-u1');

  assert.deepEqual(
    calls.filter((c) => !isReadyProbe(c.args)).map((c) => ({ command: c.command, args: c.args })),
    [
      { command: 'docker', args: ['start', 'grokbot-u1'] },
      { command: 'docker', args: ['stop', '-t', '10', 'grokbot-u1'] },
      { command: 'docker', args: ['stop', '-t', '10', 'grokbot-u1'] },
      { command: 'docker', args: ['restart', '-t', '10', 'grokbot-u1'] },
    ],
  );
  const lifecycleCalls = calls.filter((c) => !isReadyProbe(c.args));
  assert.deepEqual(lifecycleCalls.map((c) => c.timeoutMs), [undefined, 60_000, 60_000, 60_000]);

  // start and restart boot the entrypoint again, so both must wait for the displays;
  // stop and suspend must not (a stopped box has none to wait for).
  assert.equal(calls.filter((c) => isReadyProbe(c.args)).length, 2, 'start and restart each probe readiness once');
});

test('create does not return until every display answers, and gives up loudly', async () => {
  // A box whose later displays never come up must fail create, not hand back a
  // half-booted box that fails on the bot's first screenshot.
  const { run } = createRecordingRunner((command, args) => {
    if (isReadyProbe(args)) return { code: 0, stdout: ':99', stderr: '' };
    return undefined;
  });
  const box = createDockerBoxRuntime(run, { ...TEST_CONFIG, displayTimeoutMs: 300 });
  await assert.rejects(() => box.create('u1', { name: 'grokbot-late' }), /never brought up :1 :2 :3/);
});

test('a probe that answers every display lets create return on the first poll', async () => {
  let probes = 0;
  const { run } = createRecordingRunner((command, args) => {
    if (isReadyProbe(args)) { probes += 1; return undefined; }
    return undefined;
  });
  const box = createDockerBoxRuntime(run, TEST_CONFIG);
  await box.create('u2', { name: 'grokbot-ready' });
  assert.equal(probes, 1, 'no retry loop when the box is already up');
});
