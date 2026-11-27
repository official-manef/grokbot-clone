import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { env, capabilityReport } from './env.js';
import { api } from './routes.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { configApi } from './routes-config.js';
import { mcpApi } from './mcp.js';
import { onError } from './lib/error-handler.js';
import { capabilitiesPayload } from './lib/capabilities.js';
import { checkOrigin, parseOrigins } from './lib/origin-check.js';

/**
 * The whole request surface, in the order it actually runs.
 *
 * This is a builder rather than a module-level `const app` so a test can drive the
 * composed app instead of a sub-app: `_staff-signin-probe.mjs` used to mount `api`
 * bare and call `/auth/google/callback` on it directly, so a path production never
 * serves still answered `401` in the test while the served build answered
 * `200 text/html` from the SPA fallback. Same class of false green as the stale-dist
 * gate: the fixture was not the app.
 *
 * `staticRoot` exists for the same reason. CI runs `npm test` *before* `npm run
 * build`, so `web/dist` is absent there and a fallback registered only when the
 * directory exists would be missing in exactly the run that is supposed to catch
 * this. A test passes a temp dir with a fake `index.html` and gets the production
 * shape without needing a build.
 */
export function buildApp(opts: { staticRoot?: string | null } = {}): Hono {
  const app = new Hono();
  // Capability gaps answer 501 with the vars that close them; everything else gets
  // a request id. No stack or key ever reaches a client.
  app.onError(onError);

  /**
   * CSRF gate. With the default `SameSite=Lax` cookie this is belt-and-braces; with
   * `SESSION_COOKIE_SAMESITE=none` (an embedded deployment) it is the only thing
   * stopping another site from driving this API with the user's cookie.
   *
   * The own-origins list is derived here, not configured, so it cannot drift from the
   * URLs the server actually advertises. `EMBED_ALLOWED_ORIGINS` adds the console that
   * frames the app and nothing else.
   */
  const ownOrigins = parseOrigins([env.appUrl, env.serverUrl].join(','));
  app.use('/api/*', async (c, next) => {
    const verdict = checkOrigin({
      method: c.req.method,
      path: c.req.path,
      origin: c.req.header('origin'),
      ownOrigins,
      allowedOrigins: env.embedAllowedOrigins,
    });
    if (verdict.ok) return next();
    if (verdict.reason === 'missing') console.warn(`[csrf] ${c.req.method} ${c.req.path} had no Origin header`);
    return c.json({ error: 'cross-site request refused' }, 403);
  });
  /**
   * Liveness vs readiness. `ok` is readiness: the server is up AND its configured
   * backend exists, so a bot turn could be answered. A half-configured endpoint
   * (model name only, key without base) is NOT ready, and the status code is 503
   * so an uptime check pages instead of reading green while every turn dies.
   *
   * No network call per request by default: the answer is configuration truth.
   * `?probe=1` adds one reachability check against the Hermes engine when that is
   * the backend being used (never against a BYOK endpoint, whose billable path
   * should not be hit by a monitor). Opt-in, so polling stays free.
   */
  app.get('/api/health', async (c) => {
    const report = capabilityReport();
    const ok = report.ok;
    const body: Record<string, unknown> = { ok, engine: report.engine, model: report.model, capabilities: report.capabilities };
    if (c.req.query('probe') === '1') {
      if (report.engine === 'hermes') {
        try {
          const r = await fetch(`${env.hermesUrl}/health`, { signal: AbortSignal.timeout(2500) });
          body.reachable = r.ok;
          if (!r.ok) body.ok = false;
        } catch {
          body.reachable = false;
          body.ok = false;
        }
      } else if (report.engine === 'byok') {
        body.reachable = null;
        body.note = 'No probe for a BYOK endpoint: a reachability call would be a billable model request.';
      }
    }
    const status = body.ok ? 200 : 503;
    return c.json(body, status);
  });
  app.get('/api/capabilities', async (c) => c.json(await capabilitiesPayload()));
  // The app's tools for the agent engines (MCP).
  app.route('/mcp', mcpApi);
  app.route('/api/checkins', checkinsApi);
  app.route('/api/rooms', roomsApi);
  app.route('/api', api);
  app.route('/api', configApi);

  /**
   * An unmatched `/api/*` path is not a page.
   *
   * Without this the SPA fallback below answers `200 text/html` for every unknown API
   * path, because Hono carries on past a sub-app that matched nothing. That is wrong
   * three ways, all measured: a client's `req()` tries `res.json()` on `index.html`
   * and throws a parse error instead of reporting a 404; a removed route still
   * answers 200, so "does this route exist?" cannot be answered from outside; and a
   * test asserting 404-or-401 could pass while the served build returned a page.
   * Registered after every API mount and before the static handler so it wins.
   */
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // Serve the built web app in production.
  const webDist = opts.staticRoot ?? path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
  if (webDist && fs.existsSync(webDist)) {
    app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
    app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
  }

  return app;
}
