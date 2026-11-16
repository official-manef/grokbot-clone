import {
  MAX_SCREENS,
  type BoxBashResult,
  type BoxClickInput,
  type BoxConfig,
  type BoxDragInput,
  type BoxMoveInput,
  type BoxRelayScreen,
  type BoxRelaySocket,
  type BoxRunResult,
  type BoxRunner,
  type BoxRuntime,
  type BoxScreenshot,
  type BoxScrollInput,
  type DesktopComputer,
  type DesktopScreen,
} from '../contract.js';

/**
 * Docker adapter for `BoxRuntime` backed solely by an injected `run` function.
 * Keeps process, filesystem, environment, and daemon socket I/O out of this
 * module so any host (such as Nakama) can supply its own process runner while
 * reusing the exact container hardening flags and input-sanitization rules.
 */

export const LABEL = 'grokbot.desktop=1';
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
export const SCREEN_RE = /^screen-(\d)$/;

const DEFAULT_CONFIG: BoxConfig = {
  image: 'grokbot-desktop:latest',
  ramGb: 8,
  cpu: 2,
  resolution: '1280x800x24',
  socketPath: '/var/run/docker.sock',
  maxScreens: MAX_SCREENS,
};

export function assertName(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid container name: ${name}`);
  return name;
}

export function containerNameFor(userId: string): string {
  assertName(userId);
  return assertName(`grokbot-${userId.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`);
}

export function networkFor(container: string): string {
  return `${assertName(container)}-net`;
}

export const displayFor = (index: number): string => (index === 0 ? ':99' : `:${index}`);
export const vncPortFor = (index: number): number => 6080 + index;
export const screenIdFor = (index: number): string => (index === 0 ? 'default' : `screen-${index}`);

/** Strict screen parser: rejects non-digit single characters and unknown ids. */
export function parseScreenIndex(screenId: string | undefined): number {
  if (!screenId || screenId === 'default') return 0;
  const m = SCREEN_RE.exec(screenId);
  if (!m) throw new Error(`invalid screen id: ${screenId}`);
  return Number(m[1]);
}

/** Orgo-compatible screen index resolver used by display commands. */
export function screenIndex(screenId: string | undefined): number {
  if (!screenId || screenId === 'default') return 0;
  const m = SCREEN_RE.exec(screenId);
  return m ? Number(m[1]) : 0;
}

export class DockerBoxError extends Error {
  constructor(readonly args: readonly string[], readonly result: BoxRunResult) {
    const out = typeof result.stdout === 'string' ? result.stdout : Buffer.from(result.stdout).toString('utf8');
    super(`docker ${args[0]}: ${(result.stderr || out || '').trim().slice(0, 400) || `exit ${result.code}`}`);
    this.name = 'DockerBoxError';
  }
}

const asText = (out: string | Uint8Array): string =>
  typeof out === 'string' ? out : Buffer.from(out).toString('utf8');

const asBuffer = (out: string | Uint8Array): Buffer =>
  typeof out === 'string' ? Buffer.from(out, 'utf8') : Buffer.from(out);

export interface DockerBoxRuntime extends BoxRuntime {
  createComputer(userId: string, opts?: { name?: string }): Promise<DesktopComputer>;
  getComputer(id: string): Promise<DesktopComputer>;
  removeComputer(id: string): Promise<void>;
}

export function createDockerBoxRuntime(
  runOrConfig: BoxRunner | Partial<BoxConfig>,
  maybeConfigOrRun?: Partial<BoxConfig> | BoxRunner,
): DockerBoxRuntime {
  const run: BoxRunner = typeof runOrConfig === 'function' ? runOrConfig : (maybeConfigOrRun as BoxRunner);
  const rawCfg = (typeof runOrConfig === 'function' ? maybeConfigOrRun : runOrConfig) as Partial<BoxConfig> | undefined;
  const cfg: BoxConfig = { ...DEFAULT_CONFIG, ...rawCfg };
  const maxScreens = cfg.maxScreens ?? MAX_SCREENS;

  const execDocker = (args: readonly string[], timeoutMs?: number) => run('docker', args, timeoutMs);
  const dockerOk = async (args: readonly string[], timeoutMs?: number): Promise<string> => {
    const r = await execDocker(args, timeoutMs);
    if (r.code !== 0) throw new DockerBoxError(args, r);
    return asText(r.stdout);
  };

  const inspect = async (name: string): Promise<any | null> => {
    const r = await execDocker(['inspect', assertName(name)], 30_000);
    if (r.code !== 0) {
      if (/no such (object|container)/i.test(r.stderr)) return null;
      throw new DockerBoxError(['inspect', name], r);
    }
    try {
      const arr = JSON.parse(asText(r.stdout));
      return Array.isArray(arr) ? arr[0] : arr;
    } catch { return null; }
  };

  const ensureNetwork = async (network: string): Promise<void> => {
    const r = await execDocker(['network', 'create', '--opt', 'com.docker.network.bridge.enable_icc=false', network], 30_000);
    if (r.code !== 0 && !/already exists/.test(r.stderr)) {
      throw new Error(`could not create network ${network}: ${r.stderr.slice(0, 200)}`);
    }
  };

  const xdo = async (id: string, screen: string | undefined, args: string[], timeoutMs = 20_000): Promise<string> => {
    const out = await dockerOk(['exec', '-e', `DISPLAY=${displayFor(screenIndex(screen))}`, assertName(id), 'xdotool', ...args], timeoutMs);
    return out.trim();
  };

  const create = async (userId: string, opts: { name?: string } = {}): Promise<DesktopComputer> => {
    // `opts.name ?` would treat '' as "not given" and silently fall back to a
    // generated name. An explicitly empty name is a bug at the call site, so it is
    // validated and rejected like any other hostile string.
    const name = opts.name !== undefined ? assertName(opts.name) : containerNameFor(userId);
    const net = networkFor(name);
    await ensureNetwork(net);
    const args = [
      'run', '-d', '--name', name,
      '--label', LABEL, '--label', `grokbot.user=${userId.slice(0, 40)}`,
      '--memory', `${cfg.ramGb}g`, '--memory-swap', `${cfg.ramGb}g`,
      '--cpus', String(cfg.cpu), '--pids-limit', '2048', '--shm-size', '512m',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--network', net,
      '-e', `GROKBOT_SCREENS=${maxScreens}`, '-e', `GROKBOT_RESOLUTION=${cfg.resolution}`,
      cfg.image,
    ];
    try {
      await dockerOk(args, 300_000);
    } catch (e) {
      if (e instanceof DockerBoxError && /already in use/.test(e.result.stderr)) {
        await dockerOk(['start', name]).catch(() => {});
      } else throw e;
    }
    const info = await inspect(name);
    return { id: name, name, status: String(info?.State?.Status ?? 'running'), resolution: cfg.resolution, vnc_password: null, asleep: null };
  };

  const get = async (id: string): Promise<DesktopComputer> => {
    const info = await inspect(assertName(id));
    if (!info) {
      const err = new Error(`No such container: ${id}`);
      (err as any).status = 404;
      throw err;
    }
    return {
      id,
      name: String(info.Name ?? id).replace(/^\//, ''),
      status: String(info.State?.Status ?? 'unknown'),
      resolution: cfg.resolution,
      vnc_password: null,
      asleep: null,
    };
  };

  const start = async (id: string): Promise<{ ok: true }> => { await dockerOk(['start', assertName(id)]); return { ok: true }; };
  const stop = async (id: string): Promise<{ ok: true }> => { await dockerOk(['stop', '-t', '10', assertName(id)], 60_000); return { ok: true }; };
  const restart = async (id: string): Promise<{ ok: true }> => { await dockerOk(['restart', '-t', '10', assertName(id)], 60_000); return { ok: true }; };
  const remove = async (id: string): Promise<void> => {
    const name = assertName(id);
    await execDocker(['rm', '-f', name], 60_000);
    await execDocker(['network', 'rm', networkFor(name)], 30_000).catch(() => null);
  };

  const listScreens = async (_id: string): Promise<DesktopScreen[]> => {
    const [w, h] = cfg.resolution.split('x').map(Number);
    return Array.from({ length: maxScreens }, (_, i) => ({
      id: screenIdFor(i), display: displayFor(i), width: w || 1280, height: h || 800, default: i === 0,
    }));
  };

  const createScreen = async (_id: string): Promise<DesktopScreen> => ({
    id: screenIdFor(1), display: displayFor(1), width: 1280, height: 800, default: false,
  });

  const deleteScreen = async (_id: string, _screen: string): Promise<void> => {};
  const getScreen = async (id: string, screen: string): Promise<DesktopScreen> => {
    const found = (await listScreens(id)).find((s) => s.id === screen);
    if (!found) throw new Error(`No such screen: ${screen}`);
    return found;
  };

  const screenshot = async (id: string, screen?: string): Promise<BoxScreenshot> => {
    const r = await execDocker(['exec', assertName(id), 'grokbot-shot', displayFor(screenIndex(screen))], 30_000);
    const buf = asBuffer(r.stdout);
    if (r.code !== 0 || !buf.length) throw new Error(`screenshot failed: ${(r.stderr || 'empty image').slice(0, 200)}`);
    const [w, h] = cfg.resolution.split('x').map(Number);
    return { image: buf.toString('base64'), mime_type: 'image/png', width: w || 1280, height: h || 800 };
  };

  const click = async (id: string, screen: string | undefined, b: BoxClickInput): Promise<{ ok: true }> => {
    const btn = b.button === 'right' ? '3' : b.button === 'middle' ? '2' : '1';
    await xdo(id, screen, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
    await xdo(id, screen, ['click', ...(b.double ? ['--repeat', '2', '--delay', '120'] : []), btn]);
    return { ok: true };
  };

  const move = async (id: string, screen: string | undefined, b: BoxMoveInput): Promise<{ ok: true }> => {
    await xdo(id, screen, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
    return { ok: true };
  };

  const drag = async (id: string, screen: string | undefined, b: BoxDragInput): Promise<{ ok: true }> => {
    await xdo(id, screen, ['mousemove', String(Math.round(b.start_x)), String(Math.round(b.start_y))]);
    await xdo(id, screen, ['mousedown', '1']);
    await xdo(id, screen, ['mousemove', String(Math.round(b.end_x)), String(Math.round(b.end_y))]);
    await xdo(id, screen, ['mouseup', '1']);
    return { ok: true };
  };

  const type = async (id: string, screen: string | undefined, text: string): Promise<{ ok: true }> => {
    await xdo(id, screen, ['type', '--delay', '12', '--clearmodifiers', '--', text], 60_000);
    return { ok: true };
  };

  const key = async (id: string, screen: string | undefined, keys: string): Promise<{ ok: true }> => {
    await xdo(id, screen, ['key', '--clearmodifiers', keys]);
    return { ok: true };
  };

  const scroll = async (id: string, screen: string | undefined, b: BoxScrollInput): Promise<{ ok: true }> => {
    const times = Math.min(Math.max(Math.round(b.amount || 3), 1), 50);
    await xdo(id, screen, ['mousemove', String(Math.round(b.x)), String(Math.round(b.y))]);
    await xdo(id, screen, ['click', '--repeat', String(times), '--delay', '40', b.direction === 'up' ? '4' : '5']);
    return { ok: true };
  };

  const bash = async (id: string, screen: string | undefined, command: string, timeoutSeconds = 120): Promise<BoxBashResult> => {
    const timeoutMs = Math.min(Math.max(timeoutSeconds, 1), 290) * 1000;
    const r = await execDocker(['exec', '-e', `DISPLAY=${displayFor(screenIndex(screen))}`, '-w', '/home/bot', assertName(id), 'sh', '-lc', command], timeoutMs);
    return { success: r.code === 0, output: asText(r.stdout) + (r.stderr ? `\n${r.stderr}` : ''), exit_code: r.code };
  };

  const readFile = async (id: string, path: string): Promise<Buffer> => {
    const name = assertName(id);
    if (!path.startsWith('/')) throw new Error('absolute path required');
    const r = await execDocker(['exec', name, 'cat', path], 120_000);
    if (r.code !== 0) throw new Error(`read ${path} failed: ${r.stderr.slice(0, 200)}`);
    return asBuffer(r.stdout);
  };

  const exportFile = async (id: string, path: string): Promise<{ url?: undefined; bytes: Buffer }> => ({
    bytes: await readFile(id, path),
  });

  const relay = async (socket: BoxRelaySocket, _screen: string | DesktopScreen | BoxRelayScreen): Promise<void> => {
    socket.close(1011, 'VNC relay requires a bidirectional WebSocket/TCP stream transport, not a CLI runner');
    throw new Error('relay cannot be expressed through a CLI command runner');
  };

  return {
    create, createComputer: create, get, getComputer: get,
    start, suspend: stop, stop, restart, remove, removeComputer: remove,
    listScreens, createScreen, getScreen, deleteScreen,
    screenshot, click, move, drag, type, key, scroll,
    bash, readFile, exportFile, relay,
  };
}
