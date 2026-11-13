import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import { orgo } from './orgo.js';
import * as dockerDesktop from './desktop.js';
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
 */

export interface BashResult { output: string; exit_code: number }

/** Orgo screen id -> X display. The default screen is :99, "screen-100" is :100. */
export const displayFor = (screenId?: string | null) =>
  (!screenId || screenId === 'default' ? ':99' : `:${screenId.replace('screen-', '')}`);

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
 * Where the bot's own files live inside its box. This is the single source of
 * truth: the tools write here, the Library reads here, and the two must agree
 * or a saved file is invisible. Root on a shared VM; the unprivileged bot user
 * on a Docker box.
 */
export const boxHome = (): string => (env.desktop.mode === 'docker' ? '/home/bot' : '/root');
export const boxGrokbot = (): string => `${boxHome()}/grokbot`;

export function screenIndex(screenId: string | undefined): number {
  if (!screenId || screenId === 'default') return 0;
  const m = /^screen-(\d)$/.exec(screenId);
  return m ? Number(m[1]) : 0;
}

export function screenIdFor(index: number): string {
  return index === 0 ? 'default' : `screen-${index}`;
}

const isDocker = () => env.desktop.mode === 'docker';

function orgoOnly(): void {
  if (env.desktop.mode !== 'orgo') throw new CapabilityError('desktop');
}

/** Docker's bridge address for a container, as reachable from this host. */
async function containerHost(name: string): Promise<string> {
  const info = await inspect(name);
  const ip =
    info?.NetworkSettings?.IPAddress ||
    Object.values(info?.NetworkSettings?.Networks ?? {}).map((n: any) => n?.IPAddress).find(Boolean);
  if (!ip) throw new Error(`container ${name} has no address (is it running?)`);
  return String(ip);
}

/** The desktop lifecycle. Same surface `orgo.ts` exposed, whichever backend answers. */
export const computer = {
  available: () => dockerDesktop.desktopAvailable(),
  health: () => dockerDesktop.desktopHealth(),

  create: (userId: string, name: string, _idem: string) => {
    // Only the Docker backend owns its boxes. A shared Orgo computer is
    // somebody's working machine and is never created from here.
    if (!isDocker()) throw new Error('The shared computer is not created by this app; set ORGO_COMPUTER_ID instead.');
    return dockerDesktop.createComputer(userId, { name });
  },
  get: (id: string) => (isDocker() ? dockerDesktop.getComputer(id) : orgo.getComputer(id)),
  start: (id: string) => (isDocker() ? dockerDesktop.start(id) : orgo.start(id)),
  resume: (id: string) => (isDocker() ? dockerDesktop.start(id) : orgo.resume(id)),
  suspend: (id: string) => (isDocker() ? dockerDesktop.suspend(id) : orgo.suspend(id)),
  remove: (id: string) => (isDocker() ? dockerDesktop.removeComputer(id) : Promise.resolve()),

  listScreens: (id: string) => (isDocker() ? dockerDesktop.listScreens(id) : orgo.listScreens(id)),
  createScreen: (id: string) => (isDocker() ? dockerDesktop.createScreen(id) : orgo.createScreen(id)),
  getScreen: (id: string, screen: string) => (isDocker() ? dockerDesktop.getScreen(id, screen) : orgo.getScreen(id, screen)),
  deleteScreen: (id: string, screen: string) =>
    isDocker() ? dockerDesktop.deleteScreen(id, screen) : orgo.deleteScreen(id, screen),

  screenshot: (id: string, screen?: string) => (isDocker() ? dockerDesktop.screenshot(id, screen) : orgo.screenshot(id, screen)),
  click: (id: string, screen: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) =>
    isDocker() ? dockerDesktop.click(id, screen, b) : orgo.click(id, screen, b),
  move: (id: string, screen: string | undefined, b: { x: number; y: number }) =>
    isDocker() ? dockerDesktop.move(id, screen, b) : orgo.move(id, screen, b),
  drag: (id: string, screen: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) =>
    isDocker() ? dockerDesktop.drag(id, screen, b) : orgo.drag(id, screen, b),
  type: (id: string, screen: string | undefined, text: string) =>
    isDocker() ? dockerDesktop.type(id, screen, text) : orgo.type(id, screen, text),
  key: (id: string, screen: string | undefined, k: string) =>
    isDocker() ? dockerDesktop.key(id, screen, k) : orgo.key(id, screen, k),
  scroll: (id: string, screen: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) =>
    isDocker() ? dockerDesktop.scroll(id, screen, b) : orgo.scroll(id, screen, b),

  bash: (id: string, screen: string | undefined, command: string, timeout = 120) =>
    isDocker() ? dockerDesktop.bash(id, screen, command, timeout) : orgo.bash(id, screen, command, timeout),

  readFile: (id: string, p: string) => dockerDesktop.readFile(id, p),
  exportFile: (id: string, p: string) => dockerDesktop.exportFile(id, p),

  /** VNC upstream for the relay: where to dial and with what secret. */
  async vncUpstream(computerId: string, screenId: string): Promise<{ url: string; password: string }> {
    if (!isDocker()) {
      orgoOnly();
      const { password } = await orgo.vncPassword(computerId);
      const screen = screenId !== 'default' ? `&screen=${encodeURIComponent(screenId)}` : '';
      return {
        url: `wss://www.orgo.ai/desktops/${computerId}/ws/websockify?token=${encodeURIComponent(password)}${screen}`,
        password,
      };
    }
    // websockify in the box listens on the container's bridge address and
    // forwards to a loopback-only x11vnc. No VNC password: the host relay is the
    // only client that can reach that address, and it authenticated the user.
    const port = dockerDesktop.vncPortFor(screenIndex(screenId));
    const host = await containerHost(computerId);
    return { url: `ws://${host}:${port}/websockify`, password: '' };
  },
};

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
