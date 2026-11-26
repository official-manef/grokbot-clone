/**
 * Deliberate open/close of the two phone overlays, by pointer and by keyboard.
 *
 * `mobile-clean-start.mjs` answers "does a first visit land on the chat?". This file
 * answers the next question, which nobody had tested: once the person *chooses* to
 * open the sidebar or details on a phone, can they close it again with Escape, and
 * does focus come back to the control that opened it?
 *
 * Why Escape matters here and not on a desktop: at 390/360px the sidebar is a 350px
 * overlay at z-index 30 and details is a full-width sheet at z-index 20, so both
 * cover the chat. A panel that can only be left by hitting one small button is a trap
 * for a keyboard or screen-reader user; Escape plus focus restoration is the standard
 * way out.
 *
 * Every case gets its own fresh page. A failed check then cannot leave an overlay
 * open and make the next check fail for the wrong reason — with a shared page the
 * first stuck overlay cascades into eight "failures" that are really one.
 *
 * Read-only against the loopback fixture.
 *
 *   PREVIEW=http://127.0.0.1:5199 node web/mobile-overlays.test.mjs
 *   PREVIEW=http://127.0.0.1:5199 QA_EXPECT=red node web/mobile-overlays.test.mjs
 */
import { chromium } from 'playwright';
import { gotoApp } from './app-ready.mjs';

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

/**
 * The layout as the DOM reports it. Reading the rendered result rather than the store
 * is deliberate: a store flag that says "closed" while the sheet is still painted is
 * exactly the kind of bug this file exists to catch.
 */
const snap = (page) => page.evaluate(() => {
  const sb = document.querySelector('.sidebar');
  const det = document.querySelector('.details');
  const owner = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return 'none';
    if (sb && sb.contains(el)) return 'sidebar';
    if (det && det.contains(el)) return 'details';
    return 'chat';
  };
  const ae = document.activeElement;
  return {
    collapsed: sb ? sb.classList.contains('is-collapsed') : null,
    details: !!det,
    topCentre: owner(innerWidth / 2, innerHeight / 2),
    focus: ae && ae !== document.body
      ? (ae.getAttribute('aria-label') || ae.textContent?.trim().slice(0, 20) || ae.tagName.toLowerCase())
      : 'body',
    scrollW: document.documentElement.scrollWidth,
    vw: innerWidth,
  };
});

/**
 * Click with a short timeout. A panel stuck over the chat makes Playwright wait 30s
 * per click and then throw, which hides every check after the first failure. This
 * turns "blocked by an overlay" into a recorded observation plus a normal FAIL.
 */
const press = async (page, selector) => {
  try {
    await page.locator(selector).click({ timeout: 4_000 });
    return 'ok';
  } catch (e) {
    return /intercepts pointer events/.test(String(e)) ? 'intercepted' : String(e).split('\n')[0];
  }
};

/** Would a tap at the control's centre reach the control, or is an overlay on top? */
const pressable = (page, selector) => page.evaluate((sel) => {
  const b = document.querySelector(sel);
  if (!b) return 'missing';
  const r = b.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (el === b || b.contains(el)) return 'pressable';
  return `covered by ${el?.className || el?.tagName}`;
}, selector);

// ---------- 0. a session is genuinely required (no session leak into auth) ----------
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await gotoApp(page, BASE);
  const anon = await page.evaluate(async () => {
    const bots = await fetch('/api/bots').then((r) => r.status).catch(() => 'error');
    const rows = await fetch('/api/bots/qa-bot/rows').then((r) => r.status).catch(() => 'error');
    return { bots, rows, hasComposer: !!document.querySelector('.composer') };
  });
  check('no session: /api/bots refuses', anon.bots === 401, `status ${anon.bots}`);
  check('no session: /api/bots/:id/rows refuses', anon.rows === 401, `status ${anon.rows}`);
  check('no session: the chat shell is not rendered', anon.hasComposer === false);
  await ctx.close();
} catch (e) {
  check('no session: the anonymous shell loaded', false, String(e).split('\n')[0]);
}

const session = await signInOnce();
check('dev sign-in reaches a session', session.status === 200, `status ${session.status}`);
if (session.status !== 200) { await browser.close(); process.exit(1); }

/** A brand-new phone page in its own context, so no case can contaminate another. */
async function fresh(width, errors) {
  const context = await browser.newContext({
    viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoApp(page, BASE);
  return { context, page };
}

async function runPhone(width, label) {
  const errors = [];

  // ---------- initial state ----------
  {
    const { context, page } = await fresh(width, errors);
    const s = await snap(page);
    check(`[${label}] starts with the sidebar collapsed and details closed`, s.collapsed === true && s.details === false, `collapsed=${s.collapsed} details=${s.details}`);
    check(`[${label}] no horizontal overflow on arrival`, s.scrollW <= s.vw, `${s.scrollW}/${s.vw}`);
    await context.close();
  }

  // ---------- 1a. sidebar: open by its own control, then close by its own control ----------
  {
    const { context, page } = await fresh(width, errors);
    check(`[${label}] "Expand sidebar" is pressable`, (await pressable(page, '[aria-label="Expand sidebar"]')) === 'pressable');
    check(`[${label}] "Expand sidebar" is clickable`, (await press(page, '[aria-label="Expand sidebar"]')) === 'ok');
    await page.waitForTimeout(300);
    const open = await snap(page);
    check(`[${label}] sidebar opens over the chat`, open.collapsed === false && open.topCentre === 'sidebar', `collapsed=${open.collapsed} top=${open.topCentre}`);
    check(`[${label}] "Collapse sidebar" is pressable`, (await pressable(page, '[aria-label="Collapse sidebar"]')) === 'pressable');
    check(`[${label}] "Collapse sidebar" is clickable`, (await press(page, '[aria-label="Collapse sidebar"]')) === 'ok');
    await page.waitForTimeout(300);
    const shut = await snap(page);
    check(`[${label}] sidebar closes again`, shut.collapsed === true && shut.topCentre === 'chat', `collapsed=${shut.collapsed} top=${shut.topCentre}`);
    await context.close();
  }

  // ---------- 1b. details: open with "Show details", close with "Close details" ----------
  {
    const { context, page } = await fresh(width, errors);
    check(`[${label}] "Show details" is pressable`, (await pressable(page, '[aria-label="Show details"]')) === 'pressable');
    check(`[${label}] "Show details" is clickable`, (await press(page, '[aria-label="Show details"]')) === 'ok');
    await page.waitForTimeout(300);
    const open = await snap(page);
    check(`[${label}] details opens over the chat`, open.details === true && open.topCentre === 'details', `details=${open.details} top=${open.topCentre}`);
    check(`[${label}] "Close details" is pressable`, (await pressable(page, '[aria-label="Close details"]')) === 'pressable');
    check(`[${label}] "Close details" is clickable`, (await press(page, '[aria-label="Close details"]')) === 'ok');
    await page.waitForTimeout(300);
    const shut = await snap(page);
    check(`[${label}] details closes again`, shut.details === false && shut.topCentre === 'chat', `details=${shut.details} top=${shut.topCentre}`);
    // The close button unmounts with the panel; focus must not be dropped on <body>.
    check(`[${label}] closing details by its button returns focus to "Show details"`, shut.focus === 'Show details', `focus=${shut.focus}`);
    await context.close();
  }

  // ---------- 2a. Escape closes the sidebar ----------
  {
    const { context, page } = await fresh(width, errors);
    await press(page, '[aria-label="Expand sidebar"]');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const s = await snap(page);
    check(`[${label}] Escape closes the sidebar`, s.collapsed === true && s.topCentre === 'chat', `collapsed=${s.collapsed} top=${s.topCentre}`);
    check(`[${label}] Escape on the sidebar returns focus to "Expand sidebar"`, s.focus === 'Expand sidebar', `focus=${s.focus}`);
    await context.close();
  }

  // ---------- 2b. Escape closes details ----------
  {
    const { context, page } = await fresh(width, errors);
    await press(page, '[aria-label="Show details"]');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const s = await snap(page);
    check(`[${label}] Escape closes details`, s.details === false && s.topCentre === 'chat', `details=${s.details} top=${s.topCentre}`);
    check(`[${label}] Escape on details returns focus to "Show details"`, s.focus === 'Show details', `focus=${s.focus}`);
    await context.close();
  }

  // ---------- 2c. both open: Escape closes the one on top, unambiguously ----------
  // Opening the second panel by tapping is impossible while the first covers the chat,
  // so this uses the app's own shortcuts (⌘B / ⇧⌘,). Sidebar z-index 30 > details 20,
  // so the sidebar is the overlay on top.
  {
    const { context, page } = await fresh(width, errors);
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(250);
    await page.keyboard.press('Control+Shift+,');
    await page.waitForTimeout(250);
    const both = await snap(page);
    check(`[${label}] both overlays can be open at once`, both.collapsed === false && both.details === true, `collapsed=${both.collapsed} details=${both.details}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const after1 = await snap(page);
    check(`[${label}] first Escape closes the top overlay (sidebar) and leaves details open`, after1.collapsed === true && after1.details === true, `collapsed=${after1.collapsed} details=${after1.details} top=${after1.topCentre}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const after2 = await snap(page);
    check(`[${label}] second Escape then closes details`, after2.collapsed === true && after2.details === false, `collapsed=${after2.collapsed} details=${after2.details}`);
    check(`[${label}] after both are closed the chat is on top`, after2.topCentre === 'chat', `top=${after2.topCentre}`);
    await page.screenshot({ path: `/tmp/opencode/preview/overlays-${width}.png` });
    await context.close();
  }

  // ---------- 3. Escape with nothing open must stay in the composer ----------
  // The new key handler must not steal Escape from the thing a person is typing into:
  // a composer that blurs on Escape is a new bug in exchange for the old one.
  {
    const { context, page } = await fresh(width, errors);
    await page.locator('.composer__input').click();
    await page.keyboard.type('draft survives');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const s = await snap(page);
    const draft = await page.locator('.composer__input').inputValue();
    check(`[${label}] Escape with nothing open keeps focus in the composer`, s.focus.startsWith('Message') || s.focus === 'draft survives', `focus=${s.focus}`);
    check(`[${label}] Escape with nothing open leaves the draft alone`, draft === 'draft survives', `draft=${JSON.stringify(draft)}`);
    await context.close();
  }

  check(`[${label}] no console or page errors across all cases`, errors.length === 0, errors.slice(0, 2).join(' | '));
}
// A navigation that throws must cost this viewport its cases, not the whole run.
// Before this guard, one `goto` timeout printed a stack trace and skipped the other
// 53 checks, which reads like a layout regression instead of one slow page load.
for (const [width, label] of [[390, 'mobile-390'], [360, 'mobile-360']]) {
  try {
    await runPhone(width, label);
  } catch (e) {
    check(`[${label}] the phone suite ran to the end`, false, String(e).split('\n')[0]);
  }
}

// ---------- 4. desktop must not gain an Escape-to-collapse ----------
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  await gotoApp(page, BASE);
  const before = await snap(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const after = await snap(page);
  check('desktop: both panels still open on a clean visit', before.collapsed === false && before.details === true, `collapsed=${before.collapsed} details=${before.details}`);
  check('desktop: Escape leaves the inline panels alone', after.collapsed === false && after.details === true, `collapsed=${after.collapsed} details=${after.details}`);
  await context.close();
} catch (e) {
  check('desktop: the regression check ran to the end', false, String(e).split('\n')[0]);
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (expectation: ${EXPECT})`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
console.log('screenshot: /tmp/opencode/preview/overlays-390.png, overlays-360.png');

// Under QA_EXPECT=red a failure is the expected outcome, so invert the exit code.
process.exit(EXPECT === 'red' ? (failed.length ? 0 : 1) : (failed.length ? 1 : 0));
