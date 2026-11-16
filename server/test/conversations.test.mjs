/**
 * Conversation titles: storage, the fallback, and the "never fail a turn" rule.
 *
 * The failure this guards is not a wrong title, it is a *missing* one: a list where
 * every row says "New chat", or a turn that failed because naming it threw. Each
 * case below is a way that happens in practice.
 *
 * Runs against a throwaway database, so it does not touch a real install.
 *
 *   node --test server/test/conversations.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

// env.ts resolves once, so the database path has to be set before any import of it.
process.env.DB_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'hq-conv-')), 'test.db');
process.env.SESSION_SECRET = 'test-secret-not-a-real-one';

const { db } = await import('../src/db.ts');
const { conversationGenerations, firstExchange, getConversation, listConversations, setConversationTitle } = await import('../src/conversations.ts');

const BOT = 'bot_test';

function seedBot() {
  db.prepare('INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'u@example.com', 'Sam', Date.now());
  db.prepare('INSERT OR IGNORE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(BOT, 'u1', 'Doug', Date.now(), Date.now());
}

function addMessage(generation, seq, role, text) {
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(BOT, generation, seq, seq, 'message', JSON.stringify({ type: 'message', role, text }), Date.now());
}

seedBot();

test('a conversation with no stored title simply has no row', () => {
  assert.equal(getConversation(BOT, 1), null, 'nothing is invented for a conversation nobody named');
  assert.deepEqual(listConversations(BOT), []);
});

test('a title is stored once and replaced on re-title, never duplicated', () => {
  setConversationTitle(BOT, 1, 'Deploy the app', 'model');
  assert.equal(getConversation(BOT, 1).title, 'Deploy the app');
  setConversationTitle(BOT, 1, 'Deploy to staging', 'model');
  const all = listConversations(BOT).filter((c) => c.generation === 1);
  assert.equal(all.length, 1, 'one row per (bot, generation)');
  assert.equal(all[0].title, 'Deploy to staging');
});

test('the source is recorded, so a wrong title can be traced to the model or the fallback', () => {
  setConversationTitle(BOT, 2, 'Fallback title', 'fallback');
  assert.equal(getConversation(BOT, 2).source, 'fallback');
  setConversationTitle(BOT, 3, 'Model title', 'model');
  assert.equal(getConversation(BOT, 3).source, 'model');
});

test('a title is capped so one long model reply cannot break the list layout', () => {
  setConversationTitle(BOT, 4, 'x'.repeat(500), 'model');
  assert.equal(getConversation(BOT, 4).title.length, 120);
});

test('conversations are listed newest generation first', () => {
  const generations = listConversations(BOT).map((c) => c.generation);
  assert.deepEqual(generations, [...generations].sort((a, b) => b - a));
});

test('the first exchange is read from what the person actually saw', () => {
  addMessage(10, 1, 'user', 'how do I deploy this');
  addMessage(10, 2, 'assistant', 'run the pack script');
  addMessage(10, 3, 'user', 'and then');
  assert.deepEqual(firstExchange(BOT, 10), { user: 'how do I deploy this', assistant: 'run the pack script' });
});

test('a conversation with only a user message has no assistant half yet', () => {
  addMessage(11, 1, 'user', 'just asking');
  assert.deepEqual(firstExchange(BOT, 11), { user: 'just asking', assistant: '' });
});

test('an empty generation returns empty strings rather than throwing', () => {
  assert.deepEqual(firstExchange(BOT, 999), { user: '', assistant: '' });
});

test('generations come from rows, so a conversation that predates this feature still lists', () => {
  addMessage(20, 1, 'user', 'old conversation');
  assert.ok(conversationGenerations(BOT).includes(20), 'no conversation is missing from the index');
});

test('a malformed row body does not break the first exchange', () => {
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(BOT, 30, 1, 1, 'message', 'not json at all', Date.now());
  assert.deepEqual(firstExchange(BOT, 30), { user: '', assistant: '' }, 'garbage in a row is not a crash');
});
