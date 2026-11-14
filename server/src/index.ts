import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { env, capabilityReport } from './env.js';
import { api } from './routes.js';
import { attachVncRelay } from './vnc.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue, expireStaleApprovals } from './agent/loop.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { startIdleWatcher } from './idle.js';
import { mcpApi } from './mcp.js';
import { initEngines } from './engine.js';
import { onError } from './lib/error-handler.js';
import { capabilitiesPayload } from './lib/capabilities.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
initSubagents();
initRooms();
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();

const app = new Hono();
// Capability gaps answer 501 with the vars that close them; everything else gets
// a request id. No stack or key ever reaches a client.
app.onError(onError);
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

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`[grokbot] server on http://localhost:${info.port}`));
attachVncRelay(server as unknown as Server);
// GROKBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (process.env.GROKBOT_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
initProactive(enqueue);
} else console.log('[grokbot] scheduler disabled (GROKBOT_NO_SCHEDULER=1)');
startIdleWatcher();
initEngines();
