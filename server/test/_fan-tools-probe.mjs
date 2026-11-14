/**
 * The tool list one audience is offered. Each case runs in its own process
 * because env.ts (and therefore the database handle) resolves once per process,
 * exactly as it does at boot.
 *
 *   node --import tsx server/test/_fan-tools-probe.mjs fan
 *   node --import tsx server/test/_fan-tools-probe.mjs staff
 */
const audience = process.argv[2] === 'staff' ? 'staff' : 'fan';

const { availableTools, isStaffOnlyTool } = await import('../src/agent/tools.ts');

process.stdout.write(
  '@@PROBE@@' +
    JSON.stringify({
      audience,
      names: availableTools(audience).map((t) => t.name),
      // A canary: the predicate the loop uses to refuse must agree with the filter.
      shellIsStaffOnly: isStaffOnlyTool('shell'),
    }) +
    '\n',
);
