/**
 * What the approval gate actually decides, driven through `policyFor`.
 *
 * The failure mode this guards is a call that reaches an app action without the user
 * being asked. Three ways that used to happen, all fixed by failing closed:
 *
 *   1. `GITHUB_CREATE_CHECK_RUN` contains `CHECK`, so a read-only regex alone
 *      auto-allowed a write. A write verb anywhere in the slug now forces approval.
 *   2. `COMPOSIO_MULTI_EXECUTE_TOOL` with unparseable arguments yielded no inner
 *      slugs, and "no slugs" read as "nothing to approve" — the whole batch ran.
 *      A meta tool we cannot see inside is now gated under its own name.
 *   3. Any other `COMPOSIO_*` meta tool (the remote workbench and bash tool, which
 *      can run app actions from code) was skipped entirely unless its arguments
 *      happened to match one of four words.
 *
 * Each case runs in a child process because `env.ts` resolves once per process and
 * `db.ts` opens its database at import time. The probe prints `policyFor`'s real
 * return value, so this asserts the decision rather than restating the regex.
 *
 *   node --test server/test/approvals-policy.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_tools-probe.mjs');
const root = path.dirname(path.dirname(here));
const tsx = path.join(root, 'node_modules/.bin/tsx');

/** Ask a fresh process what `policyFor` decides for each case. */
async function decide(cases, { seed } = {}) {
  const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'hq-policy-')), 'test.db');
  const { stdout } = await run(tsx, [probe, 'policy', JSON.stringify({ cases, seed })], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, SESSION_SECRET: 'test-secret-not-a-real-one' },
    timeout: 120_000,
  });
  const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
  assert.ok(line, `probe printed no result. stdout:\n${stdout}`);
  const parsed = JSON.parse(line.slice('@@PROBE@@'.length));
  assert.equal(parsed.ok, true, `probe failed: ${parsed.error}`);
  return parsed.decisions;
}

const one = async (name, args = {}, opts) => (await decide([{ name, args }], opts))[0];

test('a read-only slug needs no approval', async () => {
  const d = await one('SLACK_LIST_CHANNELS');
  assert.equal(d.decision, 'allow', JSON.stringify(d));
});

test('a slug with both a read and a write verb still asks', async () => {
  // `CHECK` is a read word; `CREATE` is a write word. The read word used to win.
  const d = await one('GITHUB_CREATE_CHECK_RUN');
  assert.equal(d.decision, 'ask', JSON.stringify(d));
});

test('a plain write asks', async () => {
  const d = await one('GMAIL_SEND_EMAIL');
  assert.equal(d.decision, 'ask', JSON.stringify(d));
});

test('a MULTI_EXECUTE batch asks for its write members', async () => {
  const d = await one('COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [{ tool_slug: 'GMAIL_LIST_THREADS' }, { tool_slug: 'GMAIL_SEND_EMAIL' }],
  });
  assert.equal(d.decision, 'ask', JSON.stringify(d));
  assert.equal(d.key, 'GMAIL_SEND_EMAIL');
});

test('a MULTI_EXECUTE batch with unparseable arguments fails closed', async () => {
  // No `tools`/`tool_calls`/`actions` array, so no inner slug can be read. This used
  // to return `allow`, because the gate only ever looked at the inner slugs.
  const d = await one('COMPOSIO_MULTI_EXECUTE_TOOL', { garbage: true });
  assert.equal(d.decision, 'ask', JSON.stringify(d));
  assert.equal(d.key, 'COMPOSIO_MULTI_EXECUTE_TOOL');
});

test('the remote workbench asks regardless of what its arguments look like', async () => {
  // It can call any app action from code, so the word list an earlier version matched
  // on was the wrong question: "does this text mention composio" is not a safety property.
  const d = await one('COMPOSIO_REMOTE_WORKBENCH', { code: 'return 1' });
  assert.equal(d.decision, 'ask', JSON.stringify(d));
});

test('discovery meta tools stay free, because they only describe tools', async () => {
  for (const name of ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS']) {
    const d = await one(name, { query: 'gmail' });
    assert.equal(d.decision, 'allow', `${name}: ${JSON.stringify(d)}`);
  }
});

test('a stored block policy beats the read-only default', async () => {
  // Not a regex question: `blocked` has to win over `always_allow`, or a user cannot
  // turn off a read they no longer want.
  const d = await one('GMAIL_LIST_THREADS', {}, {
    seed: "INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES('u1','GMAIL_LIST_THREADS','blocked')",
  });
  assert.equal(d.decision, 'block', JSON.stringify(d));
});
