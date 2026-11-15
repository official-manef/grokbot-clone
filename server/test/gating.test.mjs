/**
 * A capability must be refused where it runs, not only hidden where it is listed.
 *
 * Two claims were different in this tree and only one was true:
 *   - `listTools` filtered on `availableTools()`
 *   - `callTool` looked the tool up in the raw `toolMap`
 * So an engine with a stale schema, or a model that named a hidden tool anyway,
 * reached the implementation. `shell` happened to fail there with its own
 * CapabilityError, which is why this was a shape bug and not an open hole — but the
 * boundary was missing, and every future tool would have inherited the gap.
 *
 * `x_search` and `web_search` gating is not tested here: it arrived with
 * `x-search.test.mjs` and `web-search.test.mjs`, which drive the real endpoint.
 *
 *   node --test server/test/gating.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/** Ask a fresh process which tools this configuration offers. */
async function toolsFor(env) {
  const { stdout } = await run(
    path.join(root, 'node_modules/.bin/tsx'),
    [path.join(root, 'server/test/_tools-probe.mjs'), 'tools', '{}'],
    { cwd: root, env: { ...process.env, ...env, DB_PATH: '/tmp/grokbot-gating-test.db' }, timeout: 120_000 },
  );
  const marked = stdout.split('\n').find((l) => l.includes('@@PROBE@@'));
  assert.ok(marked, `probe printed no result; got: ${stdout.slice(-300)}`);
  return JSON.parse(marked.slice(marked.indexOf('@@PROBE@@') + 9)).names;
}

const DESKTOP = ['computer_screenshot', 'computer_click', 'computer_type', 'computer_key',
  'computer_scroll', 'computer_drag', 'open_browser', 'save_file', 'shell'];

test('no desktop means no desktop tools, and no shell', async () => {
  const names = await toolsFor({ DESKTOP_MODE: 'disabled' });
  for (const t of DESKTOP) assert.ok(!names.includes(t), `${t} must be absent without a desktop`);
  assert.ok(names.includes('remember'), 'tooling that needs nothing is still offered');
});

test('a desktop brings the desktop tools back', async () => {
  const names = await toolsFor({ DESKTOP_MODE: 'docker' });
  for (const t of DESKTOP) assert.ok(names.includes(t), `${t} appears once a desktop exists`);
});

test('callTool refuses a tool it did not offer', () => {
  // The guard has to wrap `own.impl`, not follow it: a refusal after execution is
  // decoration. This half cannot be shown by a child process without a live engine,
  // so it reads the one function whose ordering is the contract.
  const src = read('server/src/mcp.ts');
  const at = src.indexOf('async function callTool');
  assert.ok(at > -1, 'callTool exists');
  const body = src.slice(at, src.indexOf('\n}', at));
  const checkAt = body.indexOf('availableTools()');
  const implAt = body.indexOf('own.impl');
  assert.ok(checkAt > -1, 'callTool consults availableTools');
  assert.ok(implAt > -1, 'and still calls the implementation');
  assert.ok(checkAt < implAt, 'the check precedes the call');
  assert.match(body, /isError: true|, true\)/, 'a refusal is an error result, not a silent success');
});

test('shell does not claim root', () => {
  const src = read('server/src/agent/tools.ts');
  const at = src.indexOf("name: 'shell'");
  assert.doesNotMatch(src.slice(at, at + 400), /as root/,
    'the box runs as an unprivileged user; saying root misleads the model');
});

test('the screenshot route serves the saved file it was asked for', () => {
  const src = read('server/src/routes.ts');
  const at = src.indexOf("api.get('/bots/:id/screenshot'");
  assert.ok(at > -1, 'screenshot route exists');
  const body = src.slice(at, src.indexOf('\n});', at));
  assert.match(body, /c\.req\.query\('seq'\)/, 'the route reads seq');
  assert.match(body, /\^screen-\\d\+\\\.png\$/, 'seq is validated against the name the tool writes');
  assert.match(body, /libraryDirFor\(b\.id\)/, "it reads from this bot's own library");
  assert.match(body, /readFile\(/, 'it serves the saved bytes');
  assert.match(body, /screenshot\(/, 'and falls back to a live capture when nothing was saved');
});
