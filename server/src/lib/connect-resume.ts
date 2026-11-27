/**
 * Whether an `/apps/callback` hit may resume a Bot, kept pure so the tested thing is
 * what the route runs.
 *
 * That route is unauthenticated by necessity (an OAuth popup returns with no fetch
 * headers we control), and resuming a Bot spends a real model turn. The old condition
 * was "the user's cookie names a bot that exists", so any request holding a callback
 * URL could make someone's Bot run, and a replay could do it again. The only callback
 * that may resume is the *pending connect card that started the flow*:
 *
 *   - same user's bot (a stranger's bot id must not work),
 *   - the row the flow recorded, and it still says `card: 'connect'`,
 *   - status `pending`, so one connection starts one turn,
 *   - the toolkit on the card is the slug coming back, so a card for slack cannot be
 *     "completed" by a gmail callback.
 *
 * Any missing part is a refusal, not a reason to do something weaker.
 */

export interface ConnectCardBody {
  type: 'card';
  card: 'connect';
  toolkit: string;
  status: string;
  [key: string]: unknown;
}

export interface ConnectResumeInput {
  /** The callback's `bot` param, if any. */
  botId?: string | null;
  /** The callback's `seq` param, if any. */
  seq?: number | null;
  /** The row at that seq in that bot, or null when there is none. */
  row: { body: unknown } | null;
  /** True when the bot exists and belongs to the session's user. */
  botOwned: boolean;
  /** The toolkit slug the provider is reporting connected. */
  slug: string;
}

export function mayResumeConnect(input: ConnectResumeInput): boolean {
  if (!input.botId || !input.seq || !input.botOwned) return false;
  const body = input.row?.body as ConnectCardBody | undefined;
  if (!body || body.type !== 'card' || body.card !== 'connect') return false;
  if (body.status !== 'pending') return false;
  return body.toolkit === input.slug;
}
