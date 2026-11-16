/**
 * A title is cosmetic, so the only thing worth testing is that it always exists.
 *
 * Every case here is a way the model (or the network) can misbehave, and each one
 * must still return something a sidebar can render. A thrown error, an empty reply,
 * a JSON blob, a wrapped quote: all of them fall back rather than propagate.
 *
 *   node --test server/test/session-title.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FALLBACK_TITLE_MAX_LENGTH,
  SNIPPET_MAX_LENGTH,
  fallbackTitle,
  generateSessionTitle,
  normaliseTitle,
  truncateSnippet,
} from '../src/agent/session-title.ts';

const gen = (reply) => async () => reply;
const boom = () => async () => { throw new Error('provider down'); };

test('a model title is used, cleaned of the wrapping models add', async () => {
  assert.equal(await generateSessionTitle({ userText: 'how do I deploy this', assistantText: 'run the script', generate: gen('"Deploying The App".') }), 'Deploying The App');
  assert.equal(await generateSessionTitle({ userText: 'x', assistantText: 'y', generate: gen('Title: Fix login bug') }), 'Fix login bug');
  assert.equal(await generateSessionTitle({ userText: 'x', assistantText: 'y', generate: gen('**Cache Invalidation**') }), 'Cache Invalidation');
});

test('a failing model falls back instead of throwing', async () => {
  const title = await generateSessionTitle({ userText: 'why is the build red', assistantText: '', generate: boom() });
  assert.equal(title, 'Why is the build red');
});

test('the failure is reported to the caller for logging, never swallowed silently', async () => {
  let seen = null;
  await generateSessionTitle({ userText: 'q', assistantText: 'a', generate: boom(), onError: (e) => { seen = e; } });
  assert.match(seen.message, /provider down/);
});

test('an empty, whitespace-only, or punctuation-only reply falls back', async () => {
  for (const reply of ['', '   ', '...', '""', '```']) {
    const title = await generateSessionTitle({ userText: 'set up postgres', assistantText: 'done', generate: gen(reply) });
    assert.equal(title, 'Set up postgres', `reply ${JSON.stringify(reply)} must fall back`);
  }
});

test('a reply with no letters at all is refused: a title is text', async () => {
  assert.equal(await generateSessionTitle({ userText: 'q about redis', assistantText: 'a', generate: gen('123 456') }), 'Q about redis');
});

test('an empty user message still yields a usable title', async () => {
  const title = await generateSessionTitle({ userText: '   ', assistantText: 'hi', generate: gen('should not matter') });
  assert.equal(title, 'New chat');
});

test('the fallback respects the sidebar width and never ends mid-word', () => {
  const title = fallbackTitle('a'.repeat(500));
  assert.ok(title.length <= FALLBACK_TITLE_MAX_LENGTH + 1, `got ${title.length}`);
  const words = fallbackTitle('deploy the payments service to staging before friday please');
  assert.ok(words.length <= FALLBACK_TITLE_MAX_LENGTH);
  assert.equal(words.endsWith(' '), false);
  assert.doesNotMatch(words, /\s{2,}/, 'no doubled spaces');
});

test('the snippet is bounded, so a giant paste does not become the prompt', () => {
  assert.equal(truncateSnippet('a'.repeat(SNIPPET_MAX_LENGTH + 100)).length, SNIPPET_MAX_LENGTH + 1, 'plus the ellipsis');
  assert.equal(truncateSnippet('  short  '), 'short');
});

test('normaliseTitle is idempotent, which keeps the two paths consistent', () => {
  for (const raw of ['"Fix bug"', 'Title: Fix bug.', '**Fix bug**', '  Fix  bug  ']) {
    const once = normaliseTitle(raw);
    assert.equal(normaliseTitle(once), once, `unstable on ${JSON.stringify(raw)}`);
  }
});

test('a very long model title is capped so it cannot break the layout', async () => {
  const title = await generateSessionTitle({ userText: 'q', assistantText: 'a', generate: gen('word '.repeat(100)) });
  assert.ok(title.length <= FALLBACK_TITLE_MAX_LENGTH * 2, `got ${title.length}`);
});
