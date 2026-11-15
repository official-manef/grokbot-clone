/**
 * The wiring, not the libraries (rate-limit.test.mjs and usage-quota.test.mjs already
 * cover those). Four claims, each in its own child process because env.ts and the db
 * handle resolve once per process, as at boot:
 *
 *   1. an over-limit turn on `/bots/:id/messages` is 429 with `Retry-After`;
 *   2. a request under the limit is not 429 (the route still works);
 *   3. a user past their daily tokens sees a message explaining it, and the model is
 *      never called;
 *   4. an unreadable usage ledger denies the spend (fail closed) instead of granting it.
 *
 * No network: the stub model is an HTTP server on 127.0.0.1 that only counts hits.
 *
 *   node --test server/test/rate-limit-wiring.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_rate-limit-wiring-probe.mjs');

function run(mode) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, mode],
      {
        cwd: path.join(here, '..'),
        env: {
          ...process.env,
          SESSION_SECRET: 'test-secret',
          XAI_API_KEY: 'test-key',
          COMPOSIO_API_KEY: '',
          WORKOS_API_KEY: '',
          WORKOS_CLIENT_ID: '',
          GROKBOT_NO_SCHEDULER: '1',
          DB_PATH: path.join(os.tmpdir(), `grokbot-wiring-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
        },
        timeout: 120_000,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stderr}`));
        const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe output\n${stdout}\n${stderr}`));
        resolve(JSON.parse(line.slice('@@PROBE@@'.length)));
      },
    );
  });
}

// ---------- the request wall ----------

test('a turn past the per-user limit is 429 and carries Retry-After', async () => {
  const r = await run('routes');
  assert.equal(r.statuses.at(-1), 429, `expected a 429 eventually, saw ${r.statuses.join(',')}`);
  assert.ok(r.statuses.slice(0, -1).every((s) => s !== 429), 'no 429 before the limit was reached');
  assert.ok(r.retryAfter !== null, 'a 429 must tell the caller when to come back');
  assert.match(r.retryAfter, /^\d+$/, `Retry-After is whole seconds, got ${r.retryAfter}`);
  assert.ok(Number(r.retryAfter) >= 1, 'Retry-After is never 0');
});

test('a request under the limit is accepted, not 429', async () => {
  const r = await run('routes-under');
  assert.equal(r.status, 200, `a single turn must succeed, got ${r.status}`);
  assert.equal(r.retryAfter, null, 'no Retry-After on a success');
});

// ---------- the token wall ----------

test('a user past the daily token limit gets a message and the model is not called', async () => {
  const r = await run('quota-tokens');
  assert.equal(r.modelHits, 0, 'no model call may be spent once the quota is gone');
  assert.ok(r.assistantText, 'the user must see why nothing happened, not a silent stop');
  assert.match(r.assistantText, /today's usage limit/i, 'the message names the wall that was hit');
  assert.match(r.assistantText, /midnight UTC/, 'and when it resets');
});

test('an unreadable usage ledger denies the spend instead of allowing it', async () => {
  const r = await run('quota-unavailable');
  assert.equal(r.modelHits, 0, 'fail closed: a ledger read error must deny the spend');
  assert.ok(r.assistantText, 'the user is told the turn was stopped');
  assert.match(r.assistantText, /couldn't check today's usage/i, 'says the check failed, not that a limit was hit');
});

test('control: under the wall the model is called and the spend is recorded', async () => {
  const r = await run('quota-allowed');
  assert.equal(r.modelHits, 1, 'the stub model is reached when the quota allows it');
  assert.equal(r.assistantText, 'stub answer', 'and its answer reaches the conversation');
  assert.ok(r.usage, 'the spend is written to usage_daily');
  assert.equal(r.usage.requests, 1, 'one turn, one request');
  assert.equal(r.usage.input_tokens, 10, 'input tokens come from final.usage');
  assert.equal(r.usage.output_tokens, 5, 'output tokens too');
});
