import { useEffect, useState } from 'react';
import { loadCapabilities, type CapabilityReport } from '../lib/capabilities';

/**
 * A one-line banner when this deployment is missing something the app needs to
 * be whole. It names the gap and the env vars, and stays out of the way.
 *
 * Rendered once above the app shell. When every capability is configured it
 * renders nothing at all.
 */
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

  // signin falls back to the email form and stt only disables dictation, so
  // neither is worth a banner on its own.
  const missing = report.gaps.filter((g) => g !== 'signin' && g !== 'stt');
  if (!missing.length) return null;

  return (
    <div className="capability-notice" role="status">
      <strong>Partly configured.</strong> {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} hidden rather than broken.
    </div>
  );
}
