import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Capability } from './lib/capability-error.js';

// Every optional integration resolves here, once, at boot. Nothing below throws
// for a missing key: a capability is either configured or it is reported as a
// gap. See docs/MANEF-PORT.md.

/** A vendor pair from the same capability, e.g. { base, key, model }. */
export interface Endpoint {
  base: string;
  key: string;
  model: string;
}

/** A secret from NAME, or from the file named by NAME_FILE (so keys need not sit in .env). */
function secret(name: string): string {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`]?.trim();
  if (file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
  }
  return '';
}

function endpoint(baseName: string, keyName: string, modelName: string, fallbackModel: string): Endpoint | null {
  const base = process.env[baseName]?.trim();
  const key = secret(keyName);
  if (!base || !key) return null;
  return { base: base.replace(/\/+$/, ''), key, model: process.env[modelName]?.trim() || fallbackModel };
}

// XAI_* / LLM_* aliases. Upstream used one vendor per capability; we accept both
// spellings so an existing .env keeps working, and say which one we prefer.
const aliased = new Set<string>();
function alias(preferred: string, legacy: string): string | undefined {
  const value = process.env[preferred]?.trim() || process.env[legacy]?.trim();
  if (value && !process.env[preferred]?.trim() && process.env[legacy]?.trim()) aliased.add(`${legacy} (use ${preferred})`);
  return value || undefined;
}

// The model endpoint. Empty means "no BYOK endpoint", which is not an error: the
// bots can still be driven by a Hermes engine that owns its own credentials.
const llmBase = alias('LLM_BASE_URL', 'XAI_BASE_URL') ?? '';
const llmKey = secret('LLM_API_KEY') || secret('XAI_API_KEY');
const llmModel = alias('LLM_MODEL', 'XAI_MODEL') ?? '';

const image = endpoint('IMAGE_BASE_URL', 'IMAGE_API_KEY', 'IMAGE_MODEL', 'grok-2-image');
const ttsTmp = endpoint('TTS_BASE_URL', 'TTS_API_KEY', 'TTS_MODEL', 'grok-voice-latest');
const stt = endpoint('STT_BASE_URL', 'STT_API_KEY', 'STT_MODEL', 'grok-voice-transcribe-2.0');
const realtimeTmp = endpoint('REALTIME_BASE_URL', 'REALTIME_API_KEY', 'REALTIME_MODEL', 'grok-voice-latest');

/** Speech endpoints may default to the LLM endpoint when only a key is supplied. */
const tts: Endpoint | null = ttsTmp;
const realtimeResolved: Endpoint | null =
  realtimeTmp ??
  (secret('REALTIME_API_KEY') && llmBase
    ? { base: llmBase, key: secret('REALTIME_API_KEY'), model: process.env.REALTIME_MODEL?.trim() || 'grok-voice-latest' }
    : null);

const desktopMode = (process.env.DESKTOP_MODE?.trim() || (process.env.HQ_LOCAL === '1' ? 'mso' : 'docker')) as
  | 'disabled'
  | 'docker'
  | 'orgo'
  | 'mso';
const composioKey = alias('COMPOSIO_API_KEY', 'COMPOSIO_API_KEY') ?? '';

const hermesHome = process.env.HERMES_HOME_PRIMARY ?? path.join(os.homedir(), '.hermes');

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  sessionSecret: process.env.SESSION_SECRET?.trim() || '',
  devLogin: process.env.DEV_LOGIN === '1',
  dbPath: process.env.DB_PATH ?? new URL('../../data/grokbot.db', import.meta.url).pathname,
  composioKey,

  // ---- BYOK capabilities ----
  llm: { base: llmBase, key: llmKey, model: llmModel } satisfies Endpoint,
  /** chat = /chat/completions, responses = /responses. Endpoints differ. */
  llmProtocol: (process.env.LLM_PROTOCOL?.trim() || 'responses') as 'responses' | 'chat',
  /** Vendor-hosted tools (web_search, x_search) exist only on vendor endpoints. */
  hostedTools: process.env.LLM_HOSTED_TOOLS === '1',
  /** Optional search endpoint for the local web_search tool. */
  search: process.env.SEARCH_BASE_URL?.trim()
    ? { base: process.env.SEARCH_BASE_URL.trim().replace(/\/+$/, ''), key: secret('SEARCH_API_KEY') }
    : null,

  image,
  tts,
  stt,
  realtime: realtimeResolved,

  // ---- Hermes engine ----
  /** The `hermes` CLI used to start a gateway for each extra bot. */
  hermesBin: process.env.HERMES_BIN ?? 'hermes',
  /** The primary bot's Hermes home and API server (an agent that already runs; never restarted by us). */
  hermesHome,
  hermesUrl: (process.env.HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/+$/, ''),
  hermesKey: process.env.HERMES_KEY ?? '',
  /** Where each extra bot's own Hermes home lives. Must be outside ~/.hermes so it is a separate tenant. */
  enginesDir: process.env.ENGINES_DIR ?? new URL('../../data/engines', import.meta.url).pathname,
  enginePortBase: Number(process.env.ENGINE_PORT_BASE ?? 8650),
  /** URL the Hermes gateways use to reach this server's MCP endpoint. */
  mcpBaseUrl: (process.env.MCP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/+$/, ''),
  /** Extra MCP servers every managed bot gets, as a JSON object of Hermes `mcp_servers` entries (e.g. X's XMCP). */
  extraMcpServers: process.env.EXTRA_MCP_SERVERS ?? '',
  primaryBotName: process.env.PRIMARY_BOT_NAME ?? 'Doug',
  primaryBotLabel: process.env.PRIMARY_BOT_LABEL ?? 'Chief of Staff',

  // ---- bot desktops ----
  desktop: {
    mode: desktopMode,
    /** Docker daemon socket; the trust boundary for bot desktops. */
    socket: process.env.DOCKER_SOCKET?.trim() || '/var/run/docker.sock',
    image: process.env.DESKTOP_IMAGE?.trim() || 'grokbot-desktop:latest',
    ramGb: Number(process.env.DESKTOP_RAM_GB ?? 8),
    cpu: Number(process.env.DESKTOP_CPU ?? 2),
    resolution: process.env.DESKTOP_RESOLUTION ?? '1280x800x24',
  },

  // ---- the shared computer (bot-hq model) ----
  /** The computer every bot works on (one screen each). Empty = per-user boxes via `desktop`. */
  orgoComputerId: process.env.ORGO_COMPUTER_ID ?? '',
  /** This server runs on that computer, so shell commands run locally instead of through an API. */
  localBox: process.env.HQ_LOCAL === '1',
  /**
   * DevTools URL of a Chrome that already runs on the default screen and belongs to the primary bot
   * (e.g. http://127.0.0.1:9333). When set, we never start or stop that screen's Chrome ourselves.
   */
  primaryCdpUrl: process.env.PRIMARY_CDP_URL ?? '',
  /** Bots that can each have a screen. */
  maxBots: Number(process.env.MAX_BOTS ?? 4),
  /** Comma-separated emails allowed to sign in; empty = anyone who can reach the app. */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  /** Kept for the orgo mode only, so the old path still compiles while it exists. */
  orgo: {
    key: secret('ORGO_API_KEY'),
    workspaceId: process.env.ORGO_WORKSPACE_ID?.trim() || '',
    ramGb: Number(process.env.ORGO_RAM_GB ?? 8),
    cpu: Number(process.env.ORGO_CPU ?? 2),
    resolution: process.env.ORGO_RESOLUTION ?? '1280x800x24',
  },

  /** Legacy accessors, kept while the remaining modules are ported. */
  get xaiKey() { return llmKey; },
  get xaiModel() { return llmModel || 'hermes-agent'; },
  get xaiBase() { return llmBase; },
  get orgoKey() { return env.orgo.key; },
  get orgoWorkspaceId() { return env.orgo.workspaceId; },
  set orgoWorkspaceId(v: string) { env.orgo.workspaceId = v; },
  get orgoRamGb() { return env.orgo.ramGb; },
  get orgoCpu() { return env.orgo.cpu; },
  get orgoResolution() { return env.orgo.resolution; },
};

export const capabilities: Record<Capability, boolean> = {
  // A bot answers if either a BYOK endpoint is configured or a Hermes engine runs.
  llm: Boolean(llmKey) || Boolean(process.env.HERMES_URL || process.env.HQ_LOCAL === '1'),
  image: Boolean(image),
  tts: Boolean(tts),
  stt: Boolean(stt),
  realtime: Boolean(realtimeResolved),
  desktop: desktopMode !== 'disabled' && (desktopMode !== 'orgo' || Boolean(env.orgo.key)),
  integrations: Boolean(composioKey),
  signin: Boolean(composioKey),
};

/** What /api/capabilities returns. Never includes a key, only whether it exists. */
export function capabilityReport() {
  return {
    ok: capabilities.llm,
    model: env.llm.model || env.xaiModel,
    protocol: env.llmProtocol,
    hostedTools: env.hostedTools,
    desktop: env.desktop.mode,
    capabilities,
    /** True when bots are driven by a Hermes engine rather than a direct model call. */
    engine: Boolean(process.env.HERMES_URL || process.env.HQ_LOCAL === '1'),
    /** Non-fatal boot notes: legacy env names, skipped integrations. */
    notes: [...aliased],
  };
}

// SESSION_SECRET is not used to sign anything: sessions are opaque tokens in the
// auth_sessions table. Keep the variable for compatibility, but do not gate boot on it.
if (aliased.size) console.log(`[env] legacy names in use: ${[...aliased].join(', ')}`);
const gaps = (Object.entries(capabilities) as [Capability, boolean][]).filter(([, on]) => !on).map(([k]) => k);
if (gaps.length) console.log(`[env] capabilities off: ${gaps.join(', ')}`);
