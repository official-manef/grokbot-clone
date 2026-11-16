/**
 * Title generation must never be the reason a turn failed.
 *
 * `maybeTitleConversation` runs after the answer is already delivered, so every way
 * it can go wrong (no model configured, model throws, model returns garbage, a
 * second call for the same generation) has to end in "nothing happened" or "the
 * fallback was used" — never in a rejection.
 *
 * Runs against a throwaway database and with LLM_* unset, so no network is touched.
 *
 *   node --test server/test/titles.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.DB_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'hq-titles-')), 'test.db');
process.env.SESSION_SECRET = 'test-secret-not-a-real-one';
// No endpoint: the fallback path is the one that has to work everywhere.
delete process.env.LLM_BASE_URL;
delete process.env.LLM_API_KEY;

const { db } = await import('../src/db.ts');
const { getConversation, setConversationTitle } = await import('../src/conversations.ts');
const { maybeTitleConversation } = await import('../src/agent/titles.ts');

const BOT = 'bot_titles';

db.prepare('INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'u@example.com', 'Sam', Date.now());
db.prepare('INSERT OR IGNORE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(BOT, 'u1', 'Doug', Date.now(), Date.now());

function addMessage(generation, seq, role, text) {
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(BOT, generation, seq, seq, 'message', JSON.stringify({ type: 'message', role, text }), Date.now());
}

test('a generation with no exchange is left untitled rather than titled "nothing"', async () => {
  await maybeTitleConversation(BOT, 1);
  assert.equal(getConversation(BOT, 1), null, 'no message, no title');
});

test('with no model configured the fallback names the conversation', async () => {
  addMessage(2, 1, 'user', 'why is the build red');
  addMessage(2, 2, 'assistant', 'a test is flaky');
  await maybeTitleConversation(BOT, 2);
  const c = getConversation(BOT, 2);
  assert.ok(c, 'a title was stored');
  assert.equal(c.source, 'fallback', 'no endpoint was configured, so this cannot have come from a model');
  assert.match(c.title, /Why is the build red/);
});

test('calling it again is a no-op: a title is not regenerated on every turn', async () => {
  const before = getConversation(BOT, 2);
  addMessage(2, 3, 'user', 'another message later');
  await maybeTitleConversation(BOT, 2);
  const after = getConversation(BOT, 2);
  assert.equal(after.title, before.title, 'the name the person saw does not change under them');
  assert.equal(after.updatedAt, before.updatedAt, 'and it was not rewritten');
});

test('an existing title is respected even if it came from somewhere else', async () => {
  addMessage(3, 1, 'user', 'a message');
  setConversationTitle(BOT, 3, 'Renamed by hand', 'model');
  await maybeTitleConversation(BOT, 3);
  assert.equal(getConversation(BOT, 3).title, 'Renamed by hand', 'a rename is not overwritten');
});

test('it resolves instead of rejecting, whatever the database says', async () => {
  // A generation that does not exist must not throw: the caller fires this and
  // forgets it, so a rejection would become an unhandled promise rejection.
  await assert.doesNotReject(() => maybeTitleConversation('bot_does_not_exist', 1));
  await assert.doesNotReject(() => maybeTitleConversation(BOT, 99_999));
});
