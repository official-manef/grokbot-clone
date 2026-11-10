/**
 * Provider adapter tests against a local mock endpoint.
 *
 * The real gateway has no image or TTS model, so these adapters would otherwise
 * be untested code. Each case runs in its own process (test/_probe.mjs) because
 * env.ts resolves once per process, exactly as it does at boot.
 *
 *   npx tsx --test server/test/providers.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_probe.mjs');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

/** Run one adapter call in a fresh process with exactly these env vars. */
function run(kind, args, env) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, kind, JSON.stringify(args ?? {})],
      { cwd: path.join(here, '..'), env: { ...process.env, ...env }, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`${err.message}\n${stderr}`));
        // The probe prefixes its payload so boot logs on stdout cannot confuse it.
        const line = stdout.split('\n').reverse().find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe payload in: ${stdout}\n${stderr}`));
        try { resolve(JSON.parse(line.slice('@@PROBE@@'.length))); } catch { reject(new Error(`bad probe output: ${line}\n${stderr}`)); }
      },
    );
  });
}

test('image: parses b64_json and calls the documented path', async () => {
  const seen = [];
  const { server, base } = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      json(res, { data: [{ b64_json: PNG_1PX.toString('base64') }] });
    });
  });
  try {
    const r = await run('image', { prompt: 'a cat', opts: { size: '512x512' } }, {
      IMAGE_BASE_URL: base, IMAGE_API_KEY: 'test-key', IMAGE_MODEL: 'test-image-model',
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value.length, 1);
    assert.equal(r.value[0].b64, PNG_1PX.toString('base64'));
    assert.equal(seen[0].url, '/images/generations');
    assert.equal(seen[0].auth, 'Bearer test-key');
    assert.equal(seen[0].body.model, 'test-image-model');
    assert.equal(seen[0].body.size, '512x512');
  } finally { server.close(); }
});

test('image: parses a data: URL and strips the prefix', async () => {
  const { server, base } = await serve((_req, res) =>
    json(res, { data: [{ b64_json: `data:image/jpeg;base64,${PNG_1PX.toString('base64')}` }] }));
  try {
    const r = await run('image', { prompt: 'x' }, { IMAGE_BASE_URL: base, IMAGE_API_KEY: 'k' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value[0].mime, 'image/jpeg');
    assert.ok(!r.value[0].b64.startsWith('data:'));
  } finally { server.close(); }
});

test('image: surfaces the provider message and status on failure', async () => {
  const { server, base } = await serve((_req, res) =>
    json(res, { error: { message: 'model does not support images' } }, 400));
  try {
    const r = await run('image', { prompt: 'x' }, { IMAGE_BASE_URL: base, IMAGE_API_KEY: 'k' });
    assert.equal(r.ok, false);
    assert.match(r.error, /does not support images/);
    assert.equal(r.status, 400);
  } finally { server.close(); }
});

test('image: unset endpoint is a capability gap, not a crash', async () => {
  const r = await run('image', { prompt: 'x' }, { IMAGE_BASE_URL: '', IMAGE_API_KEY: '', IMAGE_MODEL: '' });
  assert.equal(r.ok, false);
  assert.equal(r.capability, 'image');
  assert.match(r.error, /not configured/);
});

test('tts: returns bytes and the content type', async () => {
  const audio = Buffer.from('ID3fake-mp3-bytes');
  const seen = [];
  const { server, base } = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(audio);
    });
  });
  try {
    const r = await run('tts', { text: 'hello', opts: { voice: 'alloy', speed: 1.2 } }, {
      TTS_BASE_URL: base, TTS_API_KEY: 'tts-key', TTS_MODEL: 'tts-model',
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value.mime, 'audio/mpeg');
    assert.equal(Buffer.from(r.value.bytes, 'base64').toString(), audio.toString());
    assert.equal(seen[0].model, 'tts-model');
    assert.equal(seen[0].input, 'hello');
    assert.equal(seen[0].speed, 1.2);
  } finally { server.close(); }
});

test('stt: posts a multipart form and trims the text', async () => {
  let contentType = '';
  let raw = '';
  const { server, base } = await serve((req, res) => {
    contentType = req.headers['content-type'] ?? '';
    req.on('data', (c) => (raw += c.toString('latin1')));
    req.on('end', () => json(res, { text: '  transcribed words  ' }));
  });
  try {
    const r = await run('stt', {
      audioB64: Buffer.from('audio').toString('base64'),
      opts: { filename: 'a.webm', mime: 'audio/webm', language: 'id' },
    }, { STT_BASE_URL: base, STT_API_KEY: 'stt-key', STT_MODEL: 'stt-model' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value.text, 'transcribed words');
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.match(raw, /name="model"/);
    assert.match(raw, /stt-model/);
    assert.match(raw, /name="language"/);
  } finally { server.close(); }
});

test('realtime: a 404 from the gateway is a capability gap, not a crash', async () => {
  const { server, base } = await serve((_req, res) => json(res, { detail: 'Not Found' }, 404));
  try {
    const r = await run('realtime', {}, {
      REALTIME_BASE_URL: base, REALTIME_API_KEY: 'k', REALTIME_MODEL: 'm',
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.match(r.error, /realtime endpoint/);
  } finally { server.close(); }
});

test('realtime: mints a secret and derives the websocket url', async () => {
  const { server, base } = await serve((_req, res) =>
    json(res, { client_secret: { value: 'ek_abc123' } }));
  try {
    const r = await run('realtime', {}, {
      REALTIME_BASE_URL: base, REALTIME_API_KEY: 'k', REALTIME_MODEL: 'voice-1',
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value.clientSecret, 'ek_abc123');
    assert.match(r.value.websocketUrl, /^ws:\/\/127\.0\.0\.1:\d+\/realtime\?model=voice-1$/);
  } finally { server.close(); }
});
