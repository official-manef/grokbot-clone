/**
 * Clean-start mobile reachability: can a first-time visitor reach the rename action
 * without dismissing overlays?
 *
 * "Clean storage" is the point of this file. Every context is brand new, so there is
 * no `grokbot.*` key in localStorage — the app boots exactly as it does for somebody
 * who has never opened it. A test that presets `sidebarCollapsed=1` measures a state
 * a real first visit never has, which is how the two-dismissal problem survived the
 * previous round of QA.
 *
 * Read-only against the loopback fixture. It renames and then restores the original
 * title, so it can be run repeatedly against the same database.
 *
 *   PREVIEW=http://127.0.0.1:5199 node web/mobile-clean-start.mjs
 *   PREVIEW=http://127.0.0.1:5199 QA_EXPECT=red node web/mobile-clean-start.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.PREVIEW ?? 'http://127.0.0.1:5199';
const EMAIL = process.env.PREVIEW_EMAIL ?? 'artist@antinrml.com';
const EXPECT = process.env.QA_EXPECT === 'red' ? 'red' : 'green';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const browser = await chromium.launch();

/** Sign in once; every viewport reuses the cookie. Dev login is capped at 10/5min. */
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
if (session.status !== 200) {
  await browser.close();
  process.exit(1);
}

/** Every overlay currently covering the centre of the header, by accessible name. */
const overlaysAtPill = (page) => page.evaluate(() => {
  const pill = document.querySelector('.chat__pill');
  if (!pill) return ['no pill'];
  const b = pill.getBoundingClientRect();
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  if (!hit || pill.contains(hit)) return [];
  const owners = [];
  const details = document.querySelector('.details');
  const sidebar = document.querySelector('.sidebar');
  if (details && details.contains(hit)) owners.push('details');
  if (sidebar && sidebar.contains(hit)) owners.push('sidebar');
  return owners.length ? owners : [`other:${hit.className}`];
});

async function cleanStart(width, label) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

  // Prove the storage really is clean; otherwise this whole file tests nothing new.
  const storage = await page.evaluate(() => ({
    sidebar: localStorage.getItem('grokbot.sidebarCollapsed'),
    details: localStorage.getItem('grokbot.detailsOpen'),
  }));
  check(`[${label}] boots with no stored layout preference`, storage.sidebar === null && storage.details === null, JSON.stringify(storage));

  // The whole question: is the pill pressable straight away?
  const blocking = await overlaysAtPill(page);
  check(`[${label}] chat header is reachable on first visit (no dismissal)`, blocking.length === 0, blocking.join(',') || 'clear');

  // The primary action must work without touching anything else first. A short
  // action timeout turns "blocked by an overlay" into a recorded observation instead
  // of a 30-second Playwright retry loop.
  let menuOpened = false;
  try {
    await page.locator('.chat__pill').tap({ timeout: 4_000 });
    menuOpened = await page.locator('.menu').isVisible({ timeout: 3_000 }).catch(() => false);
  } catch (e) {
    const blocked = /intercepts pointer events/.test(String(e));
    menuOpened = false;
    check(`[${label}] the pill tap is not intercepted by an overlay`, !blocked, blocked ? 'intercepted' : String(e).split('\n')[0]);
  }
  check(`[${label}] the chat menu opens without dismissing an overlay`, menuOpened);

  if (!menuOpened) {
    // Record how many dismissals the current build actually needs, so a red run is
    // informative rather than just "failed".
    let dismissals = 0;
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    if (await collapse.isVisible().catch(() => false)) { await collapse.tap(); dismissals += 1; await page.waitForTimeout(350); }
    const closeDetails = page.getByRole('button', { name: 'Close details' });
    if (await closeDetails.isVisible().catch(() => false)) { await closeDetails.tap(); dismissals += 1; await page.waitForTimeout(350); }
    console.log(`  [${label}] had to dismiss ${dismissals} overlay(s) first`);
    await page.screenshot({ path: `/tmp/opencode/preview/clean-${width}-blocked.png` });
    await context.close();
    return;
  }

  await page.getByText('Conversation history', { exact: true }).first().tap();
  await page.locator('.menu__item--row').first().waitFor({ timeout: 15_000 });
  const geo = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { vw: innerWidth, sw: document.documentElement.scrollWidth, row: r('.menu__item--row'), pencil: r('.menu__rename') };
  });
  const on = (b) => b && b.l >= 0 && b.r <= geo.vw;
  check(`[${label}] history row is on screen`, on(geo.row), JSON.stringify(geo.row));
  check(`[${label}] pencil is on screen and >=24x24`, on(geo.pencil) && geo.pencil.w >= 24 && geo.pencil.h >= 24, JSON.stringify(geo.pencil));
  check(`[${label}] no horizontal overflow`, geo.sw <= geo.vw, `${geo.sw}/${geo.vw}`);

  // Touch: tap the pencil, save, confirm, then restore.
  const original = (await page.locator('.menu__item-title').first().innerText()).trim();
  const box = await page.locator('.menu__rename').first().boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  const opened = await page.locator('.menu__rename-input').isVisible({ timeout: 3_000 }).catch(() => false);
  check(`[${label}] touch tap opens the editor`, opened);
  if (opened) {
    await page.keyboard.type('clean start');
    await page.locator('.menu__rename-input').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
    check(`[${label}] touch save persists`, (await page.locator('.menu__item-title').first().innerText()).trim() === 'clean start');
    check(`[${label}] focus returns to the pencil`, await page.evaluate(() => document.activeElement?.classList.contains('menu__rename')));

    // Keyboard: F2 from a focused row.
    await page.locator('.menu__item-main').first().focus();
    await page.keyboard.press('F2');
    check(`[${label}] F2 opens the editor`, await page.locator('.menu__rename-input').isVisible({ timeout: 3_000 }).catch(() => false));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });

    // Empty save restores the automatic name.
    await page.locator('.menu__rename').first().tap();
    await page.locator('.menu__rename-input').fill('');
    await page.locator('.menu__rename-input').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
    check(`[${label}] empty save restores the automatic name`, (await page.locator('.menu__item-title').first().innerText()).trim() === original, original);
  }

  check(`[${label}] no console or page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: `/tmp/opencode/preview/clean-${width}.png` });
  await context.close();
}

for (const width of [390, 360]) await cleanStart(width, `mobile-${width}`);

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (expectation: ${EXPECT})`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
console.log('screenshots: /tmp/opencode/preview/clean-390.png, clean-360.png');

// Under QA_EXPECT=red a failure is the expected outcome, so invert the exit code and
// let the caller see red as a pass of the *reproduction*, not of the product.
process.exit(EXPECT === 'red' ? (failed.length ? 0 : 1) : (failed.length ? 1 : 0));
