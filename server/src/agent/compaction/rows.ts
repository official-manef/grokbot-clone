/**
 * Compaction against a live conversation.
 *
 * The arithmetic and the summariser are tested on their own; this is the seam that
 * turns grokbot's transcript rows into the `TurnMessage` view and back, and the
 * only part that would touch the store.
 *
 * Rows, not a ChatMessage union: grokbot keeps what it shows (messages, tool calls,
 * cards, notices) and Hermes keeps the model's real history. So a compaction here
 * is about the *displayed* conversation staying readable after Hermes has already
 * compacted its own — the two are deliberately separate, and this file must never
 * pretend to be the model's memory.
 */

import type { Row } from '../../types.js';
import { compactHistory, type CompactionResult, type Summarize } from './compaction.js';
import type { CompactionConfig, TurnMessage } from './context.js';

/**
 * Rows to turns. Cards, events and notices are dropped: they are app chrome, and
 * carrying them into a summary would describe buttons rather than work.
 */
export function rowsToTurns(rows: readonly Row[]): TurnMessage[] {
  const turns: TurnMessage[] = [];
  for (const row of rows) {
    const body = row.body;
    if (body.type === 'message') {
      turns.push({ role: body.role, text: body.text });
      continue;
    }
    if (body.type === 'tool-call') {
      // A tool call is context for the assistant's reasoning, not a turn of its own.
      // The summary it produces is what matters, and the status is what says whether
      // the result can be trusted.
      const detail = [body.name, body.status, body.summary].filter(Boolean).join(' · ');
      turns.push({ role: 'tool', text: detail || body.label });
    }
  }
  return turns;
}

/** Turns back to the minimum a caller can render: a message row per turn. */
export function turnsToMessages(turns: readonly TurnMessage[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  return turns
    .filter((t) => t.role !== 'tool')
    .map((t) => ({ role: t.role as 'user' | 'assistant', text: t.text }));
}

export interface CompactRowsInput {
  rows: readonly Row[];
  systemPrompt: string;
  toolDefinitionsJson?: string;
  compaction: CompactionConfig;
  summarize: Summarize;
  force?: boolean;
}

export async function compactRows(input: CompactRowsInput): Promise<CompactionResult> {
  return compactHistory({
    history: rowsToTurns(input.rows),
    systemPrompt: input.systemPrompt,
    ...(input.toolDefinitionsJson !== undefined ? { toolDefinitionsJson: input.toolDefinitionsJson } : {}),
    compaction: input.compaction,
    summarize: input.summarize,
    ...(input.force !== undefined ? { force: input.force } : {}),
  });
}
