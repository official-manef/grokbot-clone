import { env } from '../env.js';
import { CapabilityError } from '../lib/capability-error.js';

/**
 * Speech, BYOK and optional, in three independent pieces because vendors rarely
 * ship all three: TTS, STT, and realtime (a WebSocket the gateway either has or
 * does not). Each one is its own capability so a deployment can have dictation
 * without calls, which is the common case.
 */

export const ttsConfigured = () => Boolean(env.tts);
export const sttConfigured = () => Boolean(env.stt);
export const realtimeConfigured = () => Boolean(env.realtime);

// ---------- TTS ----------

export async function synthesize(text: string, opts: { voice?: string; speed?: number } = {}): Promise<{ bytes: Buffer; mime: string }> {
  if (!env.tts) throw new CapabilityError('tts');
  const res = await fetch(`${env.tts.base}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.tts.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.tts.model,
      input: text,
      voice: opts.voice || 'alloy',
      ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    const err = new Error(`tts endpoint: ${res.status} ${detail}`);
    (err as any).status = res.status;
    throw err;
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'audio/mpeg' };
}

/** Vendors that publish their voices; the caller falls back to a static list. */
export async function listVoices(): Promise<{ id: string; name: string; gender?: string }[] | null> {
  if (!env.tts) return null;
  try {
    const r = await fetch(`${env.tts.base}/audio/voices`, {
      headers: { Authorization: `Bearer ${env.tts.key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => null);
    const arr: any[] = j?.voices ?? j?.data ?? (Array.isArray(j) ? j : []);
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.map((v: any) => ({
      id: String(v.voice_id ?? v.id ?? v.name),
      name: String(v.name ?? v.voice_id ?? v.id),
      gender: v.gender,
    }));
  } catch {
    return null;
  }
}

// ---------- STT ----------

export async function transcribe(
  audio: Buffer,
  opts: { filename?: string; mime?: string; language?: string } = {},
): Promise<{ text: string }> {
  if (!env.stt) throw new CapabilityError('stt');
  const form = new FormData();
  form.set('model', env.stt.model);
  form.set('file', new Blob([new Uint8Array(audio)], { type: opts.mime ?? 'audio/webm' }), opts.filename ?? 'audio.webm');
  if (opts.language && opts.language !== 'auto') form.set('language', opts.language);
  const res = await fetch(`${env.stt.base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.stt.key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`stt endpoint: ${res.status} ${text.slice(0, 300)}`);
    (err as any).status = res.status;
    throw err;
  }
  let json: any;
  try { json = JSON.parse(text); } catch { return { text: text.trim() }; }
  return { text: String(json?.text ?? json?.transcript ?? '').trim() };
}

// ---------- realtime ----------

/**
 * Mint a short-lived client secret for a browser WebSocket. Gateways that do not
 * implement this answer 404, which is exactly the capability gap: it must reach
 * the UI as "calls unavailable", not as a broken call button.
 */
export async function mintRealtimeSecret(): Promise<{ clientSecret: string; websocketUrl: string; model: string }> {
  if (!env.realtime) throw new CapabilityError('realtime');
  const res = await fetch(`${env.realtime.base}/realtime/client_secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.realtime.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.realtime.model }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.detail ?? `${res.status} ${res.statusText}`;
    const err = new Error(`realtime endpoint: ${String(msg).slice(0, 300)}`);
    (err as any).status = res.status;
    throw err;
  }
  const secret = json?.client_secret?.value ?? json?.client_secret ?? json?.value;
  if (!secret) throw new Error('realtime endpoint returned no client secret');
  const ws = String(env.realtime.base).replace(/^http/, 'ws');
  return {
    clientSecret: String(secret),
    websocketUrl: `${ws}/realtime?model=${encodeURIComponent(env.realtime.model)}`,
    model: env.realtime.model,
  };
}
