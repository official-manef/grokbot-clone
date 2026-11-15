import { useState } from 'react';
import { BotAvatar } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { useStore } from '../store';
import { useCapability } from '../lib/capabilities';
import { TrafficLights } from './Sidebar';

export function SignIn() {
  const devLogin = useStore((s) => s.devLogin);
  const passwordLogin = useStore((s) => s.passwordLogin);
  const checkAuth = useStore((s) => s.checkAuth);
  const canGoogle = useCapability('signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const flag = new URLSearchParams(location.search).get('login');
    // Plain, and deliberately vague: a refused person is told the same thing whether
    // the allowlist, the domain or the provider said no.
    if (flag === 'refused') return 'This app is for the AntiNRML team.';
    if (flag === 'failed') return 'Sign-in didn’t finish. Try again.';
    return null;
  });

  const withPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) { setError('Enter an email address'); return; }
    if (!password) { setError('Enter your password'); return; }
    setBusy(true); setError(null);
    try {
      await api.passwordLogin(email.trim(), password);
      setPassword('');
      await checkAuth();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  const dev = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) { setError('Enter an email address'); return; }
    setBusy(true); setError(null);
    try { await api.devLogin(email.trim(), name.trim() || undefined); await checkAuth(); } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <div className="signin">
      <div className="signin__chrome"><TrafficLights /></div>
      <div className="signin__card">
        <div className="signin__hero">
          <BotAvatar shape="blob" color="black" size={84} />
        </div>
        <h1 className="signin__title">Grokbot</h1>
        <p className="signin__sub">AI teammates with their own computers. Hand them a task and they get it done.</p>
        {canGoogle && (
          // Staff only: this goes to WorkOS AuthKit, walled by the server's allowlist.
          // The old label said "Sign in with Google", which is the fan-facing flow that
          // now lives in the game and antinrml.com instead.
          <a className="btn btn--primary signin__google" href="/api/auth/google/start">
            Sign in with your work account
          </a>
        )}
        {passwordLogin && (
          <form className="signin__dev" onSubmit={withPassword}>
            <div className="signin__divider"><span>Sign in</span></div>
            <input className="text-input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" autoComplete="username" />
            <input className="text-input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" autoComplete="current-password" />
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        )}
        {devLogin && !passwordLogin && (
          <form className="signin__dev" onSubmit={dev}>
            <div className="signin__divider"><span>Dev sign-in</span></div>
            <input className="text-input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            <input className="text-input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <button type="submit" className="btn btn--secondary" disabled={busy}>{busy ? 'Signing in…' : 'Continue with email'}</button>
          </form>
        )}
        {error && <div className="card__error signin__error">{error}</div>}
        <p className="signin__foot">Open source. Not affiliated with xAI.</p>
      </div>
    </div>
  );
}
