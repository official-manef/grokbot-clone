import { query, mutation } from './_generated/server';
import { v } from 'convex/values';

/**
 * Functions backing the tables in schema.ts. Kept deliberately small: this deployment
 * is a durable side-channel, not the primary store. See the note in schema.ts.
 */

export const bot = query({
  args: { botId: v.string() },
  handler: async (ctx, { botId }) =>
    (await ctx.db.query('bots').withIndex('by_bot', (q) => q.eq('botId', botId)).unique()) ?? null,
});

export const upsertBot = mutation({
  args: { botId: v.string(), ownerId: v.string(), name: v.string(), label: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query('bots').withIndex('by_bot', (q) => q.eq('botId', args.botId)).unique();
    const row = { ...args, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, row);
      return existing._id;
    }
    return ctx.db.insert('bots', row);
  },
});

export const recentEvents = query({
  args: { botId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { botId, limit }) => {
    const n = Math.min(Math.max(limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query('events')
      .withIndex('by_bot_at', (q) => q.eq('botId', botId))
      .order('desc')
      .take(n);
    return rows;
  },
});

export const logEvent = mutation({
  args: { botId: v.string(), kind: v.string(), detail: v.string(), ok: v.boolean() },
  handler: async (ctx, args) => ctx.db.insert('events', { ...args, at: Date.now() }),
});

/** Enqueue work; `nextAttemptAt` lets a drainer implement backoff without a scheduler. */
export const enqueue = mutation({
  args: { botId: v.string(), payload: v.string() },
  handler: async (ctx, { botId, payload }) =>
    ctx.db.insert('outbox', { botId, payload, attempts: 0, nextAttemptAt: Date.now() }),
});

/** Claim the next due item, bumping its attempt counter. Returns null when idle. */
export const claimNext = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query('outbox')
      .withIndex('by_pending', (q) => q.eq('doneAt', undefined).lte('nextAttemptAt', now))
      .first();
    if (!due) return null;
    await ctx.db.patch(due._id, { attempts: due.attempts + 1, nextAttemptAt: now + Math.min(60_000, 2 ** due.attempts * 1000) });
    return due;
  },
});

export const complete = mutation({
  args: { id: v.id('outbox') },
  handler: async (ctx, { id }) => ctx.db.patch(id, { doneAt: Date.now() }),
});
