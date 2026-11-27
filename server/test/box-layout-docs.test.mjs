import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bot-desktop boundary is described in three places, and one of them drifted:
 * AGENTS.md claimed `server/src/box/adapters/` held a `mso.ts` and an `orgo.ts`, and
 * that `desktop.ts` wraps "the chosen adapter". Only `docker.ts` lives there; the
 * other two backends are `server/src/mso.ts` and `server/src/orgo.ts`, dispatched by
 * `box.ts`.
 *
 * This test reads the filesystem and `box.ts`'s imports, so it fails when the doc
 * stops matching the code instead of restating the doc.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('the adapters directory holds exactly the one adapter the docs name', () => {
  const dir = path.join(root, 'server/src/box/adapters');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
  assert.deepEqual(files, ['docker.ts']);

  const agents = read('AGENTS.md');
  assert.match(agents, /adapters\/docker\.ts/, 'AGENTS.md must name the one adapter');
  assert.doesNotMatch(agents, /adapters\/(mso|orgo)\.ts/, 'no such adapter files exist');
});

test('box.ts dispatches to mso and orgo from server/src, not from adapters/', () => {
  const box = read('server/src/box.ts');
  assert.match(box, /from '\.\/mso\.js'/);
  assert.match(box, /from '\.\/orgo\.js'/);
  assert.doesNotMatch(box, /from '\.\/box\/adapters\/(mso|orgo)/);

  // ...and those modules are really there, so the import is not decorative.
  assert.ok(fs.existsSync(path.join(root, 'server/src/mso.ts')));
  assert.ok(fs.existsSync(path.join(root, 'server/src/orgo.ts')));
});

test('desktop.ts is wiring over adapters/docker.ts, not its own implementation', () => {
  const desktop = read('server/src/desktop.ts');
  assert.match(desktop, /from '\.\/box\/adapters\/docker\.js'/);

  // The mechanics must not be duplicated: the adapter owns container construction.
  const adapter = read('server/src/box/adapters/docker.ts');
  assert.match(adapter, /createDockerBoxRuntime/);
  assert.match(desktop, /\bcreateDockerBoxRuntime\b/);
});

test('the handoff does not try to record its own HEAD', () => {
  // A file cannot contain the SHA of the commit that contains it: committing the SHA
  // makes it its own parent, so the value is stale the instant it lands. That column
  // was wrong in every commit that had it, and four PRs each re-moved the one number.
  const doc = read('docs/CONTINUE.md');
  const start = doc.indexOf('## Where the repos stand');
  assert.ok(start >= 0, 'CONTINUE.md must still have a repo-status section');

  // Scope to that section: SHAs quoted in prose are fine, a status table is not.
  // Both `## ` and `### ` end it — the deployments table below is a separate claim.
  const ends = [doc.indexOf('\n## ', start + 1), doc.indexOf('\n### ', start + 1)].filter((i) => i !== -1);
  const section = doc.slice(start, ends.length ? Math.min(...ends) : undefined);

  const rows = section.split('\n').filter((l) => l.trim().startsWith('|'));
  assert.ok(rows.length >= 3, 'expected a markdown table with a header and rows');

  const header = rows[0];
  assert.doesNotMatch(header, /\bHEAD\b/i, 'the repo table must not carry a HEAD column');
  assert.doesNotMatch(header, /vs remote/i, 'or a drift column that only a SHA can fill');

  for (const row of rows.slice(2)) {
    assert.doesNotMatch(
      row,
      /`[0-9a-f]{7,40}`/,
      `repo row records a commit SHA, which cannot be correct: ${row}`,
    );
  }
});
