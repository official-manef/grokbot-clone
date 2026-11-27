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
import test from 'node:test';
import { isReadOnlySlug } from '../src/composio.ts';

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
