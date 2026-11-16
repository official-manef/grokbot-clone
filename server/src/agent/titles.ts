/**
 * Naming a conversation once, after its first exchange.
 *
 * The title is cosmetic, so this module is written to be impossible to blame for
 * anything else: it runs after the turn has already been delivered, it never throws,
 * and it does nothing at all the second time it is called for the same generation.
 *
 * Why "once, after the first exchange": that is when there is exactly enough text to
 * name the conversation, and naming it later would mean a list where every row says
 * "New chat" until the person happens to send another message.
 */

import { firstExchange, getConversation, setConversationTitle } from '../conversations.js';
import { fallbackTitle, generateSessionTitle } from './session-title.js';
import { llm, model as llmModel } from '../providers/llm.js';
import { llmConfigured } from '../env.js';

/**
 * Ask the configured endpoint for a title. Returns the fallback when there is no
 * endpoint or the call fails, so a deployment without a model still gets titles.
 */
async function modelTitle(user: string, assistant: string): Promise<{ title: string; source: 'model' | 'fallback' }> {
  if (!llmConfigured()) return { title: fallbackTitle(user), source: 'fallback' };
  try {
    return await generateSessionTitle({
      userText: user,
      assistantText: assistant,
      generate: async ({ system, prompt }) => {
        const res: any = await llm().responses.create({
          model: llmModel(),
          // A title is one short phrase: low effort keeps the cost of this feature
          // negligible against a turn that already spent real tokens.
          reasoning: { effort: 'low' },
          store: false,
          input: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        } as any);
        return String(res.output_text ?? '');
      },
      // Nowhere to report to: a failed title is not an error the person can act on.
      onError: (e) => console.warn(`[titles] model title failed: ${e instanceof Error ? e.message : e}`),
    }).then((title) => ({ title, source: 'model' as const }));
  } catch {
    return { title: fallbackTitle(user), source: 'fallback' };
  }
}

/**
 * Title this bot's CURRENT generation if it has no title yet and has an exchange to
 * name it after. Safe to call after every turn: the second call is one SELECT.
 */
export async function maybeTitleConversation(botId: string, generation: number): Promise<void> {
  try {
    const existing = getConversation(botId, generation);
    if (existing?.title) return;

    const { user, assistant } = firstExchange(botId, generation);
    if (!user.trim()) return; // nothing to name yet

    const { title, source } = await modelTitle(user, assistant);
    if (!title.trim()) return;
    setConversationTitle(botId, generation, title, source);
  } catch (e) {
    // A title must never surface as a failed turn.
    console.warn(`[titles] could not title ${botId} g${generation}: ${e instanceof Error ? e.message : e}`);
  }
}
