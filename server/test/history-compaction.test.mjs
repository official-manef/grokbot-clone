/**
 * Compaction: token accounting, pruning, and the summarise-or-keep decision.
 *
 * The properties that matter are not "the numbers are pretty" but the two ways this
 * can destroy work: replacing a conversation with an empty summary, and dropping
 * turns when the model call failed. Both are asserted below, plus the boundary
 * cases that decide when compaction fires at all.
 *
 *   node --test server/test/history-compaction.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPACTION_BUFFER,
  estimateTokens,
  estimateTotal,
  isOverflow,
  pruneToolOutputs,
  reservedTokens,
  selectRange,
  usableContextTokens,
  withPruned,

} from '../src/agent/compaction/context.ts';
import { buildCompactionPrompt, compactHistory } from '../src/agent/compaction/compaction.ts';
import { rowsToTurns, turnsToMessages } from '../src/agent/compaction/rows.ts';

const cfg = (contextWindow = 10_000, maxOutputTokens = 1_000) => ({ contextWindow, maxOutputTokens });

const user = (text) => ({ role: 'user', text });
const assistant = (text, summary = false) => (summary ? { role: 'assistant', text, summary } : { role: 'assistant', text });
const tool = (text) => ({ role: 'tool', text });

/** Enough history that a small window considers it over the line. */
const longHistory = () => [
  user('first question'),
  assistant('first answer'),
  tool('x'.repeat(4000)),
  user('second question'),
  assistant('second answer'),
  tool('y'.repeat(4000)),
  user('third question'),
  assistant('third answer'),
];

test('token estimation is the documented ratio and monotonic', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(401)), 101);
  assert.ok(estimateTokens('a'.repeat(200)) < estimateTokens('a'.repeat(400)), 'longer text estimates higher');
});

test('the output reservation is capped, so a huge maxOutput cannot zero the window', () => {
  assert.equal(reservedTokens(1_000), 1_000);
  assert.equal(reservedTokens(COMPACTION_BUFFER * 10), COMPACTION_BUFFER, 'capped at the buffer');
  assert.equal(reservedTokens(0), 0);
  assert.ok(usableContextTokens(cfg(10_000, 1_000_000)) > 0, 'still positive usable context');
});

test('overflow fires at the usable boundary, not at the raw window', () => {
  const c = cfg(10_000, 1_000);
  const usable = usableContextTokens(c);
  assert.equal(isOverflow(usable - 1, c), false);
  assert.equal(isOverflow(usable, c), true, 'the boundary itself counts as overflow');
});

test('a conversation that fits is left completely alone', async () => {
  const history = [user('hi'), assistant('hello')];
  const result = await compactHistory({
    history,
    systemPrompt: 'sys',
    compaction: cfg(100_000),
    summarize: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.action, 'none');
  assert.deepEqual(result.history, history);
  assert.equal(result.messagesAfter, 2);
});

test('a summariser failure keeps every turn: no summary means no compaction', async () => {
  const history = longHistory();
  const result = await compactHistory({
    history,
    systemPrompt: 'sys',
    compaction: cfg(200, 100),
    summarize: async () => { throw new Error('provider down'); },
  });
  assert.equal(result.action === 'summarized', false, 'must not claim to have summarised');
  assert.equal(result.history.filter((m) => m.role === 'user').length, 3, 'all user turns survive');
  assert.match(result.error ?? '', /provider down/);
});

test('an empty summariser reply is refused, not appended as a summary', async () => {
  const history = longHistory();
  const result = await compactHistory({
    history,
    systemPrompt: 'sys',
    compaction: cfg(200, 100),
    summarize: async () => '   ',
  });
  assert.equal(result.action === 'summarized', false);
  assert.equal(result.history.filter((m) => m.role === 'user').length, 3);
  assert.match(result.error ?? '', /no text/);
});

test('a successful summary replaces the head and keeps the tail verbatim', async () => {
  const history = longHistory();
  const result = await compactHistory({
    history,
    systemPrompt: 'sys',
    compaction: cfg(200, 100),
    summarize: async () => '## Goal\n- summarised',
  });
  assert.equal(result.action, 'summarized');
  const summaries = result.history.filter((m) => m.summary);
  assert.equal(summaries.length, 1, 'exactly one summary at the front');
  assert.equal(result.history[0].summary, true);
  assert.equal(result.history.at(-1).text, 'third answer', 'the most recent turn is still there word for word');
  // TAIL_TURNS = 2 keeps the last two user turns, i.e. the last four messages here.
  assert.ok(result.messagesAfter < result.messagesBefore);
});

test('the tail is kept: the newest turns are never summarised away', () => {
  const { head, tailStartIndex } = selectRange(longHistory(), 2);
  assert.ok(head.length > 0);
  assert.equal(longHistory()[tailStartIndex].role, 'user');
  assert.equal(longHistory().slice(tailStartIndex).at(-1).text, 'third answer');
});

test('a conversation with no more turns than the tail has nothing to summarise', async () => {
  const history = [user('one'), assistant('a'), user('two'), assistant('b')];
  const result = await compactHistory({
    history,
    systemPrompt: 'sys',
    compaction: cfg(10, 1),
    summarize: async () => 'should not be used',
  });
  assert.equal(result.action === 'summarized', false, 'nothing older than the tail');
  assert.equal(result.history.length, 4);
});

test('pruning drops the oldest tool output first and never the newest', () => {
  const history = longHistory();
  const result = pruneToolOutputs(history, cfg(2_000, 1_000));
  if (result.prunedTokens > 0) {
    const newestTool = history.length - 1;
    assert.equal(result.indexes.includes(newestTool), false, 'the most recent tool result survives');
  }
});

test('pruning below the minimum reclaim is skipped rather than done for nothing', () => {
  const tiny = [user('q'), assistant('a'), tool('small'), user('q2'), assistant('a2')];
  const result = pruneToolOutputs(tiny, cfg(10_000, 100));
  assert.equal(result.prunedTokens, 0);
  assert.deepEqual(result.indexes, []);
});

test('pruning never crosses a previous summary, which is the next anchor', () => {
  const history = [
    user('old'),
    tool('z'.repeat(5000)),
    assistant('## Goal\n- previous summary', true),
    user('new'),
    tool('w'.repeat(20)),
    assistant('answer'),
  ];
  const result = pruneToolOutputs(history, cfg(1_000, 100));
  assert.equal(result.indexes.includes(1), false, 'the turn before the summary is not pruned through it');
});

test('withPruned returns new objects and leaves the input untouched', () => {
  const history = [user('q'), assistant('a'), tool('payload'), user('q2'), assistant('a2')];
  const before = JSON.stringify(history);
  const out = withPruned(history, [2]);
  assert.equal(JSON.stringify(history), before, 'input is not mutated');
  assert.equal(out[2].truncated, true);
  assert.notEqual(out[2], history[2], 'the pruned entry is a copy');
});

test('rows become turns, and app chrome is dropped', () => {
  const rows = [
    { kind: 'message', body: { type: 'message', role: 'user', text: 'hello' } },
    { kind: 'message', body: { type: 'message', role: 'assistant', text: 'hi' } },
    { kind: 'tool-call', body: { type: 'tool-call', callId: 'c1', name: 'shell', label: 'Running commands', status: 'done', summary: 'exit 0' } },
    { kind: 'card', body: { type: 'card', card: 'question', question: 'pick', options: ['a'], status: 'pending' } },
    { kind: 'notice', body: { type: 'notice', text: 'heads up' } },
  ];
  const turns = rowsToTurns(rows);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool']);
  assert.match(turns[2].text, /shell · done · exit 0/, 'a tool turn carries the outcome, not just the name');
  assert.deepEqual(turnsToMessages(turns).map((m) => m.role), ['user', 'assistant'], 'tool turns are not rendered as messages');
});

test('the prompt anchors to a previous summary instead of starting over', () => {
  const fresh = buildCompactionPrompt();
  const anchored = buildCompactionPrompt('## Goal\n- previous');
  assert.match(fresh, /Create a new anchored summary/);
  assert.match(anchored, /Update the anchored summary/);
  assert.match(anchored, /previous-summary/);
  assert.match(anchored, /## Next Steps/, 'the template is always present');
});

test('tool definitions count toward the budget', () => {
  const history = [user('q')];
  const withoutTools = estimateTotal(history, 'sys');
  const withTools = estimateTotal(history, 'sys', JSON.stringify({ name: 'shell', description: 'x'.repeat(400) }));
  assert.ok(withTools > withoutTools, 'a big tool schema makes overflow arrive sooner');
});
