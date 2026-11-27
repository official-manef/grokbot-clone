/**
 * Child-process probe for conversation rename *as the route runs it*.
 *
 * Why a separate process: `env.ts` and the db handle resolve once per process, so a
 * route that reads configuration at boot cannot be re-pointed mid-test. Same reason
 * `_rate-limit-wiring-probe.mjs` exists.
 *
 * Why the route and not `setConversationTitle` directly: `conversation-rename.test.mjs`
 * used to re-implement the PATCH handler's trim-and-delete in its own helper. That
 * test would still pass if `routes.ts` dropped the trim, stored a blank title, or
 * stopped deleting the row on clear — it asserted a copy of the decision, not the
 * decision. Everything here goes through `api.request`, the same entry the browser uses.
 *
 * No model, no network, no enqueued turn: only `POST /bots` and the rename route,
 * whose fixtures are `rows` written directly (the fixture is not the thing under test).
 *
 *   node --import tsx server/test/_conversation-rename-probe.mjs
 */
import crypto from 'node:crypto';

const { api } = await import('../src/routes.ts');
const { db } = await import('../src/db.ts');


const ownerKey = () =>
  crypto.createHmac('sha256', process.env.SESSION_SECRET ?? '').update('owner-login').digest('hex');

/** The session the operator actually holds, minted by the route they sign in through. */
async function signIn(email) {
  const res = await api.request('/auth/owner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerKey()}` },
    body: JSON.stringify({ email }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  if (res.status !== 200 || !cookie) throw new Error(`sign-in failed: ${res.status}`);
  return cookie;
}

async function call(path, cookie, method, body) {
  const init = { method, headers: { cookie } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await api.request(path, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function createBot(cookie, name) {
  const r = await call('/bots', cookie, 'POST', { name });
  if (r.status !== 200) throw new Error(`bot create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.bot.id;
}

/** Fixture rows, not the subject: the route reads them to build the fallback title. */
function seedExchange(botId, generation, user, assistant) {
  const stmt = db.prepare(
    'INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)',
  );
  stmt.run(botId, generation, 1, 1, 'message', JSON.stringify({ type: 'message', role: 'user', text: user }), Date.now());
  stmt.run(botId, generation, 2, 2, 'message', JSON.stringify({ type: 'message', role: 'assistant', text: assistant }), Date.now());
}

const storedRow = (botId, generation) =>
  db.prepare('SELECT title, source FROM conversations WHERE bot_id=? AND generation=?').get(botId, generation);

const rowCount = (botId, generation) =>
  db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE bot_id=? AND generation=?').get(botId, generation).n;

const cookie = await signIn('artist@antinrml.com');
const botId = await createBot(cookie, 'Rename probe');
seedExchange(botId, 1, 'how do I deploy the payments service to staging', 'run the pack script');

const out = { botId, cases: {} };

// 1. A plain rename persists, attributed to the person rather than the fallback.
out.cases.rename = await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', { title: 'Payments deploy' });
out.cases.renameRow = storedRow(botId, 1);

// 2. Renaming again replaces in place — two names, still one row.
await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', { title: 'Payments deploy v2' });
out.cases.secondRenameRows = rowCount(botId, 1);
out.cases.secondRenameRow = storedRow(botId, 1);

// 3. Whitespace-only must take the CLEAR branch: no blank title can reach the list.
//    The old test's helper decided this itself; here the route decides.
out.cases.whitespace = await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', { title: '   ' });
out.cases.whitespaceRow = storedRow(botId, 1);

// 4. Empty string takes the same branch.
await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', { title: 'Real name' });
out.cases.empty = await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', { title: '' });
out.cases.emptyRow = storedRow(botId, 1);

// 5. A non-string title is a 400, not a coerced "undefined" in the row.
out.cases.notAString = await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', { title: 42 });
out.cases.missingTitle = await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', {});

// 6. The cap is the route's, not the test's: 400 characters in, 120 stored.
await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', { title: 'r'.repeat(400) });
out.cases.capRow = storedRow(botId, 1);

// 7. A generation this bot has no rows for and is not current is a 404, so a
//    crafted generation cannot plant a row on someone's conversation list.
out.cases.unknownGeneration = await call(`/bots/${botId}/conversations/999`, cookie, 'PATCH', { title: 'nope' });

// 8. Cross-bot isolation, driven through the route for both bots.
const otherBot = await createBot(cookie, 'Rename probe two');
seedExchange(otherBot, 1, 'why is the nightly build red', 'a flaky test');
await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', { title: 'Only the first' });
await call(`/bots/${otherBot}/conversations/1`, cookie, 'PATCH', { title: 'Only the second' });
out.cases.isolation = { first: storedRow(botId, 1), second: storedRow(otherBot, 1) };

// 9. Another user's bot is not renameable with this session.
const strangerCookie = await signIn('other@antinrml.com');
out.cases.foreignBot = await call(`/bots/${botId}/conversations/1`, strangerCookie, 'PATCH', { title: 'theirs now' });

// 10. The list endpoint must never surface a blank title after a clear.
await call(`/bots/${botId}/conversations/1`, cookie, 'PATCH', { title: '   ' });
out.cases.list = await call(`/bots/${botId}/conversations`, cookie, 'GET');

console.log('@@PROBE@@' + JSON.stringify(out));
process.exit(0);
