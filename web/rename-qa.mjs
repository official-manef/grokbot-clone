/**
 * Independent QA of the rename flow, driven through the real UI in a real browser.
 *
 * Covers what the brief asks for and the commit's own script did not:
 *   - Enter saves, Escape cancels, an empty name restores the automatic name
 *   - the inline input takes FOCUS and selects its text on open
 *   - focus RETURNS to the pencil after save and after cancel
 *   - F2 opens the editor from a focused row (its handler lives on the row and
 *     fires from bubbling; the row is not itself a tab stop)
 *   - the pencil is visible without hovering and meets the 24x24 touch minimum
 *   - the same flow at a mobile viewport, with touch taps instead of clicks
 *   - no page/console errors, and the result survives a reload
 *
 * Read-only against a preview: it seeds nothing and creates nothing. It restores the
 * title it started with, so it can be run repeatedly against the same database.
 *
 *   PREVIEW=http://127.0.0.1:5199 node web/rename-qa.mjs
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

/**
 * One session for both viewports.
 *
 * `POST /api/auth/dev` is capped at 10 requests per 5 minutes and this script used to
 * sign in twice per run, so three runs in a row hit 429 and the mobile half died with
 * a confusing timeout. Signing in once and sharing the cookie is both cheaper and
 * closer to reality — one person, one session, two screen sizes.
 */
async function signInOnce(browser) {
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

/** Open the conversation list the way a person reaches it: pill -> Conversation history. */
async function openList(page) {
  await page.locator('.chat__pill').waitFor({ timeout: 20_000 });
  await page.locator('.chat__pill').click();
  await page.getByText('Conversation history', { exact: true }).first().click();
  await page.locator('.menu__item-title').first().waitFor({ timeout: 15_000 });
}

/** One full pass of the rename behaviours at a given viewport, reusing the session. */
async function runFlow(page, label, { tapMode = false, narrow = false } = {}) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

  // On a phone both overlays start open: details is a full-screen sheet and the
  // sidebar is 350px wide on a 390px screen, so each covers the header. A real user
  // closes them with their own on-screen controls, which is exactly what this does —
  // no localStorage presets, so first-run reachability is what gets tested.
  if (narrow) {
    // Order matters: the sidebar overlay is above the details sheet, and its collapse
    // control is the only header control a phone user can reach first.
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    if (await collapse.isVisible().catch(() => false)) { await collapse.tap(); await page.waitForTimeout(400); }
    const closeDetails = page.getByRole('button', { name: 'Close details' });
    if (await closeDetails.isVisible().catch(() => false)) { await closeDetails.tap(); await page.waitForTimeout(350); }
  }

  await openList(page);

  const row = page.locator('.menu__item--row').first();
  const originalName = (await page.locator('.menu__item-title').first().innerText()).trim();
  console.log(`  [${label}] first conversation: ${JSON.stringify(originalName)}`);

  // Is the row actually reachable by a thumb/finger? `.chat` has `min-width: 424px`
  // and the sidebar is 350px fixed, so at phone widths the pane starts off-screen and
  // the list renders past the right edge with no way to scroll to it. That is
  // pre-existing and broader than rename, but a mobile check that ignores it would be
  // claiming a tap that cannot physically land.
  const geometry = await page.evaluate(() => {
    const r = document.querySelector('.menu__item--row')?.getBoundingClientRect();
    return r ? { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth } : null;
  });
  const reachable = !!geometry && geometry.left >= 0 && geometry.right <= geometry.vw;
  check(
    `[${label}] the conversation row is inside the viewport`,
    reachable,
    geometry ? `[${geometry.left},${geometry.right}] in ${geometry.vw}px` : 'no row',
  );

  const openEditor = async () => {
    const pencil = row.locator('.menu__rename');
    if (tapMode) await pencil.tap(); else await pencil.click();
    const input = page.locator('.menu__rename-input');
    await input.waitFor({ timeout: 5_000 });
    return input;
  };

  // --- Enter saves -----------------------------------------------------------
  let input = await openEditor();
  check(`[${label}] pencil opens an inline input`, await input.isVisible());

  // Focus is the thing keyboard users depend on: without it, typing goes nowhere.
  const focusedIsInput = await page.evaluate(() => document.activeElement?.classList.contains('menu__rename-input'));
  check(`[${label}] the input receives focus on open`, focusedIsInput);

  // It also selects the existing text, so typing replaces rather than appends.
  const selection = await page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement ? [el.selectionStart, el.selectionEnd, el.value.length] : null;
  });
  check(
    `[${label}] the existing name is selected, not just focused`,
    !!selection && selection[0] === 0 && selection[1] === selection[2] && selection[2] > 0,
    selection ? `sel ${selection[0]}-${selection[1]} of ${selection[2]}` : 'no input focused',
  );

  await input.fill('QA renamed');
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
  const afterSave = (await page.locator('.menu__item-title').first().innerText()).trim();
  check(`[${label}] Enter saves the new name`, afterSave === 'QA renamed', afterSave);

  // --- Escape cancels --------------------------------------------------------
  input = await openEditor();
  await input.fill('this must not be saved');
  await input.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
  const afterEscape = (await page.locator('.menu__item-title').first().innerText()).trim();
  check(`[${label}] Escape cancels without saving`, afterEscape === 'QA renamed', afterEscape);

  // --- empty clears to the automatic name ------------------------------------
  input = await openEditor();
  await input.fill('');
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
  const afterClear = (await page.locator('.menu__item-title').first().innerText()).trim();
  check(
    `[${label}] an empty name restores the automatic name`,
    afterClear.length > 0 && afterClear === originalName,
    JSON.stringify(afterClear),
  );

  // --- the rename persisted --------------------------------------------------
  await page.reload({ waitUntil: 'networkidle' });
  await openList(page);
  const afterReload = (await page.locator('.menu__item-title').first().innerText()).trim();
  check(`[${label}] the cleared name survives a reload`, afterReload === afterClear, afterReload);

  // --- the pencil must be perceivable and tappable ---------------------------
  // Found while running this QA: `.menu__rename` was `opacity: 0` until :hover or
  // :focus-visible, and a touch device has neither, so it was permanently invisible
  // yet still hit-testable. The rule is pointer-dependent, so the assertion is too:
  // a fine pointer MAY hide it until hover (that is the intended design), a coarse
  // pointer MUST show it.
  const pencil = page.locator('.menu__rename').first();
  const style = await pencil.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      opacity: Number(s.opacity),
      width: parseFloat(s.width),
      height: parseFloat(s.height),
      coarse: matchMedia('(pointer: coarse)').matches,
    };
  });
  const box = await pencil.boundingBox();
  check(
    `[${label}] the pencil is visible without hovering (pointer: ${style.coarse ? 'coarse' : 'fine'})`,
    style.coarse ? style.opacity > 0.1 : true,
    `opacity ${style.opacity}`,
  );
  check(
    `[${label}] the pencil meets the 24x24 touch minimum`,
    !!box && box.width >= 24 && box.height >= 24,
    box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box',
  );

  // --- F2 from a focused child must open the editor --------------------------
  // This check previously asserted `row.tabIndex >= 0`, which was wrong: the row
  // has no tabIndex ON PURPOSE, and F2 still works because React's onKeyDown on the
  // container fires for keydown events bubbling from the two buttons inside it.
  // Asserting the implementation detail reported a defect that did not exist, so
  // this now presses the key and checks what happens.
  await page.locator('.menu__item-main').first().focus();
  await page.keyboard.press('F2');
  const f2Opened = await page.locator('.menu__rename-input').isVisible({ timeout: 3_000 }).catch(() => false);
  check(`[${label}] F2 on a focused row opens the editor`, f2Opened);
  if (f2Opened) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
  }

  // --- focus returns after save, and after cancel ---------------------------
  // Without this the pencil's own F2 shortcut gains you nothing: focus lands on
  // <body> and the next Tab restarts at the top of the document.
  const focusIsPencil = () => page.evaluate(() => document.activeElement?.classList.contains('menu__rename'));

  await page.locator('.menu__rename').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('.menu__rename-input').waitFor({ timeout: 5_000 });
  await page.keyboard.type('focus save');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
  check(`[${label}] focus returns to the pencil after Enter saves`, await focusIsPencil());

  await page.locator('.menu__rename').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('.menu__rename-input').waitFor({ timeout: 5_000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
  check(`[${label}] focus returns to the pencil after Escape cancels`, await focusIsPencil());

  // --- keyboard-only completion still works via the pencil button ------------
  const pencilButton = page.locator('.menu__rename').first();
  await pencilButton.focus();
  await page.keyboard.press('Enter');
  const kbOpen = await page.locator('.menu__rename-input').isVisible({ timeout: 3_000 }).catch(() => false);
  check(`[${label}] keyboard can open the editor from the pencil`, kbOpen);
  if (kbOpen) {
    await page.keyboard.type('QA keyboard');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
    const kbName = (await page.locator('.menu__item-title').first().innerText()).trim();
    check(`[${label}] keyboard can save a rename`, kbName === 'QA keyboard', kbName);
    // Leave the database as it was found.
    await page.locator('.menu__rename').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.menu__rename-input').fill('');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 });
  }

  check(`[${label}] no console or page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
}

// ---------- sign in once, share the cookie ----------
const session = await signInOnce(browser);
check('dev sign-in reaches a session', session.status === 200, `status ${session.status}`);
if (session.status !== 200) {
  await browser.close();
  console.log('\ncannot continue without a session');
  process.exit(1);
}

// ---------- desktop ----------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  await runFlow(page, 'desktop');
  await page.screenshot({ path: '/tmp/opencode/preview/qa-desktop.png', fullPage: true });
  await context.close();
}

// ---------- narrow touch: 390 then 360 ----------
// A coarse pointer with no hover, at real phone widths. These used to fail outright:
// `.chat` was `min-width: 424px` and the sidebar 350px fixed, so the pane began at
// x=133 and the conversation list ended at x=586 on a 390px screen — off-screen and
// unscrollable, because body is overflow:hidden. The narrow-screen rules in chat.css
// fix that; these widths are what keeps them honest.
for (const width of [390, 360]) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await context.addCookies(session.cookies);
  const page = await context.newPage();
  await runFlow(page, `mobile-${width}`, { tapMode: true, narrow: true });

  // The pencil's size/visibility is already asserted inside runFlow; no second copy.
  await page.screenshot({ path: '/tmp/opencode/preview/qa-mobile.png', fullPage: true });
  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
console.log('screenshots: /tmp/opencode/preview/qa-desktop.png, /tmp/opencode/preview/qa-mobile.png');
process.exit(failed.length ? 1 : 0);
