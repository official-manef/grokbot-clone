/**
 * Renaming a conversation, asserted at the route the browser actually calls.
 *
 * This file used to import `setConversationTitle` and re-implement the PATCH
 * handler's trim-and-delete in two local helpers (`applyRename`, `clear`). That
 * made it a test of its own copy: removing `body.title.trim()` from `routes.ts`, or
 * dropping the `DELETE` that the clear branch performs, left all seven cases green.
 * Both were verified by mutation against this tree before the rewrite.
 *
 * Now every case drives `api.request('/bots/:id/conversations/:generation')`, the
 * same entry the list UI uses, in a child process (env.ts and the db handle resolve
 * once per process). Fixtures are only the bot and the `rows` the fallback title
 * reads; the decide-and-store path is the route's.
 *
 * Not covered here: the browser UI (inline input, Esc cancels, F2). That is
 * `web/` behaviour and is checked by hand; see the note at the bottom of
 * `docs/CONTINUE.md`. What a route bug could do to it — a blank title, a second
 * row — is what this file pins down.
 *
 *   node --test server/test/conversation-rename.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_conversation-rename-probe.mjs');

/**
 * Run the probe in its own process. The env is the minimum that boots `routes.ts`
 * without a model, a desktop, or a network call; `ALLOWED_EMAIL_DOMAINS` is what
 * lets the two sign-in calls through the staff wall.
 */
function probeOnce() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe],
      {
        cwd: path.join(here, '..'),
        env: {
          ...process.env,
          SESSION_SECRET: 'test-secret',
          DB_PATH: path.join(os.tmpdir(), `grokbot-rename-probe-${process.pid}-${Date.now()}.db`),
          ALLOWED_EMAIL_DOMAINS: 'antinrml.com',
          ALLOWED_EMAILS: '',
          AUTH_PASSWORD: '',
          AUTH_PASSWORD_HASH: '',
          AUTH_PROVIDER: '',
          DEV_LOGIN: '',
          DESKTOP_MODE: 'disabled',
          HERMES_BIN: '/bin/false',
          GROKBOT_NO_SCHEDULER: '1',
          XAI_API_KEY: 'test-key',
          COMPOSIO_API_KEY: '',
          WORKOS_API_KEY: '',
          WORKOS_CLIENT_ID: '',
          APP_URL: 'http://localhost:5173',
          SERVER_URL: 'http://localhost:8787',
          NODE_ENV: '',
          TRUSTED_PROXY_HOPS: '1',
        },
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const marked = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
        if (!marked) return reject(new Error(`probe printed no result\nstdout: ${stdout.slice(-800)}\nstderr: ${stderr.slice(-800)}\n${error ?? ''}`));
        try {
          resolve(JSON.parse(marked.slice('@@PROBE@@'.length)));
        } catch (e) {
          reject(new Error(`probe result was not JSON: ${marked.slice(0, 200)}`));
        }
      },
    );
  });
}

// One probe run: it is a single process boot, and the cases are ordered inside it
// (a rename needs the row a previous case left). Splitting by test would boot N times.
const result = await probeOnce();
const c = result.cases;

test('a rename is stored, and attributed to the person rather than the fallback', () => {
  assert.equal(c.rename.status, 200);
  assert.equal(c.rename.body.title, 'Payments deploy');
  assert.equal(c.rename.body.source, 'model', 'a human-typed name is not marked as a fallback');
  assert.deepEqual(c.renameRow, { title: 'Payments deploy', source: 'model' });
});

test('renaming twice replaces rather than duplicating the row', () => {
  assert.equal(c.secondRenameRows, 1, 'one conversation must not accumulate rows');
  assert.equal(c.secondRenameRow.title, 'Payments deploy v2');
});

test('whitespace-only takes the clearing branch, so no blank title is stored', () => {
  assert.equal(c.whitespace.status, 200);
  assert.equal(c.whitespace.body.source, 'fallback');
  assert.equal(c.whitespace.body.title, 'How do I deploy the payments service to staging');
  assert.equal(
    c.whitespaceRow,
    undefined,
    'the route must DELETE the row; a surviving row means the list shows the old name after a clear',
  );
});

test('an empty title takes the same clearing branch', () => {
  assert.equal(c.empty.body.source, 'fallback');
  assert.equal(c.empty.body.title, 'How do I deploy the payments service to staging');
  assert.equal(c.emptyRow, undefined);
});

test('a non-string title is refused, not coerced into the row', () => {
  assert.equal(c.notAString.status, 400);
  assert.equal(c.missingTitle.status, 400);
});

test('a very long rename is capped by the route, so the row cannot break the layout', () => {
  assert.equal(c.capRow.title.length, 120);
  assert.equal(c.capRow.source, 'model');
});

test('a generation the bot does not have is a 404, not a place to plant a row', () => {
  assert.equal(c.unknownGeneration.status, 404);
});

test('renaming one conversation does not touch another bot', () => {
  assert.deepEqual(c.isolation.first, { title: 'Only the first', source: 'model' });
  assert.deepEqual(c.isolation.second, { title: 'Only the second', source: 'model' });
});

test("another account cannot rename a bot it does not own", () => {
  assert.equal(c.foreignBot.status, 404, 'ownership must be checked before the write, and must look like absence');
});

test('the list endpoint never surfaces a blank title after a clear', () => {
  assert.equal(c.list.status, 200);
  const [row] = c.list.body.conversations;
  assert.ok(row, 'the conversation must still be listed');
  assert.equal(row.title, 'How do I deploy the payments service to staging');
  assert.equal(row.source, 'fallback');
  assert.doesNotMatch(row.title, /^\s*$/);
});
