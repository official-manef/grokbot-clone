function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function reqEither(names: string[]): string {
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
  throw new Error(`Missing env ${names.join(' or ')}`);
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Computer backend.
 *  - `mso`  (default): bots run on THIS host, driven by the MSO control plane.
 *  - `orgo`: the upstream cloud VM backend, kept for anyone who still has a key.
 */
export type ComputerBackend = 'mso' | 'orgo';
const backendRaw = (opt('COMPUTER_BACKEND', 'mso') || 'mso').toLowerCase();
if (backendRaw !== 'mso' && backendRaw !== 'orgo') {
  throw new Error(`COMPUTER_BACKEND must be "mso" or "orgo" (got "${backendRaw}")`);
}

/**
 * Which sign-in flow `/auth/google/start` runs.
 *  - `workos`   (default when configured): WorkOS AuthKit.
 *  - `composio`: the older Composio-managed Google (Gmail) connection, kept for back-compat.
 * With no AUTH_PROVIDER set, WorkOS wins as soon as both of its vars are present.
 */
export type AuthProvider = 'workos' | 'composio';
const workosApiKey = opt('WORKOS_API_KEY');
const workosClientId = opt('WORKOS_CLIENT_ID');
const authProviderRaw = opt('AUTH_PROVIDER').toLowerCase();
if (authProviderRaw && authProviderRaw !== 'workos' && authProviderRaw !== 'composio') {
  throw new Error(`AUTH_PROVIDER must be "workos" or "composio" (got "${authProviderRaw}")`);
}
const authProvider: AuthProvider = authProviderRaw
  ? (authProviderRaw as AuthProvider)
  : workosApiKey && workosClientId
    ? 'workos'
    : 'composio';

/**
 * Does this process look like production? Derived, not a single flag, because a
 * lone `DEV_LOGIN=1` in a production `.env` was enough to open a staff-session
 * factory. Two signals, either one wins:
 *   - `NODE_ENV=production` (the usual marker), or
 *   - a non-loopback public URL: `SERVER_URL` or `APP_URL` pointing anywhere other
 *     than localhost/127.x/[::1]. Production here is `https://grok.antinrml.com`,
 *     so the deployed process is closed even if nobody exports NODE_ENV.
 */
const LOOPBACK_HOST = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|::1)$/;
function isPublicUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return !LOOPBACK_HOST.test(host);
  } catch {
    return false;
  }
}
const appUrl = process.env.APP_URL ?? 'http://localhost:5173';
const serverUrl = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const production = process.env.NODE_ENV === 'production' || isPublicUrl(serverUrl) || isPublicUrl(appUrl);

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl,
  /** See `production` above: NODE_ENV=production, or APP_URL/SERVER_URL off loopback. */
  production,
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl,

  // ---- model ----
  /**
   * An OpenAI-compatible endpoint that also implements the Responses API, because the
   * agent loop is built on `responses.create`. xAI is the default; any gateway that
   * proxies it (a 9router/VPS router, LiteLLM, …) works by changing this one value.
   */
  xaiBaseUrl: (opt('XAI_BASE_URL', 'https://api.x.ai/v1') || 'https://api.x.ai/v1').replace(/\/+$/, ''),
  xaiKey: reqEither(['XAI_API_KEY', 'OPENAI_API_KEY']),
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  /** Hosted tools (`web_search`, `x_search`) are xAI-only. Off for gateways that reject them. */
  enableHostedSearch: process.env.ENABLE_HOSTED_SEARCH !== '0',
  /** Voice/TTS/STT are xAI-only; skip minting realtime secrets when disabled. */
  enableVoice: process.env.ENABLE_VOICE === '1',

  // ---- computers ----
  computerBackend: backendRaw as ComputerBackend,
  /** Orgo backend (legacy). */
  orgoKey: opt('ORGO_API_KEY'),
  /** Orgo workspace that holds every user's box. */
  orgoWorkspaceId: process.env.ORGO_WORKSPACE_ID ?? '',
  /** Orgo box size for new users. */
  orgoRamGb: Number(process.env.ORGO_RAM_GB ?? 8),
  orgoCpu: Number(process.env.ORGO_CPU ?? 2),
  orgoResolution: process.env.ORGO_RESOLUTION ?? '1280x800x24',

  // ---- MSO backend ----
  /** MSO API base. The local MSO service by default. */
  msoBaseUrl: (opt('MSO_BASE_URL', 'http://127.0.0.1:4005') || 'http://127.0.0.1:4005').replace(/\/+$/, ''),
  /**
   * Absolute path to the MSO CLI. The CLI holds its own signed session, so the server
   * never needs a browser password or a copied session cookie.
   */
  msoCli: opt('MSO_CLI', ''),
  /** Where per-bot desktops, browser profiles and libraries live on this host. */
  msoDesktopRoot: (opt('MSO_DESKTOP_ROOT', '') || `${process.env.HOME ?? '/tmp'}/.grokbot/desktops`).replace(/\/+$/, ''),
  /** Screen geometry for each bot X display. */
  msoGeometry: process.env.MSO_GEOMETRY ?? '1280x800x24',
  /** Port range for the per-screen VNC servers (one port per bot display). */
  msoVncPortBase: Number(process.env.MSO_VNC_PORT_BASE ?? 5900),
  /** Linux user the desktops run as. Empty = the server's own user. */
  msoDesktopUser: process.env.MSO_DESKTOP_USER ?? '',

  sessionSecret: reqEither(['SESSION_SECRET']),
  devLogin: process.env.DEV_LOGIN === '1',
  /**
   * The only thing that can open dev login *in production*. Absent by default, so
   * production is closed even when `DEV_LOGIN=1` leaks into `.env`. Set it to `1`
   * only for a deliberate, temporary production debug session. It never admits a
   * staff address (see lib/dev-login-guard.ts).
   */
  devLoginAllowProduction: process.env.DEV_LOGIN_ALLOW_PRODUCTION === '1',
  /** Comma-separated emails allowed to sign in; empty = no email rule (see allowedEmailDomains). */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Comma-separated extra staff domains (leading `@` optional). Additive to staffEmailDomains. */
  allowedEmailDomains: (process.env.ALLOWED_EMAIL_DOMAINS ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
  /** Comma-separated company domains. An address here is staff (artist/management); everyone else is a fan. */
  staffEmailDomains: (process.env.STAFF_EMAIL_DOMAINS ?? 'antinrml.com').split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
  dbPath: process.env.DB_PATH ?? new URL('../../data/grokbot.db', import.meta.url).pathname,

  /** Composio powers app connections and, with AUTH_PROVIDER=composio, Google sign-in. Optional. */
  composioKey: opt('COMPOSIO_API_KEY'),
  get composioEnabled(): boolean {
    return env.composioKey.length > 0;
  },

  // ---- sign-in (WorkOS AuthKit) ----
  /**
   * Exposed here so boot-time validation and `authProvider` agree with what
   * `lib/workos.ts` reads; that module reads `process.env` lazily (same values) so it
   * stays import-free for `node --test`.
   */
  /** WorkOS secret key (`sk_...`). Server-side only; never sent to the browser or logged. */
  workosApiKey,
  /** WorkOS client id (`client_...`). Public, but only the server builds the URL. */
  workosClientId,
  authProvider,
};

export const idleDefaults = {
  idleMin: num(process.env.GROKBOT_IDLE_SUSPEND_MIN, 20),
  sweepSec: num(process.env.GROKBOT_IDLE_SWEEP_SEC, 60),
  dryRun: process.env.GROKBOT_IDLE_DRY_RUN === '1',
};

export { num };
