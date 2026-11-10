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
