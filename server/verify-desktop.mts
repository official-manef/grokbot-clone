/**
 * Real-container check for the bot-desktop layer.
 *
 *   docker build -t grokbot-desktop:latest server/desktop
 *   npx tsx server/verify-desktop.mts
 *
 * Not a unit test: it talks to the real daemon, so it is the only thing that can
 * catch a Dockerfile that builds and a box that never boots. Everything here was
 * previously verified only against a stubbed runner. Exits non-zero on any failure.
 */
import { execFile } from 'node:child_process';
import net from 'node:net';
import { createDockerBoxRuntime } from './src/box/adapters/docker.js';
import type { BoxRunResult } from './src/box/contract.js';

const run = (command: string, args: readonly string[], timeoutMs = 300_000): Promise<BoxRunResult> =>
  new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err: any, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: Buffer.from(stdout as Buffer),
        stderr: Buffer.from(stderr as Buffer).toString('utf8') + (err?.killed ? ' [timed out]' : ''),
      }));
  });

const box = createDockerBoxRuntime(run, { image: 'grokbot-desktop:latest', ramGb: 2, cpu: 1, resolution: '1280x800x24' });
const NAME = 'grokbot-verifybox';
let passed = 0;

function ok(what: string, cond: boolean, detail = '') {
  if (!cond) { console.error(`FAIL ${what}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; }
  else passed += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
}

const tcpOpen = (host: string, port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host, port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.setTimeout(3000, () => { s.destroy(); resolve(false); });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The window's absolute frame position. `xdotool getwindowgeometry` reports the
 * client area inside the xfwm4 frame, which is off by the titlebar height (measured
 * 98 vs 69), so a drag aimed with it grabs the wrong band.
 */
async function framePos(): Promise<{ x: number; y: number } | null> {
  const r = await box.bash(NAME, undefined,
    'W=$(xdotool search --name xmessage | head -1); [ -n "$W" ] || exit 1; xwininfo -id $W');
  const x = /Absolute upper-left X:\s*(-?\d+)/.exec(r.output);
  const y = /Absolute upper-left Y:\s*(-?\d+)/.exec(r.output);
  return x && y ? { x: Number(x[1]), y: Number(y[1]) } : null;
}

const main = async () => {
  await box.remove(NAME).catch(() => {});
  const created = await box.create('verifybox', { name: NAME });
  ok('create returns running', created.status === 'running', created.status);

  const info = await box.get(NAME);
  ok('get reports the name', info.name === NAME, info.name);

  // Hardening flags are the reason the box exists; read them back from the daemon
  // rather than trusting the argv this same code just built.
  const [raw] = JSON.parse((await run('docker', ['inspect', NAME])).stdout.toString());
  const host = raw.HostConfig;
  ok('label grokbot.desktop=1', raw.Config.Labels?.['grokbot.desktop'] === '1');
  ok('cap-drop ALL', (host.CapDrop ?? []).includes('ALL'), JSON.stringify(host.CapDrop));
  ok('no-new-privileges', (host.SecurityOpt ?? []).includes('no-new-privileges'));
  ok('memory capped', host.Memory === 2 * 1024 ** 3, String(host.Memory));
  ok('pids capped', host.PidsLimit === 2048, String(host.PidsLimit));
  ok('own network, not bridge', raw.NetworkSettings.Networks && Object.keys(raw.NetworkSettings.Networks)[0] === `${NAME}-net`);
  ok('runs as bot, not root', (await box.bash(NAME, undefined, 'id -un')).output.trim() === 'bot');
  ok('no docker socket inside', (await box.bash(NAME, undefined, 'ls /var/run/docker.sock 2>/dev/null | wc -l')).output.trim() === '0');

  // Displays: four X servers, each with a websockify in front.
  const screens = await box.listScreens(NAME);
  ok('four screens', screens.length === 4, screens.map((s) => `${s.id}:${s.display}`).join(' '));
  // On a user-defined network the address lives under Networks, not IPAddress; this is
  // the same fallback box.ts uses to build the VNC upstream URL.
  const ip = String(
    raw.NetworkSettings.IPAddress ||
    Object.values(raw.NetworkSettings.Networks ?? {}).map((n: any) => n?.IPAddress).find(Boolean),
  );
  ok('container has a bridge address', /^\d+\.\d+\.\d+\.\d+$/.test(ip), ip);
  for (const [i, s] of screens.entries()) {
    const r = await box.bash(NAME, s.id, 'xdpyinfo -display $DISPLAY | sed -n "s/  dimensions: *//p"');
    ok(`display ${s.display} up at 1280x800`, r.output.trim().startsWith('1280x800'), r.output.trim());
    ok(`websockify :${6080 + i} reachable`, await tcpOpen(ip, 6080 + i), `${ip}:${6080 + i}`);
  }

  const shot = await box.screenshot(NAME);
  const png = Buffer.from(shot.image, 'base64');
  ok('screenshot is a PNG', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', `${png.length} bytes`);
  ok('screenshot size matches config', shot.width === 1280 && shot.height === 800, `${shot.width}x${shot.height}`);

  // The frame must follow what is drawn on the screen. A stubbed runner could return
  // a plausible PNG forever and nothing else here would notice.
  const blank = Buffer.from((await box.screenshot(NAME, 'screen-2')).image, 'base64');
  await box.bash(NAME, 'screen-2', 'nohup xmessage -geometry 900x600+20+20 drawn >/dev/null 2>&1 & sleep 1; true');
  const drawn = Buffer.from((await box.screenshot(NAME, 'screen-2')).image, 'base64');
  ok('screenshot follows the screen', blank.compare(drawn) !== 0, `${blank.length} -> ${drawn.length} bytes`);

  // Input on the primary display, with xev as the witness: it logs every event the
  // X server actually delivered, so "the click reached the client" is observed rather
  // than inferred from window geometry.
  await box.bash(NAME, undefined, 'nohup xev -geometry 300x200+300+300 -event mouse -event keyboard > /tmp/xev.log 2>&1 & sleep 1.5; true');
  const xevWin = await box.bash(NAME, undefined, 'xdotool search --name "Event Tester" | head -1');
  ok('an X client can be started and found', xevWin.output.trim().length > 0, xevWin.output.trim());
  const geom = await box.bash(NAME, undefined, `xwininfo -id ${xevWin.output.trim()}`);
  const cxm = /Absolute upper-left X:\s*(-?\d+)/.exec(geom.output);
  const cym = /Absolute upper-left Y:\s*(-?\d+)/.exec(geom.output);
  ok('xev geometry located', Boolean(cxm && cym), `${cxm?.[1]},${cym?.[1]}`);
  const center = { x: Number(cxm![1]) + 150, y: Number(cym![1]) + 100 };

  const logCount = async (pattern: string) => {
    const r = await box.bash(NAME, undefined, `grep -c "${pattern}" /tmp/xev.log || true`);
    return Number(r.output.trim() || 0);
  };

  await box.click(NAME, undefined, { x: center.x, y: center.y });
  await sleep(200);
  ok('click delivers a ButtonPress to the client', (await logCount('ButtonPress')) >= 1, `${await logCount('ButtonPress')} presses`);

  await box.click(NAME, undefined, { x: center.x, y: center.y, double: true });
  await sleep(200);
  ok('double click delivers two presses', (await logCount('ButtonPress')) >= 3, `${await logCount('ButtonPress')} presses so far`);

  await box.key(NAME, undefined, 'a');
  await sleep(200);
  ok('key delivers a KeyPress to the client', (await logCount('KeyPress')) >= 1);

  await box.type(NAME, undefined, 'abc');
  await sleep(200);
  ok('type delivers every character', (await logCount('KeyPress')) >= 4, `${await logCount('KeyPress')} key events`);

  await box.move(NAME, undefined, { x: center.x - 50, y: center.y });
  const moved = await box.bash(NAME, undefined, 'xdotool getmouselocation --shell');
  ok('move puts the pointer where asked', moved.output.includes(`X=${center.x - 50}`) && moved.output.includes(`Y=${center.y}`), moved.output.replace(/\n/g, ' '));

  await box.scroll(NAME, undefined, { x: center.x, y: center.y, direction: 'down', amount: 3 });
  await sleep(200);
  ok('scroll delivers button 5 presses', (await logCount('button 5')) >= 1, `${await logCount('button 5')} scroll events`);

  // Drag: the xfwm4 frame is the client's parent. Its absolute origin is the titlebar
  // top, so the grab point is ~15px below that; aiming at the client's own origin
  // grabs the app body and drags a selection instead of the window.
  const frameOf = async (id: string) => {
    // `xwininfo -children` is what prints the parent (frame) id; plain `xwininfo` omits it.
    const r = await box.bash(NAME, undefined,
      `F=$(xwininfo -id ${id} -children | awk '/Parent window id:/{print $4}'); xwininfo -id $F | awk '/Absolute upper-left X:/{print "X="$4} /Absolute upper-left Y:/{print "Y="$4}'`);
    const x = /X=(-?\d+)/.exec(r.output);
    const y = /Y=(-?\d+)/.exec(r.output);
    return x && y ? { x: Number(x[1]), y: Number(y[1]) } : null;
  };
  const frame = await frameOf(xevWin.output.trim());
  ok('window frame located', frame !== null, JSON.stringify(frame));
  if (frame) {
    await box.drag(NAME, undefined, {
      start_x: frame.x + 60, start_y: frame.y + 15,
      end_x: frame.x + 260, end_y: frame.y + 115,
    });
    await sleep(400);
    const frameAfter = await frameOf(xevWin.output.trim());
    ok('drag moved the window', frameAfter !== null && frameAfter.x > frame.x + 100, `x ${frame.x} -> ${frameAfter?.x}`);
  }

  // Second display draws independently of the first.
  const shot1 = await box.screenshot(NAME, 'screen-1');
  const shot0 = await box.screenshot(NAME);
  ok('screen-1 differs from default', Buffer.from(shot1.image, 'base64').compare(Buffer.from(shot0.image, 'base64')) !== 0);

  // Files: write through bash, read through the adapter.
  await box.bash(NAME, undefined, 'printf "box-file\\n" > /home/bot/grokbot/files/probe.txt');
  ok('readFile returns the bytes', (await box.readFile(NAME, '/home/bot/grokbot/files/probe.txt')).toString() === 'box-file\n');
  ok('readFile refuses a relative path', await box.readFile(NAME, 'etc/passwd').then(() => false, () => true));

  // Lifecycle.
  await box.stop(NAME);
  ok('stop -> exited', (await box.get(NAME)).status === 'exited', (await box.get(NAME)).status);
  await box.start(NAME);
  ok('start -> running', (await box.get(NAME)).status === 'running');
  // start returned only after every display answered, so this must not be a race.
  const allUp = await box.bash(NAME, 'screen-3', 'xdpyinfo >/dev/null 2>&1 && echo up || echo DOWN');
  ok('all displays up the moment start returns', allUp.output.trim() === 'up', allUp.output.trim());
  await box.restart(NAME);
  const reboot = await box.bash(NAME, 'screen-3', 'xdpyinfo >/dev/null 2>&1 && echo up || echo DOWN');
  ok('display survives a restart', reboot.output.includes('up'), reboot.output.trim());

  // relay() cannot be expressed through a CLI runner by design.
  ok('relay refuses a CLI transport', await box.relay({ send() {}, close() {}, on() {} }, 'default').then(() => false, () => true));

  await box.remove(NAME);
  ok('remove leaves no container', (await run('docker', ['inspect', NAME])).code !== 0);
  ok('remove leaves no network', (await run('docker', ['network', 'inspect', `${NAME}-net`])).code !== 0);

  console.log(`\n${passed} checks passed`);
};

main().catch(async (e) => {
  console.error('FATAL', e?.message ?? e);
  await box.remove(NAME).catch(() => {});
  process.exitCode = 1;
});
