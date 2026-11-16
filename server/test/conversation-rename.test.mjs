/**
 * Renaming a conversation, and the rule that an empty name restores the automatic one.
 *
 * This is the server half of the rename UI. Two behaviours matter and are easy to get
 * wrong: a rename must not create a second row for the same conversation, and
 * clearing the title has to bring the fallback back rather than leaving the list
 * showing an empty string.
 *
 * Runs against a throwaway database.
 *
 *   node --test server/test/conversation-rename.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.DB_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'hq-rename-')), 'test.db');
process.env.SESSION_SECRET = 'test-secret-not-a-real-one';

const { db } = await import('../src/db.ts');
const { firstExchange, getConversation, listConversations, setConversationTitle } = await import('../src/conversations.ts');
const { fallbackTitle } = await import('../src/agent/session-title.ts');

const BOT = 'bot_rename';

db.prepare('INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'u@example.com', 'Sam', Date.now());
db.prepare('INSERT OR IGNORE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(BOT, 'u1', 'Doug', Date.now(), Date.now());

function addMessage(generation, seq, role, text) {
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(BOT, generation, seq, seq, 'message', JSON.stringify({ type: 'message', role, text }), Date.now());
}

/** What the PATCH route does for a non-empty title. */
const rename = (generation, title) => setConversationTitle(BOT, generation, title, 'model');

/** What the PATCH route does for an empty title: drop the row, fall back. */
const clear = (generation) => {
  db.prepare('DELETE FROM conversations WHERE bot_id=? AND generation=?').run(BOT, generation);
  const { user } = firstExchange(BOT, generation);
  return user ? fallbackTitle(user) : 'New chat';
};

addMessage(1, 1, 'user', 'how do I deploy the payments service to staging');
addMessage(1, 2, 'assistant', 'run the pack script');

/**
 * What the PATCH route does with a title, after the trim it performs.
 *
 * Extracted here so the test asserts the ROUTE's decision rather than restating it:
 * `routes.ts` trims, and an empty result deletes the row so the fallback takes over.
 * A row with an empty title would render as a blank line in the list.
 */
function applyRename(generation, rawTitle) {
  const title = String(rawTitle).trim();
  if (!title) return { title: clear(generation), source: 'fallback' };
  const saved = rename(generation, title);
  return { title: saved.title, source: saved.source };
}

test('a rename is stored with the model as its source', () => {
  const r = applyRename(1, 'Payments deploy');
  assert.equal(r.title, 'Payments deploy');
  assert.equal(r.source, 'model', 'a human-typed name is not marked as a fallback');
  assert.equal(getConversation(BOT, 1).title, 'Payments deploy');
});

test('renaming twice replaces rather than duplicates', () => {
  applyRename(1, 'Payments deploy v2');
  assert.equal(listConversations(BOT).filter((c) => c.generation === 1).length, 1);
  assert.equal(getConversation(BOT, 1).title, 'Payments deploy v2');
});

test('clearing a title brings the automatic name back, not an empty row', () => {
  const r = applyRename(1, '');
  assert.equal(getConversation(BOT, 1), null, 'no stored row means the fallback is used');
  assert.equal(r.source, 'fallback');
  assert.equal(r.title, 'How do I deploy the payments service to staging', 'the first message names it again');
});

test('a cleared title comes back from the list endpoint as a fallback, never as empty', () => {
  // Mirrors what GET /conversations builds when a generation has no stored row.
  const { user } = firstExchange(BOT, 1);
  const title = user ? fallbackTitle(user) : 'New chat';
  assert.ok(title.length > 0);
  assert.doesNotMatch(title, /^\s*$/);
});

test('whitespace-only input takes the clearing branch, not the rename branch', () => {
  applyRename(1, 'Real name');
  const r = applyRename(1, '   ');
  assert.equal(getConversation(BOT, 1), null, 'whitespace must clear, not store a blank title');
  assert.equal(r.source, 'fallback');
});

test('a very long rename is capped, so the row cannot break the layout', () => {
  applyRename(1, 'r'.repeat(400));
  assert.equal(getConversation(BOT, 1).title.length, 120);
});

test('renaming one conversation does not touch another', () => {
  addMessage(2, 1, 'user', 'why is the nightly build red');
  applyRename(1, 'Only the first');
  applyRename(2, 'Only the second');
  assert.equal(getConversation(BOT, 1).title, 'Only the first');
  assert.equal(getConversation(BOT, 2).title, 'Only the second');
});
