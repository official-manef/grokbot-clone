/**
 * "The LLM is configured" has one definition, in env.ts, and every other module
 * asks it. The failure this guards is a half-configured endpoint reporting
 * itself ready: a model name with no base URL and no key cannot answer a turn.
 *
 * Each case runs in its own process (test/_tools-probe.mjs) because env.ts
 * resolves once per process, exactly as it does at boot.
 *
 *   node --import tsx --test server/test/llm-capability.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_tools-probe.mjs');

/** Run one probe in a fresh process with exactly these env vars. */
function run(kind, args, env) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, kind, JSON.stringify(args ?? {})],
      {
        cwd: path.join(here, '..'),
        env: {
          ...process.env,
          DB_PATH: path.join(os.tmpdir(), `grokbot-caps-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
          // Nothing inherited: each case states the whole endpoint it wants.
          LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '', LLM_PROTOCOL: '',
          XAI_BASE_URL: '', XAI_API_KEY: '', XAI_MODEL: '',
          HERMES_URL: '', HQ_LOCAL: '', SEARCH_BASE_URL: '',
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

test('llm: a model name alone is NOT a configured endpoint', async () => {
  const r = await run('caps', {}, { LLM_MODEL: 'some-model' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.capabilities.llm, false, 'LLM_MODEL with no base and no key cannot answer a turn');
  assert.equal(r.report.ok, false, 'the report must agree with the capability map');
});

test('llm: a base without a key is not configured either', async () => {
  const r = await run('caps', {}, { LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_MODEL: 'm' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.capabilities.llm, false, 'half a pair is still half a pair');
});

test('llm: base + key is configured', async () => {
  const r = await run('caps', {}, { LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.capabilities.llm, true);
  assert.equal(r.report.ok, true);
});

test('llm: a configured Hermes engine is configured', async () => {
  const r = await run('caps', {}, { HERMES_URL: 'http://127.0.0.1:8642' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.capabilities.llm, true, 'the engine owns its own credentials');
});

test('engine name: honest, so /api/health cannot call a BYOK endpoint hermes', async () => {
  const byok = await run('caps', {}, { LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
  assert.equal(byok.report.engine, 'byok');
  const hermes = await run('caps', {}, { HERMES_URL: 'http://127.0.0.1:8642' });
  assert.equal(hermes.report.engine, 'hermes');
  const none = await run('caps', {}, { LLM_MODEL: 'm' });
  assert.equal(none.report.engine, 'unconfigured', 'a model name is not an engine');
  assert.equal(none.report.ok, false, '/api/health must not report ready here');
});

test('x_search: a chat-protocol endpoint cannot serve it, so it is not offered', async () => {
  const r = await run('tools', {}, {
    LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm',
    LLM_PROTOCOL: 'chat', LLM_X_SEARCH: '1',
  });
  assert.equal(r.ok, true, r.error);
  assert.ok(!r.names.includes('x_search'), `chat has no /responses, got ${r.names.join(',')}`);
});

test('x_search: base + key on the responses protocol offers it', async () => {
  const r = await run('tools', {}, {
    LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm',
    LLM_PROTOCOL: 'responses', LLM_X_SEARCH: '1',
  });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.names.includes('x_search'), `expected x_search in ${r.names.join(',')}`);
});

test('capabilities: the search tools are inside the contract, not outside it', async () => {
  const off = await run('caps', {}, { LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
  assert.equal(off.ok, true, off.error);
  assert.deepEqual(off.report.tools, { web_search: false, x_search: false },
    'a client must be able to read that neither search tool exists');

  const on = await run('caps', {}, {
    LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm',
    LLM_PROTOCOL: 'responses', LLM_X_SEARCH: '1', SEARCH_BASE_URL: 'http://127.0.0.1:9',
  });
  assert.equal(on.ok, true, on.error);
  assert.deepEqual(on.report.tools, { web_search: true, x_search: true });
  assert.ok(!('web_search' in on.report.capabilities), 'the Capability union stays the UI contract');
});

test('prompt: only tools that exist are advertised', async () => {
  const bare = await run('prompt', {}, { LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
  assert.equal(bare.ok, true, bare.error);
  assert.doesNotMatch(bare.text, /x_search/, 'x_search is not on this endpoint and must not be named');
  assert.doesNotMatch(bare.text, /web_search/);

  const on = await run('prompt', {}, {
    LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm',
    LLM_PROTOCOL: 'responses', LLM_X_SEARCH: '1', SEARCH_BASE_URL: 'http://127.0.0.1:9',
  });
  assert.equal(on.ok, true, on.error);
  assert.match(on.text, /x_search researches X/);
  assert.match(on.text, /web_search searches the web/);
});
