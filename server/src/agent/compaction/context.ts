/**
 * Token accounting and pruning for a conversation that is about to outgrow the
 * model window.
 *
 * Ported from Nakama's `packages/agent/src/history-compaction.ts`. That module
 * operates on a `ChatMessage` union it does not own; grokbot only ever has to
 * decide "does this conversation still fit, and what can we drop without losing
 * meaning", so this half is written against a minimal local shape instead.
 *
 * Split from the summariser on purpose: this file is pure arithmetic over text and
 * can be tested with no model, no clock and no store. The prompt and the
 * orchestration live in `compaction.ts`.
 *
 * Why these numbers: the thresholds are fractions of the model's *usable* context
 * (window minus the output reservation), not absolute token counts, so a 32k window
 * reclaims space sooner than a 200k one while both keep short histories intact.
 */

/** One turn of a conversation, flattened. grokbot stores rows; this is the view. */
export interface TurnMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** Present on an assistant message that IS a previous summary. */
  summary?: boolean;
  /** Set on a tool result that was already truncated by a previous compaction. */
  truncated?: boolean;
}

export interface CompactionConfig {
  contextWindow: number;
  /** Room kept for the reply. Capped so a huge maxOutput does not eat the window. */
  maxOutputTokens: number;
}

/** Nakama's buffer, kept deliberately: it is the value its tests pin. */
export const COMPACTION_BUFFER = 20_000;

/** Fraction of usable context kept before pruning starts. */
export const PRUNE_PROTECT_FRACTION = 0.5;

/** Below this much reclaimed, pruning is not worth the information loss. */
export const PRUNE_MINIMUM_FRACTION = 0.1;

/** Turns kept verbatim at the end; the summary replaces everything before them. */
export const TAIL_TURNS = 2;

/** Characters per token. A rough ratio, not a tokenizer: it is only used to decide
 *  *when* to compact, and a 4x error still fires a few turns early or late. */
export const TOKEN_ESTIMATE_RATIO = 4;

export const PRUNE_TRUNCATION = '[output truncated by compaction]';

/** Text of a message, in tokens by the rough ratio. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_ESTIMATE_RATIO);
}

export function estimateMessageTokens(message: TurnMessage): number {
  // A truncated tool result is already summarised text; counting it again would
  // make a second compaction pass think nothing was reclaimed.
  if (message.truncated) return 0;
  return estimateTokens(message.text);
}

export interface TokenBreakdown {
  conversation: number;
  systemPrompt: number;
  toolDefinitions: number;
}

export function estimateBreakdown(
  messages: readonly TurnMessage[],
  systemPrompt: string,
  toolDefinitionsJson = '',
): TokenBreakdown {
  return {
    conversation: messages.reduce((total, m) => total + estimateMessageTokens(m), 0),
    systemPrompt: estimateTokens(systemPrompt),
    toolDefinitions: estimateTokens(toolDefinitionsJson),
  };
}

export function estimateTotal(
  messages: readonly TurnMessage[],
  systemPrompt: string,
  toolDefinitionsJson = '',
): number {
  const b = estimateBreakdown(messages, systemPrompt, toolDefinitionsJson);
  return b.systemPrompt + b.conversation + b.toolDefinitions;
}

/** Output reservation, capped so a large maxOutput cannot zero out the window. */
export function reservedTokens(maxOutputTokens: number): number {
  return Math.min(COMPACTION_BUFFER, Math.max(0, maxOutputTokens));
}

/**
 * The part of the window that history may occupy.
 *
 * Never negative. With a small window the fixed 20k buffer would otherwise exceed
 * the whole context and make `usableContextTokens` negative, which reads as "always
 * over budget" and fires compaction on a two-message conversation. Half the window
 * is the floor: below that there is no room for a summary plus a reply anyway.
 */
export function usableContextTokens(compaction: CompactionConfig): number {
  const window = Math.max(0, compaction.contextWindow);
  const reserved = Math.min(reservedTokens(compaction.maxOutputTokens), Math.floor(window / 2));
  return Math.max(0, window - reserved);
}

export function isOverflow(usedTokens: number, compaction: CompactionConfig): boolean {
  return usedTokens >= usableContextTokens(compaction);
}

export interface PruneResult {
  prunedTokens: number;
  /** Indexes that were replaced; the caller owns the array. */
  indexes: number[];
}

/**
 * Replace oversized tool output with a marker, oldest first, until the history
 * fits the protected fraction again.
 *
 * Scans backwards because the most recent tool output is the one still being
 * reasoned about: an old search result can be dropped, the screenshot the bot just
 * took cannot. Stops at the tail turns and at a previous summary, so pruning never
 * eats the part the summariser was going to keep anyway.
 *
 * Returns the indexes rather than mutating in place: a caller holding a copy (an
 * in-flight render, a test fixture) must not see its history change underneath it.
 */
export function pruneToolOutputs(
  messages: readonly TurnMessage[],
  compaction: CompactionConfig,
): PruneResult {
  const usable = usableContextTokens(compaction);
  if (usable <= 0) return { prunedTokens: 0, indexes: [] };

  const protect = Math.floor(usable * PRUNE_PROTECT_FRACTION);
  const minimum = Math.floor(usable * PRUNE_MINIMUM_FRACTION);

  let total = 0;
  let pruned = 0;
  let turns = 0;
  const indexes: number[] = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;

    if (message.role === 'user') turns += 1;
    if (turns < 2) continue;
    // A summary is the anchor for the next compaction; never prune past it.
    if (message.role === 'assistant' && message.summary) break;
    if (message.role !== 'tool') continue;
    if (message.truncated) break;

    const estimate = estimateMessageTokens(message);
    total += estimate;
    if (total <= protect) continue;

    pruned += estimate;
    indexes.push(i);
  }

  if (pruned <= minimum) return { prunedTokens: 0, indexes: [] };
  return { prunedTokens: pruned, indexes };
}

/** Apply a prune result by index, returning a new array. */
export function withPruned(messages: readonly TurnMessage[], indexes: readonly number[]): TurnMessage[] {
  const drop = new Set(indexes);
  return messages.map((m, i) => (drop.has(i) ? { ...m, text: PRUNE_TRUNCATION, truncated: true } : m));
}

export interface CompactionRange {
  head: TurnMessage[];
  tailStartIndex: number;
}

/**
 * Where to cut: everything before the last `tailTurns` user turns becomes the head
 * that gets summarised; the tail stays verbatim.
 *
 * A conversation with no more turns than the tail keeps nothing back, which the
 * caller reads as "nothing to do" rather than "summarise an empty conversation into
 * a summary of itself".
 */
export function selectRange(
  messages: readonly TurnMessage[],
  tailTurns = TAIL_TURNS,
): CompactionRange {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') starts.push(i);
  }
  if (starts.length <= tailTurns) return { head: [], tailStartIndex: 0 };
  const tailStartIndex = starts[starts.length - tailTurns]!;
  if (tailStartIndex <= 0) return { head: [], tailStartIndex: 0 };
  return { head: messages.slice(0, tailStartIndex), tailStartIndex };
}

/** The most recent assistant summary, which the next compaction extends. */
export function findPreviousSummary(messages: readonly TurnMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === 'assistant' && m.summary && m.text.trim()) return m.text.trim();
  }
  return undefined;
}
