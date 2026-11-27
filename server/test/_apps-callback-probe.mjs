/**
 * The `/apps/callback` page, answered in a child process because env.ts resolves
 * once per process. That route is the one HTML page an unauthenticated caller can
 * make this server print: a popup returns from the provider with no fetch headers
 * we control, so the page is mounted outside the session gate.
 *
 *   node --import tsx server/test/_apps-callback-probe.mjs '<slug>' [status]
 *
 * Mounts `api` under `/api` exactly as index.ts does, so the path the route sees is
 * the path production sees. Prints status, headers and body.
 */
const slug = process.argv[2] ?? '';
const status = process.argv[3] ?? 'ok';

const { Hono } = await import('hono');
const { api } = await import('../src/routes.ts');
const { db } = await import('../src/db.ts');

const app = new Hono();
app.route('/api', api);

const qs = new URLSearchParams({ slug, status });
const res = await app.request(`/api/apps/callback?${qs}`);
const body = await res.text();

process.stdout.write(
  '@@PROBE@@' +
    JSON.stringify({
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      cacheControl: res.headers.get('cache-control') ?? '',
      nosniff: res.headers.get('x-content-type-options') ?? '',
      body,
    }) +
    '\n',
);

db.close?.();
process.exit(0);
