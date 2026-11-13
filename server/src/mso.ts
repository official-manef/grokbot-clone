import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { env } from './env.js';
import { CapabilityError } from './lib/capability-error.js';

/**
 * DESKTOP_MODE=mso — bot desktops on the host, with no container runtime.
 *
 * `desktop.ts` needs a Docker daemon. That is the right default, but it is not always
 * available: a host without Docker, a Docker socket the service cannot reach, or a
 * machine where the operator wants the desktop visible on the host's own X server.
 * This module is the third backend behind `box.ts`, with the same surface.
 *
 *   box     -> a directory per user
 *   screen  -> an Xvfb display: :99 for the primary, :9N for screen-N
 *   capture -> one ffmpeg x11grab JPEG frame
 *   input   -> xdotool against that display
 *   shell   -> bash -lc with cwd = the box
 *   watch   -> loopback x11vnc, dialled by the RFB relay over TCP
 *
 * ISOLATION IS WEAKER THAN THE DOCKER BACKEND, and that is the whole tradeoff: shell
 * commands run as the service account (the same power MSO itself grants), not as an
 * unprivileged user in a throwaway container. Use `docker` unless you cannot.
 *
 * Binaries: `Xvfb`, `ffmpeg` and a Chromium build are expected on the host. `xdotool`,
 * `x11vnc` and `fluxbox` are vendored by `server/scripts/install-desktop-deps.sh`
 * (extracted .deb, no root) because a service account usually cannot apt-install them.
 */

const SERVER_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const VENDOR = path.join(SERVER_ROOT, 'vendor');

export const MAX_SCREENS = 4;
const SCREEN_PREFIX = 'screen-';

// ---------- binaries ----------

/** Vendored binary when present, else the PATH name. */
function bin(name: string): string {
  const local = path.join(VENDOR, 'bin', name);
  return fs.existsSync(local) ? local : name;
}

/**
 * Loader path for the vendored libraries. Without it the vendored xdotool exits
 * with "libxdo.so.3: cannot open shared object file", which looks exactly like a
 * broken desktop and not at all like an env mistake.
 */
function vendorLibPath(): string {
  const lib = path.join(VENDOR, 'usr', 'lib', 'x86_64-linux-gnu');
  return fs.existsSync(lib) ? `${lib}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}` : process.env.LD_LIBRARY_PATH ?? '';
}

function xenv(display: string): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: display, LD_LIBRARY_PATH: vendorLibPath() };
}

/**
 * The browser for a bot, or null. A bare command with no args, so callers append
 * their own profile and URL. Playwright's Chromium counts: it is a normal build.
 */
export function browserBinary(): string | null {
  const playwright = (() => {
    const base = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
    try {
      return fs
        .readdirSync(base)
        .filter((d) => d.startsWith('chromium-'))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
        .map((d) => path.join(base, d, 'chrome-linux64', 'chrome'));
    } catch { return []; }
  })();
  const candidates = [
    env.desktop.mso.browser,
    ...playwright,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

// ---------- screen mapping ----------

/** Screen index 0..3 for an Orgo-style screen id. */
export function screenIndex(screenId: string | undefined): number {
  if (!screenId || screenId === 'default') return 0;
  const m = new RegExp(`^${SCREEN_PREFIX}(\\d)$`).exec(screenId);
  return m ? Number(m[1]) : 0;
}

export function screenIdFor(index: number): string {
  return index === 0 ? 'default' : `${SCREEN_PREFIX}${index}`;
}

/**
 * X display for a screen index. Index 0 is :99; the rest are :9N so `screen-1` is
 * :91, not :1. Off-by-one here means a bot's browser opens on a display nothing
 * screenshots, and the screenshot tool then reports a black screen.
 */
export function displayFor(index: number): string {
  return index === 0 ? ':99' : `:${90 + index}`;
}

/** VNC port for a screen index: :99 -> 5909, :91 -> 5901. */
export function vncPortFor(index: number): number {
  return env.desktop.mso.vncPortBase + index;
}

function displayNum(index: number): number {
  return index === 0 ? 99 : 90 + index;
}

function ensureMode(): void {
  if (env.desktop.mode !== 'mso') throw new CapabilityError('desktop');
}

// ---------- processes ----------

interface DisplayState { display: string; num: number; port: number; xvfb?: import('node:child_process').ChildProcess; vnc?: import('node:child_process').ChildProcess; wm?: import('node:child_process').ChildProcess }

const displays = new Map<number, DisplayState>();
const starting = new Map<number, Promise<DisplayState>>();

function run(cmd: string, args: string[], timeoutMs = 30_000, childEnv?: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(e.message) }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen({ port, host: '127.0.0.1' });
  });
}

/**
 * Does an X server answer on this display number?
 *
 * The socket file alone is not evidence: an Xvfb whose socket was unlinked still holds
 * the lock, and a dead one leaves the file behind forever. Probe with ffmpeg, a plain
 * system binary, so a missing vendored library cannot masquerade as "no display".
 */
async function displayAlive(num: number): Promise<boolean> {
  if (!fs.existsSync(`/tmp/.X11-unix/X${num}`)) return false;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '16x16', '-i', `:${num}`, '-frames:v', '1', '-f', 'null', '-'], 8_000);
  return r.code === 0;
}

/**
 * Make a display number usable: stop whatever owns it and clear its lock.
 *
 * Two independent signals. The lock file can be missing (a /tmp clean while X kept
 * running), so /proc is the authority. Only a process whose command line names THIS
 * display is signalled — never a blind pkill.
 */
async function reclaimDisplay(num: number) {
  const lock = `/tmp/.X${num}-lock`;
  const pids = new Set<number>();

  const fromLock = Number((await fsp.readFile(lock, 'utf8').catch(() => '')).trim());
  if (Number.isFinite(fromLock) && fromLock > 1) pids.add(fromLock);

  let entries: string[] = [];
  try { entries = await fsp.readdir('/proc'); } catch { /* no procfs */ }
  await Promise.all(
    entries.filter((e) => /^\d+$/.test(e)).map(async (e) => {
      const pid = Number(e);
      if (pid === process.pid) return;
      const cmd = (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).replace(/\0/g, ' ').trim();
      if (/^Xvfb\b|^Xorg\b|^X\b/.test(cmd) && new RegExp(`(^|\\s):${num}(\\s|$)`).test(cmd)) pids.add(pid);
    }),
  );

  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  if (pids.size) await new Promise((r) => setTimeout(r, 400));
  await fsp.rm(lock, { force: true });
  await fsp.rm(`/tmp/.X11-unix/X${num}`, { force: true });
}

async function waitTcp(port: number, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); resolve(false); });
      s.setTimeout(700, () => { s.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`VNC port ${port} never opened`);
}

async function ensureDisplay(index: number): Promise<DisplayState> {
  const existing = displays.get(index);
  if (existing?.xvfb && existing.xvfb.exitCode === null) return existing;
  const inflight = starting.get(index);
  if (inflight) return inflight;

  const p = (async (): Promise<DisplayState> => {
    const num = displayNum(index);
    const display = displayFor(index);
    const port = vncPortFor(index);
    if (!(await displayAlive(num))) {
      await reclaimDisplay(num);
      const xvfb = spawn('Xvfb', [display, '-screen', '0', env.desktop.resolution, '-nolisten', 'tcp', '-ac'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      });
      xvfb.unref();
      const t0 = Date.now();
      while (Date.now() - t0 < 15_000 && !(await displayAlive(num))) await new Promise((r) => setTimeout(r, 200));
      if (!(await displayAlive(num))) {
        try { xvfb.kill('SIGKILL'); } catch { /* gone */ }
        throw new Error(`X display ${display} did not come up`);
      }
      return startVnc(index, display, port, xvfb);
    }
    return startVnc(index, display, port);
  })();
  starting.set(index, p);
  try { return await p; } finally { starting.delete(index); }
}

async function startVnc(index: number, display: string, port: number, xvfb?: DisplayState['xvfb']): Promise<DisplayState> {
  const actual = (await portFree(port)) ? port : await findFreePort(port);
  const vnc = spawn(
    bin('x11vnc'),
    ['-display', display, '-rfbport', String(actual), '-localhost', '-nopw', '-forever', '-shared',
      '-repeat', '-norc', '-quiet', '-noxdamage', '-desktop', `bot ${screenIdFor(index)}`],
    { env: xenv(display), stdio: 'ignore', detached: true },
  );
  vnc.unref();
  vnc.once('exit', () => displays.delete(index));
  await waitTcp(actual);

  // Window manager: makes the display behave like a desktop (frames, focus). x11vnc
  // works without it, so a missing fluxbox must never fail a box.
  let wm: DisplayState['wm'];
  try {
    const start = bin('startfluxbox');
    if (fs.existsSync(start)) {
      wm = spawn(start, [], { env: xenv(display), stdio: 'ignore', detached: true });
      wm.unref();
    }
  } catch { /* cosmetic */ }

  const state: DisplayState = { display, num: displayNum(index), port: actual, xvfb, vnc, wm };
  displays.set(index, state);
  return state;
}

async function findFreePort(from: number): Promise<number> {
  for (let p = from; p < from + 50; p++) if (await portFree(p)) return p;
  throw new Error(`No free VNC port near ${from}`);
}

/** The RFB port serving a screen, starting its display if needed (used by the relay). */
export async function vncUpstreamPort(index: number): Promise<number> {
  ensureMode();
  return (await ensureDisplay(index)).port;
}

// ---------- box lifecycle ----------

export interface MsoComputer { id: string; status: string; name: string; resolution?: string }

function boxDir(userId: string): string {
  return path.join(env.desktop.mso.root, 'boxes', sanitize(userId));
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) || 'box';
}

export async function createComputer(userId: string, opts: { name?: string } = {}): Promise<MsoComputer> {
  ensureMode();
  const id = opts.name ? sanitize(opts.name) : sanitize(userId);
  await fsp.mkdir(boxDir(userId), { recursive: true });
  // The display is created lazily on first use: a box nobody looks at costs nothing.
  return { id, status: 'running', name: id, resolution: env.desktop.resolution };
}

export async function getComputer(id: string): Promise<MsoComputer> {
  ensureMode();
  const dir = path.join(env.desktop.mso.root, 'boxes', sanitize(id));
  return { id, status: fs.existsSync(dir) ? 'running' : 'absent', name: id, resolution: env.desktop.resolution };
}

export async function start(id: string): Promise<{ ok: true }> {
  ensureMode();
  await fsp.mkdir(path.join(env.desktop.mso.root, 'boxes', sanitize(id)), { recursive: true });
  return { ok: true };
}

export async function suspend(_id: string): Promise<{ ok: true }> {
  ensureMode();
  for (const [index] of [...displays]) await teardownDisplay(index);
  return { ok: true };
}

export async function removeComputer(id: string): Promise<void> {
  ensureMode();
  await suspend(id);
  await fsp.rm(path.join(env.desktop.mso.root, 'boxes', sanitize(id)), { recursive: true, force: true });
}

async function teardownDisplay(index: number) {
  const state = displays.get(index);
  if (!state) return;
  for (const p of [state.wm, state.vnc, state.xvfb]) { try { p?.kill('SIGTERM'); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 300));
  for (const p of [state.wm, state.vnc, state.xvfb]) {
    try { if (p && p.exitCode === null) p.kill('SIGKILL'); } catch { /* gone */ }
  }
  displays.delete(index);
}

/** Stop every display this process started (service shutdown). */
export async function shutdown(): Promise<void> {
  for (const [index] of [...displays]) await teardownDisplay(index);
}

// ---------- screens ----------

export interface MsoScreen { id: string; display: string; width: number; height: number; default: boolean }

export async function listScreens(_id: string): Promise<MsoScreen[]> {
  ensureMode();
  const [w, h] = env.desktop.resolution.split('x').map(Number);
  return Array.from({ length: MAX_SCREENS }, (_, i) => ({
    id: screenIdFor(i),
    display: displayFor(i),
    width: w || 1280,
    height: h || 800,
    default: i === 0,
  }));
}

export async function createScreen(id: string): Promise<MsoScreen> {
  ensureMode();
  // Give the caller a screen that is already serving, rather than a name it has to
  // wake itself: the lease is immediately usable.
  const index = 1;
  await ensureDisplay(index);
  const [w, h] = env.desktop.resolution.split('x').map(Number);
  return { id: screenIdFor(index), display: displayFor(index), width: w || 1280, height: h || 800, default: false };
}

export async function getScreen(id: string, screen: string): Promise<MsoScreen> {
  const all = await listScreens(id);
  const found = all.find((s) => s.id === screen);
  if (!found) throw new Error(`No such screen: ${screen}`);
  return found;
}

/** Tear down a display. Files and browser profiles stay on disk. */
export async function deleteScreen(_id: string, screen: string): Promise<void> {
  ensureMode();
  const index = screenIndex(screen);
  if (index === 0) throw new Error('The default screen cannot be deleted');
  await teardownDisplay(index);
}

// ---------- capture ----------

export async function screenshot(_id: string, screen?: string): Promise<{ image: string; mime_type?: string; width: number; height: number }> {
  ensureMode();
  const state = await ensureDisplay(screenIndex(screen));
  const [w, h] = env.desktop.resolution.split('x').map(Number);
  const file = path.join('/tmp', `grokbot-mso-${process.pid}-${state.num}-${Date.now()}.jpg`);
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', `${w}x${h}`, '-i', state.display, '-frames:v', '1', '-q:v', '4', '-f', 'mjpeg', '-y', file], 20_000);
  try {
    const buf = await fsp.readFile(file);
    return { image: buf.toString('base64'), mime_type: 'image/jpeg', width: w, height: h };
  } catch {
    throw new Error(`screenshot failed: ${(r.stderr || 'no image written').slice(0, 200)}`);
  } finally {
    await fsp.rm(file, { force: true });
  }
}

// ---------- input ----------

async function xdo(screen: string | undefined, args: string[], timeoutMs = 20_000): Promise<string> {
  ensureMode();
  const state = await ensureDisplay(screenIndex(screen));
  const r = await run(bin('xdotool'), args, timeoutMs, xenv(state.display));
  if (r.code !== 0) throw new Error(`xdotool ${args[0]} failed: ${(r.stderr || `exit ${r.code}`).slice(0, 200)}`);
  return r.stdout;
}

export async function move(_id: string, screen: string | undefined, b: { x: number; y: number }) {
  await xdo(screen, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
  return { ok: true };
}

export async function click(_id: string, screen: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) {
  const button = b.button === 'right' ? '3' : b.button === 'middle' ? '2' : '1';
  await xdo(screen, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
  await xdo(screen, ['click', '--repeat', b.double ? '2' : '1', '--delay', '80', button]);
  return { ok: true };
}

export async function drag(_id: string, screen: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) {
  await xdo(screen, ['mousemove', String(Math.round(b.start_x)), String(Math.round(b.start_y))]);
  await xdo(screen, ['mousedown', '1']);
  // Intermediate moves: many toolkits only treat the release as a drag after motion.
  for (let i = 1; i <= 8; i++) {
    await xdo(screen, ['mousemove', String(Math.round(b.start_x + ((b.end_x - b.start_x) * i) / 8)), String(Math.round(b.start_y + ((b.end_y - b.start_y) * i) / 8))]);
  }
  await xdo(screen, ['mouseup', '1']);
  return { ok: true };
}

export async function type(_id: string, screen: string | undefined, text: string) {
  // --clearmodifiers: a stuck ctrl from a previous tool call would otherwise eat characters.
  await xdo(screen, ['type', '--clearmodifiers', '--delay', '12', text], 60_000);
  return { ok: true };
}

export async function key(_id: string, screen: string | undefined, keys: string) {
  await xdo(screen, ['key', '--clearmodifiers', keys.replace(/\s+/g, '')]);
  return { ok: true };
}

export async function scroll(_id: string, screen: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) {
  const button = b.direction === 'up' ? '4' : '5';
  const times = Math.min(Math.max(Math.round(b.amount || 3), 1), 50);
  await xdo(screen, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
  await xdo(screen, ['click', '--repeat', String(times), '--delay', '40', button]);
  return { ok: true };
}

// ---------- exec and files ----------

export async function bash(
  id: string,
  screen: string | undefined,
  command: string,
  timeoutSeconds = 120,
): Promise<{ success: boolean; output: string; exit_code: number }> {
  ensureMode();
  const cwd = path.join(env.desktop.mso.root, 'boxes', sanitize(id));
  await fsp.mkdir(cwd, { recursive: true });
  const state = screen === undefined ? null : await ensureDisplay(screenIndex(screen));
  const timeoutMs = Math.min(Math.max(timeoutSeconds, 1), 290) * 1000;
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: state ? xenv(state.display) : { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const cap = (b: string, c: Buffer) => (b.length > 200_000 ? b : b + c.toString('utf8')).slice(0, 200_000);
    child.stdout?.on('data', (c: Buffer) => { out = cap(out, c); });
    child.stderr?.on('data', (c: Buffer) => { err = cap(err, c); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); resolve({ success: false, output: String(e.message), exit_code: 127 }); });
    child.once('exit', (code, sig) => {
      clearTimeout(timer);
      const output = (out + (err ? (out ? '\n' : '') + err : '')).trimEnd();
      resolve({ success: code === 0, output: sig === 'SIGKILL' ? `${output}\n[timed out after ${timeoutSeconds}s]`.trim() : output, exit_code: code ?? 124 });
    });
  });
}

/**
 * Where this bot's Library files live ON THE HOST. The Library routes read this path
 * directly, so it must agree with what `bash` sees as its working tree.
 */
export function libraryDir(botId: string): string {
  return path.join(env.desktop.mso.root, 'boxes', sanitize(botId), 'files');
}

/** Browser profile directory for a bot (persists logins across hibernation). */
export function profileDir(botId: string): string {
  return path.join(env.desktop.mso.root, 'boxes', sanitize(botId), 'profile');
}

export async function readFile(_id: string, filePath: string): Promise<Buffer> {
  ensureMode();
  if (!path.isAbsolute(filePath)) throw new Error('absolute path required');
  return fsp.readFile(filePath);
}

export async function exportFile(id: string, filePath: string): Promise<{ url?: undefined; bytes: Buffer }> {
  return { bytes: await readFile(id, filePath) };
}

// ---------- health ----------

export async function msoAvailable(force = false): Promise<boolean> {
  if (env.desktop.mode === 'disabled') return false;
  if (!cached || force || Date.now() - cached.at > 30_000) {
    cached = { at: Date.now(), ok: await Promise.all(['Xvfb', 'ffmpeg'].map((b) =>
      new Promise<boolean>((resolve) => {
        const c = spawn('sh', ['-c', `command -v ${b}`], { stdio: 'ignore' });
        c.once('exit', (code) => resolve(code === 0));
        c.once('error', () => resolve(false));
      }),
    )).then((r) => r.every(Boolean)) };
  }
  return cached.ok;
}

let cached: { at: number; ok: boolean } | null = null;

export async function desktopHealth(): Promise<{ mode: string; ready: boolean; displays?: number }> {
  const ready = await msoAvailable();
  return { mode: 'mso', ready, displays: displays.size };
}
