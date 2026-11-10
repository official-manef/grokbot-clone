import { env } from './env.js';
import { orgo } from './orgo.js';
import * as docker from './desktop.js';
import * as mso from './mso.js';
import { inspect } from './docker.js';
import { CapabilityError } from './lib/capability-error.js';

/**
 * One bot box, whichever backend is configured.
 *
 * DESKTOP_MODE=docker  local containers (the default posture of this fork)
 * DESKTOP_MODE=mso     host Xvfb displays, no container runtime
 * DESKTOP_MODE=orgo    the original rented VM, kept while it still compiles
 * DESKTOP_MODE=disabled computer tools report a capability gap
 *
 * Everything above this file speaks in computerId + screenId and never asks which
 * backend answered.
 *
 * Backend selection used to be a chain of `dockerOnly() ? desktop : orgo` ternaries,
 * one per operation. Adding a third backend meant touching every line and made the
 * mso branch silently fall through to Orgo whenever one was missed — which is exactly
 * what happened: DESKTOP_MODE=mso was accepted by the type and then threw
 * CapabilityError from every call. A single dispatch table is harder to get wrong.
 */

export const mode = () => env.desktop.mode;

/**
 * Where the bot's own files live inside its box. This is the single source of truth:
 * the tools write here, the Library reads here, and the two must agree or a saved file
 * is invisible. Root on an Orgo VM, the unprivileged bot user on a Docker box.
 *
 * The mso backend is host-local: its "inside the box" path is a real host path, so it
 * is resolved per bot rather than returned as a constant — see `boxGrokbotFor`.
 */
export const boxHome = (): string => (env.desktop.mode === 'docker' ? '/home/bot' : '/root');
export const boxGrokbot = (): string => `${boxHome()}/grokbot`;

/** Library directory for a specific bot on backends whose paths are host paths. */
export function boxGrokbotFor(botId: string): string {
  return env.desktop.mode === 'mso' ? mso.libraryDir(botId) : boxGrokbot();
}

/** Browser profile directory for a specific bot. */
export function profileDirFor(botId: string): string {
  return env.desktop.mode === 'mso' ? mso.profileDir(botId) : '/root/grokbot/profiles/' + botId;
}

export function screenIndex(screenId: string | undefined): number {
  return docker.screenIndex(screenId);
}

export function screenIdFor(index: number): string {
  return docker.screenIdFor(index);
}

/** The desktop surface both local backends implement identically. */
/** Only the fields common to every backend; `asleep` etc. are Orgo-specific. */
type Box = { id: string; status: string; name?: string; resolution?: string | null; asleep?: unknown };

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

/** Both local backends, keyed so an unhandled mode is a boot-time error, not a fallthrough. */
function local(): Local {
  if (env.desktop.mode === 'docker') return docker as unknown as Local;
  if (env.desktop.mode === 'mso') return mso as unknown as Local;
  throw new CapabilityError('desktop');
}

const isLocal = () => env.desktop.mode === 'docker' || env.desktop.mode === 'mso';

export const box = {
  available: () => (env.desktop.mode === 'mso' ? mso.msoAvailable() : docker.desktopAvailable()),
  health: () => (env.desktop.mode === 'mso' ? mso.desktopHealth() : docker.desktopHealth()),

  create: (userId: string, name: string, idem: string) =>
    isLocal() ? local().createComputer(userId, { name }) : orgo.createComputer(name, idem),
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

  readFile: (id: string, path: string) => local().readFile(id, path),
  exportFile: (id: string, path: string) => local().exportFile(id, path),

  /** VNC upstream for the relay: where to dial and with what secret. */
  async vncUpstream(computerId: string, screenId: string): Promise<{ url: string; password: string }> {
    if (env.desktop.mode === 'mso') {
      // Loopback x11vnc, no password: the relay is the only client that can reach that
      // port, and it has already authenticated the user. No credential reaches a browser.
      // `tcp://` tells the relay to dial raw RFB rather than a WebSocket: x11vnc has
      // no websockify in front of it. Loopback only — the port never leaves this host.
      const port = await mso.vncUpstreamPort(screenIndex(screenId));
      return { url: `tcp://127.0.0.1:${port}`, password: '' };
    }
    if (env.desktop.mode === 'docker') {
      // The container's websockify listens on 0.0.0.0 inside the box and forwards
      // to an x11vnc that is loopback-only, so the box's own bridge IP is the
      // narrowest address that works. No VNC password: the host relay is the only
      // client that can reach that IP, and it already authenticated the user.
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

export { CapabilityError };
