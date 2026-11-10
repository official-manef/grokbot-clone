import { execFile } from 'node:child_process';

/**
 * Minimal Docker driver over argv arrays.
 *
 * No shell is ever involved: every call is `execFile('docker', [...])`, so a
 * container name or a bot id cannot become a command. The values that reach
 * here are still validated by desktop.ts, because defence in depth is cheap and
 * a 40-character bot id inside a `--label` is exactly where a mistake hides.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const DOCKER = process.env.DOCKER_BIN?.trim() || 'docker';
const TIMEOUT_MS = Number(process.env.DOCKER_TIMEOUT_MS ?? 300_000);

export function docker(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      DOCKER,
      args,
      { timeout: opts.timeoutMs ?? TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: Buffer.from(stdout as unknown as Buffer).toString('utf8'),
          stderr: Buffer.from(stderr as unknown as Buffer).toString('utf8') + (e && (e as any).killed ? '\n[timed out]' : ''),
        });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Same driver, but stdout stays binary (screenshots). */
export function dockerBuffer(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      DOCKER,
      args,
      { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: Buffer.from(stdout as unknown as Buffer),
          stderr: Buffer.from(stderr as unknown as Buffer).toString('utf8'),
        });
      },
    );
  });
}

export async function dockerOk(args: string[], opts?: { timeoutMs?: number; input?: string }): Promise<string> {
  const r = await docker(args, opts);
  if (r.code !== 0) throw new DockerError(args, r);
  return r.stdout;
}

export class DockerError extends Error {
  constructor(readonly args: string[], readonly result: RunResult) {
    super(`docker ${args[0]}: ${(result.stderr || result.stdout || '').trim().slice(0, 400) || `exit ${result.code}`}`);
    this.name = 'DockerError';
  }
}

/** True when the daemon answers. A missing daemon is a capability gap, not a crash. */
export async function daemonAvailable(): Promise<boolean> {
  const r = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 });
  return r.code === 0;
}

/** Containers this app owns. The label is the whole inventory contract. */
export async function listOwned(label = 'grokbot.desktop=1'): Promise<DockerContainer[]> {
  const out = await dockerOk(['ps', '-a', '--filter', `label=${label}`, '--format', '{{json .}}']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const j = JSON.parse(line);
      return {
        id: String(j.ID),
        name: String(j.Names ?? j.Name ?? ''),
        image: String(j.Image ?? ''),
        state: String(j.State ?? ''),
        status: String(j.Status ?? ''),
        ports: String(j.Ports ?? ''),
        createdAt: String(j.CreatedAt ?? ''),
      };
    });
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
}

export async function inspect(name: string): Promise<any | null> {
  const r = await docker(['inspect', name], { timeoutMs: 30_000 });
  if (r.code !== 0) {
    if (/no such (object|container)/i.test(r.stderr)) return null;
    throw new DockerError(['inspect', name], r);
  }
  const arr = JSON.parse(r.stdout);
  return Array.isArray(arr) ? arr[0] : arr;
}

export async function exists(name: string): Promise<boolean> {
  return (await inspect(name)) !== null;
}
