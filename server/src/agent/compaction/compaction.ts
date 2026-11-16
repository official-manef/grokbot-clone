/**
 * Compact a conversation that no longer fits: prune oversized tool output, and if
 * that is not enough, replace the older half with a structured summary.
 *
 * Ported from Nakama's `history-compaction.ts`. The arithmetic and the cut point
 * live in `./context.ts`; this file owns the prompt and the one side effect a
 * compaction has (calling the model).
 *
 * Two properties this must hold, because losing either loses work:
 *
 *  1. The summariser runs OUTSIDE the caller's array. If the model call fails, the
 *     caller still has its history exactly as it was. Nakama learned this the hard
 *     way; the shape below makes it structural rather than a matter of care.
 *  2. Whatever the model returns is only accepted as a summary if it is non-empty.
 *     An empty reply appended as a "summary" would silently delete the conversation
 *     it was meant to describe.
 */

import {
  PRUNE_TRUNCATION,
  estimateTotal,
  findPreviousSummary,
  isOverflow,
  pruneToolOutputs,
  selectRange,
  withPruned,
  type CompactionConfig,
  type TurnMessage,
} from './context.js';

export const COMPACTION_SYSTEM =
  'You summarize conversation history for context continuity. Follow the user instructions exactly.';

export const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

/** How the model is called. Injected so this module needs no client and no network. */
export type Summarize = (input: { system: string; prompt: string }) => Promise<string>;

export interface CompactInput {
  history: readonly TurnMessage[];
  systemPrompt: string;
  toolDefinitionsJson?: string;
  compaction: CompactionConfig;
  summarize: Summarize;
  /** Compact even when the history still fits (a user asking for it). */
  force?: boolean;
}

export type CompactionAction = 'none' | 'pruned' | 'summarized';

export interface CompactionResult {
  action: CompactionAction;
  /** The history to use from now on. Unchanged reference-wise when action is 'none'. */
  history: TurnMessage[];
  messagesBefore: number;
  messagesAfter: number;
  prunedTokens?: number;
  /** Why the summary was not produced, when it was attempted. Never a silent no-op. */
  error?: string;
}

/** Build the instruction that asks for the summary, anchored to a previous one. */
export function buildCompactionPrompt(previousSummary?: string): string {
  const anchor = previousSummary
    ? [
        'Update the anchored summary below using the conversation history above.',
        'Preserve still-true details, remove stale details, and merge in the new facts.',
        '<previous-summary>',
        previousSummary,
        '</previous-summary>',
      ].join('\n')
    : 'Create a new anchored summary from the conversation history above.';
  return `${anchor}\n\n${SUMMARY_TEMPLATE}`;
}

/** The history as one block of text, which is what a summariser wants to read. */
function renderHistory(messages: readonly TurnMessage[]): string {
  return messages
    .map((m) => `${m.role === 'tool' ? 'tool result' : m.role}: ${m.text}`)
    .join('\n\n');
}

export async function compactHistory(input: CompactInput): Promise<CompactionResult> {
  const messagesBefore = input.history.length;

  // Step 1: drop oversized tool output. Cheap, lossless in meaning, and often enough.
  const prune = pruneToolOutputs(input.history, input.compaction);
  const pruned = prune.prunedTokens > 0 ? withPruned(input.history, prune.indexes) : [...input.history];

  const used = estimateTotal(pruned, input.systemPrompt, input.toolDefinitionsJson);
  if (!input.force && !isOverflow(used, input.compaction)) {
    return {
      action: prune.prunedTokens > 0 ? 'pruned' : 'none',
      history: pruned,
      messagesBefore,
      messagesAfter: pruned.length,
      ...(prune.prunedTokens > 0 ? { prunedTokens: prune.prunedTokens } : {}),
    };
  }

  // Step 2: summarise the head, keep the tail verbatim.
  const { head, tailStartIndex } = selectRange(pruned);
  if (head.length === 0) {
    // Everything is tail: there is nothing to summarise, and pretending otherwise
    // would replace the recent turns with a summary of nothing.
    return {
      action: prune.prunedTokens > 0 ? 'pruned' : 'none',
      history: pruned,
      messagesBefore,
      messagesAfter: pruned.length,
      ...(prune.prunedTokens > 0 ? { prunedTokens: prune.prunedTokens } : {}),
    };
  }

  const prompt = buildCompactionPrompt(findPreviousSummary(head));
  let summary = '';
  let error: string | undefined;
  try {
    summary = (await input.summarize({ system: COMPACTION_SYSTEM, prompt: `${renderHistory(head)}\n\n${prompt}` })).trim();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!summary) {
    // The model failed or answered nothing. Keep the history: a compaction that
    // drops turns without a summary is data loss dressed as housekeeping.
    return {
      action: prune.prunedTokens > 0 ? 'pruned' : 'none',
      history: pruned,
      messagesBefore,
      messagesAfter: pruned.length,
      ...(prune.prunedTokens > 0 ? { prunedTokens: prune.prunedTokens } : {}),
      error: error ?? 'summariser returned no text',
    };
  }

  const summaryMessage: TurnMessage = { role: 'assistant', text: summary, summary: true };
  const tail = pruned.slice(tailStartIndex);
  return {
    action: 'summarized',
    history: [summaryMessage, ...tail],
    messagesBefore,
    messagesAfter: 1 + tail.length,
    ...(prune.prunedTokens > 0 ? { prunedTokens: prune.prunedTokens } : {}),
  };
}

/** True when a message is the marker a previous prune left behind. */
export const isPruneMarker = (m: TurnMessage): boolean => m.text === PRUNE_TRUNCATION;
