import { env } from './env.js';
import { CapabilityError } from './lib/capability-error.js';
import { docker, daemonAvailable } from './docker.js';
import { MAX_SCREENS } from './box/contract.js';
import {
  LABEL,
  assertName,
  createDockerBoxRuntime,
  displayFor,
  screenIdFor,
  screenIndex,
  vncPortFor,
  type DockerBoxRuntime,
} from './box/adapters/docker.js';
import type { BoxRunResult } from './box/contract.js';

/**
 * The bot desktop: what `orgo.ts` was, backed by a Docker container instead of a
 * rented VM. Same surface (screenshot/click/type/key/scroll/drag/bash/screens)
 * so tools.ts and vnc.ts do not care which one is behind it.
 *
 * The mechanics live in `box/adapters/docker.ts`, which takes its command runner as
 * a parameter so another host can drive the same boxes. This module is the grokbot
 * wiring for it: the real docker client, `env`, the capability gate, and the one
 * operation the adapter cannot express (a shell with a working directory).
 *
 * Keeping this a thin wrapper is the point: two implementations of the same argv
 * would drift, and the security flags on `docker run` are exactly the kind of thing
 * that must not exist twice.
 */

export { MAX_SCREENS, LABEL, assertName, displayFor, screenIndex, screenIdFor, vncPortFor };

/** docker.ts already speaks argv arrays; this adapts it to the adapter's contract. */
async function run(command: string, args: readonly string[], timeoutMs?: number): Promise<BoxRunResult> {
  if (command !== 'docker') throw new Error(`unsupported command: ${command}`);
  const r = await docker([...args], timeoutMs ? { timeoutMs } : undefined);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

let runtime: DockerBoxRuntime | null = null;

/** The box runtime for the current configuration. Built once; `env` does not change. */
function box(): DockerBoxRuntime {
  ensureMode();
  runtime ??= createDockerBoxRuntime(run, {
    image: env.desktop.image,
    ramGb: env.desktop.ramGb,
    cpu: env.desktop.cpu,
    resolution: env.desktop.resolution,
    socketPath: env.desktop.socket,
    maxScreens: MAX_SCREENS,
  });
  return runtime;
}

function ensureMode(): void {
  if (env.desktop.mode !== 'docker') throw new CapabilityError('desktop');
}

let availability: { at: number; ok: boolean } | null = null;
/** Docker reachable? Cached briefly so a turn does not shell out per call. */
export async function desktopAvailable(force = false): Promise<boolean> {
  if (env.desktop.mode === 'disabled') return false;
  if (env.desktop.mode === 'docker') {
    if (!force && availability && Date.now() - availability.at < 30_000) return availability.ok;
    const ok = await daemonAvailable();
    availability = { at: Date.now(), ok };
    return ok;
  }
  // orgo keeps its own gate: a key is present or it is not.
  return Boolean(env.orgo.key);
}

export type { DesktopComputer, DesktopScreen } from './box/contract.js';

// ---------- lifecycle ----------

export const createComputer = (userId: string, opts: { name?: string } = {}) => box().create(userId, opts);
export const getComputer = (id: string) => box().get(id);
export const start = (id: string) => box().start(id);
export const suspend = (id: string) => box().suspend(id);
export const removeComputer = (id: string) => box().remove(id);

// ---------- screens ----------

export const listScreens = (id: string) => box().listScreens(id);
export const createScreen = (id: string) => box().createScreen(id);
export const deleteScreen = (id: string, screen: string) => box().deleteScreen(id, screen);
export const getScreen = (id: string, screen: string) => box().getScreen(id, screen);

// ---------- capture and input ----------

export const screenshot = (id: string, screen?: string) => box().screenshot(id, screen);
export const click = (id: string, screen: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) =>
  box().click(id, screen, b);
export const move = (id: string, screen: string | undefined, b: { x: number; y: number }) => box().move(id, screen, b);
export const drag = (id: string, screen: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) =>
  box().drag(id, screen, b);
export const type = (id: string, screen: string | undefined, text: string) => box().type(id, screen, text);
export const key = (id: string, screen: string | undefined, keys: string) => box().key(id, screen, keys);
export const scroll = (id: string, screen: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) =>
  box().scroll(id, screen, b);

// ---------- exec ----------

/**
 * A shell inside the box.
 *
 * Not delegated to the adapter: it runs with a working directory (`/home/bot` in a
 * Docker box), and the adapter's `bash` has no cwd option. Rather than add one and
 * make every host carry a Docker-specific path, the cwd lives here where the mode is
 * already known.
 */
export async function bash(
  id: string,
  screen: string | undefined,
  command: string,
  timeoutSeconds = 120,
): Promise<{ success: boolean; output: string; exit_code: number }> {
  ensureMode();
  const display = displayFor(screenIndex(screen));
  const timeoutMs = Math.min(Math.max(timeoutSeconds, 1), 290) * 1000;
  // The command is a shell string by design (that is what a bash tool takes),
  // but it runs INSIDE the box as the unprivileged bot user. `sh -lc` supplies
  // its own argv, so the container name is still a separate argument.
  const r = await docker(
    ['exec', '-e', `DISPLAY=${display}`, '-w', '/home/bot', assertName(id), 'sh', '-lc', command],
    { timeoutMs },
  );
  return { success: r.code === 0, output: r.stdout + (r.stderr ? `\n${r.stderr}` : ''), exit_code: r.code };
}

// ---------- files ----------

export const readFile = (id: string, path: string) => box().readFile(id, path);
export const exportFile = (id: string, path: string) => box().exportFile(id, path);

/** Bring the box's capabilities into view for the UI and for /api/capabilities. */
export async function desktopHealth(): Promise<{ mode: string; ready: boolean; image?: string; containers?: number }> {
  const ready = await desktopAvailable();
  if (env.desktop.mode !== 'docker') return { mode: env.desktop.mode, ready };
  let containers: number | undefined;
  try {
    const out = await docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.ID}}']).catch(() => null);
    if (out?.code === 0) containers = out.stdout.split('\n').filter(Boolean).length;
  } catch { /* count is cosmetic */ }
  return { mode: 'docker', ready, image: env.desktop.image, containers };
}
