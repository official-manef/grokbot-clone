import OpenAI from 'openai';
import { env } from '../env.js';

/**
 * The model endpoint. One client, two protocols, because OpenAI-compatible
 * gateways do not agree on which one they implement:
 *
 * - responses: POST /responses. What upstream Grokbot used, and what carries
 *   reasoning items and server-side compaction.
 * - chat: POST /chat/completions. What several gateways expose instead, with
 *   tools translated to function schemas.
 *
 * Callers ask the adapter; they never build a URL.
 */

export const llmConfigured = Boolean(env.llm.key);

let client: OpenAI | null = null;
export function llm(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: env.llm.key || 'unconfigured',
      baseURL: env.llm.base,
      timeout: 360_000,
      maxRetries: 2,
    });
  }
  return client;
}

/** Vendor-hosted tools (web_search, x_search) only exist on vendor endpoints. */
export const hostedTools = () => env.hostedTools;
export const protocol = () => env.llmProtocol;
export const model = () => env.llm.model;

/**
 * Build the request body for a turn. On the chat protocol the vendor-hosted
 * tools are dropped rather than sent and rejected, and function tools are
 * reshaped into chat-completions shape.
 */
export function responsesBody(input: unknown[], tools: any[], opts: { stream: boolean; signal?: AbortSignal }) {
  const body: Record<string, unknown> = {
    model: env.llm.model,
    input,
    tools,
    store: false,
    stream: opts.stream,
  };
  if (!hostedTools()) body.tools = stripHosted(tools);
  return body;
}

const HOSTED = new Set(['web_search', 'x_search', 'code_interpreter', 'file_search']);

export function stripHosted(tools: any[]): any[] {
  return tools.filter((t) => !HOSTED.has(t?.type));
}

/**
 * Errors from a gateway are frequently a nested JSON string inside an error
 * envelope. Flatten to one line so a capability gap reads as one, not as
 * "[404]: {"detail":"Not Found"}" thrown into a log.
 */
export function describeLLMError(e: unknown): string {
  const raw = e as { status?: number; message?: string; error?: any; response?: { status?: number } };
  const status = raw?.status ?? raw?.response?.status;
  let text = String(raw?.message ?? e ?? 'unknown error');
  const nested = /^\[(\d+)\]:\s*([\s\S]*)$/.exec(text);
  if (nested) {
    try {
      const parsed = JSON.parse(nested[2]);
      const inner = parsed?.error?.message ?? parsed?.detail ?? parsed?.message;
      if (inner) text = String(inner);
      else text = nested[2];
    } catch {
      text = nested[2];
    }
  }
  text = text.replace(/\s*\(reset after [^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
  return status ? `${status}: ${text}` : text;
}

/** True when the failure is configuration, not content. Routes map this to 501. */
export function isConfigError(e: unknown): boolean {
  const s = describeLLMError(e).toLowerCase();
  return (
    /not found|does not exist|unknown model|invalid model|no such model/.test(s) ||
    /unauthorized|invalid api key|incorrect api key|401|403/.test(s)
  );
}

// ---------- chat-completions protocol ----------
//
// Some gateways implement /chat/completions but not /responses. The agent loop
// stores Responses-shaped items (message / function_call / function_call_output),
// so the translator below is the only place that knows both vocabularies.

type AnyItem = Record<string, any>;

/** Responses items -> chat messages. Images survive as multi-part content. */
export function toChatMessages(items: AnyItem[]): AnyItem[] {
  const out: AnyItem[] = [];
  for (const it of items) {
    if (it?.type === 'function_call') {
      const prev = out[out.length - 1];
      const call = {
        id: it.call_id ?? it.id ?? `call_${out.length}`,
        type: 'function',
        function: { name: it.name, arguments: it.arguments ?? '{}' },
      };
      // Merge consecutive calls into one assistant message: some providers reject
      // a second tool_calls message that arrives before the first is answered.
      if (prev?.role === 'assistant' && Array.isArray(prev.tool_calls)) prev.tool_calls.push(call);
      else out.push({ role: 'assistant', content: '', tool_calls: [call] });
      continue;
    }
    if (it?.type === 'function_call_output') {
      out.push({ role: 'tool', tool_call_id: it.call_id, content: outputText(it.output) });
      continue;
    }
    if (it?.type === 'reasoning' || it?.type === 'compaction') continue;
    if (it?.type === 'message' || it?.role === 'assistant') {
      out.push({ role: 'assistant', content: contentText(it.content) });
      continue;
    }
    if (it?.role === 'user') out.push({ role: 'user', content: userContent(it.content) });
    if (it?.role === 'system') out.push({ role: 'system', content: contentText(it.content) });
  }
  return out;
}

function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => c?.text ?? '').filter(Boolean).join('\n');
}

/** User content may carry screenshots; keep them as image_url parts. */
function userContent(content: any): any {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = content
    .map((c) => {
      if (c?.type === 'input_image' || c?.type === 'image_url') {
        const url = c.image_url?.url ?? c.image_url ?? c.url;
        return url ? { type: 'image_url', image_url: { url } } : null;
      }
      const text = c?.text ?? c?.content;
      return text ? { type: 'text', text } : null;
    })
    .filter(Boolean);
  return parts.length ? parts : '';
}

/** function_call_output.output is a string or an array of text/image parts. */
function outputText(output: any): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? null);
  const lines = output.map((c) => (c?.type === 'input_image' ? '[image omitted on this protocol]' : c?.text ?? '')).filter(Boolean);
  return lines.join('\n');
}

/** Responses function tools -> chat function tools. */
export function toChatTools(tools: AnyItem[]): AnyItem[] {
  return stripHosted(tools)
    .filter((t) => t?.type === 'function' && t.name)
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/**
 * A chat-completions stream, reshaped into the events the agent loop already
 * understands. This is what keeps the loop protocol-agnostic: it keeps reading
 * response.output_text.delta and never learns that chat exists.
 */
export async function* chatAsResponseEvents(stream: AsyncIterable<any>): AsyncGenerator<any> {
  let text = '';
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let finish: string | null = null;
  let usage: any = null;

  for await (const chunk of stream) {
    const choice = chunk?.choices?.[0];
    if (chunk?.usage) usage = chunk.usage;
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      yield { type: 'response.output_text.delta', delta: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = Number(tc.index ?? 0);
      const cur = calls.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(idx, cur);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  const output: AnyItem[] = [];
  if (text) {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  }
  // Emit the completed calls in index order, with their arguments parsed back
  // into the JSON string the loop already expects.
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    output.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments || '{}' });
    yield { type: 'response.output_item.added', item: { type: 'function_call', name: c.name } };
  }
  if (!output.length) throw new Error('model returned no content and no tool calls');
  yield {
    type: finish === 'length' ? 'response.incomplete' : 'response.completed',
    response: {
      output,
      usage: usage ? { input_tokens: usage.prompt_tokens ?? usage.input_tokens, output_tokens: usage.completion_tokens ?? usage.output_tokens } : undefined,
    },
  };
}

/** One chat turn. Returns an async iterable of Responses-shaped events. */
export async function chatStream(body: { input: AnyItem[]; tools: AnyItem[]; signal?: AbortSignal; effort?: string }) {
  const messages = toChatMessages(body.input);
  const params: AnyItem = {
    model: env.llm.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  const tools = toChatTools(body.tools);
  if (tools.length) { params.tools = tools; params.tool_choice = 'auto'; }
  if (body.effort) params.reasoning_effort = body.effort;

  const raw = (await llm().chat.completions.create(params as any, { signal: body.signal })) as unknown as AsyncIterable<any>;
  return chatAsResponseEvents(raw);
}
