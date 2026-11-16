/**
 * Fitting a voice-call transcript into a prompt.
 *
 * The previous code did `lines.slice(-12_000)`, which throws away the beginning of
 * the conversation — the part that usually says what the call was about — and can
 * cut a sentence in half. This keeps the opening line, drops the oldest middle
 * exchanges, and marks what it removed, so a summary of a long call is still a
 * summary of that call rather than of its last ten minutes.
 *
 * Pure and dependency-free so it is testable without a model.
 */

/** Characters the summariser prompt allows for the transcript. */
export const TRANSCRIPT_BUDGET = 12_000;

/** How much of the opening line always survives, however long the call. */
export const OPENING_KEEP = 600;

export interface TranscriptLine {
  role: string;
  text: string;
}

/**
 * The transcript as one block, trimmed to `budget` characters without losing the
 * opening.
 *
 * Rules, in order:
 *   1. A transcript that already fits is returned verbatim. Short calls must be
 *      untouched — the old behaviour was correct there.
 *   2. The FIRST line is always kept (truncated to OPENING_KEEP if it alone is huge),
 *      because it is what the call was about.
 *   3. The newest lines are kept from the end until the budget is spent.
 *   4. Whatever dropped out of the middle is replaced by one explicit marker, so the
 *      summariser knows it is looking at a gap rather than a continuous call.
 */
export function compactCallTranscript(
  transcript: readonly TranscriptLine[],
  rendered: string,
  botName: string,
  budget = TRANSCRIPT_BUDGET,
): string {
  if (rendered.length <= budget) return rendered;
  if (transcript.length === 0) return rendered.slice(-budget);

  const line = (t: TranscriptLine) => `${t.role === 'user' ? 'User' : botName}: ${t.text}`;

  const first = line(transcript[0]!);
  // The `User: ` prefix is part of what the prompt receives, so the budget for the
  // opening text is what is left after it. Counting only the text let a capped
  // opening overshoot the total by the prefix length.
  const openingPrefix = first.slice(0, first.length - transcript[0]!.text.length);
  const openingBudget = Math.max(0, OPENING_KEEP - openingPrefix.length);
  const opening = first.length <= OPENING_KEEP
    ? first
    : `${openingPrefix}${transcript[0]!.text.slice(0, openingBudget).trimEnd()}…`;

  // Newest first, so the most recent exchange is always the first thing kept. The
  // marker is reserved up front: adding it after the budget was spent pushed the
  // result over the limit by the marker's length.
  const markerReserve = 64;
  const kept: string[] = [];
  let used = opening.length + markerReserve;
  for (let i = transcript.length - 1; i > 0; i -= 1) {
    const next = line(transcript[i]!);
    if (used + next.length + 1 > budget) break;
    kept.unshift(next);
    used += next.length + 1;
  }

  const omitted = transcript.length - 1 - kept.length;
  if (kept.length === 0) return opening;
  const marker = `[… ${omitted} earlier ${omitted === 1 ? 'line' : 'lines'} omitted …]`;
  return [opening, marker, ...kept].join('\n');
}
