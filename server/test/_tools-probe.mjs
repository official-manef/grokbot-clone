/**
 * One tool-layer call, in its own process, so env.ts resolves once per case
 * exactly as it does at boot. Prints a JSON result on stdout.
 *
 *   node --import tsx test/_tools-probe.mjs tools '{}'
 *   node --import tsx test/_tools-probe.mjs caps '{}'
 *   node --import tsx test/_tools-probe.mjs prompt '{}'
 *   node --import tsx test/_tools-probe.mjs call '{"name":"web_search","args":{...}}'
 */
const [kind, rawArgs] = process.argv.slice(2);
const args = rawArgs ? JSON.parse(rawArgs) : {};

const { availableTools, toolMap } = await import('../src/agent/tools.ts');
const { capabilities, capabilityReport } = await import('../src/env.ts');

const MARK = '@@PROBE@@';
/** env.ts writes boot notes to stdout; a marker keeps the JSON unambiguous. */
const out = (value) => process.stdout.write(MARK + JSON.stringify(value) + '\n');

try {
  switch (kind) {
    case 'tools':
      out({ ok: true, names: availableTools().map((t) => t.name) });
      break;
    case 'caps':
      out({ ok: true, capabilities, report: capabilityReport() });
      break;
    case 'prompt': {
      // A throwaway database with one user and one bot, so the prompt can be
      // assembled without a live server. Nothing here touches the network.
      // `hidden`, `kind` and `members` are read by store.ts and prompt.ts but are
      // not in the CREATE TABLE in db.ts, so a fresh database needs them added
      // here (a pre-existing migration gap, not part of this task).
      const { db } = await import('../src/db.ts');
      for (const ddl of [
        "hidden INTEGER NOT NULL DEFAULT 0",
        "kind TEXT NOT NULL DEFAULT 'agent'",
        "members TEXT NOT NULL DEFAULT '[]'",
      ]) {
        try { db.exec(`ALTER TABLE bots ADD COLUMN ${ddl}`); } catch { /* already there */ }
      }
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'u@example.com', 'Sam', Date.now());
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('b1', 'u1', 'Doug', Date.now(), Date.now());
      const { instructionsFor } = await import('../src/agent/prompt.ts');
      out({ ok: true, text: await instructionsFor('u1', 'b1') });
      break;
    }
    case 'call': {
      const tool = toolMap.get(args.name);
      if (!tool) throw new Error(`no such tool: ${args.name}`);
      const ctx = { userId: 'u1', botId: 'b1', enqueueBotMessage: () => {}, depth: 0 };
      out({ ok: true, value: await tool.impl(args.args ?? {}, ctx) });
      break;
    }
    default:
      throw new Error(`unknown probe: ${kind}`);
  }
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e), capability: e?.capability });
}
