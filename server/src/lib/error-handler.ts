import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CapabilityError } from './capability-error.js';

/**
 * One error envelope for the whole API. Two rules:
 *
 * 1. A capability gap is 501 with the names of the vars that close it — that is
 *    an operator task, not a bug, and it must not look like a crash.
 * 2. Anything else is 500 with a short id. The id is logged with the stack; the
 *    client gets the id and a one-line message, never a stack or a key path.
 */

export function requestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function capabilityResponse(c: Context, e: CapabilityError) {
  return c.json(e.toJSON(), 501);
}

export function errorResponse(c: Context, e: unknown) {
  if (e instanceof CapabilityError) return capabilityResponse(c, e);

  const id = requestId();
  const status = statusOf(e);
  const message = messageOf(e);
  console.error(`[api] ${id} ${c.req.method} ${c.req.path} -> ${status}: ${message}\n${(e as any)?.stack ?? ''}`);

  if (status === 413) return c.json({ error: 'payload_too_large', message: 'The request is too large.', request_id: id }, 413);
  if (status === 429) return c.json({ error: 'rate_limited', message: 'Too many requests.', request_id: id }, 429);
  if (status >= 400 && status < 500) {
    return c.json({ error: 'bad_request', message, request_id: id }, status as ContentfulStatusCode);
  }

  return c.json({ error: 'internal_error', message: 'Something went wrong on the server.', request_id: id }, 500);
}

function statusOf(e: unknown): number {
  const s = Number((e as any)?.status ?? (e as any)?.statusCode);
  return Number.isFinite(s) && s >= 400 && s <= 599 ? s : 500;
}

function messageOf(e: unknown): string {
  const raw = String((e as any)?.message ?? e ?? 'unknown error');
  // Strip anything that looks like a credential before it can reach a log line
  // or a browser: bearer tokens, api keys, and query strings with keys in them.
  return raw
    .replace(/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]')
    .replace(/\b(sk|ak|pk|xai|gho|ghp)_[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/([?&](?:api[-_]?key|key|token)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 400);
}

/** Hono onError hook. Mount with app.onError(onError). */
export const onError = (e: unknown, c: Context) => errorResponse(c, e);
