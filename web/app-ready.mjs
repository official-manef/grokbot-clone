/**
 * Wait for the app to be ready, instead of for the network to go quiet.
 *
 * `goto(..., { waitUntil: 'networkidle' })` was a coin flip here. The shell opens a
 * long-lived EventSource on `/api/events` and reconnects on its own with exponential
 * backoff up to 15s (`web/src/lib/events.ts`), so "no request for 500ms" depends on
 * when that socket happened to land. The failure it produced was a 30s `goto`
 * timeout on a healthy loopback server: the suite threw, and every case after it
 * never ran — which reads like a layout regression when it is only a timing one.
 *
 * The app already has a readiness signal of its own: the store renders `.chat` once
 * `checkAuth()` and `loadBots()` resolve, and `.signin` when there is no session.
 * Waiting for that is strictly stronger than waiting for silence — a broken app
 * fails this check instead of passing it — and it cannot hang on a stream.
 */
export async function gotoApp(page, base, { timeout = 30_000 } = {}) {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout });
  await page.locator('.chat, .signin').first().waitFor({ state: 'visible', timeout });
}

/** The same wait, for a reload that keeps the current session. */
export async function reloadApp(page, { timeout = 30_000 } = {}) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout });
  await page.locator('.chat, .signin').first().waitFor({ state: 'visible', timeout });
}
