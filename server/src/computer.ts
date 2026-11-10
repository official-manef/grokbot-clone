import { db, now } from './db.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { orgo, OrgoError } from './orgo.js';
import { box, boxGrokbot, mode as desktopMode } from './box.js';
import { getLive } from './store.js';
import type { ComputerState } from './types.js';

/**
 * One Orgo Linux computer per user (the "box"). Every bot gets its own Orgo screen
 * (separate X server) on that box, up to Orgo's 4-screen limit; past that, screens
 * are leased least-recently-used.
 */

const MAX_SCREENS = 4;
const inflight = new Map<string, Promise<string>>();

function rowFor(userId: string) {
  let r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId) as any;
  if (!r) {
    db.prepare("INSERT INTO computers(user_id,status,updated_at) VALUES (?, 'absent', ?)").run(userId, now());
    r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId);
  }
  return r;
}

function setStatus(userId: string, status: ComputerState['status'], extra: { orgoId?: string; error?: string | null } = {}) {
  db.prepare('UPDATE computers SET status=?, orgo_id=COALESCE(?, orgo_id), error=?, updated_at=? WHERE user_id=?').run(status, extra.orgoId ?? null, extra.error ?? null, now(), userId);
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
}

export function computerState(userId: string): ComputerState {
  const r = rowFor(userId);
  const screens = (db.prepare('SELECT bot_id, screen_id FROM screens WHERE user_id=?').all(userId) as any[]).map((s) => ({ botId: s.bot_id, screenId: s.screen_id }));
  return { status: r.status, orgoId: r.orgo_id, error: r.error, screens };
}

let workspaceId = env.orgoWorkspaceId;
async function ensureWorkspace(): Promise<string> {
  // Only the Orgo backend has a workspace concept. Both local backends must return
  // BEFORE the Orgo API is called: a missing branch here means every local box
  // creation fails with "Bot desktop is not configured", which looks like the desktop
  // itself is broken.
  const mode = desktopMode();
  if (mode === 'docker' || mode === 'mso') return mode;
  if (workspaceId) return workspaceId;
  const ws = await orgo.workspaces();
  const list = Array.isArray(ws) ? ws : ws.workspaces ?? ws.projects ?? [];
  if (!list.length) throw new Error('No Orgo workspace available for this key');
  workspaceId = list[0].id;
  (env as any).orgoWorkspaceId = workspaceId;
  return workspaceId;
}

function mapStatus(s: string): ComputerState['status'] {
  // Docker reports created/exited/paused/restarting; map both vocabularies.
  if (s === 'running') return 'running';
  if (s === 'creating' || s === 'created') return 'creating';
  if (s === 'suspended' || s === 'exited' || s === 'paused' || s === 'dead') return 'suspended';
  if (s === 'restarting') return 'resuming';
  if (s === 'suspending') return 'suspending';
  if (s === 'resuming') return 'resuming';
  if (s === 'frozen' || s === 'stopped') return 'stopped';
  if (s === 'error') return 'error';
  return 'starting';
}

/** Make sure the user's box exists and is running. Returns the backend's computer id. */
export function ensureComputer(userId: string): Promise<string> {
  const existing = inflight.get(userId);
  if (existing) return existing;
  const p = (async () => {
    await suspending.get(userId)?.catch(() => {});
    const r = rowFor(userId);
    try {
      if (!r.orgo_id) {
        await ensureWorkspace();
        setStatus(userId, 'creating');
        const user = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as any;
        const name = `grokbot-${(user?.email ?? userId).split('@')[0].replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 30)}-${userId.slice(-6)}`;
        const c = await box.create(userId, name, `grokbot-box-${userId}`);
        setStatus(userId, mapStatus(c.status), { orgoId: c.id });
        await prepareBox(c.id);
        setStatus(userId, 'running', { orgoId: c.id });
        return c.id;
      }
      const c = await box.get(r.orgo_id);
      // Branch on the mapped status, not the backend's own word: Docker says
      // 'exited' where Orgo says 'suspended', and matching on the raw value is
      // how a wake silently fell through to a 240 s timeout.
      const status = mapStatus(c.asleep ? 'suspended' : c.status);
      if (status === 'running') {
        if (r.status !== 'running') setStatus(userId, 'running');
        return c.id;
      }
      if (status === 'suspended' || status === 'suspending') {
        const t0 = Date.now();
        console.log(`[computer] resume user=${userId} computer=${c.id} (was ${c.status}${c.asleep ? ', asleep' : ''})`);
        setStatus(userId, 'resuming');
        // Let an in-flight suspend settle first; resuming mid-suspend can be rejected.
        for (let i = 0; i < 40 && mapStatus((await box.get(c.id)).status) === 'suspending'; i++) await new Promise((res) => setTimeout(res, 3000));
        await box.resume(c.id);
        await waitRunning(c.id);
        console.log(`[computer] resumed user=${userId} in ${Math.round((Date.now() - t0) / 1000)}s`);
      } else if (status === 'stopped' || status === 'error') {
        setStatus(userId, 'starting');
        await box.start(c.id);
        await waitRunning(c.id);
      } else {
        setStatus(userId, status);
        await waitRunning(c.id);
      }
      setStatus(userId, 'running');
      return c.id;
    } catch (e: any) {
      if (e instanceof OrgoError && e.status === 404) {
        // Computer was deleted out from under us: forget it so the next call recreates it.
        db.prepare("UPDATE computers SET orgo_id=NULL, status='absent' WHERE user_id=?").run(userId);
        db.prepare('DELETE FROM screens WHERE user_id=?').run(userId);
      }
      setStatus(userId, 'error', { error: String(e?.message ?? e) });
      throw e;
    } finally {
      inflight.delete(userId);
    }
  })();
  inflight.set(userId, p);
  return p;
}

async function waitRunning(id: string, timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = await box.get(id);
    if (mapStatus(c.status) === 'running') return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Timed out waiting for the computer to start');
}

/** First-boot setup: a profile dir for per-bot Chrome sessions. */
async function prepareBox(id: string) {
  try {
    // Report the browser found, rather than failing: which returns non-zero when none
    // matches, and that must not turn a usable box into a broken one.
    await box.bash(id, undefined, `mkdir -p ${boxGrokbot()}/profiles ${boxGrokbot()}/files && { command -v google-chrome || command -v chromium || command -v chromium-browser || command -v firefox || echo 'no system browser'; }`, 60);
  } catch { /* non-fatal */ }
}

/** Get (or lease) this bot's screen on the box. */
export async function screenFor(userId: string, botId: string): Promise<{ computerId: string; screenId: string }> {
  const computerId = await ensureComputer(userId);
  const mine = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(botId) as any;
  if (mine) {
    try {
      await box.getScreen(computerId, mine.screen_id);
      db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
      return { computerId, screenId: mine.screen_id };
    } catch {
      db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
    }
  }
  // Primary bot uses the box's default screen.
  const bot = db.prepare('SELECT is_primary FROM bots WHERE id=?').get(botId) as any;
  const leased = db.prepare('SELECT bot_id, screen_id, last_used_at FROM screens WHERE user_id=? ORDER BY last_used_at ASC').all(userId) as any[];
  const taken = new Set(leased.map((l) => l.screen_id));
  let screenId: string | null = null;
  if (bot?.is_primary && !taken.has('default')) screenId = 'default';
  if (!screenId) {
    const existing = await box.listScreens(computerId);
    const free = existing.find((s) => !taken.has(s.id) && (s.id !== 'default' || !leased.length));
    if (free) screenId = free.id;
    else if (existing.length < MAX_SCREENS) screenId = (await box.createScreen(computerId)).id;
    else {
      // Evict the least-recently-used idle bot's lease (never one mid-turn), and close its browser
      // so the next bot doesn't inherit another bot's windows. Its Chrome profile stays on disk.
      const victim = leased.find((l) => !getLive(l.bot_id).isRunning && l.screen_id !== 'default') ?? leased.find((l) => l.screen_id !== 'default') ?? leased[0];
      db.prepare('DELETE FROM screens WHERE bot_id=?').run(victim.bot_id);
      screenId = victim.screen_id;
      try { await box.bash(computerId, screenId!, `pkill -f "user-data-dir=${boxGrokbot()}/profiles/${victim.bot_id}" || true`, 20); } catch { /* best effort */ }
    }
  }
  db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at) VALUES (?,?,?,?)').run(botId, userId, screenId, now());
  if (screenId !== 'default') await prepareScreen(computerId, screenId!);
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
  return { computerId, screenId: screenId! };
}

/** Orgo's extra screens start as a bare X display (black); give them the normal desktop and wallpaper. */
async function prepareScreen(computerId: string, screenId: string) {
  try {
    const display = `:${screenId.replace('screen-', '')}`;
    // xfwm4's compositor paints over the root window, so run a desktop (wallpaper) on this display.
    // xfdesktop is single-instance per D-Bus session, hence a private session per screen.
    const pid = `/tmp/grokbot-desktop-${display.slice(1)}.pid`;
    await box.bash(
      computerId,
      screenId,
      `export DISPLAY=${display}; if [ -f ${pid} ] && kill -0 $(cat ${pid}) 2>/dev/null; then echo running; else ` +
        `(setsid nohup dbus-run-session -- xfdesktop --disable-wm-check >/tmp/grokbot-desktop-${display.slice(1)}.log 2>&1 < /dev/null & echo $! > ${pid}); sleep 2; echo started; fi`,
      30,
    );
  } catch { /* cosmetic; ignore */ }
}

const suspending = new Map<string, Promise<void>>();

export function suspendComputer(userId: string, reason = 'manual'): Promise<void> {
  const existing = suspending.get(userId);
  if (existing) return existing;
  const p = (async () => {
    const r = rowFor(userId);
    if (!r.orgo_id) return;
    console.log(`[computer] suspend user=${userId} computer=${r.orgo_id} reason=${reason}`);
    setStatus(userId, 'suspending');
    try {
      await box.suspend(r.orgo_id);
      setStatus(userId, 'suspended');
      console.log(`[computer] suspended user=${userId}`);
    } catch (e: any) {
      console.warn(`[computer] suspend failed user=${userId}: ${e?.message ?? e}`);
      setStatus(userId, 'running', { error: String(e?.message ?? e) });
      throw e;
    }
  })();
  suspending.set(userId, p);
  p.finally(() => suspending.delete(userId)).catch(() => {});
  return p;
}

/** Refresh status from Orgo (cheap; used when the UI opens). */
export async function refreshComputer(userId: string): Promise<ComputerState> {
  const r = rowFor(userId);
  if (r.orgo_id) {
    try {
      const c = await box.get(r.orgo_id);
      const s = mapStatus(c.asleep ? 'suspended' : c.status);
      if (s !== r.status) setStatus(userId, s);
    } catch (e: any) {
      if (e instanceof OrgoError && e.status === 404) {
        db.prepare("UPDATE computers SET orgo_id=NULL, status='absent' WHERE user_id=?").run(userId);
        db.prepare('DELETE FROM screens WHERE user_id=?').run(userId);
      }
    }
  }
  return computerState(userId);
}
