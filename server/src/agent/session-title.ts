/**
 * A short title for a conversation, taken from its opening exchange.
 *
 * Ported from Nakama's `packages/agent/src/session-title.ts`. Its version walks a
 * `ChatMessage` union looking for text parts; grokbot's transcript is already text,
 * so the only real work left is the part that matters: **never fail**.
 *
 * A title is cosmetic. It is not worth a failed request, a thrown turn, or a chat
 * list that shows nothing because the model was rate-limited. So this module has
 * exactly one hard rule: every path returns a usable string, and the model is an
 * optimisation on top of a deterministic fallback.
 */

/** How much of the opening message is used as the fallback and as model context. */
export const SNIPPET_MAX_LENGTH = 500;

/** The fallback title never exceeds this, so it fits a sidebar row. */
export const FALLBACK_TITLE_MAX_LENGTH = 60;

export const SESSION_TITLE_SYSTEM = [
  'You write short titles for chat conversations.',
  'Given the opening user message and assistant reply, return a plain 3-5 word phrase that captures the topic.',
  '',
  'Rules:',
  '- Return only the title text',
  '- No quotes, markdown, punctuation at the ends, or JSON',
  '- Use title case when natural',
  '- Do not mention the assistant or that this is a chat title',
].join('\n');

export type GenerateTitle = (input: { system: string; prompt: string }) => Promise<string>;

export function truncateSnippet(value: string, maxLength = SNIPPET_MAX_LENGTH): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trimEnd()}…`;
}

/**
 * Strip what a model tends to add anyway: wrapping quotes, a leading "Title:",
 * markdown emphasis, and trailing period. Applied to the model's reply AND to the
 * fallback, so both look the same in the sidebar.
 */
export function normaliseTitle(raw: string): string {
  let title = raw.trim();
  title = title.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  title = title.replace(/^title\s*:\s*/i, '');
  title = title.replace(/^\*+|\*+$/g, '');
  // Trailing punctuation before the quote strip, so `"Deploying.` loses both.
  title = title.replace(/[.!?。]+$/, '');
  title = title.replace(/["'“”‘’`]+/g, '');
  title = title.replace(/\s+/g, ' ').trim();
  return title;
}

/** First few words, title-cased, for when the model is unavailable. */
export function fallbackTitle(userText: string): string {
  const snippet = truncateSnippet(userText);
  // Cut on a word boundary so the fallback does not end mid-word. A single
  // unbroken token (a URL, a base64 blob, a 500-char paste) has no boundary, so it
  // is hard-cut: the sidebar width matters more than the last character.
  const words = snippet.split(/\s+/).filter(Boolean);
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > FALLBACK_TITLE_MAX_LENGTH) break;
    out = next;
  }
  if (!out) out = snippet.slice(0, FALLBACK_TITLE_MAX_LENGTH).trimEnd();
  const title = capitalise(normaliseTitle(out || snippet));
  return title || 'New chat';
}

/** Uppercase the first letter, leave the rest alone: `fix login` -> `Fix login`. */
function capitalise(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
}

export interface TitleInput {
  userText: string;
  assistantText: string;
  generate: GenerateTitle;
  /** Called with the failure, for logging. Never rethrown. */
  onError?: (error: unknown) => void;
}

/**
 * Title for a conversation, or a decent fallback. Never throws.
 *
 * The model sees the same 500-character snippet the fallback uses: a longer prompt
 * buys nothing (the topic is in the first sentence) and costs tokens on a call that
 * already runs once per conversation.
 */
export async function generateSessionTitle(input: TitleInput): Promise<string> {
  const user = truncateSnippet(input.userText);
  const assistant = truncateSnippet(input.assistantText);
  if (!user) return 'New chat';

  try {
    const reply = await input.generate({
      system: SESSION_TITLE_SYSTEM,
      prompt: [
        'Opening user message:',
        user,
        '',
        'Assistant reply:',
        assistant || '(no reply yet)',
      ].join('\n'),
    });
    const title = normaliseTitle(reply);
    // A model that answers with punctuation, an empty string, or the literal word
    // "title" is worse than the fallback, so keep the fallback in that case.
    if (title.length > 0 && /\p{L}/u.test(title)) return title.slice(0, FALLBACK_TITLE_MAX_LENGTH * 2);
  } catch (error) {
    input.onError?.(error);
  }

  return fallbackTitle(user);
}
