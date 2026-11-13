import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import { orgo } from './orgo.js';
import * as docker from './desktop.js';
import * as mso from './mso.js';
import { inspect } from './docker.js';
import { CapabilityError } from './lib/capability-error.js';

/**
 * The box: where a bot's work actually happens.
 *
 * Two things share this module because they answer the same question — "which
 * computer is this bot using right now?":
 *
 * 1. Transport (from bot-hq). `box.bash/readFile/writeFile` reach the one shared
 *    computer: the local shell and disk when this server runs on it (HQ_LOCAL=1),
 *    otherwise through Orgo's API.
 * 2. Backends. `box.computer` is the desktop lifecycle the tools and the viewer
 *    call, and DESKTOP_MODE picks which implementation answers: a local Docker
 *    container (default, isolated), a host Xvfb display (mso), Orgo's VMs, or
 *    nothing at all.
 *
 * Everything above this file speaks computerId + screenId and never asks which
 * backend answered.
 *
 * Backend selection is one dispatch table, not a chain of ternaries: a missing
 * branch in a chain is invisible, and that is exactly how DESKTOP_MODE=mso came
 * to fall through to Orgo and throw from every call.
 */

export interface BashResult { output: string; exit_code: number }

/** Orgo screen id -> X display. Index 0 is :99; mso puts the rest on :9N. */
export function displayFor(screenId?: string | null): string {
  const index = screenIndex(screenId ?? undefined);
  if (env.desktop.mode === 'mso') return mso.displayFor(index);
  return index === 0 ? ':99' : `:${index}`;
}

/** Only what a desktop command needs; none of this server's secrets. */
function shellEnv(screenId?: string | null): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    USER: process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    DISPLAY: displayFor(screenId),
  };
}

function localBash(command: string, timeoutSec: number, screenId?: string | null): Promise<BashResult> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env: shellEnv(screenId) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: code });
    });
  });
}

/** A path safe to put inside single quotes in a shell command. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------- desktop backends ----------

export const mode = () => env.desktop.mode;

/**
 * Where the bot's own files live inside its box. Single source of truth: the
 * tools write here and the Library reads here, or a saved file is invisible.
 * Root on a shared VM, the unprivileged bot user on a Docker box.
 *
 * mso is host-local, so its path is a real host path resolved per bot; see
 * `boxGrokbotFor`.
 */
export const boxHome = (): string => (env.desktop.mode === 'docker' ? '/home/bot' : '/root');
export const boxGrokbot = (): string => `${boxHome()}/grokbot`;

/** Library directory for a specific bot on backends whose paths are host paths. */
export function boxGrokbotFor(botId: string): string {
  return env.desktop.mode === 'mso' ? mso.libraryDir(botId) : boxGrokbot();
}

/** Browser profile directory for a specific bot. */
export function profileDirFor(botId: string): string {
  return env.desktop.mode === 'mso' ? mso.profileDir(botId) : `${boxGrokbot()}/profiles/${botId}`;
}

export function screenIndex(screenId: string | undefined): number {
  return docker.screenIndex(screenId);
}

export function screenIdFor(index: number): string {
  return docker.screenIdFor(index);
}

/** Only the fields common to every backend; `asleep` etc. are Orgo-specific. */
type Box = { id: string; status: string; name?: string; resolution?: string | null; asleep?: unknown };

/** The desktop surface both local backends implement identically. */
type Local = {
  createComputer: (userId: string, opts?: { name?: string }) => Promise<Box>;
  getComputer: (id: string) => Promise<Box>;
  start: (id: string) => Promise<unknown>;
  suspend: (id: string) => Promise<unknown>;
  removeComputer: (id: string) => Promise<void>;
  listScreens: (id: string) => Promise<Array<{ id: string; display: string; width: number; height: number; default: boolean }>>;
  createScreen: (id: string) => Promise<{ id: string; display: string; width: number; height: number; default: boolean }>;
  getScreen: (id: string, screen: string) => Promise<{ id: string; display: string; width: number; height: number; default: boolean }>;
  deleteScreen: (id: string, screen: string) => Promise<void>;
  screenshot: (id: string, screen?: string) => Promise<{ image: string; mime_type?: string; width: number; height: number }>;
  click: (id: string, screen: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) => Promise<unknown>;
  move: (id: string, screen: string | undefined, b: { x: number; y: number }) => Promise<unknown>;
  drag: (id: string, screen: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) => Promise<unknown>;
  type: (id: string, screen: string | undefined, text: string) => Promise<unknown>;
  key: (id: string, screen: string | undefined, k: string) => Promise<unknown>;
  scroll: (id: string, screen: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) => Promise<unknown>;
  bash: (id: string, screen: string | undefined, command: string, timeout?: number) => Promise<{ success: boolean; output: string; exit_code: number }>;
  readFile: (id: string, path: string) => Promise<Buffer>;
  exportFile: (id: string, path: string) => Promise<{ url?: undefined; bytes: Buffer }>;
};

/** Both local backends, keyed so an unhandled mode is an error, not a fallthrough. */
function local(): Local {
  if (env.desktop.mode === 'docker') return docker as unknown as Local;
  if (env.desktop.mode === 'mso') return mso as unknown as Local;
  throw new CapabilityError('desktop');
}

const isLocal = () => env.desktop.mode === 'docker' || env.desktop.mode === 'mso';

/** The desktop lifecycle. Same surface `orgo.ts` exposed, whichever backend answers. */
export const computer = {
  available: () => (env.desktop.mode === 'mso' ? mso.msoAvailable() : docker.desktopAvailable()),
  health: () => (env.desktop.mode === 'mso' ? mso.desktopHealth() : docker.desktopHealth()),

  // Only a local backend owns its boxes. A shared Orgo computer is somebody's
  // working machine and is never created from here.
  create: (userId: string, name: string, _idem: string) => local().createComputer(userId, { name }),
  get: (id: string) => (isLocal() ? local().getComputer(id) : orgo.getComputer(id)),
  start: (id: string) => (isLocal() ? local().start(id) : orgo.start(id)),
  resume: (id: string) => (isLocal() ? local().start(id) : orgo.resume(id)),
  suspend: (id: string) => (isLocal() ? local().suspend(id) : orgo.suspend(id)),
  remove: (id: string) => (isLocal() ? local().removeComputer(id) : Promise.resolve()),

  listScreens: (id: string) => (isLocal() ? local().listScreens(id) : orgo.listScreens(id)),
  createScreen: (id: string) => (isLocal() ? local().createScreen(id) : orgo.createScreen(id)),
  getScreen: (id: string, screen: string) => (isLocal() ? local().getScreen(id, screen) : orgo.getScreen(id, screen)),
  deleteScreen: (id: string, screen: string) => (isLocal() ? local().deleteScreen(id, screen) : orgo.deleteScreen(id, screen)),

  screenshot: (id: string, screen?: string) => (isLocal() ? local().screenshot(id, screen) : orgo.screenshot(id, screen)),
  click: (id: string, screen: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) =>
    isLocal() ? local().click(id, screen, b) : orgo.click(id, screen, b),
  move: (id: string, screen: string | undefined, b: { x: number; y: number }) =>
    isLocal() ? local().move(id, screen, b) : orgo.move(id, screen, b),
  drag: (id: string, screen: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) =>
    isLocal() ? local().drag(id, screen, b) : orgo.drag(id, screen, b),
  type: (id: string, screen: string | undefined, text: string) =>
    isLocal() ? local().type(id, screen, text) : orgo.type(id, screen, text),
  key: (id: string, screen: string | undefined, k: string) =>
    isLocal() ? local().key(id, screen, k) : orgo.key(id, screen, k),
  scroll: (id: string, screen: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) =>
    isLocal() ? local().scroll(id, screen, b) : orgo.scroll(id, screen, b),

  bash: (id: string, screen: string | undefined, command: string, timeout = 120) =>
    isLocal() ? local().bash(id, screen, command, timeout) : orgo.bash(id, screen, command, timeout),

  readFile: (id: string, p: string) => local().readFile(id, p),
  exportFile: (id: string, p: string) => local().exportFile(id, p),

  /** VNC upstream for the relay: where to dial and with what secret. */
  async vncUpstream(computerId: string, screenId: string): Promise<{ url: string; password: string }> {
    if (env.desktop.mode === 'mso') {
      // Loopback x11vnc with no password: the relay is the only client that can reach
      // that port and it already authenticated the user. `tcp://` tells the relay to
      // dial raw RFB, because x11vnc has no websockify in front of it.
      const port = await mso.vncUpstreamPort(screenIndex(screenId));
      return { url: `tcp://127.0.0.1:${port}`, password: '' };
    }
    if (env.desktop.mode === 'docker') {
      // websockify in the box listens on the container's bridge address and forwards
      // to a loopback-only x11vnc. No VNC password: the host relay is the only client
      // that can reach that address, and it authenticated the user.
      const port = docker.vncPortFor(screenIndex(screenId));
      const host = await containerHost(computerId);
      return { url: `ws://${host}:${port}/websockify`, password: '' };
    }
    const { password } = await orgo.vncPassword(computerId);
    const screen = screenId !== 'default' ? `&screen=${encodeURIComponent(screenId)}` : '';
    return {
      url: `wss://www.orgo.ai/desktops/${computerId}/ws/websockify?token=${encodeURIComponent(password)}${screen}`,
      password,
    };
  },
};

/** Docker's bridge address for a container, as reachable from this host. */
async function containerHost(name: string): Promise<string> {
  const info = await inspect(name);
  const ip =
    info?.NetworkSettings?.IPAddress ||
    Object.values(info?.NetworkSettings?.Networks ?? {}).map((n: any) => n?.IPAddress).find(Boolean);
  if (!ip) throw new Error(`container ${name} has no address (is it running?)`);
  return String(ip);
}

/** Transport to the one shared computer: local shell when we are on it, Orgo otherwise. */
export const box = {
  local: env.localBox,
  computer,
  quote: q,
  displayFor,

  /** Run a bash command on the box. `screenId` picks which screen's DISPLAY it sees. */
  async bash(command: string, timeoutSec = 60, screenId?: string | null): Promise<BashResult> {
    if (env.localBox) return localBash(command, timeoutSec, screenId);
    if (!env.orgoComputerId) {
      // No shared computer and not running on one: fall back to the bot's own
      // desktop backend so a single-bot install still has somewhere to work.
      throw new Error('No computer available: set HQ_LOCAL=1, ORGO_COMPUTER_ID, or DESKTOP_MODE=docker');
    }
    const cmd = `export DISPLAY=${displayFor(screenId)}; ${command}`;
    const r = await orgo.bash(env.orgoComputerId, screenId ?? undefined, cmd, timeoutSec);
    return { output: r.output ?? '', exit_code: r.exit_code ?? (r.success ? 0 : 1) };
  },

  async writeFile(file: string, content: string | Buffer, fileMode = '0644'): Promise<void> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (env.localBox) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, buf);
      await fs.chmod(file, parseInt(fileMode, 8));
      return;
    }
    // Orgo drops very long commands, so the file goes over in base64 pieces.
    const b64 = buf.toString('base64');
    const tmp = `${file}.b64`;
    const first = await box.bash(`mkdir -p ${q(path.dirname(file))} && : > ${q(tmp)} && echo ok`, 30);
    if (!first.output.includes('ok')) throw new Error(`could not write ${file}: ${first.output.slice(0, 200)}`);
    for (let i = 0; i < b64.length; i += 60000) await box.bash(`printf '%s' '${b64.slice(i, i + 60000)}' >> ${q(tmp)}`, 30);
    const done = await box.bash(`base64 -d ${q(tmp)} > ${q(file)} && rm -f ${q(tmp)} && chmod ${fileMode} ${q(file)} && echo ok`, 30);
    if (!done.output.includes('ok')) throw new Error(`could not write ${file}: ${done.output.slice(0, 200)}`);
  },

  /** Read a file from the box, or null if it isn't there. Meant for small files (under ~4 MB). */
  async readFile(file: string): Promise<Buffer | null> {
    if (env.localBox) {
      try { return await fs.readFile(file); } catch { return null; }
    }
    const r = await box.bash(`[ -f ${q(file)} ] && base64 -w0 ${q(file)} || echo __missing__`, 60);
    const out = r.output.trim();
    if (!out || out.endsWith('__missing__')) return null;
    return Buffer.from(out, 'base64');
  },
};

export { CapabilityError };
