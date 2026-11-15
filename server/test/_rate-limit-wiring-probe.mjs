/**
 * Child-process probe for the limiter *as the routes run it*. env.ts and the db
 * handle resolve once per process, so each case gets its own process, as at boot.
 *
 *   node --import tsx server/test/_rate-limit-wiring-probe.mjs turns
 *   node --import tsx server/test/_rate-limit-wiring-probe.mjs rotating-hop
 *   node --import tsx server/test/_rate-limit-wiring-probe.mjs ceiling
 *
 * No network: every route below answers from configuration and SQLite, and no
 * turn is ever enqueued (`/bots/does-not-exist/messages` is limited before the
 * bot is looked up).
 */
import crypto from 'node:crypto';

const mode = process.argv[2] ?? 'turns';

const { api } = await import('../src/routes.ts');
const { db } = await import('../src/db.ts');
const { MAX_KEYS, poolSizes } = await import('../src/lib/rate-limit.ts');

// index.ts does this at boot; createBot and prompt.ts read those columns.
const { initRooms } = await import('../src/agent/rooms.ts');
const { initSubagents } = await import('../src/agent/subagents.ts');
initSubagents();
initRooms();

const ownerKey = () =>
  crypto.createHmac('sha256', process.env.SESSION_SECRET ?? '').update('owner-login').digest('hex');

/** A real session cookie, minted by the route the operator uses. */
async function signIn() {
  const res = await api.request('/auth/owner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerKey()}` },
    body: JSON.stringify({ email: 'artist@antinrml.com' }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { status: res.status, cookie };
}

/** One request, status only: the question here is 429-or-not. */
async function hit(path, headers = {}, method = 'POST', body) {
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await api.request(path, init);
  return res.status;
}

let out;
if (mode === 'turns') {
  // `/bots/:id/messages` is the route that spends model tokens per call. A
  // missing bot still counts against the limit, so this needs no turn and no
  // model: 60 allowed (404), the 61st refused (429).
  const { status, cookie } = await signIn();
  const statuses = [];
  for (let i = 0; i < 62; i += 1) {
    statuses.push(
      await hit('/bots/does-not-exist/messages', {
        'content-type': 'application/json',
        cookie,
        ...{},
      }),
    );
  }
  out = { mode, signInStatus: status, statuses };
} else if (mode === 'rotating-hop') {
  // Only the spoofable prefix changes; the proxy-appended last hop is constant.
  // 20 per window on `/auth/link/:token`, so the 21st must be 429 — a limiter
  // reading the first hop would hand out 21 fresh buckets instead.
  const statuses = [];
  for (let i = 0; i < 21; i += 1) {
    statuses.push(await hit('/auth/link/not-a-token', { 'x-forwarded-for': `127.0.0.${i}, 203.0.113.7` }, 'GET'));
  }
  out = { mode, statuses };
} else if (mode === 'ceiling') {
  // More distinct last hops than the pool cap: the map must not grow with them.
  const n = MAX_KEYS + 64;
  for (let i = 0; i < n; i += 1) {
    const last = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    await hit('/auth/link/not-a-token', { 'x-forwarded-for': `127.0.0.1, ${last}` }, 'GET');
  }
  out = { mode, requested: n, pool: poolSizes(), maxKeys: MAX_KEYS };
} else if (mode === 'direct-clients') {
  // Two clients the route must not collapse into one bucket. No socket address
  // exists in this harness, so identity comes from `x-real-ip` — the same
  // `clientKey` fallback chain the header-less path uses for the socket.
  const statuses = [];
  for (let i = 0; i < 21; i += 1) {
    statuses.push(await hit('/auth/link/not-a-token', { 'x-real-ip': '203.0.113.1' }, 'GET'));
  }
  const other = await hit('/auth/link/not-a-token', { 'x-real-ip': '203.0.113.2' }, 'GET');
  out = { mode, statuses, other };
} else if (mode === 'password-hop') {
  // `/auth/password` keeps its own failure counter. It now shares `clientKey`,
  // so a rotating first hop must not buy fresh guesses either.
  const statuses = [];
  for (let i = 0; i < 7; i += 1) {
    statuses.push(
      await hit(
        '/auth/password',
        { 'content-type': 'application/json', 'x-forwarded-for': `127.0.0.${i}, 203.0.113.9` },
        'POST',
        { email: 'artist@antinrml.com', password: 'wrong password' },
      ),
    );
  }
  out = { mode, statuses };
} else {
  throw new Error(`unknown mode ${mode}`);
}

process.stdout.write('@@PROBE@@' + JSON.stringify(out) + '\n');
db.close();
