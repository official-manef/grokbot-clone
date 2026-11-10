import { env, capabilityReport } from '../env.js';
import { desktopHealth } from '../desktop.js';

/**
 * What this deployment can and cannot do. The web app resolves this once at
 * boot and hides the affordances it cannot offer, so a user never clicks a
 * button that answers 501.
 */
export async function capabilitiesPayload() {
  const base = capabilityReport();
  let desktop: any = { mode: env.desktop.mode, ready: false };
  try {
    desktop = await desktopHealth();
  } catch (e: any) {
    desktop = { mode: env.desktop.mode, ready: false, error: String(e?.message ?? e).slice(0, 200) };
  }
  return {
    ...base,
    desktop,
    // Named so the UI can say *why* a control is missing without guessing.
    gaps: Object.entries(base.capabilities)
      .filter(([, on]) => !on)
      .map(([name]) => name),
  };
}
