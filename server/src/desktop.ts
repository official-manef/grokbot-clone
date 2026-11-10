import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { env } from './env.js';

/**
 * A local desktop runtime — the replacement for Orgo's cloud VMs.
 *
 * Orgo gave each user one Linux box and each bot an X display ("screen") on it, with
 * screenshot/click/type/bash over a JSON API and a websockified VNC stream for viewing.
 * This module provides the same *shape* on the machine the server already runs on:
 *
 *   desktop("default")   -> user-level box: directories, a shared shell namespace
 *   screen("screen-N")   -> one Xvfb display + x11vnc + its own window manager,
 *                           i.e. exactly what an Orgo extra screen was
 *
 * The public surface deliberately mirrors `orgo.ts` (screenshot, click, move, drag,
 * type, key, scroll, bash, listScreens, createScreen, …) so the agent loop, tools, idle
 * watcher and VNC relay keep working unchanged — they import `runtime.ts`, which picks
 * this module or the Orgo one.
 *
 * Isolation model: every bot owns a directory under MSO_DESKTOP_ROOT (browser profile,
 * library files, scratch). Displays are separate per bot, so one bot cannot type into
 * another bot's windows. Shell commands run as the server's user; see docs/MSO.md for
 * the blast-radius note that replaces Orgo's "root inside a throwaway VM".
 */

// ---------- vendor binaries ----------

/** server/ — desktop.ts lives in server/src, so one level up from this file. */
const SERVER_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const VENDOR = path.join(SERVER_ROOT, 'vendor');
export const desktopRoot = env.msoDesktopRoot;

/** Absolute path to a vendored binary, with the fallback to PATH. */
function bin(name: string): string {
  const local = path.join(VENDOR, 'bin', name);
  return fs.existsSync(local) ? local : name;
}

function vendorLibPath(): string {
  const lib = path.join(VENDOR, 'usr', 'lib', 'x86_64-linux-gnu');
  return fs.existsSync(lib) ? `${lib}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}` : process.env.LD_LIBRARY_PATH ?? '';
}

/** Environment for every child that talks to an X display. */
function xenv(display: string): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: display, LD_LIBRARY_PATH: vendorLibPath() };
}

// ---------- errors ----------

export class RuntimeError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

// ---------- display bookkeeping ----------

interface DisplayState {
  /** ":99" */
  display: string;
  /** X screen number, used by x11vnc's separate RFB port. */
  num: number;
  xvfb?: ChildProcess;
  vnc?: ChildProcess;
  wm?: ChildProcess;
  /** VNC port actually bound. */
  port: number;
}

const displays = new Map<string, DisplayState>();
// One in-flight start per screen so two concurrent tool calls don't race two Xvfb's.
const starting = new Map<string, Promise<DisplayState>>();

/** Which screen ids a box exposes. `default` always exists; extras are `screen-N`. */
const SCREEN_PREFIX = 'screen-';

function screenNum(screenId: string): number {
  if (!screenId || screenId === 'default') return 99;
  const m = /^screen-(\d+)$/.exec(screenId);
  if (!m) throw new RuntimeError(400, `Unknown screen ${screenId}`);
  return 90 + Number(m[1]); // screen-1 -> :91
}

function vncPortFor(num: number): number {
  return env.msoVncPortBase + (num - 90);
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen({ port, host: '127.0.0.1' });
  });
}

async function waitTcp(port: number, timeoutMs = 15_000): Promise<void> {
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
  throw new RuntimeError(500, `VNC port ${port} never opened`);
}

async function ensureDisplay(screenId: string): Promise<DisplayState> {
  const key = screenId || 'default';
  const existing = displays.get(key);
  if (existing?.xvfb && existing.xvfb.exitCode === null) return existing;
  const inflight = starting.get(key);
  if (inflight) return inflight;

  const p = (async (): Promise<DisplayState> => {
    const num = screenNum(key);
    const display = `:${num}`;
    const port = vncPortFor(num);
    // A leftover Xvfb from a previous server process still serves the display; adopt it.
    if (await isDisplayAlive(num)) {
      const state = await startVnc(key, num, display, port);
      displays.set(key, state);
      return state;
    }
    // Not answering. Reclaim the display number: kill whatever holds it (an Xvfb whose
    // socket file was unlinked still owns the lock and would make our own start fail)
    // and clear the lock so Xvfb can bind.
    await reclaimDisplay(num);
    const geometry = env.msoGeometry;
    const xvfb = spawn('Xvfb', [display, '-screen', '0', geometry, '-nolisten', 'tcp', '-ac'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    xvfb.unref();
    try {
      await waitForX(num);
    } catch (e) {
      try { xvfb.kill('SIGKILL'); } catch { /* gone */ }
      throw e;
    }
    const state = await startVnc(key, num, display, port, xvfb);
    displays.set(key, state);
    return state;
  })();
  starting.set(key, p);
  try { return await p; } finally { starting.delete(key); }
}

/**
 * Make the display number usable again.
 *
 * Two independent signals, because either one can be missing: the lock file (absent when
 * /tmp is cleaned while an X server keeps running) and the process table (authoritative —
 * an Xvfb whose socket was unlinked still holds the display). Only a process whose
 * command line actually names this display is ever signalled.
 */
async function reclaimDisplay(num: number) {
  const lock = `/tmp/.X${num}-lock`;
  const pids = new Set<number>();

  const fromLock = Number((await fsp.readFile(lock, 'utf8').catch(() => '')).trim());
  if (Number.isFinite(fromLock) && fromLock > 1) pids.add(fromLock);

  let entries: string[] = [];
  try { entries = await fsp.readdir('/proc'); } catch { /* no procfs */ }
  await Promise.all(
    entries
      .filter((e) => /^\d+$/.test(e))
      .map(async (e) => {
        const pid = Number(e);
        if (pid === process.pid) return;
        const cmdline = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
        const cmd = cmdline.replace(/\0/g, ' ').trim();
        if (/^Xvfb\b|^Xorg\b|^X\b/.test(cmd) && new RegExp(`(^|\\s):${num}(\\s|$)`).test(cmd)) pids.add(pid);
      }),
  );

  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (pids.size) await new Promise((r) => setTimeout(r, 400));
  await fsp.rm(lock, { force: true });
  await fsp.rm(`/tmp/.X11-unix/X${num}`, { force: true });
}

/**
 * Is there an X server on this display number that accepts clients?
 *
 * Cheap check first: the socket. Then prove it with a real client, because a socket file
 * left behind by a dead Xvfb answers `exists` forever. The probe deliberately removes
 * LD_LIBRARY_PATH from the equation by using ffmpeg (a normal system binary): a vendored
 * xdotool that cannot find libxdo would otherwise look exactly like "no X server".
 */
async function isDisplayAlive(num: number): Promise<boolean> {
  if (!fs.existsSync(`/tmp/.X11-unix/X${num}`)) return false;
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '16x16', '-i', `:${num}`, '-frames:v', '1', '-f', 'null', '-'], 8_000);
  return r.code === 0;
}

async function waitForX(num: number, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isDisplayAlive(num)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new RuntimeError(500, `X display :${num} did not come up`);
}

async function startVnc(screenId: string, num: number, display: string, port: number, xvfb?: ChildProcess): Promise<DisplayState> {
  const free = await portFree(port);
  const actualPort = free ? port : await findFreePort(port);
  const vnc = spawn(
    bin('x11vnc'),
    [
      '-display', display,
      '-rfbport', String(actualPort),
      '-localhost',          // never expose RFB directly; the relay proxies it
      '-nopw',               // auth is the app's session + the relay handshake
      '-forever', '-shared', '-repeat', '-norc', '-quiet', '-noxdamage',
      '-desktop', `Grokbot ${screenId}`,
    ],
    { env: xenv(display), stdio: 'ignore', detached: true },
  );
  vnc.unref();
  vnc.once('exit', () => { displays.delete(screenId); });
  await waitTcp(actualPort);

  // A window manager makes the display behave like a real desktop (window frames,
  // focus, maximize). x11vnc is enough without it, so never fail over this.
  let wm: ChildProcess | undefined;
  try {
    const fb = bin('startfluxbox');
    if (fs.existsSync(fb)) {
      wm = spawn(fb, [], { env: xenv(display), stdio: 'ignore', detached: true });
      wm.unref();
    }
  } catch { /* cosmetic */ }

  return { display, num, xvfb, vnc, wm, port: actualPort };
}

async function findFreePort(from: number): Promise<number> {
  for (let p = from; p < from + 50; p++) if (await portFree(p)) return p;
  throw new RuntimeError(500, `No free VNC port near ${from}`);
}

// ---------- shell ----------

export interface BashResult { success: boolean; output: string; exit_code: number }

const SHELL_TIMEOUT_DEFAULT = 120;
const OUTPUT_CAP = 200_000;

/**
 * Run a bash command. Mirrors orgo.bash(id, screen, command, timeout).
 * Per-bot work happens under that bot's own directory (see botHome) so relative
 * paths and the Library land somewhere predictable.
 */
export async function bash(computerId: string, screenId: string | undefined, command: string, timeout = SHELL_TIMEOUT_DEFAULT): Promise<BashResult> {
  const cwd = path.join(desktopRoot, computerId);
  await fsp.mkdir(cwd, { recursive: true });
  const display = screenId ? `:${screenNum(screenId)}` : undefined;
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: display ? xenv(display) : { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const cap = (buf: string, chunk: Buffer) => (buf.length >= OUTPUT_CAP ? buf : buf + chunk.toString('utf8')).slice(0, OUTPUT_CAP);
    child.stdout?.on('data', (c: Buffer) => { out = cap(out, c); });
    child.stderr?.on('data', (c: Buffer) => { err = cap(err, c); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, Math.max(1, timeout) * 1000);
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ success: false, output: String(e.message), exit_code: 127 });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const output = (out + (err ? (out ? '\n' : '') + err : '')).trimEnd();
      resolve({
        success: code === 0,
        output: signal === 'SIGKILL' ? `${output}\n[timed out after ${timeout}s]`.trim() : output,
        exit_code: code ?? (signal ? 124 : 1),
      });
    });
  });
}

// ---------- screenshots ----------

export interface ShotResult { image: string; mime_type: string; width: number; height: number }

/** Capture as base64 JPEG with ffmpeg's x11grab — no extra screenshot binary needed. */
export async function screenshot(_computerId: string, screenId: string | undefined): Promise<ShotResult> {
  const state = await ensureDisplay(screenId ?? 'default');
  const [w, h] = env.msoGeometry.split('x').map(Number);
  const file = path.join('/tmp', `grokbot-shot-${process.pid}-${state.num}-${Date.now()}.jpg`);
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'x11grab', '-video_size', `${w}x${h}`, '-i', state.display,
    '-frames:v', '1', '-q:v', '4', '-f', 'mjpeg', '-y', file,
  ];
  const r = await run('ffmpeg', args, 20_000);
  try {
    const buf = await fsp.readFile(file);
    return { image: buf.toString('base64'), mime_type: 'image/jpeg', width: w, height: h };
  } catch {
    throw new RuntimeError(500, `Screenshot failed: ${r.stderr.slice(0, 300) || 'no image written'}`);
  } finally {
    await fsp.rm(file, { force: true });
  }
}

function run(cmd: string, args: string[], timeoutMs = 30_000, childEnv?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
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

// ---------- input ----------

/** xdotool needs mousemove + click as two calls to honour the button. */
async function xdo(screenId: string | undefined, args: string[], timeoutMs = 20_000): Promise<string> {
  const state = await ensureDisplay(screenId ?? 'default');
  // The vendored xdotool needs the vendored libxdo on its loader path AND the display;
  // omitting either turns a working desktop into "libxdo.so.3 not found".
  const r = await run(bin('xdotool'), args, timeoutMs, xenv(state.display));
  if (r.code !== 0) throw new RuntimeError(500, `xdotool ${args[0]} failed: ${r.stderr.slice(0, 200) || `exit ${r.code}`}`);
  return r.stdout;
}

export async function move(_id: string, screenId: string | undefined, b: { x: number; y: number }) {
  await xdo(screenId, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
  return { ok: true };
}

export async function click(_id: string, screenId: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) {
  const button = b.button === 'right' ? '3' : b.button === 'middle' ? '2' : '1';
  await xdo(screenId, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
  await xdo(screenId, ['click', '--repeat', b.double ? '2' : '1', '--delay', '80', button]);
  return { ok: true };
}

export async function drag(_id: string, screenId: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) {
  await xdo(screenId, ['mousemove', String(Math.round(b.start_x)), String(Math.round(b.start_y))]);
  await xdo(screenId, ['mousedown', '1']);
  // A couple of intermediate moves: many apps need motion before the release registers as a drag.
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = b.start_x + ((b.end_x - b.start_x) * i) / steps;
    const y = b.start_y + ((b.end_y - b.start_y) * i) / steps;
    await xdo(screenId, ['mousemove', String(Math.round(x)), String(Math.round(y))]);
  }
  await xdo(screenId, ['mouseup', '1']);
  return { ok: true };
}

/** Type literal text. `--clearmodifiers` stops a stuck ctrl from eating characters. */
export async function type(_id: string, screenId: string | undefined, text: string) {
  await xdo(screenId, ['type', '--clearmodifiers', '--delay', '12', text], 60_000);
  return { ok: true };
}

/** Orgo accepted X keysym names ("Return", "ctrl+a"). xdotool speaks the same names. */
export async function key(_id: string, screenId: string | undefined, keyName: string) {
  const combo = keyName.replace(/\s+/g, '');
  await xdo(screenId, ['key', '--clearmodifiers', combo]);
  return { ok: true };
}

export async function scroll(_id: string, screenId: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) {
  await xdo(screenId, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
  const button = b.direction === 'up' ? '4' : '5';
  const times = Math.max(1, Math.min(50, Math.round(b.amount ?? 3)));
  await xdo(screenId, ['click', '--repeat', String(times), '--delay', '40', button]);
  return { ok: true };
}

// ---------- screens (the Orgo "computer" surface) ----------

export interface ScreenInfo { id: string; display: string; width: number; height: number; default: boolean }

export async function listScreens(_computerId: string): Promise<ScreenInfo[]> {
  const [w, h] = env.msoGeometry.split('x').map(Number);
  const out: ScreenInfo[] = [{ id: 'default', display: ':99', width: w, height: h, default: true }];
  // Every screen we have ever started and not deleted.
  for (const key of displays.keys()) {
    if (key === 'default') continue;
    const num = screenNum(key);
    out.push({ id: key, display: `:${num}`, width: w, height: h, default: false });
  }
  return out;
}

/** Create the next free `screen-N` and boot its display. */
export async function createScreen(_computerId: string): Promise<ScreenInfo> {
  const [w, h] = env.msoGeometry.split('x').map(Number);
  let n = 1;
  while (displays.has(`${SCREEN_PREFIX}${n}`)) n++;
  const id = `${SCREEN_PREFIX}${n}`;
  const state = await ensureDisplay(id);
  displays.set(id, state);
  return { id, display: state.display, width: w, height: h, default: false };
}

export async function getScreen(_computerId: string, screen: string): Promise<ScreenInfo> {
  const [w, h] = env.msoGeometry.split('x').map(Number);
  if (screen !== 'default' && !/^screen-\d+$/.test(screen)) throw new RuntimeError(404, `No screen ${screen}`);
  return { id: screen, display: `:${screenNum(screen)}`, width: w, height: h, default: screen === 'default' };
}

/** Stop a screen's X server and VNC endpoint. Its files (browser profile) stay on disk. */
export async function deleteScreen(_computerId: string, screen: string): Promise<void> {
  if (screen === 'default') throw new RuntimeError(400, 'The default screen cannot be deleted');
  const state = displays.get(screen);
  if (!state) return;
  for (const p of [state.wm, state.vnc, state.xvfb]) {
    try { p?.kill('SIGTERM'); } catch { /* gone */ }
  }
  await new Promise((r) => setTimeout(r, 400));
  for (const p of [state.wm, state.vnc, state.xvfb]) {
    try { if (p && p.exitCode === null) p.kill('SIGKILL'); } catch { /* gone */ }
  }
  displays.delete(screen);
}

/** The VNC port the relay should dial for this screen (starts it if needed). */
export async function vncPort(computerId: string, screenId: string | undefined): Promise<number> {
  const state = await ensureDisplay(screenId ?? 'default');
  return state.port;
}

export async function vncPassword(_computerId: string): Promise<{ password: string }> {
  // The RFB endpoint is loopback-only and passwordless *by design*: the browser already
  // authenticated to this server, and the relay performs its own handshake. Nothing that
  // grants shell access is ever handed to a client.
  return { password: '' };
}

// ---------- box lifecycle ----------

const boxes = new Set<string>();

/** Register a box. Local desktops always exist; there is nothing to provision. */
export async function createComputer(name: string, _idempotencyKey: string) {
  const id = name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'box';
  await fsp.mkdir(path.join(desktopRoot, id), { recursive: true });
  boxes.add(id);
  return { id, status: 'running', name: id, resolution: env.msoGeometry };
}

export async function getComputer(id: string) {
  const dir = path.join(desktopRoot, id);
  const exists = fs.existsSync(dir);
  return { id, status: exists ? 'running' : 'absent', name: id, resolution: env.msoGeometry } as const;
}

/** No-op: a local desktop has no boot cost. Kept so callers need no backend branch. */
export async function start(id: string): Promise<{ ok: true }> {
  await fsp.mkdir(path.join(desktopRoot, id), { recursive: true });
  boxes.add(id);
  return { ok: true };
}

export async function resume(id: string): Promise<{ ok: true }> { return start(id); }

/** "Suspend" stops the X/VNC processes; directories and profiles survive. */
export async function suspend(id: string): Promise<{ ok: true }> {
  for (const [key, state] of [...displays]) {
    // Only tear down screens covered by this box id; the caller passes one box per user.
    if (!key.startsWith(SCREEN_PREFIX)) continue;
    for (const p of [state.wm, state.vnc, state.xvfb]) { try { p?.kill('SIGTERM'); } catch { /* gone */ } }
    displays.delete(key);
  }
  boxes.delete(id);
  return { ok: true };
}

export async function workspaces() {
  return [{ id: 'local', name: 'This host' }];
}

export async function exportFile(_id: string, filePath: string): Promise<{ path: string }> {
  // No signed-URL storage: the file is already on this host, and the API streams it.
  if (!fs.existsSync(filePath)) throw new RuntimeError(404, `No such file ${filePath}`);
  return { path: filePath };
}

/** Paths the agent and UI use, kept in one place so they never hardcode /root/grokbot. */
export function botHome(botId: string): string { return path.join(desktopRoot, 'bots', botId); }
export function botProfile(botId: string): string { return path.join(botHome(botId), 'profile'); }
export function botFiles(botId: string): string { return path.join(botHome(botId), 'files'); }

/** The X display behind a screen id, e.g. `default` -> `:99`, `screen-1` -> `:91`. */
export function displayFor(screenId: string | undefined): string {
  return `:${screenNum(screenId ?? 'default')}`;
}

/**
 * The browser command for a bot, or null when none is installed.
 *
 * Orgo images shipped `google-chrome`; this host does not, but Playwright's downloaded
 * Chromium is present and is a normal Chrome build. The result is a bare command (no
 * args) so callers can append their own profile and URL flags.
 */
export function browserBinary(): string | null {
  const candidates = [
    process.env.GROKBOT_BROWSER,
    // Playwright's own download, newest first.
    ...(() => {
      const base = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
      try {
        return fs
          .readdirSync(base)
          .filter((d) => d.startsWith('chromium-'))
          .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
          .map((d) => path.join(base, d, 'chrome-linux64', 'chrome'));
      } catch { return []; }
    })(),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

/** Shut every display down (server exit). */
export async function shutdownRuntime(): Promise<void> {
  for (const [key] of [...displays]) await deleteScreen('', key).catch(() => undefined);
}
