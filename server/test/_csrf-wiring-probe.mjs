/**
 * The CSRF gate as `createApp()` wires it, against the requests the repo's own tooling
 * sends. Child process because env.ts resolves once per process.
 *
 *   node --import tsx server/test/_csrf-wiring-probe.mjs
 *
 * Prints `@@PROBE@@{results}`; each result is `{ name, status, body }`.
 */
const { createApp } = await import('../src/app.ts');

// No SPA fallback: a served page would only hide a path that fell through the router.
const app = createApp({ webDist: '/nonexistent-web-dist' });

const post = (name, path, headers, body) =>
  app
    .request('http://localhost' + path, { method: 'POST', headers, body })
    .then(async (res) => ({ name, status: res.status, body: (await res.clone().text()).slice(0, 160) }))
    .then((r) => results.push(r));

const results = [];

// Exactly what `bin/gb signIn()` sends, and what `tests/e2e.mjs` sends: JSON, no Origin.
await post('gb login / e2e (JSON, no Origin)', '/api/auth/dev', { 'content-type': 'application/json' }, JSON.stringify({ email: 'dev@local' }));

// What `scripts/sign-in-link.sh` sends: JSON plus the owner key, no Origin.
await post('sign-in-link.sh (JSON + bearer, no Origin)', '/api/auth/owner',
  { 'content-type': 'application/json', authorization: 'Bearer 00' },
  JSON.stringify({ email: 'dev@local', link: true }));

// The shape a cross-site page can actually send: a form POST with the cookie and no Origin.
await post('cross-site form POST', '/api/bots', { 'content-type': 'application/x-www-form-urlencoded' }, 'name=x');

// The same form with a foreign Origin.
await post('cross-site form POST, foreign Origin', '/api/bots',
  { 'content-type': 'text/plain', origin: 'https://evil.example' }, 'name=x');

// A unicode/plain form body carrying multipart, which is also preflight-free.
await post('multipart form POST', '/api/bots', { 'content-type': 'multipart/form-data; boundary=x' }, '--x--');

process.stdout.write('@@PROBE@@' + JSON.stringify({ results }) + '\n');
