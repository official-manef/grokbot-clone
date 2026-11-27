/**
 * When an `/apps/callback` hit may resume a Bot.
 *
 * The route is unauthenticated (an OAuth popup returns with no fetch headers we
 * control) and resuming a Bot spends a model turn, so the decision is tested here,
 * as the decision, rather than by restating the condition inside the route. A guard
 * that is only asserted in prose drifts; this one is run.
 *
 * Covers both directions: the single legitimate callback must resume, and every
 * callback that did not start a flow must not — including the replay, which is the
 * same URL twice and must yield exactly one turn.
 *
 *   node --test server/test/connect-resume.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mayResumeConnect } from '../src/lib/connect-resume.ts';

const card = (over = {}) => ({
  type: 'card',
  card: 'connect',
  toolkit: 'gmail',
  status: 'pending',
  toolkitName: 'Gmail',
  ...over,
});

/** The one callback a real flow produces. */
const started = {
  botId: 'b1',
  seq: 7,
  row: { body: card() },
  botOwned: true,
  slug: 'gmail',
};

test('the callback that started the flow resumes the Bot', () => {
  assert.equal(mayResumeConnect(started), true);
});

test('a replay finds the card no longer pending, so it does not resume again', () => {
  // The first call flipped the card to `connected` before enqueueing.
  const replay = { ...started, row: { body: card({ status: 'connected' }) } };
  assert.equal(mayResumeConnect(replay), false);
});

test('a callback for a slug the card did not ask for does not resume', () => {
  assert.equal(mayResumeConnect({ ...started, slug: 'slack' }), false);
});

test("another user's bot id does not resume", () => {
  assert.equal(mayResumeConnect({ ...started, botOwned: false }), false);
});

test('a callback with no seq cannot name a card, so it does not resume', () => {
  for (const seq of [null, undefined, 0]) {
    assert.equal(mayResumeConnect({ ...started, seq }), false, `seq=${seq}`);
  }
});

test('a callback with no bot id does not resume', () => {
  assert.equal(mayResumeConnect({ ...started, botId: null }), false);
});

test('a row that is not a connect card does not resume', () => {
  // e.g. a chat message, an approval card, or a connect card already superseded.
  for (const body of [null, { type: 'message', text: 'hi' }, card({ card: 'approval' })]) {
    assert.equal(mayResumeConnect({ ...started, row: body ? { body } : null }), false, JSON.stringify(body));
  }
});

test('a missing row does not resume', () => {
  assert.equal(mayResumeConnect({ ...started, row: null }), false);
});
