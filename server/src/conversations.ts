import { db, now } from './db.js';
import type { Conversation } from './types.js';

/**
 * One row per conversation, i.e. per (bot, generation).
 *
 * `bots.generation` already IS the conversation counter: "New chat" bumps it and
 * starts another Hermes thread. What was missing is a place to remember what each
 * generation was about, because the rows themselves only say what was said.
 *
 * A row is created lazily: a conversation that never got a title simply has no row,
 * and the UI falls back to the first message. That keeps the table small and means
 * this feature cannot break a conversation that predates it.
 *
 * Why not a column on `bots`: a bot has one current generation but many past ones,
 * so a column would lose history the moment "New chat" is pressed — which is exactly
 * the history a conversation list is for.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  /** How the title was produced: 'model' or 'fallback'. For debugging a bad title. */
  source TEXT NOT NULL DEFAULT 'fallback',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, generation)
);
`);

// `Conversation` is declared in types.ts (the web imports it too), re-exported
// here so server callers have one import path.
export type { Conversation };

function toConversation(r: any): Conversation {
  return {
    botId: r.bot_id,
    generation: r.generation,
    title: r.title,
    source: r.source === 'model' ? 'model' : 'fallback',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Titles for this bot, newest conversation first. */
export function listConversations(botId: string): Conversation[] {
  return (db
    .prepare('SELECT * FROM conversations WHERE bot_id=? ORDER BY generation DESC')
    .all(botId) as any[]).map(toConversation);
}

export function getConversation(botId: string, generation: number): Conversation | null {
  const r = db.prepare('SELECT * FROM conversations WHERE bot_id=? AND generation=?').get(botId, generation) as any;
  return r ? toConversation(r) : null;
}

/**
 * Store a title. Insert-or-update so a re-title replaces the old text without
 * creating a second row for the same conversation.
 */
export function setConversationTitle(
  botId: string,
  generation: number,
  title: string,
  source: 'model' | 'fallback',
): Conversation {
  const clean = title.trim().slice(0, 120);
  db.prepare(
    `INSERT INTO conversations(bot_id,generation,title,source,created_at,updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(bot_id,generation) DO UPDATE SET title=excluded.title, source=excluded.source, updated_at=excluded.updated_at`,
  ).run(botId, generation, clean, source, now(), now());
  return getConversation(botId, generation)!;
}

/**
 * What this conversation opened with, for a fallback title: the first user message
 * and the first assistant reply, in that order.
 *
 * Read from `rows` rather than from the model's history on purpose — this app keeps
 * what it shows, and a title has to describe what the person sees.
 */
export function firstExchange(botId: string, generation: number): { user: string; assistant: string } {
  const user = db
    .prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' AND seq=(SELECT MIN(seq) FROM rows WHERE bot_id=? AND generation=? AND kind='message')")
    .get(botId, generation, botId, generation) as any;
  const assistant = db
    .prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' AND seq>(SELECT MIN(seq) FROM rows WHERE bot_id=? AND generation=? AND kind='message') ORDER BY seq ASC LIMIT 1")
    .get(botId, generation, botId, generation) as any;

  const text = (raw: any): string => {
    if (!raw) return '';
    try {
      const body = JSON.parse(raw.body);
      return body?.type === 'message' && typeof body.text === 'string' ? body.text : '';
    } catch {
      return '';
    }
  };
  return { user: text(user), assistant: text(assistant) };
}

/** Every distinct generation this bot has rows for, newest first. */
export function conversationGenerations(botId: string): number[] {
  return (db
    .prepare('SELECT DISTINCT generation FROM rows WHERE bot_id=? ORDER BY generation DESC')
    .all(botId) as any[]).map((r) => r.generation as number);
}
