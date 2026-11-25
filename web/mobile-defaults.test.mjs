/**
 * Desktop layout must not change, and a stored preference must still win on a phone.
 *
 * Three questions, in order:
 *   1. A clean desktop visit still opens the sidebar and the details panel — the old
 *      behaviour, unchanged. (The narrow fix must not leak upward.)
 *   2. A phone whose stored preference says "sidebar open, details open" still obeys
 *      it. The new default must not override a choice a person made.
 *   3. Both of those choices survive a reload.
 *
 *   PREVIEW=http://127.0.0.1:5199 node web/mobile-defaults.test.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.PREVIEW ?? 'http://127.0.0.1:5199';
const EMAIL = process.env.PREVIEW_EMAIL ?? 'artist@antinrml.com';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const browser = await chromium.launch();

async function signInOnce() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const status = await page.evaluate(async (email) => {
    const r = await fetch('/api/auth/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return r.status;
  }, EMAIL);
  const cookies = await ctx.cookies();
  await ctx.close();
  return { status, cookies };
}

const session = await signInOnce();
check('dev sign-in reaches a session', session.status === 200, `status ${session.status}`);
if (session.status !== 200) { await browser.close(); process.exit(1); }

/** What the app decided to show, read from the DOM rather than from the store. */
const panels = (page) => page.evaluate(() => {
  const sb = document.querySelector('.sidebar');
  const det = document.querySelector('.details');
  const pill = document.querySelector('.chat__pill');
  let blocked = false;
  if (pill) {
    const b = pill.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    blocked = !!(hit && sb && sb.contains(hit)) || !!(hit && det && det.contains(hit));
  }
  return {
    sidebarPresent: !!sb,
    sidebarCollapsed: sb?.classList.contains('is-collapsed') ?? null,
    detailsPresent: !!det,
    pillBlocked: blocked,
    stored: { sidebar: localStorage.getItem('grokbot.sidebarCollapsed'), details: localStorage.getItem('grokbot.detailsOpen') },
  };
});

// ---------- 1. clean desktop: unchanged ----------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const s = await panels(page);
  check('desktop: clean visit boots with no stored preference', s.stored.sidebar === null && s.stored.details === null, JSON.stringify(s.stored));
  check('desktop: sidebar is expanded as before', s.sidebarPresent && s.sidebarCollapsed === false, `collapsed=${s.sidebarCollapsed}`);
  check('desktop: details is open as before', s.detailsPresent, `present=${s.detailsPresent}`);
  check('desktop: the pill is not covered', !s.pillBlocked);

  // Chat geometry must be the pre-existing desktop layout, not the narrow one.
  const geo = await page.evaluate(() => {
    const c = document.querySelector('.chat')?.getBoundingClientRect();
    return c ? { l: Math.round(c.left), w: Math.round(c.width), minW: getComputedStyle(document.querySelector('.chat')).minWidth } : null;
  });
  check('desktop: chat keeps its 424px minimum', geo?.minW === '424px', JSON.stringify(geo));
  await page.screenshot({ path: '/tmp/opencode/preview/defaults-desktop.png' });
  await context.close();
}

// ---------- 2. desktop preference still persists ----------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  const s = await panels(page);
  check('desktop: a collapsed sidebar survives a reload', s.sidebarCollapsed === true, `collapsed=${s.sidebarCollapsed}`);
  await context.close();
}

// ---------- 3. a phone honours a stored "open" preference ----------
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await context.addCookies(session.cookies);
  await context.addInitScript(() => {
    localStorage.setItem('grokbot.sidebarCollapsed', '0');
    localStorage.setItem('grokbot.detailsOpen', '1');
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const s = await panels(page);
  check('phone: a stored "sidebar open" preference is obeyed', s.sidebarCollapsed === false, `collapsed=${s.sidebarCollapsed}`);
  check('phone: a stored "details open" preference is obeyed', s.detailsPresent, `present=${s.detailsPresent}`);
  check('phone: stored choices are not overwritten on boot', s.stored.sidebar === '0' && s.stored.details === '1', JSON.stringify(s.stored));
  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
process.exit(failed.length ? 1 : 0);
