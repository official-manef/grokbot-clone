/**
 * Which HTTP surfaces belong to label staff.
 *
 * The app serves two audiences now (see lib/email-allowlist.ts). Fans sign in and
 * get a chat Bot; staff get the whole product. This module is the single list of
 * what a fan may not reach, shared by routes.ts and routes-config.ts (they are
 * mounted separately in index.ts).
 *
 *   staff only:  /approvals, /apps (marketplace, connections and the OAuth callback
 *                it needs), /policies, /memories, /routines, /tasks, /computer*,
 *                /bots/:id/{routines,tasks,memories,files,screenshot,settings,screen/reset},
 *                /skills*
 *   fans get:    /auth/*, /events, /health, /bots (list, create, patch, delete,
 *                primary, read), the whole conversation (/bots/:id/rows, messages,
 *                interrupt, fresh, cards), /rooms, /checkins and /voice
 *
 * Why: a fan's Bot is a chat agent with model + memory + its own conversation.
 * Approvals exist only to authorise host/app actions fans cannot take; policies
 * are staff tooling; routines and tasks are unattended work; the computer,
 * screenshot, files and screen reset reach the host desktop that production runs
 * as MSO; skills are author-supplied staff instructions; connected apps are the
 * staff marketplace; the settings bundle is those same staff things (skills,
 * routines, tasks, memory maintenance) in one payload. The memories *routes* are
 * staff-only; a fan's Bot still keeps its own memories through remember/recall.
 */

const STAFF_ONLY_PREFIXES = ['/apps', '/approvals', '/policies', '/computer'];
const STAFF_ONLY_EXACT = new Set(['/tasks']);
const STAFF_ONLY_SEGMENT = /\/(routines|tasks|memories|files|screenshot|skills|settings)(\/|$)/;
const STAFF_ONLY_SCREEN_RESET = /\/screen\/reset(\/|$)/;

export function isStaffOnlyPath(path: string): boolean {
  const p = path.replace(/^\/api/, '');
  if (STAFF_ONLY_EXACT.has(p)) return true;
  if (STAFF_ONLY_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) return true;
  if (p.startsWith('/routines/') || p.startsWith('/memories/') || p.startsWith('/skills/')) return true;
  return STAFF_ONLY_SEGMENT.test(p) || STAFF_ONLY_SCREEN_RESET.test(p);
}

/** 403 for a fan on a staff surface: names no staff data and no internals. */
export function staffOnlyRefusal(c: any) {
  return c.json({ error: 'This area is for label staff accounts. You are signed in, but this is not available to fan accounts.' }, 403);
}
