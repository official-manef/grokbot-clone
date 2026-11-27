/**
 * Drives one real WebSocket upgrade at `attachVncRelay` and prints what came back.
 *
 * The relay is wired to a real HTTP server rather than a stub, because the thing under
 * test is the `upgrade` handler: a stubbed server would let the handler be absent and
 * the test still pass. No bot or desktop backend is needed — the origin gate answers
 * before the relay runs, and an allowed origin falls through to the 401 auth wall.
 *
 *   node --import tsx server/test/_vnc-origin-probe.mjs '{"origin":"https://evil.example"}'
 */
import http from 'node:http';
import net from 'node:net';

const { origin } = JSON.parse(process.argv[2] ?? '{}');

const { attachVncRelay } = await import('../src/vnc.ts');

const server = http.createServer((_req, res) => res.end('ok'));
attachVncRelay(server);
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const port = server.address().port;

/** Send raw upgrade headers so the response status is readable even when refused. */
const status = await new Promise((resolve, reject) => {
  const sock = net.connect({ port, host: '127.0.0.1' });
  let buf = '';
  sock.setTimeout(10_000, () => reject(new Error('upgrade timed out')));
  sock.on('connect', () => {
    const headers = [
      'GET /api/bots/b1/screen HTTP/1.1',
      'Host: grok.example',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Protocol: binary',
    ];
    if (origin !== null) headers.push(`Origin: ${origin}`);
    sock.write(headers.join('\r\n') + '\r\n\r\n');
  });
  sock.on('data', (d) => {
    buf += d.toString();
    const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
    if (m) {
      sock.destroy();
      resolve(Number(m[1]));
    }
  });
  sock.on('error', (e) => {
    // A refused upgrade closes the socket; the status line usually arrived first.
    const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
    if (m) resolve(Number(m[1]));
    else reject(e);
  });
  sock.on('close', () => {
    const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
    if (m) resolve(Number(m[1]));
  });
});

process.stdout.write('@@PROBE@@' + JSON.stringify({ status }) + '\n');
server.close();
process.exit(0);
