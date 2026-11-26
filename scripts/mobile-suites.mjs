/**
 * Run the three synthetic mobile suites against a throwaway server.
 *
 * Why this exists: `npm test` globs `server/test/*.test.mjs`, so the three
 * `web/mobile-*.mjs` suites were green by hand but never ran in CI. The merged branch
 * (e0d1ce7) shipped them as evidence while CI only proved typecheck + 192 server tests
 * + build. This file is the wiring that closes that gap.
 *
 * Why no Vite: `server/src/index.ts` serves `web/dist` over `serveStatic` when the
 * build exists, so one process answers both `/api/*` and the app. That needs `npm run
 * build` first (CI already does it) and removes a proxy, a second port, and a second
 * startup race from the picture.
 *
 * Safety: everything here is loopback and throwaway. The port is ephemeral, the
 * database is a temp file, dev login is enabled only because this is a local synthetic
 * server, and the secret is generated per run. No production auth is involved: the
 * suites sign in through `POST /api/auth/dev`, which the dev-login guard refuses
 * outside loopback and outside a staff-allowlisted address.
 *
 *   node scripts/mobile-suites.mjs
 *   node scripts/mobile-suites.mjs --keep   # leave the server up for debugging
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const keep = process.argv.includes('--keep');

/** An ephemeral free port, so parallel CI runs cannot collide on a fixed one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll until the server answers, so the suites never race the boot. */
async function waitForServer(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 503 is the honest "up but no model key" answer; any response means it is listening.
      await fetch(`http://127.0.0.1:${port}/api/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`server did not answer on :${port} within ${timeoutMs}ms`);
}

const dist = path.join(root, 'web/dist/index.html');
if (!existsSync(dist)) {
  console.error('[mobile-suites] web/dist/index.html is missing. Run `npm run build` first.');
  process.exit(1);
}

const port = await freePort();
const tmp = await mkdtemp(path.join(os.tmpdir(), 'grokbot-mobile-ci-'));
const dbPath = path.join(tmp, 'ci.db');

const env = {
  ...process.env,
  PORT: String(port),
  APP_URL: `http://127.0.0.1:${port}`,
  SERVER_URL: `http://127.0.0.1:${port}`,
  DB_PATH: dbPath,
  // Generated per run: nothing to leak, nothing to reuse.
  SESSION_SECRET: randomBytes(32).toString('hex'),
  DEV_LOGIN: '1',
  ALLOWED_EMAILS: '',
  ALLOWED_EMAIL_DOMAINS: 'antinrml.com',
  // No model, no desktop, no scheduler: the suites drive UI and read SQLite only.
  DESKTOP_MODE: 'disabled',
  HERMES_BIN: '/bin/false',
  GROKBOT_NO_SCHEDULER: '1',
  AUTH_PASSWORD: '',
  AUTH_PASSWORD_HASH: '',
  AUTH_PROVIDER: '',
  XAI_API_KEY: '',
  COMPOSIO_API_KEY: '',
  WORKOS_API_KEY: '',
  WORKOS_CLIENT_ID: '',
  NODE_ENV: '',
};

const children = [];
function stopAll() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
}
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

/** Seed the same shape the suites expect: one primary bot and a few messages. */
async function seed() {
  // Run through `tsx`, not `import()` in this process: `server/src/db.ts` imports
  // `./env.js`, which only resolves under tsx's `.js` -> `.ts` rewriting.
  const script = [
    "const { db } = await import('./server/src/db.ts');",
    'const now = Date.now();',
    `db.prepare('INSERT OR REPLACE INTO users (id,email,name,created_at) VALUES (?,?,?,?)')`,
    `  .run('ci-user', 'artist@antinrml.com', 'CI Artist', now);`,
    "db.prepare(`INSERT OR REPLACE INTO bots (id,user_id,name,label,description,avatar_color,is_primary,generation,next_seq,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)",
    `  .run('ci-bot', 'ci-user', 'Studio', '', 'CI fixture bot', 'blue', 1, 1, 9, now, now);`,
    `const insert = db.prepare('INSERT OR REPLACE INTO rows (bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)');`,
    'const msgs = [',
    "  ['user', 'how do I deploy the payments service to staging'],",
    "  ['assistant', 'run the pack script'],",
    "  ['user', 'why is the nightly build red'],",
    "  ['assistant', 'a flaky test'],",
    "  ['user', 'add a dark mode toggle to settings'],",
    "  ['assistant', 'CSS has the tokens'],",
    '];',
    `msgs.forEach((m, i) => insert.run('ci-bot', 1, i + 1, i + 1, 'message', JSON.stringify({ type: 'message', role: m[0], text: m[1] }), now + i));`,
    '// Extra generations so the conversation list has more than one row.',
    'for (let g = 2; g <= 3; g += 1) {',
    `  insert.run('ci-bot', g, 1, 1, 'message', JSON.stringify({ type: 'message', role: 'user', text: 'question ' + g }), now + 10 + g);`,
    `  insert.run('ci-bot', g, 2, 2, 'message', JSON.stringify({ type: 'message', role: 'assistant', text: 'answer ' + g }), now + 20 + g);`,
    '}',
    'db.close();',
  ].join('\n');
  const code = await run(process.execPath, ['--import', 'tsx', '-e', script]);
  if (code !== 0) throw new Error('seed failed');
}

const suites = [
  'web/mobile-clean-start.mjs',
  'web/mobile-overlays.test.mjs',
  'web/mobile-defaults.test.mjs',
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit', ...opts });
    children.push(child);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

let failures = 0;
try {
  console.log(`[mobile-suites] seeded ${dbPath}`);
  await seed();

  console.log(`[mobile-suites] starting server on 127.0.0.1:${port}`);
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(server);
  server.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  await waitForServer(port);

  for (const suite of suites) {
    console.log(`\n[mobile-suites] ${suite}`);
    const code = await run(process.execPath, [suite], {
      env: { ...env, PREVIEW: `http://127.0.0.1:${port}` },
    });
    if (code !== 0) { failures += 1; console.error(`[mobile-suites] FAILED: ${suite}`); }
  }
} finally {
  if (!keep) {
    stopAll();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  } else {
    console.log(`[mobile-suites] --keep: server on :${port}, db ${dbPath}`);
  }
}

if (failures) {
  console.error(`\n[mobile-suites] ${failures} suite(s) failed`);
  process.exit(1);
}
console.log('\n[mobile-suites] all suites passed');
