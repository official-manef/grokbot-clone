/**
 * What the model is told about its own box has to match what the box does.
 *
 * The bug this guards: `shell` said "as root" on every backend while the default
 * Docker box runs as the unprivileged `bot` user, so the model believed it could
 * install system packages. Same class of bug for the Library path: the prompt
 * named /root/grokbot/files on a box where nothing is writable there.
 *
 * Each case runs in its own process (test/_tools-probe.mjs) because env.ts
 * resolves once per process, exactly as it does at boot.
 *
 *   node --test server/test/shell-description.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_tools-probe.mjs');

/** Run one probe with a clean capability environment and a throwaway database. */
function run(kind, args, extraEnv) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(LLM_|IMAGE_|TTS_|STT_|REALTIME_|SEARCH_|XAI_|DESKTOP_|HQ_LOCAL|COMPOSIO_|DB_PATH)/.test(k)) delete env[k];
  }
  // The prompt probe inserts a user and a bot, so two cases must not share a file.
  const db = path.join(os.tmpdir(), `hq-probe-${process.pid}-${++probeSeq}-${Math.random().toString(36).slice(2)}.db`);
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', probe, kind, JSON.stringify(args)], { env: { ...env, DB_PATH: db, ...extraEnv }, timeout: 30_000 },
      (err, stdout) => {
        const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe output: ${err?.message ?? ''} ${stdout.slice(0, 400)}`));
        resolve(JSON.parse(line.slice('@@PROBE@@'.length)));
      });
  });
}

let probeSeq = 0;

const shellOf = (tools) => tools.descriptions.shell;

test('shell says bot user in the default Docker box, not root', async () => {
  const r = await run('tools', {}, { DESKTOP_MODE: 'docker' });
  assert.equal(r.ok, true, r.error);
  const d = shellOf(r);
  assert.match(d, /unprivileged `bot` user/);
  assert.doesNotMatch(d, /as root/, 'the Docker box cannot touch system files');
});

test('shell says host account for mso, and names the missing container', async () => {
  const r = await run('tools', {}, { DESKTOP_MODE: 'mso' });
  assert.equal(r.ok, true, r.error);
  const d = shellOf(r);
  assert.match(d, /host/);
  assert.match(d, /no container/i);
});

test('shell says root only for the shared computer', async () => {
  const r = await run('tools', {}, { DESKTOP_MODE: 'orgo' });
  assert.equal(r.ok, true, r.error);
  assert.match(shellOf(r), /as root/);
});

test('the prompt names the Library path the box actually writes to', async () => {
  const docker = await run('prompt', {}, { DESKTOP_MODE: 'docker' });
  assert.equal(docker.ok, true, docker.error);
  assert.match(docker.text, /\/home\/bot\/grokbot\/files\//, 'a Docker box is not writable at /root');

  const orgo = await run('prompt', {}, { DESKTOP_MODE: 'orgo' });
  assert.equal(orgo.ok, true, orgo.error);
  assert.match(orgo.text, /\/root\/grokbot\/files\//);
});
