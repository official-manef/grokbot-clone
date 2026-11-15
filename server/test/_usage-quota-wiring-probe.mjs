/**
 * Child-process probe for the quota wiring: env.ts and the db handle resolve once per
 * process, so each case needs its own process, exactly as at boot.
 *
 *   node --import tsx server/test/_usage-quota-wiring-probe.mjs quota-tokens
 *   node --import tsx server/test/_usage-quota-wiring-probe.mjs quota-requests
 *   node --import tsx server/test/_usage-quota-wiring-probe.mjs quota-unavailable
 *   node --import tsx server/test/_usage-quota-wiring-probe.mjs quota-allowed
 *
 * The model is stubbed with a loopback HTTP server that only counts requests, so a
 * call that should never happen is observable as a non-zero count. Nothing here
 * reaches the public network.
 */
import http from 'node:http';

const mode = process.argv[2] ?? 'quota-allowed';

/** A stub Responses endpoint that records hits and answers with one SSE message. */
function stubModel() {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    hits.push({ path: req.url });
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"stub answer"}\n\n');
      res.write('event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"stub answer"}]}],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, hits, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const stub = await stubModel();
// env.ts reads HERMES_URL at import time, so it points at the stub before anything loads.
// The primary engine is the one that needs no provisioning: engineFor returns its URL as-is.
process.env.HERMES_URL = stub.baseUrl.replace(/\/v1$/, '');
process.env.HERMES_KEY = 'test-key';

const { db } = await import('../src/db.ts');
const { initSubagents } = await import('../src/agent/subagents.ts');
const { initRooms } = await import('../src/agent/rooms.ts');
const { enqueue } = await import('../src/agent/loop.ts');

// index.ts does this at boot; the queries in createBot and prompt.ts read those columns.
initSubagents();
initRooms();

const T = `${Date.now()}${Math.round(Math.random() * 1e6)}`;
const DAY = new Date().toISOString().slice(0, 10);

function seed({ spendTokens = 0, spendRequests = 0, dropUsage = false } = {}) {
  const userId = `usr_probe_${T}`;
  const botId = `bot_probe_${T}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(
    userId, `${userId}@antinrml.com`, 'Probe', Date.now());
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,engine,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(botId, userId, 'Quinn', '', '', '', 'blob', 'blue', 'personal', 1, 'primary', Date.now(), Date.now());
  if (dropUsage) db.exec('DROP TABLE usage_daily');
  else if (spendTokens || spendRequests) {
    db.prepare('INSERT INTO usage_daily(user_id,day,requests,input_tokens,output_tokens) VALUES (?,?,?,?,?)').run(
      userId, DAY, spendRequests, spendTokens, 0);
  }
  return { userId, botId };
}

/** Wait for a runTurn (queued, not awaited) to finish writing rows. */
async function waitForAssistant(botId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message' ORDER BY seq DESC").get(botId);
    if (row) {
      const body = JSON.parse(row.body);
      if (body.role === 'assistant') return body;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

let out;
const turn = async (seeded) => {
  enqueue(seeded.botId, { type: 'user', text: 'hello there' });
  return waitForAssistant(seeded.botId);
};

if (mode === 'quota-tokens') {
  // The staff wall is 2M tokens/day: spend all of it before the turn.
  const seeded = seed({ spendTokens: 2_000_000 });
  const body = await turn(seeded);
  out = { mode, assistantText: body?.text ?? null, modelHits: stub.hits.length };
} else if (mode === 'quota-requests') {
  const seeded = seed({ spendRequests: 2000 });
  const body = await turn(seeded);
  out = { mode, assistantText: body?.text ?? null, modelHits: stub.hits.length };
} else if (mode === 'quota-unavailable') {
  const seeded = seed({ dropUsage: true });
  const body = await turn(seeded);
  out = { mode, assistantText: body?.text ?? null, modelHits: stub.hits.length };
} else if (mode === 'quota-allowed') {
  // Control: under the wall the model really is called, and the spend is recorded.
  const seeded = seed();
  const body = await turn(seeded);
  const usage = db.prepare('SELECT requests, input_tokens, output_tokens FROM usage_daily WHERE user_id=? AND day=?').get(seeded.userId, DAY);
  out = { mode, assistantText: body?.text ?? null, modelHits: stub.hits.length, usage: usage ?? null };
} else {
  throw new Error(`unknown mode ${mode}`);
}

await stub.close();
process.stdout.write('@@PROBE@@' + JSON.stringify(out) + '\n');
db.close();
