/**
 * What the verb allowlist does to *real* Composio slugs, not to plausible-looking ones.
 *
 * `isReadOnlySlug` decides whether a tool call skips the approval card entirely, so a
 * false positive here is an app write that runs unasked. The upstream regexes are
 * brittle in principle (any slug shaped `<read>_AND_<verb missing from WRITE_RE>`
 * auto-allows), and a note in CONTINUE.md once asserted that was a live hole.
 *
 * It is not. Measured against the live catalog (185 slugs from 66 `composio search`
 * queries) every auto-allowed slug was a genuine read: 88/88. Composio names writes with
 * verbs WRITE_RE already carries.
 *
 * So this test pins the behaviour on slugs taken from that crawl — real names, quoted
 * here with their verdict. It is deliberately not a test of invented slugs: that would
 * assert the regex against a fiction, which is the failure mode this repo keeps
 * re-learning.
 *
 * The list is a sample, not the catalog: no Composio key works against
 * `backend.composio.dev` (all 10 in the MSO store return 401; the `composio` CLI reaches
 * the catalog over a different path), so a full refresh is not automated here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isReadOnlySlug, READ_RE } from '../src/composio.ts';

/** Straight from the crawl. Every one of these is a read. */
const READS = [
  'GMAIL_LIST_LABELS',
  'GMAIL_FETCH_EMAILS',
  'GMAIL_GET_DRAFT',
  'GOOGLEDRIVE_FIND_FILE',
  'GOOGLESHEETS_SEARCH_SPREADSHEETS',
  'GOOGLECALENDAR_FIND_EVENT',
  'NOTION_RETRIEVE_PAGE',
  'NOTION_SEARCH_NOTION_PAGE',
  'SLACK_FIND_CHANNELS',
  'SLACK_FETCH_CONVERSATION_HISTORY',
  'STRIPE_LIST_REFUNDS',
  'STRIPE_RETRIEVE_CHARGE',
  'HUBSPOT_SEARCH_DEALS',
  'JIRA_GET_PROJECT',
  'LINEAR_LIST_LINEAR_STATES',
  'TRELLO_GET_CARDS_BY_ID_CARD',
  'DISCORDBOT_LIST_GUILD_CHANNELS',
  'DROPBOX_SEARCH_FILE_OR_FOLDER',
  'GITHUB_SEARCH_ISSUES',
  'CUSTOM_OPENSEO_GET_SERP_RESULTS',
];

/**
 * Real slugs whose writes must ask. These pin the verbs WRITE_RE carries in the positions
 * Composio actually uses them.
 *
 * Honest limit: dropping any single verb from WRITE_RE does NOT fail this test, because
 * no real slug combines a read word with a missing write verb — which is exactly the
 * measurement in CONTINUE.md (0 of 185). These cases catch WRITE_RE being removed or
 * gutted, not one verb going missing.
 */
const WRITES = [
  'NOTION_APPEND_TEXT_BLOCKS',
  'JIRA_ADD_COMMENT',
  'GITHUB_ADD_ASSIGNEES_TO_AN_ISSUE',
  'SLACK_SCHEDULE_MESSAGE',
  'SLACK_SEND_MESSAGE',
  'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND',
  'GOOGLESHEETS_VALUES_UPDATE',
  'CUSTOM_OPENSEO_SAVE_KEYWORDS',
  'CUSTOM_OPENSEO_RUN_SITE_AUDIT',
  'CUSTOM_BATONLY_RAHMAN_BATON_PROJECT_MEMBER_ROLE_SET',
  'CUSTOM_BATONLY_RAHMAN_BATON_PROJECT_MEMBER_REMOVE',
  'CUSTOM_BATONLY_RAHMAN_BATON_REPOSITORY_EXECUTE',
  'GITHUB_CREATE_CHECK_RUN',
  'NOTION_GET_PAGE_AND_UPDATE',
];

test('every crawled read slug is auto-allowed', () => {
  const allowed = READS.filter(isReadOnlySlug);
  assert.deepEqual(
    READS.filter((s) => !isReadOnlySlug(s)),
    [],
    'these reads would each show an approval card, which is the safe direction but wrong',
  );
  assert.equal(allowed.length, READS.length);
});

test('every crawled write slug asks, so gutting WRITE_RE fails here', () => {
  const slipped = WRITES.filter(isReadOnlySlug);
  assert.deepEqual(
    slipped,
    [],
    'these writes would run without an approval card: ' + slipped.join(', '),
  );
});

/**
 * The one shape that would slip, and the six verbs that used to make it slip.
 *
 * These are not from the crawl: the crawl never produced `<read>_AND_<missing verb>`, which
 * is why the gap sat unmeasured for a session. Each case is the shape itself, so it fails
 * if any of the six verbs is dropped from WRITE_RE again. The right-hand side of each is a
 * real Composio write slug that already asked and still asks.
 */
const READ_THEN_UNLISTED_WRITE = [
  ['SLACK_FETCH_MESSAGES_AND_APPEND', 'NOTION_APPEND_TEXT_BLOCKS'],
  ['GMAIL_LIST_THREADS_AND_LABEL', 'GMAIL_ADD_LABEL_TO_EMAIL'],
  ['HUBSPOT_SEARCH_CONTACTS_AND_UPSERT', 'SLACK_SCHEDULE_MESSAGE'],
  ['GITHUB_GET_ISSUE_AND_DUPLICATE', 'RESEND_CREATE_CONTACT_IMPORT'],
];

test('a read verb followed by a write verb names asks, for all six verbs the crawl missed', () => {
  const slipped = READ_THEN_UNLISTED_WRITE.filter(([slug]) => isReadOnlySlug(slug)).map(([s]) => s);
  assert.deepEqual(slipped, [], 'these would run unasked: ' + slipped.join(', '));
  // And the real write slugs are still writes, so this is not satisfied by rejecting all.
  for (const [, real] of READ_THEN_UNLISTED_WRITE) {
    assert.equal(isReadOnlySlug(real), false, real);
  }
});

/**
 * The measurement, run against the local catalog when it exists.
 *
 * `composio search` writes one tool definition per slug to `~/.composio/tool_definitions`.
 * It is present on a developer box and absent on CI, so this case skips rather than
 * failing there — a catalog assertion that needs a login is not a CI gate. What it guards
 * is the premise of the paragraph above: that widening WRITE_RE costs no real read.
 */
test('no real catalog read is pushed onto the approval card', (t) => {
  const dir = path.join(os.homedir(), '.composio', 'tool_definitions');
  if (!fs.existsSync(dir)) return t.skip('no local Composio catalog');
  const slugs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  assert.ok(slugs.length > 20, 'catalog too small to mean anything: ' + slugs.length);
  // Every slug whose name pairs a read verb with one of the six now asks; none of those
  // are reads in this catalog. Stated as a count so a regression names itself.
  const nowAsking = slugs.filter((s) => READ_RE.test(s) && !isReadOnlySlug(s));
  const allowed = slugs.filter(isReadOnlySlug);
  assert.deepEqual(
    allowed.filter((s) => /_(APPEND|UPSERT|SCHEDULE|IMPORT|DUPLICATE|LABEL)(_|$)/.test(s)),
    [],
    'a real auto-allowed slug names one of the six write verbs',
  );
  assert.ok(nowAsking.length > 0 && allowed.length > 0, 'catalog produced no verdicts');
});

test('a read word inside a longer word does not count, which is what saved SPREADSHEETS', () => {
  // `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` contains "READ" inside "SPREADSHEETS".
  // READ_RE requires `_READ(_|$)`, so it does not match -- and APPEND is not in
  // WRITE_RE. If READ_RE were ever loosened to a bare substring, this slug would
  // auto-allow. Assert the boundary, not just today's verdict.
  assert.equal(
    /_READ(_|$)/.test('_SPREADSHEETS_VALUES_APPEND'),
    false,
    'READ_RE must keep its underscore boundary',
  );
  assert.equal(isReadOnlySlug('GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND'), false);
});
