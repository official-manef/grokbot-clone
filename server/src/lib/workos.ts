/**
 * WorkOS AuthKit sign-in, over plain HTTPS + JSON.
 *
 * No `@workos-inc/node`: the two calls we need are a URL and one JSON POST, and a new
 * dependency would mean lockfile churn on a branch that is being deployed to production.
 *
 * Config is read lazily from `process.env` (the same `process.env.X ?? default` pattern
 * as `env.ts`) rather than from the `env` object, for two reasons: this module then has
 * zero imports, so `node --test` can load it with native type-stripping and no network,
 * and every entry point also accepts an override bag so a test can point it at a fake
 * base URL and a fake key pair without touching process env.
 */

const DEFAULT_BASE = 'https://api.workos.com';
const opt = (name: string, fallback = '') => process.env[name] ?? fallback;

export type WorkosOverrides = {
  apiKey?: string;
  clientId?: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export type WorkosProfile = { email: string; name?: string; emailVerified: boolean };

const baseOf = (o: WorkosOverrides) => (o.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
const keyOf = (o: WorkosOverrides) => o.apiKey ?? opt('WORKOS_API_KEY');
const clientOf = (o: WorkosOverrides) => o.clientId ?? opt('WORKOS_CLIENT_ID');

/** True only when both halves of the WorkOS credentials are present. */
export function workosConfigured(o: WorkosOverrides = {}): boolean {
  return keyOf(o).length > 0 && clientOf(o).length > 0;
}

/**
 * The AuthKit authorize URL. Built with `URL`/`URLSearchParams` (never string
 * concatenation) so a redirect URI containing `?` or `&` stays one argument.
 */
export function authorizationUrl(o: { redirectUri: string; state: string } & WorkosOverrides): string {
  const url = new URL(`${baseOf(o)}/user_management/authorize`);
  url.searchParams.set('client_id', clientOf(o));
  url.searchParams.set('redirect_uri', o.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('provider', 'authkit');
  url.searchParams.set('state', o.state);
  return url.toString();
}

/** The API key must never appear in an error we might log. */
const redact = (text: string, secret: string) => (secret ? text.split(secret).join('[redacted]') : text);

/**
 * Trade an authorization code for the signed-in profile.
 * Throws a clear error on any non-2xx (status + message, secrets redacted).
 */
export async function exchangeCode(code: string, o: WorkosOverrides = {}): Promise<WorkosProfile> {
  const apiKey = keyOf(o);
  const clientId = clientOf(o);
  if (!apiKey || !clientId) throw new Error('WorkOS is not configured');

  const endpoint = `${baseOf(o)}/user_management/authenticate`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: apiKey, grant_type: 'authorization_code', code }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
  } catch (e: any) {
    // Never include the request body (it carries the secret) in the failure path.
    throw new Error(`WorkOS authenticate request failed: ${e?.name ?? 'network error'}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WorkOS authenticate failed: ${res.status} ${redact(text, apiKey).slice(0, 300)}`.trim());
  }

  const body = (await res.json().catch(() => null)) as any;
  const user = body?.user;
  const email = typeof user?.email === 'string' ? user.email.trim() : '';
  if (!email.includes('@')) throw new Error('WorkOS authenticate: response had no user email');
  const name = [user?.first_name, user?.last_name]
    .filter((s: unknown) => typeof s === 'string' && s.trim())
    .join(' ')
    .trim();
  return { email, name: name || undefined, emailVerified: user?.email_verified === true };
}
