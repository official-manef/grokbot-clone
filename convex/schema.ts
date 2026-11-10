import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Convex Cloud deployment for grok.antinrml.com.
 *
 * Scope, stated honestly: grokbot-clone keeps its own state — users, bots, transcript
 * rows, model history, routines, memories, computers — in a local SQLite database
 * (server/src/db.ts). That is a single-writer design and works well on one host, so the
 * Convex deployment is NOT a second copy of it and nothing reads from it at runtime yet.
 *
 * What it is for: the durable, multi-device state that a per-host SQLite file cannot
 * serve — telemetry-free usage counters, shared bot templates, and an outbox for events
 * that outlive the process. The tables below are the contract for that work; push them
 * now so the deployment is real and addressable rather than an empty project.
 */
export default defineSchema({
  /** One row per bot, mirroring the host so a bot's identity is stable across machines. */
  bots: defineTable({
    botId: v.string(),
    ownerId: v.string(),
    name: v.string(),
    label: v.string(),
    updatedAt: v.number(),
  }).index('by_bot', ['botId']).index('by_owner', ['ownerId']),

  /** Append-only activity log: what a bot did, when, and whether it succeeded. */
  events: defineTable({
    botId: v.string(),
    kind: v.string(),
    detail: v.string(),
    ok: v.boolean(),
    at: v.number(),
  }).index('by_bot_at', ['botId', 'at']),

  /** Durable queue for work that must survive a restart of the host process. */
  outbox: defineTable({
    botId: v.string(),
    payload: v.string(),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    doneAt: v.optional(v.number()),
  }).index('by_pending', ['doneAt', 'nextAttemptAt']),

  /** Reusable bot definitions a user can start from. */
  templates: defineTable({
    slug: v.string(),
    name: v.string(),
    instructions: v.string(),
    authorId: v.string(),
    createdAt: v.number(),
  }).index('by_slug', ['slug']),
});
