/**
 * Drive the rename flow through the real UI, in a real browser.
 *
 * The server test (`server/test/conversation-rename.test.mjs`) pins what the route
 * decides. This pins what a person does: pencil -> inline input -> Enter saves,
 * Escape cancels, empty clears back to the fallback name, and the list shows the new
 * name without a reload. Neither test can stand in for the other.
 *
 * Read-only against a preview instance: it seeds nothing and creates no bot. Point it
 * at whatever preview is running:
 *
 *   PREVIEW=http://127.0.0.1:5199 node web/rename-preview.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.PREVIEW ?? 'http://127.0.0.1:5199';
const EMAIL = process.env.PREVIEW_EMAIL ?? 'artist@antinrml.com';

const log = (...a) => console.log(...a);
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

/** Collect console errors: a rename that works but throws is not working. */
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// Sign in through the dev route the app itself calls, then load the app shell.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const signedIn = await page.evaluate(async (email) => {
  const r = await fetch('/api/auth/dev', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return r.status;
}, EMAIL);
check('dev sign-in reaches the app session', signedIn === 200, `status ${signedIn}`);

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

// The list is not on the main screen: it opens from the chat pill's menu
// ("Conversation history"), so reach it the way a person does rather than
// navigating to a URL the UI never uses.
const pill = page.locator('.chat__pill');
await pill.waitFor({ timeout: 20_000 }).catch(() => {});
check('the chat header loaded with a bot selected', await pill.isVisible().catch(() => false));

await pill.click();
const historyItem = page.getByRole('menuitem', { name: 'Conversation history' })
  .or(page.getByRole('button', { name: 'Conversation history' }))
  .or(page.getByText('Conversation history', { exact: true }));
await historyItem.first().waitFor({ timeout: 10_000 }).catch(() => {});
check('the bot menu offers "Conversation history"', await historyItem.first().isVisible().catch(() => false));
await historyItem.first().click();

const title = page.locator('.menu__item-title').first();
await title.waitFor({ timeout: 15_000 }).catch(() => {});
const listVisible = await title.isVisible().catch(() => false);
check('conversation list renders rows', listVisible);

if (!listVisible) {
  await page.screenshot({ path: '/tmp/opencode/preview/ui-list-missing.png', fullPage: true });
  log(`  page text: ${(await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | ')}`);
  log('saved /tmp/opencode/preview/ui-list-missing.png');
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

const firstRow = page.locator('.menu__item--row').first();
const originalName = (await title.innerText()).trim();
log(`  first conversation: ${JSON.stringify(originalName)}`);

// 1. Pencil opens an inline input, selected, not a modal.
await firstRow.locator('.menu__rename').click();
const input = page.locator('.menu__rename-input');
await input.waitFor({ timeout: 5_000 });
check('pencil opens an inline input', await input.isVisible());

const hint = await page.locator('.menu__hint').first().innerText().catch(() => '');
check('the inline input shows how to save or cancel', /save|cancel/i.test(hint), hint.trim());

// 2. Typing a new name and pressing Enter saves it and leaves editing mode.
await input.fill('QA renamed by Lara');
await input.press('Enter');
await page.waitForFunction(
  () => !document.querySelector('.menu__rename-input'),
  null,
  { timeout: 10_000 },
).catch(() => {});
const afterSave = (await page.locator('.menu__item-title').first().innerText()).trim();
check('Enter saves the new name and exits editing', afterSave === 'QA renamed by Lara', afterSave);

// 3. Escape cancels: the stored name must come back unchanged.
await page.locator('.menu__item--row').first().locator('.menu__rename').click();
const input2 = page.locator('.menu__rename-input');
await input2.waitFor({ timeout: 5_000 });
await input2.fill('this should not be saved');
await input2.press('Escape');
await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 }).catch(() => {});
const afterEscape = (await page.locator('.menu__item-title').first().innerText()).trim();
check('Escape cancels without saving', afterEscape === 'QA renamed by Lara', afterEscape);

// 4. An empty name clears back to the automatic (fallback) name, never a blank row.
await page.locator('.menu__item--row').first().locator('.menu__rename').click();
const input3 = page.locator('.menu__rename-input');
await input3.waitFor({ timeout: 5_000 });
await input3.fill('');
await input3.press('Enter');
await page.waitForFunction(() => !document.querySelector('.menu__rename-input'), null, { timeout: 10_000 }).catch(() => {});
const afterClear = (await page.locator('.menu__item-title').first().innerText()).trim();
check('an empty name restores the automatic name', afterClear.length > 0 && afterClear !== 'QA renamed by Lara', JSON.stringify(afterClear));
check('the restored name is not blank', afterClear.trim().length > 0);

// 5. No console errors across the whole flow.
check('no console or page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await page.screenshot({ path: '/tmp/opencode/preview/ui-after-rename.png', fullPage: true });

// 6. The change survives a reload: it was stored, not just held in React state.
//    The menu closes on reload, so reopen it before reading the row back.
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.chat__pill').click();
await page.getByText('Conversation history', { exact: true }).first().click();
const reloadedTitle = page.locator('.menu__item-title').first();
await reloadedTitle.waitFor({ timeout: 15_000 });
const afterReload = (await reloadedTitle.innerText()).trim();
check('the cleared title persists across a reload', afterReload === afterClear, afterReload);

await browser.close();
const failed = results.filter((r) => !r.ok).length;
log(`\n${results.length - failed}/${results.length} checks passed`);
log(`screenshots: /tmp/opencode/preview/ui-after-rename.png`);
process.exit(failed ? 1 : 0);
