import { useEffect, useState } from 'react';

/**
 * What this deployment can do, resolved once.
 *
 * The server already refuses with 501 + the env vars that are missing, but a
 * button that answers 501 is a bug from the user's side. Every optional
 * affordance asks here first and renders itself off instead.
 */

export type Capability =
  | 'llm'
  | 'image'
  | 'tts'
  | 'stt'
  | 'realtime'
  | 'desktop'
  | 'integrations'
  | 'signin';

export interface CapabilityReport {
  ok: boolean;
  model: string;
  protocol: 'responses' | 'chat';
  hostedTools: boolean;
  desktop: { mode: string; ready: boolean; image?: string; containers?: number; error?: string };
  capabilities: Record<Capability, boolean>;
  gaps: Capability[];
  notes: string[];
}

let cached: CapabilityReport | null = null;
let inflight: Promise<CapabilityReport | null> | null = null;

export async function loadCapabilities(force = false): Promise<CapabilityReport | null> {
  if (!force && cached) return cached;
  if (!force && inflight) return inflight;
  inflight = fetch('/api/capabilities', { credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) return null;
      cached = (await r.json()) as CapabilityReport;
      return cached;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

/** False until the report arrives: unknown must not mean "show it". */
export function useCapability(name: Capability): boolean {
  const [on, setOn] = useState(cached?.capabilities?.[name] ?? false);
  useEffect(() => {
    let alive = true;
    void loadCapabilities().then((report) => {
      if (alive) setOn(report?.capabilities?.[name] ?? false);
    });
    return () => { alive = false; };
  }, [name]);
  return on;
}

export function useCapabilities(): CapabilityReport | null {
  const [report, setReport] = useState<CapabilityReport | null>(cached);
  useEffect(() => {
    let alive = true;
    void loadCapabilities().then((r) => { if (alive) setReport(r); });
    return () => { alive = false; };
  }, []);
  return report;
}

/** The one-line reason a control is missing, for the tooltip or the empty state. */
export function gapReason(name: Capability): string {
  switch (name) {
    case 'tts': return 'Voice preview needs a text-to-speech endpoint (TTS_BASE_URL, TTS_API_KEY, TTS_MODEL).';
    case 'stt': return 'Dictation needs a speech-to-text endpoint (STT_BASE_URL, STT_API_KEY, STT_MODEL).';
    case 'realtime': return 'Voice calls need a realtime endpoint (REALTIME_BASE_URL, REALTIME_API_KEY, REALTIME_MODEL).';
    case 'image': return 'Image generation needs an image endpoint (IMAGE_BASE_URL, IMAGE_API_KEY, IMAGE_MODEL).';
    case 'desktop': return 'Bot desktops need DESKTOP_MODE=docker (or orgo) plus a running daemon.';
    case 'integrations': return 'App connections need COMPOSIO_API_KEY.';
    case 'signin': return 'Google sign-in needs COMPOSIO_API_KEY. Use the email form when DEV_LOGIN=1.';
    case 'llm': return 'The model endpoint is not configured (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL).';
    default: return '';
  }
}
