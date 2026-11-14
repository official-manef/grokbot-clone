/**
 * One tool-layer call, in its own process, so env.ts resolves once per case
 * exactly as it does at boot. Prints a JSON result on stdout.
 *
 *   node --import tsx test/_tools-probe.mjs tools '{}'
 *   node --import tsx test/_tools-probe.mjs call '{"name":"web_search","args":{...}}'
 */
const [kind, rawArgs] = process.argv.slice(2);
const args = rawArgs ? JSON.parse(rawArgs) : {};

const { availableTools, toolMap } = await import('../src/agent/tools.ts');

const MARK = '@@PROBE@@';
/** env.ts writes boot notes to stdout; a marker keeps the JSON unambiguous. */
const out = (value) => process.stdout.write(MARK + JSON.stringify(value) + '\n');

try {
  switch (kind) {
    case 'tools':
      out({ ok: true, names: availableTools().map((t) => t.name) });
      break;
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
