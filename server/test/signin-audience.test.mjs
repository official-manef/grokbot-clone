/**
 * Who a signed-in email is: staff (artist/management) or fan. Fans are allowed in,
 * so the tests here are about classification and about what a fan is *offered*,
 * not about refusal. The boundary bug guarded on both sides:
 *
 *   - `evil-antinrml.com` must classify as a fan, never staff (a lookalike must
 *     not reach the staff surfaces or the host shell);
 *   - a fan's tool list must contain no shell and no computer_* (production runs
 *     COMPUTER_BACKEND=mso, so those tools are a root shell on the live host).
 *
 *   node --test server/test/signin-audience.test.mjs
 *
 * (Imports TypeScript source; Node >=22.18 strips types natively. Older Node:
 *  run with `node --import tsx --test ...`. The tool-list cases spawn a child
 *  process because env.ts resolves once per process, as at boot.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyEmail, isSignableEmail } from '../src/lib/email-allowlist.ts';
import { isStaffOnlyPath } from '../src/lib/staff-gate.ts';

const lists = (over = {}) => ({ allowedEmails: [], allowedEmailDomains: [], staffEmailDomains: ['antinrml.com'], ...over });

// ---------- classification ----------

test('a company address is staff, and staff is split by handle', () => {
  const artist = classifyEmail('riku@antinrml.com', lists());
  assert.equal(artist.audience, 'staff');
  assert.equal(artist.role, 'artist', 'riku is one of the 18 artist handles');

  const management = classifyEmail('ops@antinrml.com', lists());
  assert.equal(management.audience, 'staff');
  assert.equal(management.role, 'management', 'a staff address that is not an artist handle is management');

  const hyphenated = classifyEmail('yung-caters@antinrml.com', lists());
  assert.equal(hyphenated.role, 'artist', 'handles with hyphens are handles too');
});

test('a fan address is a fan, and is not refused', () => {
  const fan = classifyEmail('someone@gmail.com', lists());
  assert.deepEqual(fan, { audience: 'fan', role: null });
  assert.equal(isSignableEmail('someone@gmail.com'), true, 'a fan can sign in: the app is for fans too');
});

test('domain lookalikes and subdomains are fans, never staff', () => {
  for (const address of ['x@evil-antinrml.com', 'x@notantinrml.com', 'x@antinrml.com.evil.com', 'x@mail.antinrml.com', 'x@antinrml.co']) {
    assert.deepEqual(classifyEmail(address, lists()), { audience: 'fan', role: null }, `${address} must not be staff`);
  }
});

test('the domain is taken after the LAST @, so a quoted local part cannot relocate it', () => {
  assert.equal(classifyEmail('"a@antinrml.com"@evil.com', lists()).audience, 'fan');
  assert.equal(classifyEmail('a@evil.com@antinrml.com', lists()).audience, 'staff', 'after the last @ is antinrml.com, and that is what is compared');
});

test('no @ (or nothing around it) is never staff, and is not signable', () => {
  for (const address of ['nobody', 'nobody@', '@antinrml.com', '', '   ']) {
    assert.equal(classifyEmail(address, lists()).audience, 'fan', `${JSON.stringify(address)} is never staff`);
    assert.equal(isSignableEmail(address), false, `${JSON.stringify(address)} is not an address we sign in`);
  }
});

test('case is irrelevant on both sides', () => {
  assert.deepEqual(classifyEmail('Riku@ANTINRML.COM', lists()), { audience: 'staff', role: 'artist' });
  assert.deepEqual(classifyEmail('RIKU@antinrml.com', lists({ staffEmailDomains: ['ANTINRML.COM'] })), { audience: 'staff', role: 'artist' });
  assert.equal(classifyEmail('Riku@Gmail.com', lists()).audience, 'fan');
});

test('the older email/domain lists still only add staff, never subtract', () => {
  assert.deepEqual(classifyEmail('boss@elsewhere.io', lists({ allowedEmails: ['boss@elsewhere.io'] })), { audience: 'staff', role: 'management' });
  assert.equal(classifyEmail('anyone@partner.test', lists({ allowedEmailDomains: ['partner.test'] })).audience, 'staff');
  assert.equal(classifyEmail('boss@elsewhere.io', lists()).audience, 'fan', 'no list entry means fan');
});

test('every artist handle from the Nakama roster is an artist here', () => {
  // The 18 handles, hardcoded in the module because this repo has no roster file.
  const handles = ['808bunny', 'anangga', 'bboogie', 'dia', 'jemsii', 'josua-natanael', 'kirohta', 'mr-trash-dubbing', 'naufal-syachreza', 'naykilla', 'ridotaka', 'riku', 'ryo', 'sonmv', 'suisei', 'tenxi', 'yung-caters', 'moona'];
  for (const handle of handles) assert.equal(classifyEmail(`${handle}@antinrml.com`, lists()).role, 'artist', handle);
  assert.equal(handles.length, 18);
});

// ---------- the staff gate ----------

test('the gate names the staff surfaces and leaves chat alone', () => {
  for (const p of ['/api/apps', '/api/apps/gmail', '/api/approvals/apr_1', '/api/policies', '/api/computer', '/api/computer/ensure', '/api/tasks', '/api/memories/mem_1', '/api/routines/rt_1',
    '/api/bots/bot_1/routines', '/api/bots/bot_1/tasks', '/api/bots/bot_1/memories', '/api/bots/bot_1/files', '/api/bots/bot_1/screenshot', '/api/bots/bot_1/settings', '/api/bots/bot_1/screen/reset', '/api/bots/bot_1/skills', '/api/skills/skl_1']) {
    assert.equal(isStaffOnlyPath(p), true, `${p} must be staff-only`);
  }
  for (const p of ['/api/bots', '/api/bots/bot_1', '/api/bots/bot_1/rows', '/api/bots/bot_1/messages', '/api/bots/bot_1/interrupt', '/api/bots/bot_1/fresh', '/api/bots/bot_1/cards/4/answer', '/api/bots/bot_1/read', '/api/bots/bot_1/primary', '/api/events', '/api/auth/me', '/api/rooms/room_1/members', '/api/checkins', '/api/voice/options']) {
    assert.equal(isStaffOnlyPath(p), false, `${p} is a fan surface`);
  }
});

// ---------- the tool set ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, '_fan-tools-probe.mjs');

function toolNames(audience) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, audience],
      {
        cwd: path.join(here, '..'),
        env: {
          ...process.env,
          SESSION_SECRET: 'test-secret',
          XAI_API_KEY: 'test-key',
          DB_PATH: path.join(os.tmpdir(), `grokbot-audience-${process.pid}-${Math.random().toString(36).slice(2)}.db`),
        },
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stderr}`));
        const line = stdout.split('\n').find((l) => l.startsWith('@@PROBE@@'));
        if (!line) return reject(new Error(`no probe output\n${stdout}\n${stderr}`));
        resolve(JSON.parse(line.slice('@@PROBE@@'.length)));
      },
    );
  });
}

test('a fan is offered no shell, no computer_*, no host browser, no host file write', async () => {
  const { names, shellIsStaffOnly } = await toolNames('fan');
  assert.equal(shellIsStaffOnly, true, 'the refusal predicate must agree with the filter');
  assert.ok(!names.includes('shell'), 'a fan must not reach a root shell on the production host');
  assert.deepEqual(names.filter((n) => n.startsWith('computer_')), [], 'no desktop tools for a fan');
  assert.ok(!names.includes('open_browser'), 'no host browser for a fan');
  assert.ok(!names.includes('save_file'), 'no write into host paths for a fan');
  assert.ok(!names.includes('create_routine') && !names.includes('spawn_subagent'), 'no unattended work for a fan');
  // What a fan keeps: their Bot is a chat agent with model + memory + conversation.
  for (const kept of ['remember', 'recall', 'ask_user', 'send_to_bot']) assert.ok(names.includes(kept), `a fan keeps ${kept}`);
});

test('staff still have the full tool set', async () => {
  const { names } = await toolNames('staff');
  assert.ok(names.includes('shell'), 'staff keep the shell');
  for (const n of ['computer_screenshot', 'computer_click', 'open_browser', 'save_file', 'create_routine', 'spawn_subagent']) {
    assert.ok(names.includes(n), `staff keep ${n}`);
  }
});
