/**
 * The sign-in start route, answered in a child process because env.ts resolves once
 * per process (AUTH_PROVIDER is decided at boot). Nothing here touches the network:
 * an unconfigured server returns 503, and a configured one returns a 302 whose
 * Location is built locally by `authorizationUrl`.
 *
 *   node --import tsx server/test/_signin-start-probe.mjs unconfigured
 *   node --import tsx server/test/_signin-start-probe.mjs workos
 */
const mode = process.argv[2] === 'workos' ? 'workos' : 'unconfigured';

const { api } = await import('../src/routes.ts');
const { env } = await import('../src/env.ts');
const { db } = await import('../src/db.ts');

const res = await api.request('/auth/google/start');
const location = res.headers.get('location') ?? '';

// Does the state in the redirect name a live login_attempts row?
const state = location ? new URL(location).searchParams.get('state') ?? '' : '';
const liveAttempt = state ? db.prepare('SELECT 1 FROM login_attempts WHERE id=?').get(state) : undefined;

process.stdout.write(
  '@@PROBE@@' +
    JSON.stringify({
      mode,
      authProvider: env.authProvider,
      status: res.status,
      location,
      body: res.status === 503 ? await res.json().catch(() => null) : null,
      state,
      stateIsLive: Boolean(liveAttempt),
      // The 500 we are fixing came from Composio throwing with no API key.
      composioKeyPresent: env.composioEnabled,
    }) +
    '\n',
);

db.prepare("DELETE FROM login_attempts WHERE provisional_user_id=''").run();
