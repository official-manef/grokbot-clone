/**
 * Fitting a long voice-call transcript into a prompt without losing the point.
 *
 * The behaviour this replaces was `lines.slice(-12_000)`: it dropped the start of
 * the conversation (where a call says what it is about) and could split a sentence.
 * Every case below is a way that can go wrong for a person reading the summary.
 *
 *   node --test server/test/call-transcript.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { OPENING_KEEP, TRANSCRIPT_BUDGET, compactCallTranscript } from '../src/agent/call-transcript.ts';

const BOT = 'Doug';
const render = (transcript, botName = BOT) =>
  transcript.map((t) => `${t.role === 'user' ? 'User' : botName}: ${t.text}`).join('\n');

const line = (i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `line ${i} ${'x'.repeat(200)}` });

test('a call that fits is returned exactly as rendered', () => {
  const t = [{ role: 'user', text: 'book me a flight' }, { role: 'assistant', text: 'to where?' }];
  const rendered = render(t);
  assert.equal(compactCallTranscript(t, rendered, BOT), rendered, 'short calls must be untouched');
});

test('a long call keeps its opening line, which is what the call was about', () => {
  const t = [{ role: 'user', text: 'I need to reschedule the launch' }, ...Array.from({ length: 200 }, (_, i) => line(i))];
  const out = compactCallTranscript(t, render(t), BOT);
  assert.ok(out.length <= TRANSCRIPT_BUDGET, `got ${out.length}`);
  assert.match(out.slice(0, 40), /reschedule the launch/, 'the opening survives');
});

test('a long call keeps the most recent exchange', () => {
  const t = [{ role: 'user', text: 'start' }, ...Array.from({ length: 200 }, (_, i) => line(i))];
  const out = compactCallTranscript(t, render(t), BOT);
  assert.match(out, /line 199 /, 'the newest line is still there word for word');
});

test('the gap is marked, so a summary knows it is not looking at a continuous call', () => {
  const t = [{ role: 'user', text: 'start' }, ...Array.from({ length: 200 }, (_, i) => line(i))];
  const out = compactCallTranscript(t, render(t), BOT);
  assert.match(out, /earlier lines? omitted/, 'silence about the gap would read as continuity');
  assert.match(out, /\d+ earlier line/, 'the count is stated, not just "some"');
});

test('a single enormous opening line cannot eat the whole budget', () => {
  const t = [{ role: 'user', text: 'y'.repeat(50_000) }, line(1), line(2)];
  const out = compactCallTranscript(t, render(t), BOT);
  assert.ok(out.length <= TRANSCRIPT_BUDGET, `got ${out.length}`);
  assert.ok(out.includes('line 2'), 'the newest lines are still kept');
  assert.match(out, /…$|…\n/, 'the opening is truncated rather than dropped');
});

test('an empty transcript falls back to a hard cut, never to an empty string', () => {
  const rendered = 'z'.repeat(20_000);
  const out = compactCallTranscript([], rendered, BOT);
  assert.equal(out.length, TRANSCRIPT_BUDGET);
});

test('the budget is respected for a transcript of any size', () => {
  for (const n of [10, 100, 1000]) {
    const t = [{ role: 'user', text: 'opening' }, ...Array.from({ length: n }, (_, i) => line(i))];
    const out = compactCallTranscript(t, render(t), BOT);
    assert.ok(out.length <= TRANSCRIPT_BUDGET, `n=${n} produced ${out.length}`);
  }
});

test('one very long line does not blow the budget when it is the only recent turn', () => {
  const t = [{ role: 'user', text: 'opening' }, { role: 'assistant', text: 'q'.repeat(30_000) }];
  const out = compactCallTranscript(t, render(t), BOT);
  // The huge line cannot fit, so only the opening survives; the point is that the
  // result is still bounded and still says what the call was about.
  assert.ok(out.length <= TRANSCRIPT_BUDGET);
  assert.match(out, /opening/);
});

test('the opening allowance is a real limit once the budget is exceeded', () => {
  // A single 5k opening still fits the 12k budget, so it is returned verbatim — the
  // cap only applies when the transcript as a whole has to be trimmed.
  const fits = [{ role: 'user', text: 'w'.repeat(5_000) }, line(1)];
  assert.ok(compactCallTranscript(fits, render(fits), BOT).split('\n')[0].length > OPENING_KEEP);

  const over = [{ role: 'user', text: 'w'.repeat(5_000) }, ...Array.from({ length: 100 }, (_, i) => line(i))];
  const out = compactCallTranscript(over, render(over), BOT);
  const firstLine = out.split('\n')[0];
  assert.ok(firstLine.length <= OPENING_KEEP + 1, `opening was ${firstLine.length}`);
  assert.ok(out.length <= TRANSCRIPT_BUDGET);
});
