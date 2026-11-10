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

function endpoint(baseName: string, keyName: string, modelName: string, fallbackModel: string): Endpoint | null {
  const base = process.env[baseName]?.trim();
  const key = process.env[keyName]?.trim();
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

const llmBase = alias('LLM_BASE_URL', 'XAI_BASE_URL') ?? 'https://api.x.ai/v1';
const llmKey = alias('LLM_API_KEY', 'XAI_API_KEY') ?? '';
const llmModel = alias('LLM_MODEL', 'XAI_MODEL') ?? 'grok-4.7';

const image = endpoint('IMAGE_BASE_URL', 'IMAGE_API_KEY', 'IMAGE_MODEL', 'grok-2-image');
const tts = endpoint('TTS_BASE_URL', 'TTS_API_KEY', 'TTS_MODEL', 'grok-voice-latest');
const stt = endpoint('STT_BASE_URL', 'STT_API_KEY', 'STT_MODEL', 'grok-voice-transcribe-2.0');
const realtime = endpoint('REALTIME_BASE_URL', 'REALTIME_API_KEY', 'REALTIME_MODEL', 'grok-voice-latest');

/** Realtime needs a key even when the base defaults to the LLM endpoint. */
const realtimeResolved: Endpoint | null =
  realtime ??
  (alias('REALTIME_API_KEY', 'XAI_API_KEY') && llmBase
    ? { base: llmBase, key: alias('REALTIME_API_KEY', 'XAI_API_KEY')!, model: process.env.REALTIME_MODEL?.trim() || 'grok-voice-latest' }
    : null);

const desktopMode = (process.env.DESKTOP_MODE?.trim() || 'disabled') as 'disabled' | 'docker' | 'orgo' | 'mso';
const composioKey = alias('COMPOSIO_API_KEY', 'COMPOSIO_API_KEY') ?? '';

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  sessionSecret: process.env.SESSION_SECRET?.trim() || '',
  devLogin: process.env.DEV_LOGIN === '1',
  dbPath: process.env.DB_PATH ?? new URL('../../data/grokbot.db', import.meta.url).pathname,

  llm: { base: llmBase, key: llmKey, model: llmModel } satisfies Endpoint,
  /** chat = /chat/completions, responses = /responses. Endpoints differ. */
  llmProtocol: (process.env.LLM_PROTOCOL?.trim() || 'responses') as 'responses' | 'chat',
  /** Vendor-hosted tools (web_search, x_search) exist only on vendor endpoints. */
  hostedTools: process.env.LLM_HOSTED_TOOLS === '1',
  /** Optional search endpoint for the local web_search tool. */
  search: process.env.SEARCH_BASE_URL?.trim()
    ? { base: process.env.SEARCH_BASE_URL.trim().replace(/\/+$/, ''), key: process.env.SEARCH_API_KEY?.trim() || '' }
    : null,

  image,
  tts,
  stt,
  realtime: realtimeResolved,

  desktop: {
    mode: desktopMode,
    /** Docker daemon socket; the trust boundary for bot desktops. */
    socket: process.env.DOCKER_SOCKET?.trim() || '/var/run/docker.sock',
    image: process.env.DESKTOP_IMAGE?.trim() || 'grokbot-desktop:latest',
    ramGb: Number(process.env.DESKTOP_RAM_GB ?? 8),
    cpu: Number(process.env.DESKTOP_CPU ?? 2),
    resolution: process.env.DESKTOP_RESOLUTION ?? '1280x800x24',
    /** DESKTOP_MODE=mso: host Xvfb displays, no container runtime. */
    mso: {
      root: (process.env.MSO_DESKTOP_ROOT?.trim() || path.join(process.env.HOME ?? '/tmp', '.grokbot', 'desktops')).replace(/\/+$/, ''),
      /** First VNC port; :99 -> base+0, :91 -> base+1. */
      vncPortBase: Number(process.env.MSO_VNC_PORT_BASE ?? 5900),
      /** Explicit browser path; otherwise discovered (Playwright, then PATH). */
      browser: process.env.GROKBOT_BROWSER?.trim() || '',
    },
  },

  /** Kept for the orgo mode only, so the old path still compiles while it exists. */
  orgo: {
    key: process.env.ORGO_API_KEY?.trim() || '',
    workspaceId: process.env.ORGO_WORKSPACE_ID?.trim() || '',
    ramGb: Number(process.env.ORGO_RAM_GB ?? 8),
    cpu: Number(process.env.ORGO_CPU ?? 2),
    resolution: process.env.ORGO_RESOLUTION ?? '1280x800x24',
  },

  composioKey,

  /** Legacy accessors, kept while the remaining modules are ported. */
  get xaiKey() { return llmKey; },
  get xaiModel() { return llmModel; },
  get xaiBase() { return llmBase; },
  get orgoKey() { return env.orgo.key; },
  get orgoWorkspaceId() { return env.orgo.workspaceId; },
  set orgoWorkspaceId(v: string) { env.orgo.workspaceId = v; },
  get orgoRamGb() { return env.orgo.ramGb; },
  get orgoCpu() { return env.orgo.cpu; },
  get orgoResolution() { return env.orgo.resolution; },
};

export const capabilities: Record<Capability, boolean> = {
  llm: Boolean(llmKey),
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
    model: env.llm.model,
    protocol: env.llmProtocol,
    hostedTools: env.hostedTools,
    desktop: env.desktop.mode,
    capabilities,
    /** Non-fatal boot notes: legacy env names, skipped integrations. */
    notes: [...aliased],
  };
}

// SESSION_SECRET is not used to sign anything: sessions are opaque tokens in the
// auth_sessions table. Keep the variable for compatibility, but do not gate boot on it.
if (aliased.size) console.log(`[env] legacy names in use: ${[...aliased].join(', ')}`);
const gaps = (Object.entries(capabilities) as [Capability, boolean][]).filter(([, on]) => !on).map(([k]) => k);
if (gaps.length) console.log(`[env] capabilities off: ${gaps.join(', ')}`);
