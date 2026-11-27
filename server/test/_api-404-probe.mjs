/**
 * Mounts the real app (`createApp`) in a child process and reports what it answers.
 * A child process because `env.ts` resolves once per process, and the app is built
 * from that env.
 *
 *   node --import tsx server/test/_api-404-probe.mjs '<webDist dir>'
 *
 * Prints `@@PROBE@@{results}`; each result is `{ path, status, contentType, body }`.
 */
const webDist = process.argv[2];

const { createApp } = await import('../src/app.ts');

const app = createApp({ webDist });

const paths = [
  '/',
  '/assets/missing.js',
  '/api/health',
  '/api/definitely-not-a-route',
  '/api/auth/google/callback',
  '/api/bots/not-a-bot/nope',
];

const results = [];
for (const p of paths) {
  const res = await app.request('http://localhost' + p);
  const contentType = res.headers.get('content-type') ?? '';
  let body = '';
  try {
    body = await res.clone().text();
  } catch { /* nothing to read */ }
  results.push({ path: p, status: res.status, contentType, body: body.slice(0, 120) });
}

// A cross-site POST to an unknown path: the CSRF gate is registered before the 404
// catch-all, so this must be 403. If the catch-all ever moved above the gate, an
// unknown path would answer 404 and skip the one check that protects writes.
const cross = await app.request('http://localhost/api/definitely-not-a-route', {
  method: 'POST',
  headers: { origin: 'https://evil.example' },
});
results.push({
  path: 'POST /api/definitely-not-a-route (foreign origin)',
  status: cross.status,
  contentType: cross.headers.get('content-type') ?? '',
  body: (await cross.clone().text()).slice(0, 120),
});

process.stdout.write('@@PROBE@@' + JSON.stringify({ results }) + '\n');
