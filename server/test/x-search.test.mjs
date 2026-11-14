/**
 * x_search is a vendor-hosted tool: it must follow the configured endpoint and
 * must only be advertised when the operator opts in.
 *
 * Each case runs in its own process (test/_tools-probe.mjs) because env.ts
 * resolves once per process, exactly as it does at boot.
 *
 *   node --import tsx --test server/test/x-search.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_tools-probe.mjs');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Run one tool-layer call in a fresh process with exactly these env vars. */
function run(kind, args, env) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, kind, JSON.stringify(args ?? {})],
      {
        cwd: path.join(here, '..'),
        env: {
          ...process.env,
          // No writes into the repo: every case gets a throwaway database.
          DB_PATH: path.join(os.tmpdir(), `grokbot-tools-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
          ...env,
        },
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`${err.message}\n${stderr}`));
        const line = stdout.split('\n').reverse().find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe payload in: ${stdout}\n${stderr}`));
        try { resolve(JSON.parse(line.slice('@@PROBE@@'.length))); } catch { reject(new Error(`bad probe output: ${line}\n${stderr}`)); }
      },
    );
  });
}

const LLM_ONLY = { LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' };

test('x_search: not advertised on a BYOK endpoint without the opt-in', async () => {
  const r = await run('tools', {}, { ...LLM_ONLY, LLM_X_SEARCH: '' });
  assert.equal(r.ok, true, r.error);
  assert.ok(!r.names.includes('x_search'), `x_search must be hidden, got ${r.names.join(',')}`);
});

test('x_search: advertised once the opt-in is set', async () => {
  const r = await run('tools', {}, { ...LLM_ONLY, LLM_X_SEARCH: '1' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.names.includes('x_search'), 'x_search must be listed when LLM_X_SEARCH=1');
});

test('x_search: the request follows LLM_BASE_URL, not a vendor host', async () => {
  const seen = [];
  const { server, base } = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      json(res, {
        output: [{ type: 'message', content: [{ text: 'posts found', annotations: [{ url: 'https://x.com/a/1' }] }] }],
      });
    });
  });
  try {
    const r = await run('call', { name: 'x_search', args: { query: 'agents' } }, {
      LLM_BASE_URL: `${base}/v1`, LLM_API_KEY: 'byok-key', LLM_MODEL: 'byok-model', LLM_X_SEARCH: '1',
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1/responses');
    assert.equal(seen[0].auth, 'Bearer byok-key');
    assert.equal(seen[0].body.model, 'byok-model');
    assert.equal(seen[0].body.tools[0].type, 'x_search');
    assert.match(r.value.output, /posts found/);
    assert.match(r.value.output, /https:\/\/x\.com\/a\/1/);
  } finally { server.close(); }
});

test('x_search: called with the opt-in unset answers a capability error, no fetch', async () => {
  const seen = [];
  // Port 9 (discard) is never reached: the guard runs before any fetch, and a
  // reachable stub proves it by staying silent.
  const { server, base } = await serve((req, res) => { seen.push(req.url); json(res, {}); });
  try {
    const r = await run('call', { name: 'x_search', args: { query: 'agents' } }, {
      LLM_BASE_URL: `${base}/v1`, LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_X_SEARCH: '',
    });
    assert.equal(r.ok, false);
    // The capability error, not prose: the model reads a gap and can act on it.
    assert.equal(r.capability, 'x_search');
    assert.match(r.error, /X search .* is not configured/);
    assert.ok(r.configure.includes('LLM_X_SEARCH=1'), `expected the fix named, got ${JSON.stringify(r.configure)}`);
    assert.deepEqual(seen, [], 'must not call the endpoint at all');
  } finally { server.close(); }
});

test('x_search: handles and exclude_handles are both sent', async () => {
  const seen = [];
  const { server, base } = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { seen.push(JSON.parse(body)); json(res, { output: [] }); });
  });
  try {
    const r = await run('call', { name: 'x_search', args: { query: 'agents', handles: ['@a'], exclude_handles: ['b'] } }, {
      LLM_BASE_URL: `${base}/v1`, LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_X_SEARCH: '1',
    });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(seen[0].tools[0].allowed_x_handles, ['a']);
    assert.deepEqual(seen[0].tools[0].excluded_x_handles, ['b'], 'the exclusion list must not be dropped');
  } finally { server.close(); }
});
