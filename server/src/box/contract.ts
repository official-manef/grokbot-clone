/**
 * Host-independent port contract for per-bot isolated desktop boxes.
 *
 * Extracted from `desktop.ts` and `vnc.ts` so a host runtime (such as Nakama)
 * can drive per-bot containers, X displays, and VNC relays without pulling in
 * Grokbot's database, environment singleton, or HTTP/WebSocket server wiring.
 *
 * No `process.env`, filesystem, or child-process imports belong in this file.
 */

export const MAX_SCREENS = 4;

/**
 * Configuration values required by the box runtime. Mirrors the four `env.desktop`
 * settings read by `desktop.ts` (`image`, `ramGb`, `cpu`, `resolution`), the
 * daemon socket path (`socketPath`), and `maxScreens` (`MAX_SCREENS`).
 */
export interface BoxConfig {
  image: string;
  ramGb: number;
  cpu: number;
  resolution: string;
  socketPath: string;
  maxScreens?: number;
}

/** Result returned by an injected command runner. */
export interface BoxRunResult {
  code: number;
  stdout: string | Uint8Array;
  stderr: string;
}

/**
 * Injected command runner. Always receives an explicit command name and an
 * argv array so no shell interpolation occurs at the boundary.
 */
export type BoxRunner = (
  command: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<BoxRunResult>;

export interface DesktopComputer {
  id: string;
  name: string;
  status: string;
  resolution?: string;
  vnc_password?: string | null;
  asleep?: null;
}

export interface DesktopScreen {
  id: string;
  display: string;
  width: number;
  height: number;
  default: boolean;
}

export interface BoxScreenshot {
  image: string;
  mime_type?: string;
  width: number;
  height: number;
}

export interface BoxClickInput {
  x: number;
  y: number;
  button?: string;
  double?: boolean;
}

export interface BoxMoveInput {
  x: number;
  y: number;
}

export interface BoxDragInput {
  start_x: number;
  start_y: number;
  end_x: number;
  end_y: number;
}

export interface BoxScrollInput {
  x: number;
  y: number;
  direction: 'up' | 'down';
  amount: number;
}

export interface BoxBashResult {
  success: boolean;
  output: string;
  exit_code: number;
}

/**
 * Structural WebSocket shape for VNC relaying. Kept dependency-free so this
 * contract never imports `ws`.
 */
export interface BoxRelaySocket {
  readonly readyState?: number;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Uint8Array) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

/** Target screen descriptor for a VNC relay session. */
export interface BoxRelayScreen {
  computerId: string;
  screenId?: string;
  mode?: 'watch' | 'control';
}

/**
 * Complete operations exposed by `desktop.ts` and `vnc.ts`.
 */
export interface BoxRuntime {
  create(userId: string, opts?: { name?: string }): Promise<DesktopComputer>;
  get(id: string): Promise<DesktopComputer>;
  start(id: string): Promise<{ ok: true }>;
  suspend(id: string): Promise<{ ok: true }>;
  stop(id: string): Promise<{ ok: true }>;
  restart(id: string): Promise<{ ok: true }>;
  remove(id: string): Promise<void>;

  listScreens(id: string): Promise<DesktopScreen[]>;
  createScreen(id: string): Promise<DesktopScreen>;
  getScreen(id: string, screen: string): Promise<DesktopScreen>;
  deleteScreen(id: string, screen: string): Promise<void>;

  screenshot(id: string, screen?: string): Promise<BoxScreenshot>;
  click(id: string, screen: string | undefined, b: BoxClickInput): Promise<{ ok: true }>;
  move(id: string, screen: string | undefined, b: BoxMoveInput): Promise<{ ok: true }>;
  drag(id: string, screen: string | undefined, b: BoxDragInput): Promise<{ ok: true }>;
  type(id: string, screen: string | undefined, text: string): Promise<{ ok: true }>;
  key(id: string, screen: string | undefined, keys: string): Promise<{ ok: true }>;
  scroll(id: string, screen: string | undefined, b: BoxScrollInput): Promise<{ ok: true }>;

  bash(id: string, screen: string | undefined, command: string, timeoutSeconds?: number): Promise<BoxBashResult>;
  readFile(id: string, path: string): Promise<Buffer>;
  exportFile(id: string, path: string): Promise<{ url?: undefined; bytes: Buffer }>;

  relay(socket: BoxRelaySocket, screen: string | DesktopScreen | BoxRelayScreen): Promise<void>;
}
