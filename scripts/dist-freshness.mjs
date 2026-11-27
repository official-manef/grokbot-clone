/**
 * Is `web/dist` older than anything Vite would have compiled into it?
 *
 * Exists because a stale dist has already been misread once as a layout regression, and
 * the first version of this gate had the opposite failure mode: it watched only
 * `web/src`, so editing `web/index.html` (where the `viewport` meta lives, which the
 * mobile suites read) left the gate green and the suites proved the *old* dist. A
 * false-green is worse than the false-red that started this.
 *
 * Build inputs, and why each one:
 *   web/src          the app
 *   web/index.html   the shell: viewport meta, root node, entry script
 *   web/public       copied verbatim into dist
 *   web/vite.config  target/aliases/plugins
 *
 * Not listed: `server/src`. The web bundle reaches it only through `@shared` **type**
 * imports, which are erased, so a server edit cannot change the JS.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const INPUTS = ['web/src', 'web/index.html', 'web/public', 'web/vite.config.ts'];

/**
 * @param {string} root repo root
 * @param {number} [limit] how many paths to name
 * @returns {string[]} repo-relative build inputs newer than `web/dist/index.html`
 */
export function newerThanDist(root, limit = 5) {
  const dist = path.join(root, 'web/dist/index.html');
  const builtAt = statSync(dist).mtimeMs;
  const newer = [];
  for (const rel of INPUTS) {
    const abs = path.join(root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // an input that does not exist cannot be stale
    }
    const files = st.isDirectory() ? readdirSync(abs, { recursive: true }) : [''];
    for (const f of files) {
      const p = f ? path.join(abs, String(f)) : abs;
      const s = statSync(p);
      if (s.isFile() && s.mtimeMs > builtAt) newer.push(path.relative(root, p));
      if (newer.length >= limit) return newer;
    }
  }
  return newer;
}
