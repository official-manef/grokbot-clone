/**
 * Child-process probe for the wiring tests: env.ts and the db handle resolve once per
 * process, so each case needs its own process, exactly as at boot.
 *
 *   node --import tsx server/test/_rate-limit-wiring-probe.mjs routes
 *   node --import tsx server/test/_rate-limit-wiring-probe.mjs quota-tokens
 *   node --import tsx server/test/_rate-limit-wiring-probe.mjs quota-unavailable
 *
 * The model is stubbed with a loopback HTTP server that only counts requests, so a
 * call that should never happen is observable as a non-zero count. Nothing here
 * reaches the public network.
 */
import http from 'node:http';

const mode = process.argv[2] ?? 'routes';

/** A stub Responses endpoint that records hits and answers with one SSE message. */
function stubModel() {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    hits.push({ path: req.url, body: Buffer.concat(chunks).toString('utf8').slice(0, 200) });
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
// env.ts reads XAI_BASE_URL at import time, so it is set before anything else loads.
process.env.XAI_BASE_URL = stub.baseUrl;

const { db } = await import('../src/db.ts');
const { initSubagents } = await import('../src/agent/subagents.ts');
const { api } = await import('../src/routes.ts');
const { enqueue } = await import('../src/agent/loop.ts');

// index.ts does this at boot; prompt.ts reads the column it adds.
initSubagents();

const T = Date.now();

function seed({ audience = 'fan', role = null, overLimit = false, dropUsage = false } = {}) {
  const userId = `usr_probe_${T}`;
  const botId = `bot_probe_${T}`;
  const token = `tok_probe_${T}`;
  db.prepare('INSERT INTO users(id,email,name,audience,role,created_at) VALUES (?,?,?,?,?,?)').run(
    userId, `${userId}@example.com`, 'Probe', audience, role, Date.now());
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(botId, userId, 'Quinn', '', '', '', 'blob', 'blue', 'personal', 1, Date.now(), Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(
    token, userId, Date.now(), Date.now() + 3600_000);
  if (dropUsage) db.exec('DROP TABLE usage_daily');
  else if (overLimit) {
    // Fan wall is 50k tokens/day: spend all of it before the turn.
    db.prepare('INSERT INTO usage_daily(user_id,day,requests,input_tokens,output_tokens) VALUES (?,?,?,?,?)').run(
      userId, new Date().toISOString().slice(0, 10), 1, 50_000, 0);
  }
  return { userId, botId, token };
}

const post = (token, path, body = {}) =>
  api.request(path, {
    method: 'POST',
    headers: { cookie: `grokbot_session=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Wait for a runTurn (queued, not awaited) to finish writing rows. */
async function waitForAssistant(botId, timeoutMs = 5000) {
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

if (mode === 'routes') {
  const { token, botId } = seed();
  // Empty text fails validation AFTER the limiter, so each attempt exercises the
  // limit without queueing a turn. Walk past the budget and record where the wall is.
  const statuses = [];
  let retryAfter = null;
  for (let i = 0; i < 80; i += 1) {
    const res = await post(token, `/bots/${botId}/messages`, { text: '' });
    statuses.push(res.status);
    if (res.status === 429) {
      retryAfter = res.headers.get('retry-after');
      break;
    }
  }
  out = { mode, statuses, firstBlockedAt: statuses.length, retryAfter, body: null };
} else if (mode === 'routes-under') {
  const { token, botId } = seed();
  const res = await post(token, `/bots/${botId}/messages`, { text: 'hi' });
  out = { mode, status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.clone().json().catch(() => null) };
} else if (mode === 'quota-tokens') {
  const { botId } = seed({ overLimit: true });
  enqueue(botId, { type: 'user', text: 'hello there' });
  const body = await waitForAssistant(botId);
  out = { mode, assistantText: body?.text ?? null, modelHits: stub.hits.length };
} else if (mode === 'quota-unavailable') {
  const { botId } = seed({ dropUsage: true });
  enqueue(botId, { type: 'user', text: 'hello there' });
  const body = await waitForAssistant(botId);
  out = { mode, assistantText: body?.text ?? null, modelHits: stub.hits.length };
} else if (mode === 'quota-allowed') {
  // Control: under the wall the model really is called, and the spend is recorded.
  const { botId, userId } = seed();
  enqueue(botId, { type: 'user', text: 'hello there' });
  const body = await waitForAssistant(botId);
  const usage = db.prepare('SELECT requests, input_tokens, output_tokens FROM usage_daily WHERE user_id=?').get(userId);
  out = { mode, assistantText: body?.text ?? null, modelHits: stub.hits.length, usage: usage ?? null };
} else {
  throw new Error(`unknown mode ${mode}`);
}

await stub.close();
process.stdout.write('@@PROBE@@' + JSON.stringify(out) + '\n');
