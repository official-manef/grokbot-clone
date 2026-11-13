import { useEffect, useState } from 'react';
import { loadCapabilities, type Capability, type CapabilityReport } from '../lib/capabilities';

/**
 * A one-line banner when this deployment is missing something the app needs to
 * be whole. It names the gap and the env vars, and stays out of the way.
 *
 * Rendered once above the app shell. When every capability is configured it
 * renders nothing at all.
 */

/** How a gap reads to a person. The API's keys are for the API, not for this line. */
const WORDS: Record<Capability, string> = {
  llm: 'model endpoint',
  image: 'image generation',
  tts: 'voice preview',
  stt: 'dictation',
  realtime: 'voice calls',
  desktop: 'bot desktops',
  integrations: 'app connections',
  signin: 'Google sign-in',
};

function list(words: string[]): string {
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function CapabilityNotice() {
  const [report, setReport] = useState<CapabilityReport | null>(null);

  useEffect(() => { void loadCapabilities(true).then(setReport); }, []);

  if (!report) return null;

  if (!report.capabilities.llm) {
    return (
      <div className="capability-notice capability-notice--error" role="status">
        <strong>No model endpoint.</strong> Set <code>LLM_BASE_URL</code>, <code>LLM_API_KEY</code> and{' '}
        <code>LLM_MODEL</code>. Bots will not answer until this is done.
      </div>
    );
  }

  // signin falls back to the email form, so a deployment without it is not
  // "partly configured"; the sign-in screen says what it can do.
  const missing = report.gaps.filter((g) => g !== 'signin').map((g) => WORDS[g] ?? g);
  if (!missing.length) return null;

  return (
    <div className="capability-notice" role="status">
      <strong>Partly configured.</strong> {list(missing)} {missing.length === 1 ? 'is' : 'are'} hidden rather than broken.
    </div>
  );
}
