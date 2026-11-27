/**
 * A fresh database has to be usable by `store.ts` without a helper called first.
 *
 * The bug this guards: `kind`, `members`, `parent_bot_id` and `hidden` were added by
 * `initRooms()` / `initSubagents()` at boot, while `listBots`, `prompt.ts` and
 * `engine.ts` read them. Anything that loaded the store without going through
 * `index.ts` therefore threw `no such column: hidden` on a new database, and four
 * probe files each carried a hand-written call to the two initializers so they would
 * not notice. `_tools-probe.mjs` did not, and only worked because its caller had
 * already created the columns.
 *
 * This drives the real store against a real empty SQLite file, in its own process
 * because `db.ts` opens the file once at import.
 *
 *   node --test server/test/schema-fresh-db.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Run `body` after importing db.ts and store.ts against a brand-new database. */
function inFreshDb(body) {
  const dbPath = path.join(os.tmpdir(), `grokbot-schema-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const script = `
    const { db } = await import(${JSON.stringify(path.join(here, '../src/db.ts'))});
    const { listBots } = await import(${JSON.stringify(path.join(here, '../src/store.ts'))});
    const out = await (async () => { ${body} })();
    db.close();
    console.log('@@SCHEMA@@' + JSON.stringify(out));
  `;
  const env = { ...process.env, DB_PATH: dbPath };
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, timeout: 60_000 },
      (err, stdout, stderr) => {
        fs.rmSync(dbPath, { force: true });
        fs.rmSync(`${dbPath}-wal`, { force: true });
        fs.rmSync(`${dbPath}-shm`, { force: true });
        if (err && !stdout.includes('@@SCHEMA@@')) {
          return reject(new Error(`${err.killed ? 'killed at timeout' : err.message}\n${stdout.slice(0, 400)}\n${stderr}`));
        }
        const line = stdout.split('\n').find((l) => l.startsWith('@@SCHEMA@@'));
        if (!line) return reject(new Error(`no probe output: ${stdout.slice(0, 400)}\n${stderr}`));
        resolve(JSON.parse(line.slice('@@SCHEMA@@'.length)));
      });
  });
}

test('the room and subagent columns exist on a database created from scratch', async () => {
  const cols = await inFreshDb(`
    return db.prepare("SELECT name FROM pragma_table_info('bots')").all().map((r) => r.name);
  `);
  for (const col of ['kind', 'members', 'parent_bot_id', 'hidden']) {
    assert.ok(cols.includes(col), `bots.${col} missing from a fresh schema: ${cols.join(',')}`);
  }
});

test('listBots runs against a fresh database, with no initializer called first', async () => {
  // The failing call in the original bug: `COALESCE(hidden,0)=0`.
  const out = await inFreshDb(`
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1','u@example.com','Sam',Date.now());
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('b1','u1','Doug',Date.now(),Date.now());
    return { bots: listBots('u1').map((b) => b.name) };
  `);
  assert.deepEqual(out.bots, ['Doug']);
});

test('a hidden child bot is not listed, which is what the column is for', async () => {
  const out = await inFreshDb(`
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1','u@example.com','Sam',Date.now());
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('b1','u1','Doug',Date.now(),Date.now());
    db.prepare('INSERT INTO bots(id,user_id,name,hidden,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('b2','u1','sub',1,Date.now(),Date.now());
    return { bots: listBots('u1').map((b) => b.name) };
  `);
  assert.deepEqual(out.bots, ['Doug']);
});
