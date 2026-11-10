import { env } from './env.js';
import { orgo } from './orgo.js';
import * as desktop from './desktop.js';
import { inspect } from './docker.js';
import { CapabilityError } from './lib/capability-error.js';

/**
 * One bot box, whichever backend is configured.
 *
 * DESKTOP_MODE=docker  local containers (the default posture of this fork)
 * DESKTOP_MODE=orgo    the original rented VM, kept while it still compiles
 * DESKTOP_MODE=disabled computer tools report a capability gap
 *
 * Everything above this file speaks in computerId + screenId and never asks
 * which backend answered.
 */

export const mode = () => env.desktop.mode;

function dockerOnly(): boolean {
  return env.desktop.mode === 'docker';
}

function orgoOnly(): boolean {
  if (env.desktop.mode !== 'orgo') throw new CapabilityError('desktop');
  return true;
}

export function screenIndex(screenId: string | undefined): number {
  if (!screenId || screenId === 'default') return 0;
  const m = /^screen-(\d)$/.exec(screenId);
  return m ? Number(m[1]) : 0;
}

export function screenIdFor(index: number): string {
  return index === 0 ? 'default' : `screen-${index}`;
}

export const box = {
  available: () => desktop.desktopAvailable(),
  health: () => desktop.desktopHealth(),

  create: (userId: string, name: string, _idem: string) =>
    dockerOnly() ? desktop.createComputer(userId, { name }) : orgo.createComputer(name, _idem),
  get: (id: string) => (dockerOnly() ? desktop.getComputer(id) : orgo.getComputer(id)),
  start: (id: string) => (dockerOnly() ? desktop.start(id) : orgo.start(id)),
  resume: (id: string) => (dockerOnly() ? desktop.start(id) : orgo.resume(id)),
  suspend: (id: string) => (dockerOnly() ? desktop.suspend(id) : orgo.suspend(id)),
  remove: (id: string) => (dockerOnly() ? desktop.removeComputer(id) : Promise.resolve()),

  listScreens: (id: string) => (dockerOnly() ? desktop.listScreens(id) : orgo.listScreens(id)),
  createScreen: (id: string) => (dockerOnly() ? desktop.createScreen(id) : orgo.createScreen(id)),
  getScreen: (id: string, screen: string) => (dockerOnly() ? desktop.getScreen(id, screen) : orgo.getScreen(id, screen)),
  deleteScreen: (id: string, screen: string) => (dockerOnly() ? desktop.deleteScreen(id, screen) : orgo.deleteScreen(id, screen)),

  screenshot: (id: string, screen?: string) => (dockerOnly() ? desktop.screenshot(id, screen) : orgo.screenshot(id, screen)),
  click: (id: string, screen: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) =>
    dockerOnly() ? desktop.click(id, screen, b) : orgo.click(id, screen, b),
  move: (id: string, screen: string | undefined, b: { x: number; y: number }) =>
    dockerOnly() ? desktop.move(id, screen, b) : orgo.move(id, screen, b),
  drag: (id: string, screen: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) =>
    dockerOnly() ? desktop.drag(id, screen, b) : orgo.drag(id, screen, b),
  type: (id: string, screen: string | undefined, text: string) =>
    dockerOnly() ? desktop.type(id, screen, text) : orgo.type(id, screen, text),
  key: (id: string, screen: string | undefined, k: string) =>
    dockerOnly() ? desktop.key(id, screen, k) : orgo.key(id, screen, k),
  scroll: (id: string, screen: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) =>
    dockerOnly() ? desktop.scroll(id, screen, b) : orgo.scroll(id, screen, b),

  bash: (id: string, screen: string | undefined, command: string, timeout = 120) =>
    dockerOnly() ? desktop.bash(id, screen, command, timeout) : orgo.bash(id, screen, command, timeout),

  readFile: (id: string, path: string) => desktop.readFile(id, path),
  exportFile: (id: string, path: string) => desktop.exportFile(id, path),

  /** VNC upstream for the relay: where to dial and with what secret. */
  async vncUpstream(computerId: string, screenId: string): Promise<{ url: string; password: string }> {
    if (!dockerOnly()) {
      orgoOnly();
      const { password } = await orgo.vncPassword(computerId);
      const screen = screenId !== 'default' ? `&screen=${encodeURIComponent(screenId)}` : '';
      return {
        url: `wss://www.orgo.ai/desktops/${computerId}/ws/websockify?token=${encodeURIComponent(password)}${screen}`,
        password,
      };
    }
    // The container's websockify listens on 0.0.0.0 inside the box and forwards
    // to an x11vnc that is loopback-only, so the box's own bridge IP is the
    // narrowest address that works. No VNC password: the host relay is the only
    // client that can reach that IP, and it already authenticated the user.
    const port = desktop.vncPortFor(screenIndex(screenId));
    const host = await containerHost(computerId);
    return { url: `ws://${host}:${port}/websockify`, password: '' };
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
