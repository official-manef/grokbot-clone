/**
 * web_search is a local tool: it exists only when SEARCH_BASE_URL is set, and
 * it posts to that endpoint. Same shape of test as x-search.test.mjs, same
 * one-process-per-case pattern as the provider tests (env resolves once).
 *
 *   node --import tsx --test server/test/web-search.test.mjs
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

function run(kind, args, env) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, kind, JSON.stringify(args ?? {})],
      {
        cwd: path.join(here, '..'),
        env: {
          ...process.env,
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

test('web_search: not advertised without SEARCH_BASE_URL', async () => {
  const r = await run('tools', {}, { SEARCH_BASE_URL: '', SEARCH_API_KEY: '' });
  assert.equal(r.ok, true, r.error);
  assert.ok(!r.names.includes('web_search'), `web_search must be hidden, got ${r.names.join(',')}`);
});

test('web_search: advertised when SEARCH_BASE_URL is set', async () => {
  const r = await run('tools', {}, { SEARCH_BASE_URL: 'http://127.0.0.1:9', SEARCH_API_KEY: 'k' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.names.includes('web_search'));
});

test('web_search: posts the query with the bearer header and returns cited results', async () => {
  const seen = [];
  const { server, base } = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      json(res, {
        results: [
          { title: 'First hit', url: 'https://example.com/a', snippet: 'about the  first\nthing' },
          { title: 'Second hit', url: 'https://example.com/b', description: 'another' },
          { title: 'No url', snippet: 'dropped' },
        ],
      });
    });
  });
  try {
    const r = await run('call', { name: 'web_search', args: { query: 'agents', max_results: 5 } }, {
      SEARCH_BASE_URL: base, SEARCH_API_KEY: 'search-key',
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/search');
    assert.equal(seen[0].auth, 'Bearer search-key');
    assert.equal(seen[0].body.query, 'agents');
    assert.equal(seen[0].body.max_results, 5);
    assert.match(r.value.output, /1\. First hit/);
    assert.match(r.value.output, /https:\/\/example\.com\/a/);
    assert.match(r.value.output, /about the first thing/);
    assert.match(r.value.output, /2\. Second hit/);
    assert.doesNotMatch(r.value.output, /No url/, 'a result without a url is not citable');
  } finally { server.close(); }
});

test('web_search: no key means no Authorization header', async () => {
  let auth;
  const { server, base } = await serve((req, res) => {
    auth = req.headers.authorization;
    req.on('data', () => {});
    req.on('end', () => json(res, { results: [] }));
  });
  try {
    const r = await run('call', { name: 'web_search', args: { query: 'x' } }, { SEARCH_BASE_URL: base, SEARCH_API_KEY: '' });
    assert.equal(r.ok, true, r.error);
    assert.equal(auth, undefined);
    assert.equal(r.value.output, 'No results came back.');
  } finally { server.close(); }
});

test('web_search: a non-2xx answers an error, not an uncaught throw', async () => {
  const { server, base } = await serve((_req, res) =>
    json(res, { error: { message: 'quota exceeded' } }, 429));
  try {
    const r = await run('call', { name: 'web_search', args: { query: 'x' } }, {
      SEARCH_BASE_URL: base, SEARCH_API_KEY: 'k',
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /search endpoint \(429\)/);
    assert.match(r.error, /quota exceeded/);
  } finally { server.close(); }
});

test('web_search: reads a real Serper body (organic_results), not an empty list', async () => {
  const serper = {
    searchParameters: { q: 'ai agents', type: 'search', engine: 'google' },
    organic: [
      { title: 'Agents explained', link: 'https://example.com/agents', snippet: 'A short intro.', position: 1 },
      { title: 'Agent frameworks', link: 'https://example.com/frameworks', snippet: 'Frameworks compared.', position: 2 },
    ],
    // The real field the tool must read; `organic` above is Serper's alternate.
    organic_results: [
      { title: 'Agents explained', link: 'https://example.com/agents', snippet: 'A short intro.\nSecond line.' },
      { title: 'Agent frameworks', link: 'https://example.com/frameworks', snippet: 'Frameworks compared.' },
      { title: 'No link', snippet: 'dropped' },
    ],
  };
  const { server, base } = await serve((_req, res) => json(res, serper));
  try {
    const r = await run('call', { name: 'web_search', args: { query: 'ai agents' } }, {
      SEARCH_BASE_URL: base, SEARCH_API_KEY: 'k',
    });
    assert.equal(r.ok, true, r.error);
    assert.notEqual(r.value.output, 'No results came back.');
    assert.match(r.value.output, /1\. Agents explained/);
    assert.match(r.value.output, /https:\/\/example\.com\/agents/);
    assert.match(r.value.output, /A short intro\. Second line\./);
    assert.match(r.value.output, /2\. Agent frameworks/);
    assert.doesNotMatch(r.value.output, /No link/);
  } finally { server.close(); }
});

test('web_search: reads a Google CSE body (items)', async () => {
  const cse = {
    kind: 'customsearch#search',
    items: [
      { title: 'Result one', link: 'https://example.org/one', snippet: 'From CSE.' },
    ],
  };
  const { server, base } = await serve((_req, res) => json(res, cse));
  try {
    const r = await run('call', { name: 'web_search', args: { query: 'x' } }, {
      SEARCH_BASE_URL: base, SEARCH_API_KEY: 'k',
    });
    assert.equal(r.ok, true, r.error);
    assert.match(r.value.output, /1\. Result one/);
    assert.match(r.value.output, /https:\/\/example\.org\/one/);
  } finally { server.close(); }
});
