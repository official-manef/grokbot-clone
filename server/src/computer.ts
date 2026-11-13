import { db, now } from './db.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { orgo, OrgoError, type OrgoScreen } from './orgo.js';
import { cdpPortFor, dressScreen, resetScreen, undressScreen, type DeskBot } from './desk.js';
import { box, boxGrokbot, mode as desktopMode, screenIdFor, screenIndex } from './box.js';
import { getLive } from './store.js';
import type { ComputerState } from './types.js';

/**
 * Where a user's bots work. Two shapes:
 *
 * - Local (`docker`, `mso`): one box per user, created on first use, one screen per bot.
 * - Shared (`orgo`): one computer for the whole team (ORGO_COMPUTER_ID), one screen per
 *   bot. The primary bot's engine already lives on that computer's own desktop, so it
 *   keeps the default screen; every other bot gets a screen of its own, dressed in its
 *   colour (see desk.ts). That machine is somebody's working computer: it is never
 *   created, suspended or deleted from here.
 */

/** Screens per computer, the default one included. Every backend caps at four. */
export const MAX_SCREENS = 4;

export interface BotScreen { computerId: string; screenId: string; width?: number; height?: number }

/** True when each user gets a box of their own instead of a share of one computer. */
const perUserBoxes = () => desktopMode() === 'docker' || desktopMode() === 'mso';

/**
 * Id of the computer this user's bots work on. For a local backend it is that user's own
 * box, so it depends on who is asking; on the shared computer it is ORGO_COMPUTER_ID and
 * is the same for everyone.
 */
function computerId(userId?: string): string {
  if (perUserBoxes()) {
    if (!userId) throw new Error('a user id is required to resolve a per-user box');
    const row = db.prepare('SELECT orgo_id FROM computers WHERE user_id=?').get(userId) as any;
    if (!row?.orgo_id) throw new Error('this user has no box yet; it is created on first use');
    return row.orgo_id;
  }
  if (!env.orgoComputerId) throw new Error('ORGO_COMPUTER_ID is not set, so there is no computer for the bots to use.');
  return env.orgoComputerId;
}

function rowFor(userId: string) {
  let r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId) as any;
  if (!r) {
    db.prepare("INSERT INTO computers(user_id,orgo_id,status,updated_at) VALUES (?, ?, 'starting', ?)").run(userId, env.orgoComputerId || null, now());
    r = db.prepare('SELECT * FROM computers WHERE user_id=?').get(userId);
  }
  return r;
}

function setStatus(userId: string, status: ComputerState['status'], error: string | null = null) {
  const r = rowFor(userId);
  // On a local backend the row already holds this user's own box; never replace
  // it with the shared computer id.
  const id = perUserBoxes() ? r.orgo_id : env.orgoComputerId || null;
  db.prepare('UPDATE computers SET status=?, orgo_id=?, error=?, updated_at=? WHERE user_id=?').run(status, id, error, now(), userId);
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
}

export function computerState(userId: string): ComputerState {
  const r = rowFor(userId);
  const screens = (db.prepare('SELECT bot_id, screen_id, width, height FROM screens WHERE user_id=?').all(userId) as any[]).map((s) => ({
    botId: s.bot_id as string,
    screenId: s.screen_id as string,
    ...(s.width && s.height ? { width: s.width as number, height: s.height as number } : {}),
  }));
  return { status: r.status, orgoId: env.orgoComputerId || r.orgo_id, error: r.error, screens, maxScreens: Math.min(env.maxBots, MAX_SCREENS) };
}

/**
 * Backend status -> the four-ish states the UI knows. Every value a backend can
 * report belongs here: an unknown word used to become `starting`, which then sat
 * in a 240 s wake loop waiting for a container that had already died.
 */
function mapStatus(s: string): ComputerState['status'] {
  if (s === 'running') return 'running';
  if (s === 'creating') return 'creating';
  if (s === 'suspended' || s === 'exited' || s === 'dead' || s === 'paused') return 'suspended';
  if (s === 'suspending') return 'suspending';
  if (s === 'resuming') return 'resuming';
  if (s === 'frozen' || s === 'stopped' || s === 'created' || s === 'restarting' || s === 'removing') return 'stopped';
  if (s === 'error' || s === 'absent') return s === 'absent' ? 'stopped' : 'error';
  return 'starting';
}

async function waitRunning(id: string, timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = await box.computer.get(id);
    const status = mapStatus((c as any).asleep ? 'suspended' : c.status);
    if (status === 'running') return;
    // Nothing is coming. Bail now instead of waiting out the timeout.
    if (status === 'error' || status === 'stopped') throw new Error(`The computer is ${status === 'error' ? 'in an error state' : 'not running'}; it did not start.`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Timed out waiting for the computer to start');
}

let checkedAt = 0;
let inflight: Promise<string> | null = null;

/** Make sure the computer exists and is awake. Returns its id. */
export function ensureComputer(userId: string): Promise<string> {
  if (perUserBoxes()) return ensureUserBox(userId);
  const id = computerId();
  if (Date.now() - checkedAt < 30_000) return Promise.resolve(id);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const c = await orgo.getComputer(id);
      const status = mapStatus(c.asleep ? 'suspended' : c.status);
      if (status === 'running') {
        if (rowFor(userId).status !== 'running') setStatus(userId, 'running');
      } else if (status === 'suspended' || status === 'suspending') {
        console.log(`[computer] waking ${id} (was ${c.status})`);
        setStatus(userId, 'resuming');
        for (let i = 0; i < 40 && (await orgo.getComputer(id)).status === 'suspending'; i++) await new Promise((res) => setTimeout(res, 3000));
        await orgo.resume(id);
        await waitRunning(id);
        setStatus(userId, 'running');
      } else if (status === 'stopped' || status === 'error') {
        setStatus(userId, 'starting');
        await orgo.start(id);
        await waitRunning(id);
        setStatus(userId, 'running');
      } else {
        setStatus(userId, 'starting');
        await waitRunning(id);
        setStatus(userId, 'running');
      }
      checkedAt = Date.now();
      return id;
    } catch (e: any) {
      const msg = e instanceof OrgoError && e.status === 404 ? 'The computer set in ORGO_COMPUTER_ID was not found with this Orgo key.' : String(e?.message ?? e);
      setStatus(userId, 'error', msg);
      throw new Error(msg);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const boxInflight = new Map<string, Promise<string>>();

/** The user's own box: create it the first time, wake it afterwards. */
function ensureUserBox(userId: string): Promise<string> {
  const running = boxInflight.get(userId);
  if (running) return running;
  const p = (async () => {
    const r = rowFor(userId);
    try {
      if (!r.orgo_id) {
        setStatus(userId, 'creating');
        const user = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as any;
        const name = `grokbot-${(user?.email ?? userId).split('@')[0].replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 30)}-${userId.slice(-6)}`;
        const c = await box.computer.create(userId, name, `grokbot-box-${userId}`);
        db.prepare('UPDATE computers SET orgo_id=? WHERE user_id=?').run(c.id, userId);
        await box.computer.bash(c.id, undefined, `mkdir -p ${boxGrokbot()}/profiles ${boxGrokbot()}/files`, 60).catch(() => null);
        setStatus(userId, 'running');
        return c.id;
      }
      const c = await box.computer.get(r.orgo_id);
      const status = mapStatus(c.status);
      if (status === 'running') {
        if (r.status !== 'running') setStatus(userId, 'running');
        return c.id;
      }
      // A box that was stopped is this backend's suspend: start it again.
      setStatus(userId, 'resuming');
      await box.computer.resume(c.id);
      await waitRunning(c.id);
      setStatus(userId, 'running');
      return c.id;
    } catch (e: any) {
      setStatus(userId, 'error', String(e?.message ?? e));
      throw e;
    } finally {
      boxInflight.delete(userId);
    }
  })();
  boxInflight.set(userId, p);
  return p;
}

function deskBot(botId: string): DeskBot | null {
  const b = db.prepare('SELECT id, name, label, avatar_shape, avatar_color FROM bots WHERE id=?').get(botId) as any;
  return b ? { id: b.id, name: b.name, label: b.label ?? '', avatarShape: b.avatar_shape, avatarColor: b.avatar_color } : null;
}

const isPrimaryEngine = (botId: string) => (db.prepare('SELECT engine FROM bots WHERE id=?').get(botId) as any)?.engine === 'primary';

const managesChrome = (botId: string) => !(isPrimaryEngine(botId) && env.primaryCdpUrl);

const verified = new Map<string, number>();
const leasing = new Map<string, Promise<BotScreen>>();
const dressing = new Map<string, Promise<void>>();

function saveSize(botId: string, s: OrgoScreen | undefined) {
  if (s?.width && s?.height) db.prepare('UPDATE screens SET width=?, height=? WHERE bot_id=?').run(s.width, s.height, botId);
}

/** This bot's screen on its computer; leases one the first time. */
export function screenFor(userId: string, botId: string): Promise<BotScreen> {
  const running = leasing.get(botId);
  if (running) return running;
  const p = lease(userId, botId).finally(() => leasing.delete(botId));
  leasing.set(botId, p);
  return p;
}

async function lease(userId: string, botId: string): Promise<BotScreen> {
  const id = await ensureComputer(userId);
  if (perUserBoxes()) return leaseBoxScreen(userId, botId, id);
  const mine = db.prepare('SELECT screen_id, width, height FROM screens WHERE bot_id=?').get(botId) as any;
  if (mine) {
    const fresh = Date.now() - (verified.get(botId) ?? 0) < 120_000;
    if (fresh || mine.screen_id === 'default') {
      db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
      return { computerId: id, screenId: mine.screen_id, width: mine.width ?? undefined, height: mine.height ?? undefined };
    }
    try {
      const s = await orgo.getScreen(id, mine.screen_id);
      verified.set(botId, Date.now());
      saveSize(botId, s);
      db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
      return { computerId: id, screenId: mine.screen_id, width: s?.width ?? mine.width ?? undefined, height: s?.height ?? mine.height ?? undefined };
    } catch {
      // The screen is gone (the computer restarted): lease again below.
      db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
      dressing.delete(botId);
    }
  }

  // Screens are per user: another account's screens on the same computer are not ours to take.
  const taken = new Set((db.prepare('SELECT screen_id FROM screens WHERE user_id=?').all(userId) as any[]).map((r) => r.screen_id as string));
  const existing = await orgo.listScreens(id);
  let screen: OrgoScreen | undefined;
  if (isPrimaryEngine(botId)) {
    screen = existing.find((s) => s.id === 'default' || s.default) ?? ({ id: 'default', display: ':99', width: 0, height: 0, default: true } as OrgoScreen);
    screen = { ...screen, id: 'default' };
  } else {
    screen = existing.find((s) => s.id !== 'default' && !s.default && !taken.has(s.id));
    if (!screen) {
      if (existing.length >= MAX_SCREENS) throw new Error(`Every screen on the computer is in use (${MAX_SCREENS} at most). Remove a bot to free one.`);
      screen = await orgo.createScreen(id);
    }
  }
  db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at,width,height) VALUES (?,?,?,?,?,?)').run(botId, userId, screen.id, now(), screen.width || null, screen.height || null);
  verified.set(botId, Date.now());
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
  return { computerId: id, screenId: screen.id, width: screen.width || undefined, height: screen.height || undefined };
}

/**
 * Pick this bot's display on a local box. Docker's container is created with every
 * display already running, and mso creates a display lazily, so nothing is provisioned
 * here: the primary engine keeps index 0 (:99) and every other bot takes the lowest free
 * index.
 */
function leaseBoxScreen(userId: string, botId: string, computer: string): BotScreen {
  const mine = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(botId) as any;
  if (mine) {
    db.prepare('UPDATE screens SET last_used_at=? WHERE bot_id=?').run(now(), botId);
    return { computerId: computer, screenId: mine.screen_id };
  }
  const taken = new Set((db.prepare('SELECT screen_id FROM screens WHERE user_id=?').all(userId) as any[]).map((r) => r.screen_id as string));
  const primary = isPrimaryEngine(botId);
  let index = primary && !taken.has(screenIdFor(0)) ? 0 : -1;
  if (index < 0) {
    for (let i = 0; i < MAX_SCREENS; i++) {
      if (!taken.has(screenIdFor(i))) { index = i; break; }
    }
  }
  if (index < 0) throw new Error(`Every display on the box is in use (${MAX_SCREENS} at most). Remove a bot to free one.`);
  const screenId = screenIdFor(index);
  db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at) VALUES (?,?,?,?)').run(botId, userId, screenId, now());
  hub.emit(userId, { type: 'computer', state: computerState(userId) });
  return { computerId: computer, screenId };
}

/**
 * The bot's screen, dressed as its own computer (wallpaper, dock, its Chrome on its home
 * screen). Dressing happens once per server run per bot, and again when `redress` is set
 * (rename, new colour).
 */
export async function readyScreen(userId: string, botId: string, opts: { redress?: boolean } = {}): Promise<BotScreen> {
  const s = await screenFor(userId, botId);
  // Docker's image starts its own window manager and wallpaper per display; mso's
  // displays are host Xvfb, so only a shared Orgo computer needs dressing.
  if (perUserBoxes()) return s;
  if (opts.redress) dressing.delete(botId);
  let d = dressing.get(botId);
  if (!d) {
    const bot = deskBot(botId);
    d = bot
      ? dressScreen(bot, s.screenId, { manageChrome: managesChrome(botId) }).catch((e) => {
          console.warn(`[computer] could not dress ${s.screenId} for ${botId}: ${e?.message ?? e}`);
          dressing.delete(botId);
        })
      : Promise.resolve();
    dressing.set(botId, d);
  }
  await d;
  return s;
}

/** DevTools address of the Chrome on this bot's screen (for Hermes' browser tools). */
export function cdpUrlFor(botId: string, screenId: string): string {
  if (isPrimaryEngine(botId) && env.primaryCdpUrl) return env.primaryCdpUrl;
  return `http://127.0.0.1:${cdpPortFor(screenId)}`;
}

/**
 * Called before a bot starts working: its screen is leased and dressed, and the browser we
 * run for it answers. Without this a bot's first turn finds no browser and goes off to
 * start one of its own.
 */
export async function screenForWork(userId: string, botId: string): Promise<void> {
  if (!env.orgoComputerId && !perUserBoxes()) return;
  if (!managesChrome(botId)) {
    // It brings its own browser, so nothing it needs depends on the dressing: don't make it wait.
    void readyScreen(userId, botId).catch((e) => console.warn(`[computer] screen not ready for ${botId}: ${e?.message ?? e}`));
    return;
  }
  const s = await readyScreen(userId, botId);
  if (!env.localBox) return;
  const alive = await fetch(`${cdpUrlFor(botId, s.screenId)}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  if (!alive) await readyScreen(userId, botId, { redress: true });
}

/** Close everything on the bot's screen and bring its browser back to the home screen. Logins stay. */
export async function resetBotScreen(userId: string, botId: string): Promise<void> {
  const s = await screenFor(userId, botId);
  if (perUserBoxes()) {
    // A Docker display is a bare X server: start this bot's Chrome again from a
    // clean profile session. Its files and logins on disk survive.
    const profile = `${boxGrokbot()}/profiles/${botId}`;
    await box.computer
      .bash(s.computerId, s.screenId, `pkill -f "user-data-dir=${profile}" || true; rm -f ${profile}/Singleton*; echo ok`, 30)
      .catch(() => null);
    await box.computer.type(s.computerId, s.screenId, '').catch(() => null);
    return;
  }
  const bot = deskBot(botId);
  if (bot) await resetScreen(bot, s.screenId, { manageChrome: managesChrome(botId) });
}

/** The bot is gone: stop what we ran on its screen and free the screen for the next bot. */
export async function releaseScreen(botId: string): Promise<void> {
  const mine = db.prepare('SELECT screen_id, user_id FROM screens WHERE bot_id=?').get(botId) as any;
  if (!mine) return;
  db.prepare('DELETE FROM screens WHERE bot_id=?').run(botId);
  dressing.delete(botId);
  verified.delete(botId);
  if (mine.screen_id !== 'default' && !perUserBoxes()) {
    try { await undressScreen(botId, mine.screen_id); } catch (e: any) { console.warn(`[computer] undress failed: ${e?.message ?? e}`); }
  }
  hub.emit(mine.user_id, { type: 'computer', state: computerState(mine.user_id) });
}

/** A deleted bot leaves nothing behind on its computer: its browser profile and its Library folder go. */
export async function forgetBotFiles(botId: string): Promise<void> {
  if (!/^bot_[\w-]+$/.test(botId)) return;
  const root = boxGrokbot();
  await box.computer
    .bash(computerId((db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as any)?.user_id), undefined,
      `rm -rf -- ${root}/profiles/${botId} ${root}/files/${botId}`, 60)
    .catch(() => null);
}

/** Stop the user's own box. On the shared computer this is a no-op: other things live there. */
export async function suspendComputer(userId: string, _reason = 'manual'): Promise<void> {
  if (!perUserBoxes()) return;
  const r = rowFor(userId);
  if (!r.orgo_id) return;
  setStatus(userId, 'suspending');
  try {
    await box.computer.suspend(r.orgo_id);
    setStatus(userId, 'suspended');
  } catch (e: any) {
    setStatus(userId, 'error', String(e?.message ?? e));
  }
}

/** Refresh status and screen sizes from the backend (cheap; used when the UI opens). */
export async function refreshComputer(userId: string): Promise<ComputerState> {
  // On a local backend the box is this user's own, so ask the backend instead of the
  // shared-computer id (which is legitimately empty in that mode).
  if (perUserBoxes()) {
    const r = rowFor(userId);
    if (!r.orgo_id) return computerState(userId);
    try {
      const c = await box.computer.get(r.orgo_id);
      const s = mapStatus(c.status);
      if (s !== r.status || r.error) setStatus(userId, s);
    } catch (e: any) {
      setStatus(userId, 'error', String(e?.message ?? e));
    }
    return computerState(userId);
  }
  if (!env.orgoComputerId) {
    setStatus(userId, 'error', 'ORGO_COMPUTER_ID is not set.');
    return computerState(userId);
  }
  try {
    const c = await orgo.getComputer(env.orgoComputerId);
    const s = mapStatus(c.asleep ? 'suspended' : c.status);
    const r = rowFor(userId);
    if (s !== r.status || r.error) setStatus(userId, s);
    if (s === 'running') {
      const screens = await orgo.listScreens(env.orgoComputerId);
      const byId = new Map(screens.map((x) => [x.default ? 'default' : x.id, x]));
      for (const row of db.prepare('SELECT bot_id, screen_id FROM screens WHERE user_id=?').all(userId) as any[]) saveSize(row.bot_id, byId.get(row.screen_id));
    }
  } catch (e: any) {
    setStatus(userId, 'error', e instanceof OrgoError && e.status === 404 ? 'The computer was not found with this Orgo key.' : String(e?.message ?? e));
  }
  return computerState(userId);
}
