import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { utimesSync } from 'node:fs';
import { newerThanDist } from '../../scripts/dist-freshness.mjs';

/**
 * The gate these tests drive refuses to run the mobile suites against a stale
 * `web/dist`. Its first version watched only `web/src`, so editing `web/index.html` —
 * where the `viewport` meta lives, the one thing those suites read — kept the gate
 * green and let them prove the *old* bundle. Each case below builds a real tree and
 * asks the gate a question, rather than restating the input list.
 */

const OLD = 1_700_000_000;
const NEW = OLD + 60;

function tree({ dist = OLD, ...mtimes }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-freshness-'));
  const write = (rel, at) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
    utimesSync(abs, at, at);
  };
  write('web/dist/index.html', dist);
  for (const [rel, at] of Object.entries(mtimes)) write(rel, at);
  return root;
}

test('a source file newer than the build is stale', () => {
  const root = tree({ 'web/src/App.tsx': NEW });
  assert.deepEqual(newerThanDist(root), ['web/src/App.tsx']);
});

test('web/index.html is a build input: it carries the viewport meta', () => {
  const root = tree({ 'web/index.html': NEW });
  assert.deepEqual(newerThanDist(root), ['web/index.html']);
});

test('web/public and vite.config.ts are build inputs too', () => {
  const root = tree({ 'web/public/favicon.svg': NEW, 'web/vite.config.ts': NEW });
  assert.deepEqual(newerThanDist(root).sort(), ['web/public/favicon.svg', 'web/vite.config.ts']);
});

test('a tree older than the build is not stale', () => {
  const root = tree({ dist: NEW, 'web/src/App.tsx': OLD, 'web/index.html': OLD });
  assert.deepEqual(newerThanDist(root), []);
});

test('server/src is not an input: the web bundle imports it as types only', () => {
  const root = tree({ 'server/src/types.ts': NEW });
  assert.deepEqual(newerThanDist(root), []);
});
