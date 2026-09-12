import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCdxUrl,
  parseCdxFilter,
  parseCdxJson,
  partitionRows,
  rowMatchesFilter,
  CDX_FIELDS,
  DEFAULT_CANDIDATE_FILTERS,
  type CdxQuery,
} from '../src/index.ts';

const ENDPOINT = 'https://web.archive.org/cdx/search/cdx';

const base: CdxQuery = {
  url: 'demo.invalid',
  matchType: 'domain',
  from: '1998',
  to: '1999',
  limit: 40,
  collapse: 'digest',
  resumeKey: null,
};

test('each query variant is a different declared scope, not a cosmetic flag', () => {
  const issued = (['exact', 'prefix', 'host', 'domain'] as const).map((matchType) =>
    new URL(buildCdxUrl(ENDPOINT, { ...base, matchType })).searchParams.get('matchType'),
  );

  assert.deepEqual(issued, ['exact', 'prefix', 'host', 'domain']);
});

test('the issued query carries the period, the field list and the limit verbatim', () => {
  const parameters = new URL(buildCdxUrl(ENDPOINT, base)).searchParams;

  assert.equal(parameters.get('url'), 'demo.invalid');
  assert.equal(parameters.get('from'), '1998');
  assert.equal(parameters.get('to'), '1999');
  assert.equal(parameters.get('limit'), '40');
  assert.equal(parameters.get('collapse'), 'digest');
  assert.equal(parameters.get('fl'), CDX_FIELDS.join(','));
  assert.equal(parameters.get('output'), 'json');
  assert.equal(parameters.get('showResumeKey'), 'true');
  assert.equal(parameters.get('resumeKey'), null);
});

test('a continuation key is carried into the next query', () => {
  const url = buildCdxUrl(ENDPOINT, { ...base, resumeKey: 'invalid,demo)/about.html 19990401090000' });

  assert.equal(
    new URL(url).searchParams.get('resumeKey'),
    'invalid,demo)/about.html 19990401090000',
  );
});

test('the resume key is read off the tail rows, not treated as a capture', () => {
  const body = JSON.stringify([
    ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
    ['invalid,demo)/', '19990315120000', 'http://demo.invalid/', 'text/html', '200', 'D1', '10'],
    [],
    ['invalid,demo)/next 19990401090000'],
  ]);

  const page = parseCdxJson(body, 40);

  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0]?.original, 'http://demo.invalid/');
  assert.equal(page.rows[0]?.digest, 'D1');
  assert.equal(page.resumeKey, 'invalid,demo)/next 19990401090000');
});

test('a page without a resume key is the end of the inventory', () => {
  const body = JSON.stringify([
    ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
    ['invalid,demo)/', '19990315120000', 'http://demo.invalid/', 'text/html', '200', 'D1', '10'],
  ]);

  const page = parseCdxJson(body, 40);

  assert.equal(page.resumeKey, null);
  assert.equal(page.limitReached, false);
});

test('a page that fills the limit is recorded as possibly truncated', () => {
  const body = JSON.stringify([
    ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
    ['invalid,demo)/a', '19990315120000', 'http://demo.invalid/a', 'text/html', '200', 'D1', '10'],
    ['invalid,demo)/b', '19990315120001', 'http://demo.invalid/b', 'text/html', '200', 'D2', '10'],
  ]);

  assert.equal(parseCdxJson(body, 2).limitReached, true);
});

test('an empty inventory is empty, not an error', () => {
  assert.deepEqual(parseCdxJson('', 10), { rows: [], resumeKey: null, limitReached: false });
  assert.deepEqual(parseCdxJson('[]', 10), { rows: [], resumeKey: null, limitReached: false });
});

test('a non-JSON index response is rejected rather than parsed into phantom rows', () => {
  assert.throws(() => parseCdxJson('<html>service unavailable</html>', 10), /not JSON/u);
});

/* -------------------------------------------------------------------------- */
/* candidate filtering: exclusion is not deletion                              */
/* -------------------------------------------------------------------------- */

/** One URL's history: served, then moved, then gone. */
const MIXED_STATUS_ROWS = JSON.stringify([
  ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
  ['invalid,demo)/', '19980101000000', 'http://demo.invalid/', 'text/html', '200', 'D1', '1200'],
  ['invalid,demo)/', '19990601000000', 'http://demo.invalid/', 'text/html', '302', 'D2', '300'],
  ['invalid,demo)/', '20010101000000', 'http://demo.invalid/', 'text/html', '404', 'D3', '410'],
]);

test('a non-200 row is excluded from acquisition candidates and kept as evidence', () => {
  const { rows } = parseCdxJson(MIXED_STATUS_ROWS, 40);

  const partition = partitionRows(rows, DEFAULT_CANDIDATE_FILTERS);

  assert.equal(rows.length, 3, 'the parser keeps every row the provider returned');
  assert.deepEqual(partition.candidates.map((row) => row.statusCode), ['200']);
  assert.deepEqual(partition.excluded.map((entry) => entry.row.statusCode), ['302', '404']);
  // Exclusion is not deletion: the excluded rows keep their full metadata, so
  // the record still says when this URL moved and when it died.
  assert.deepEqual(partition.excluded.map((entry) => entry.row.timestamp), ['19990601000000', '20010101000000']);
  for (const entry of partition.excluded) assert.equal(entry.excludedBy, 'statuscode:200');
});

test('the default candidate rule is the status filter, stated rather than implied', () => {
  assert.deepEqual([...DEFAULT_CANDIDATE_FILTERS], ['statuscode:200']);
});

test('a filter expression is parsed into a field, a pattern and its negation', () => {
  assert.deepEqual(parseCdxFilter('statuscode:200'), {
    field: 'statuscode',
    pattern: '200',
    negated: false,
    source: 'statuscode:200',
  });
  assert.deepEqual(parseCdxFilter('!mimetype:image/.*'), {
    field: 'mimetype',
    pattern: 'image/.*',
    negated: true,
    source: '!mimetype:image/.*',
  });
});

test('a filter pattern is anchored, so 2000 never passes a statuscode:200 rule', () => {
  const row = {
    urlkey: 'invalid,demo)/',
    timestamp: '19990101000000',
    original: 'http://demo.invalid/',
    mimetype: 'text/html',
    statusCode: '2000',
    digest: 'D',
    length: '10',
  };

  assert.equal(rowMatchesFilter(row, parseCdxFilter('statuscode:200')), false);
  assert.equal(rowMatchesFilter({ ...row, statusCode: '200' }, parseCdxFilter('statuscode:200')), true);
});

test('a filter naming an unselected field is refused rather than silently ignored', () => {
  assert.throws(() => parseCdxFilter('robotflags:A'), /unselected field/u);
  assert.throws(() => parseCdxFilter('statuscode'), /not field:pattern/u);
});

test('an empty filter list makes every row a candidate', () => {
  const { rows } = parseCdxJson(MIXED_STATUS_ROWS, 40);

  const partition = partitionRows(rows, []);

  assert.equal(partition.candidates.length, 3);
  assert.equal(partition.excluded.length, 0);
});

test('the status filter is not sent upstream, because that would delete the evidence', () => {
  // The query carries scope, period, fields, collapse and continuation. It
  // deliberately carries no statuscode filter: the provider would then never
  // return the redirect and error rows the timeline is built from.
  const parameters = new URL(buildCdxUrl(ENDPOINT, base)).searchParams;

  assert.equal(parameters.getAll('filter').length, 0);
});

test('an explicitly declared upstream filter is still issued verbatim', () => {
  const url = buildCdxUrl(ENDPOINT, { ...base, filter: ['!mimetype:image/.*', 'statuscode:200'] });

  assert.deepEqual(new URL(url).searchParams.getAll('filter'), ['!mimetype:image/.*', 'statuscode:200']);
});
