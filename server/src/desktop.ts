import { env } from './env.js';
import { CapabilityError } from './lib/capability-error.js';
import { docker, dockerBuffer, dockerOk, DockerError, daemonAvailable, inspect } from './docker.js';

/**
 * The bot desktop: what `orgo.ts` was, backed by a Docker container instead of a
 * rented VM. Same surface (screenshot/click/type/key/scroll/drag/bash/screens)
 * so tools.ts and vnc.ts do not care which one is behind it.
 *
 * Isolation is the point. Every operation is `docker exec` on one container with
 * no host mounts, so a prompt-injected bot reaches a throwaway box, not the host
 * that runs MSO.
 */

export const MAX_SCREENS = 4;
const LABEL = 'grokbot.desktop=1';

/** Display for local screen index 0..3. Index 0 is the primary :99. */
export function displayFor(index: number): string {
  return index === 0 ? ':99' : `:${index}`;
}

/** websockify port inside the box for a screen index. */
export function vncPortFor(index: number): number {
  return 6080 + index;
}

/** Turn an Orgo-style screen id ('default' | 'screen-N') into a screen index. */
export function screenIndex(screenId: string | undefined): number {
  if (!screenId || screenId === 'default') return 0;
  const m = /^screen-(\d)$/.exec(screenId);
  return m ? Number(m[1]) : 0;
}

export function screenIdFor(index: number): string {
  return index === 0 ? 'default' : `screen-${index}`;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
function assertName(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid container name: ${name}`);
  return name;
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

export interface DesktopComputer {
  id: string;
  name: string;
  status: string;
  resolution?: string;
  vnc_password?: string | null;
  asleep?: null;
}

// ---------- lifecycle ----------

function containerNameFor(userId: string): string {
  return assertName(`grokbot-${userId.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`);
}

/** The bridge network this box owns. Its own network, with peer traffic off. */
function networkFor(container: string): string {
  return `${container}-net`;
}

/**
 * Create the box's own bridge network (idempotent). `enable_icc=false` is the only
 * place Docker accepts that setting: on the network, not on `docker run`. Without it
 * every box shares `bridge` and any container can dial the next one's websockify,
 * which has no password because only the host relay was ever supposed to reach it.
 */
async function ensureNetwork(network: string): Promise<void> {
  const r = await docker(['network', 'create', '--opt', 'com.docker.network.bridge.enable_icc=false', network], { timeoutMs: 30_000 });
  if (r.code !== 0 && !/already exists/.test(r.stderr)) throw new Error(`could not create network ${network}: ${r.stderr.slice(0, 200)}`);
}

/**
 * Create the box. No host paths are mounted and no credentials are passed, so
 * the container has nothing of the host's to steal beyond its own X server.
 */
export async function createComputer(userId: string, opts: { name?: string } = {}): Promise<DesktopComputer> {
  ensureMode();
  const name = containerNameFor(userId);
  await ensureNetwork(networkFor(name));
  const ramGb = env.desktop.ramGb;
  const args = [
    'run', '-d',
    '--name', name,
    '--label', LABEL,
    '--label', `grokbot.user=${userId.slice(0, 40)}`,
    '--memory', `${ramGb}g`,
    '--memory-swap', `${ramGb}g`,
    '--cpus', String(env.desktop.cpu),
    '--pids-limit', '2048',
    '--shm-size', '512m',
    // X servers inside the box only; the host reaches them through the relay or
    // `docker exec`, never through a published port.
    '--security-opt', 'no-new-privileges',
    // No capabilities at all, SYS_ADMIN included. The displays are unprivileged Xvfb
    // and the bot is an unprivileged user, so the box never needed one: verified by
    // running the image with `--cap-drop ALL` and taking a screenshot. Keeping
    // SYS_ADMIN would have let a prompt-injected bot mount what it cannot read.
    '--cap-drop', 'ALL',
    // One network per box, with inter-container traffic off, so a bot cannot reach the
    // websockify of the box next door and drive it without a VNC password. The host
    // relay still reaches the box's own bridge address; a peer cannot.
    '--network', networkFor(name),
    '-e', `GROKBOT_SCREENS=${MAX_SCREENS}`,
    '-e', `GROKBOT_RESOLUTION=${env.desktop.resolution}`,
    env.desktop.image,
  ];
  try {
    await dockerOk(args, { timeoutMs: 300_000 });
  } catch (e) {
    if (e instanceof DockerError && /already in use/.test(e.result.stderr)) {
      // Idempotent create: a previous attempt left the box behind.
      await dockerOk(['start', name]).catch(() => {});
    } else throw e;
  }
  const info = await inspect(name);
  return {
    id: name,
    name,
    status: String(info?.State?.Status ?? 'running'),
    resolution: env.desktop.resolution,
    vnc_password: null,
    asleep: null,
  };
}

export async function getComputer(id: string): Promise<DesktopComputer> {
  ensureMode();
  const info = await inspect(assertName(id));
  if (!info) {
    const err = new Error(`No such container: ${id}`);
    (err as any).status = 404;
    throw err;
  }
  return {
    id,
    name: String(info.Name ?? '').replace(/^\//, ''),
    status: String(info.State?.Status ?? 'unknown'),
    resolution: env.desktop.resolution,
    vnc_password: null,
    asleep: null,
  };
}

export async function start(id: string): Promise<{ ok: true }> {
  ensureMode();
  await dockerOk(['start', assertName(id)]);
  return { ok: true };
}

export async function suspend(id: string): Promise<{ ok: true }> {
  ensureMode();
  // `stop` is the honest equivalent of Orgo's suspend: the process tree goes
  // away and the filesystem survives, so waking is a `start`.
  await dockerOk(['stop', '-t', '10', assertName(id)], { timeoutMs: 60_000 });
  return { ok: true };
}

export async function removeComputer(id: string): Promise<void> {
  ensureMode();
  const name = assertName(id);
  await docker(['rm', '-f', name], { timeoutMs: 60_000 });
  // The box's network exists only for the box.
  await docker(['network', 'rm', networkFor(name)], { timeoutMs: 30_000 }).catch(() => null);
}

// ---------- screens ----------

export interface DesktopScreen { id: string; display: string; width: number; height: number; default: boolean }

export async function listScreens(_id: string): Promise<DesktopScreen[]> {
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

export async function createScreen(_id: string): Promise<DesktopScreen> {
  // The box is created with all four displays already running; leasing is the
  // only allocation that happens. Kept for interface compatibility.
  ensureMode();
  return { id: screenIdFor(1), display: displayFor(1), width: 1280, height: 800, default: false };
}

export async function deleteScreen(_id: string, _screen: string): Promise<void> {
  // Nothing to tear down: displays are fixed at creation. Exists so callers that
  // evicted a lease do not have to special-case this backend.
  return;
}

export async function getScreen(id: string, screen: string): Promise<DesktopScreen> {
  const all = await listScreens(id);
  const found = all.find((s) => s.id === screen);
  if (!found) throw new Error(`No such screen: ${screen}`);
  return found;
}

// ---------- capture ----------

export async function screenshot(id: string, screen?: string): Promise<{ image: string; mime_type?: string; width: number; height: number }> {
  ensureMode();
  const display = displayFor(screenIndex(screen));
  const r = await dockerBuffer(['exec', assertName(id), 'grokbot-shot', display], { timeoutMs: 30_000 });
  if (r.code !== 0 || !r.stdout.length) {
    throw new Error(`screenshot failed: ${(r.stderr || 'empty image').slice(0, 200)}`);
  }
  const [w, h] = env.desktop.resolution.split('x').map(Number);
  return { image: r.stdout.toString('base64'), mime_type: 'image/png', width: w || 1280, height: h || 800 };
}

// ---------- input ----------

async function xdo(id: string, screen: string | undefined, args: string[], timeoutMs = 20_000): Promise<string> {
  ensureMode();
  const display = displayFor(screenIndex(screen));
  // DISPLAY is set as an env var, and the xdotool argv is passed as separate
  // arguments, so no caller text is ever parsed by a shell.
  const out = await dockerOk(['exec', '-e', `DISPLAY=${display}`, assertName(id), 'xdotool', ...args], { timeoutMs });
  return out.trim();
}

export async function click(id: string, screen: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) {
  const btn = b.button === 'right' ? '3' : b.button === 'middle' ? '2' : '1';
  await xdo(id, screen, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
  await xdo(id, screen, ['click', ...(b.double ? ['--repeat', '2', '--delay', '120'] : []), btn]);
  return { ok: true };
}

export async function move(id: string, screen: string | undefined, b: { x: number; y: number }) {
  await xdo(id, screen, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
  return { ok: true };
}

export async function drag(id: string, screen: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) {
  await xdo(id, screen, ['mousemove', String(Math.round(b.start_x)), String(Math.round(b.start_y))]);
  await xdo(id, screen, ['mousedown', '1']);
  await xdo(id, screen, ['mousemove', String(Math.round(b.end_x)), String(Math.round(b.end_y))]);
  await xdo(id, screen, ['mouseup', '1']);
  return { ok: true };
}

export async function type(id: string, screen: string | undefined, text: string) {
  // `type --clearmodifiers --` and a single argv element: xdotool types the
  // literal string, so a semicolon in the text stays a semicolon.
  await xdo(id, screen, ['type', '--delay', '12', '--clearmodifiers', '--', text], 60_000);
  return { ok: true };
}

export async function key(id: string, screen: string | undefined, keys: string) {
  // "ctrl+shift+t" is xdotool's own chord syntax.
  await xdo(id, screen, ['key', '--clearmodifiers', keys]);
  return { ok: true };
}

export async function scroll(id: string, screen: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) {
  const button = b.direction === 'up' ? '4' : '5';
  await xdo(id, screen, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
  const times = Math.min(Math.max(Math.round(b.amount || 3), 1), 50);
  await xdo(id, screen, ['click', '--repeat', String(times), '--delay', '40', button]);
  return { ok: true };
}

// ---------- exec ----------

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
    ['exec', '-e', `DISPLAY=${display}`, '-w', env.desktop.mode === 'docker' ? '/home/bot' : '/root', assertName(id), 'sh', '-lc', command],
    { timeoutMs },
  );
  return { success: r.code === 0, output: r.stdout + (r.stderr ? `\n${r.stderr}` : ''), exit_code: r.code };
}

// ---------- files ----------

/** Read a file out of the box as bytes (Library download). */
export async function readFile(id: string, path: string): Promise<Buffer> {
  ensureMode();
  if (!path.startsWith('/')) throw new Error('absolute path required');
  const r = await dockerBuffer(['exec', assertName(id), 'cat', path], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`read ${path} failed: ${r.stderr.slice(0, 200)}`);
  return r.stdout;
}

/**
 * The Orgo API returned a signed URL. There is no object store here, so the
 * caller reads the bytes instead. Kept so routes-config.ts has one shape.
 */
export async function exportFile(id: string, path: string): Promise<{ url?: undefined; bytes: Buffer }> {
  return { bytes: await readFile(id, path) };
}

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
