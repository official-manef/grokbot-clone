// One shape for "this integration is not configured". The web app resolves
// /api/capabilities once and hides affordances, so reaching here means something
// raced a config change or called the API directly. It must never be a 500.
export type Capability =
  | 'llm'
  | 'image'
  | 'tts'
  | 'stt'
  | 'realtime'
  | 'desktop'
  | 'integrations'
  | 'signin';

/**
 * Model-facing tools that are configuration. They are deliberately NOT in
 * `Capability`: nothing in the UI gates on them, so a missing search endpoint is
 * not "the app is partly configured". A tool that is still reached anyway (a
 * stale MCP tool list, a direct call) answers the same gap shape.
 */
export type ToolCapability = 'web_search' | 'x_search';

export type CapabilityKey = Capability | ToolCapability;

const LABELS: Record<CapabilityKey, string> = {
  llm: 'Language model',
  image: 'Image generation',
  tts: 'Text to speech',
  stt: 'Speech to text',
  realtime: 'Realtime voice',
  desktop: 'Bot desktop',
  integrations: 'App connections',
  signin: 'Google sign-in',
  web_search: 'Web search (SEARCH_BASE_URL)',
  x_search: 'X search (LLM_X_SEARCH=1)',
};

/** The env vars an operator has to set to close this gap, so the error names them. */
const REQUIRED: Record<CapabilityKey, string[]> = {
  llm: ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'],
  image: ['IMAGE_BASE_URL', 'IMAGE_API_KEY', 'IMAGE_MODEL'],
  tts: ['TTS_BASE_URL', 'TTS_API_KEY', 'TTS_MODEL'],
  stt: ['STT_BASE_URL', 'STT_API_KEY', 'STT_MODEL'],
  realtime: ['REALTIME_BASE_URL', 'REALTIME_API_KEY', 'REALTIME_MODEL'],
  desktop: ['DESKTOP_MODE'],
  integrations: ['COMPOSIO_API_KEY'],
  signin: ['COMPOSIO_API_KEY'],
  web_search: ['SEARCH_BASE_URL'],
  x_search: ['LLM_X_SEARCH=1', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_PROTOCOL=responses'],
};

export class CapabilityError extends Error {
  readonly code = 'capability_unavailable';
  constructor(
    readonly capability: CapabilityKey,
    readonly missing: string[] = REQUIRED[capability],
  ) {
    super(`${LABELS[capability]} is not configured.`);
    this.name = 'CapabilityError';
  }

  toJSON() {
    return {
      error: this.code,
      capability: this.capability,
      message: this.message,
      configure: this.missing,
    };
  }
}

export function requireCapability(enabled: boolean, capability: Capability): void {
  if (!enabled) throw new CapabilityError(capability);
}
