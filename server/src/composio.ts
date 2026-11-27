import { Composio } from '@composio/core';
import { OpenAIResponsesProvider } from '@composio/openai';
import { db } from './db.js';
import { env } from './env.js';
import { CapabilityError } from './lib/capability-error.js';
import type { Toolkit } from './types.js';

/** Constructing the SDK with an empty key throws inside the SDK, so the client
 *  is built lazily and every entry point refuses with a capability error first. */
let client: ReturnType<typeof build> | null = null;
function build() {
  return new Composio({ apiKey: env.composioKey, provider: new OpenAIResponsesProvider() });
}
export type ComposioClient = ReturnType<typeof build>;
export function composioClient(): ComposioClient {
  if (!env.composioKey) throw new CapabilityError('integrations');
  if (!client) client = build();
  return client;
}
export const integrationsConfigured = () => Boolean(env.composioKey);
/** Proxy so call sites can keep `composio.triggers.x()` while the key is checked lazily. */
export const composio = new Proxy({} as Composio, {
  get(_t, prop) {
    const c: any = composioClient();
    return c[prop as any];
  },
});

const REST = 'https://backend.composio.dev/api/v3.1';
async function rest<T = any>(path: string): Promise<T> {
  if (!env.composioKey) throw new CapabilityError('integrations');
  const res = await fetch(`${REST}${path}`, { headers: { 'x-api-key': env.composioKey } });
  if (!res.ok) throw new Error(`Composio ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ---------- catalog (user-independent, cached) ----------

type CatalogItem = Omit<Toolkit, 'connected'>;
let catalogCache: { at: number; items: CatalogItem[] } | null = null;

export async function catalog(): Promise<CatalogItem[]> {
  if (catalogCache && Date.now() - catalogCache.at < 3600_000) return catalogCache.items;
  const items: CatalogItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const r = await rest<any>(`/toolkits?sort_by=usage&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const t of r.items ?? []) {
      items.push({
        slug: t.slug,
        name: t.name,
        logo: t.meta?.logo,
        description: t.meta?.description,
        categories: (t.meta?.categories ?? []).map((c: any) => c.name ?? c.id),
        managedAuth: (t.composio_managed_auth_schemes ?? []).length > 0,
        noAuth: !!t.no_auth,
      });
    }
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  catalogCache = { at: Date.now(), items };
  return items;
}

export async function toolkitInfo(slug: string): Promise<CatalogItem | undefined> {
  return (await catalog()).find((t) => t.slug === slug);
}

// ---------- per-user connections ----------

export async function connectedToolkits(userId: string): Promise<Set<string>> {
  const r = await composioClient().connectedAccounts.list({ userIds: [userId], statuses: ['ACTIVE'] } as any);
  const items: any[] = (r as any).items ?? [];
  return new Set(items.map((i) => i.toolkit?.slug ?? i.toolkitSlug).filter(Boolean));
}

export async function connectionsDetail(userId: string) {
  const r = await composioClient().connectedAccounts.list({ userIds: [userId] } as any);
  return ((r as any).items ?? []).map((i: any) => ({ id: i.id, toolkit: i.toolkit?.slug ?? i.toolkitSlug, status: i.status }));
}

export async function disconnect(userId: string, toolkit: string) {
  for (const c of await connectionsDetail(userId)) {
    if (c.toolkit === toolkit) await composioClient().connectedAccounts.delete(c.id);
  }
  sessionCache.delete(userId);
}

// ---------- sessions (tool router) ----------

const sessionCache = new Map<string, any>();

export async function sessionFor(userId: string): Promise<any> {
  const cached = sessionCache.get(userId);
  if (cached) return cached;
  const row = db.prepare('SELECT session_id FROM composio_sessions WHERE user_id=?').get(userId) as any;
  let session: any;
  if (row) {
    try { session = await composioClient().use(row.session_id); } catch { session = null; }
  }
  if (!session) {
    session = await composioClient().create(userId, { manageConnections: false } as any);
    db.prepare('INSERT OR REPLACE INTO composio_sessions(user_id, session_id) VALUES (?,?)').run(userId, session.sessionId);
  }
  sessionCache.set(userId, session);
  return session;
}

/** Start a connect flow; returns the hosted Connect Link URL. */
export async function startConnect(userId: string, toolkit: string, callbackUrl: string): Promise<{ redirectUrl: string; connectedAccountId?: string }> {
  const session = await sessionFor(userId);
  const req = await session.authorize(toolkit, { callbackUrl });
  return { redirectUrl: req.redirectUrl, connectedAccountId: req.id };
}

/** OpenAI-Responses-format function tools for this user's Composio session (meta tools). */
export async function composioTools(userId: string): Promise<any[]> {
  try {
    const session = await sessionFor(userId);
    const tools = await session.tools();
    return Array.isArray(tools) ? tools : [];
  } catch (e) {
    console.warn('[composio] tools unavailable', (e as Error).message);
    return [];
  }
}

export async function executeComposio(userId: string, name: string, args: Record<string, unknown>) {
  const session = await sessionFor(userId);
  const r = await session.execute(name, args);
  return r as { data?: unknown; error?: unknown; resultType?: string; logId?: string };
}

/** Which inner tool slugs a Composio meta-tool call would run (for approval checks). */
export function innerToolSlugs(name: string, args: any): string[] {
  if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
    const list = args?.tools ?? args?.tool_calls ?? args?.actions ?? [];
    return (Array.isArray(list) ? list : []).map((t: any) => String(t.tool_slug ?? t.slug ?? t.name ?? t.tool ?? '')).filter(Boolean);
  }
  if (name.startsWith('COMPOSIO_')) return [];
  return [name];
}

export const READ_RE = /_(GET|LIST|SEARCH|FETCH|FIND|READ|RETRIEVE|QUERY|LOOKUP|CHECK|DESCRIBE|VIEW|COUNT)(_|$)/;
/**
 * A read word alone is not enough. `GITHUB_CREATE_CHECK_RUN` contains `CHECK` and
 * creates something; `SLACK_SEND_MESSAGE_SEARCH`-shaped names exist too. Anything
 * that also names a write verb needs the user's approval, so a read-only match can
 * only auto-allow when no write verb is present.
 *
 * `APPEND|UPSERT|SCHEDULE|IMPORT|DUPLICATE|LABEL` were added after measuring the 110-slug
 * catalog: none of them appears in a real auto-allowed slug, so widening the list moved
 * zero reads onto the approval card (`allowlist-real-slugs.test.mjs` pins both halves —
 * the six verbs now ask, and all 33 real auto-allowed slugs still auto-allow). They are
 * here because the gap was *unmeasured*, not because it was exploited: `<read>_AND_<one>`
 * is the shape that would slip, and Composio does use all six as write verbs
 * (`NOTION_APPEND_TEXT_BLOCKS`, `SLACK_SCHEDULE_MESSAGE`, `GMAIL_ADD_LABEL_TO_EMAIL`).
 */
const WRITE_RE = /_(CREATE|UPDATE|DELETE|REMOVE|SEND|POST|PUT|PATCH|ADD|INSERT|MOVE|COPY|UPLOAD|SET|EDIT|MODIFY|REPLY|FORWARD|INVITE|SHARE|ARCHIVE|TRASH|ENABLE|DISABLE|RUN|EXECUTE|START|STOP|CANCEL|APPROVE|MERGE|CLOSE|PUBLISH|ASSIGN|TRANSFER|PAY|REFUND|MARK|APPEND|UPSERT|SCHEDULE|IMPORT|DUPLICATE|LABEL)(_|$)/;
export const isReadOnlySlug = (slug: string) => {
  const upper = slug.toUpperCase();
  return READ_RE.test(upper) && !WRITE_RE.test(upper);
};

// ---------- sign-in via Composio-managed Google (Gmail) connection ----------
// Both halves are gone: `startGoogleLogin` when AuthKit replaced the fan-facing fork,
// and now `googleProfile` with `/auth/google/callback`. Keeping an unused helper that
// reads a caller-supplied connected-account id is one refactor away from being wired
// back into a route that mints sessions from it.

