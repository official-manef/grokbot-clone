import { env } from '../env.js';
import { CapabilityError } from '../lib/capability-error.js';

/**
 * Image generation is BYOK and optional. The endpoint is whatever OpenAI-compatible
 * `/images/generations` the operator points at; when it is not configured the tool
 * is not offered and the route answers 501 instead of pretending.
 *
 * Response shapes differ between vendors, so the parser accepts the three that
 * exist in the wild: b64_json, url, and a bare data[] array of either.
 */

export const imageConfigured = () => Boolean(env.image);

export interface GeneratedImage {
  /** base64 bytes, no data: prefix */
  b64: string;
  mime: string;
}

export async function generateImage(prompt: string, opts: { size?: string; n?: number } = {}): Promise<GeneratedImage[]> {
  if (!env.image) throw new CapabilityError('image');
  const res = await fetch(`${env.image.base}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.image.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.image.model, prompt, n: opts.n ?? 1, ...(opts.size ? { size: opts.size } : {}) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.detail ?? json?.message ?? `${res.status} ${res.statusText}`;
    const err = new Error(`image endpoint: ${String(msg).slice(0, 300)}`);
    (err as any).status = res.status;
    throw err;
  }
  return parseImages(json);
}

export function parseImages(json: any): GeneratedImage[] {
  const arr: any[] = Array.isArray(json) ? json : json?.data ?? json?.images ?? json?.output ?? [];
  const out: GeneratedImage[] = [];
  for (const item of Array.isArray(arr) ? arr : []) {
    if (typeof item === 'string') {
      // Some endpoints return bare base64 strings.
      out.push({ b64: stripDataUrl(item).b64, mime: stripDataUrl(item).mime });
      continue;
    }
    const b64 = item?.b64_json ?? item?.b64 ?? item?.image;
    if (typeof b64 === 'string') {
      const parsed = stripDataUrl(b64);
      out.push({ b64: parsed.b64, mime: item?.mime_type ?? parsed.mime });
    }
  }
  return out;
}

function stripDataUrl(s: string): { b64: string; mime: string } {
  const m = /^data:([^;,]+)(;base64)?,/.exec(s);
  if (!m) return { b64: s, mime: 'image/png' };
  return { b64: s.slice(m[0].length), mime: m[1] };
}

/**
 * URL-returning vendors need a second hop. Kept separate so a caller that only
 * accepts bytes never has to fetch a third-party URL itself.
 */
export async function fetchImageBytes(url: string): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`image download: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
