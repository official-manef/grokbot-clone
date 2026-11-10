import { env } from './env.js';
import { orgo as orgoBackend } from './orgo.js';
import * as local from './desktop.js';

/**
 * One computer interface, two backends.
 *
 * `COMPUTER_BACKEND=mso` (default) runs bots on this host via desktop.ts.
 * `COMPUTER_BACKEND=orgo` keeps the original cloud VM path for anyone with a key.
 *
 * Everything above this module (computer.ts, tools.ts, routes, vnc.ts, idle.ts) imports
 * `runtime`, so swapping backends is one env var and never a code change.
 */

export type BackendApi = {
  workspaces: () => Promise<any>;
  createComputer: (name: string, idempotencyKey: string) => Promise<{ id: string; status: string; name?: string; resolution?: string | null }>;
  getComputer: (id: string) => Promise<{ id: string; status: string; name?: string; asleep?: unknown; resolution?: string | null }>;
  start: (id: string) => Promise<unknown>;
  resume: (id: string) => Promise<unknown>;
  suspend: (id: string) => Promise<unknown>;
  vncPassword: (id: string) => Promise<{ password: string }>;
  listScreens: (id: string) => Promise<Array<{ id: string; display: string; width: number; height: number; default: boolean }>>;
  createScreen: (id: string) => Promise<{ id: string; display: string; width: number; height: number; default: boolean }>;
  getScreen: (id: string, screen: string) => Promise<{ id: string; display: string; width: number; height: number; default: boolean }>;
  deleteScreen: (id: string, screen: string) => Promise<unknown>;
  screenshot: (id: string, screen?: string) => Promise<{ image: string; mime_type?: string; width: number; height: number }>;
  click: (id: string, screen: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) => Promise<unknown>;
  move: (id: string, screen: string | undefined, b: { x: number; y: number }) => Promise<unknown>;
  drag: (id: string, screen: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) => Promise<unknown>;
  type: (id: string, screen: string | undefined, text: string) => Promise<unknown>;
  key: (id: string, screen: string | undefined, key: string) => Promise<unknown>;
  scroll: (id: string, screen: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) => Promise<unknown>;
  bash: (id: string, screen: string | undefined, command: string, timeout?: number) => Promise<{ success: boolean; output: string; exit_code: number }>;
  exportFile: (id: string, path: string) => Promise<any>;
};

const localApi: BackendApi = {
  workspaces: local.workspaces,
  createComputer: local.createComputer,
  getComputer: local.getComputer,
  start: local.start,
  resume: local.resume,
  suspend: local.suspend,
  vncPassword: local.vncPassword,
  listScreens: local.listScreens,
  createScreen: local.createScreen,
  getScreen: local.getScreen,
  deleteScreen: local.deleteScreen,
  screenshot: local.screenshot,
  click: local.click,
  move: local.move,
  drag: local.drag,
  type: local.type,
  key: local.key,
  scroll: local.scroll,
  bash: local.bash,
  exportFile: local.exportFile,
};

export const runtime: BackendApi = env.computerBackend === 'orgo' ? (orgoBackend as unknown as BackendApi) : localApi;

/** True when the backend lives on this host (no provisioning, no cloud bill). */
export const runtimeIsLocal = env.computerBackend === 'mso';

/** Where a bot's browser profile lives, for both backends. */
export function profileDirFor(botId: string): string {
  return runtimeIsLocal ? local.botProfile(botId) : `/root/grokbot/profiles/${botId}`;
}

/** Where a bot's saved Library files live, for both backends. */
export function libraryDirFor(botId: string): string {
  return runtimeIsLocal ? local.botFiles(botId) : `/root/grokbot/files/${botId}`;
}

export { local };
