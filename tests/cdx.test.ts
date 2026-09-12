import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCdxUrl, parseCdxJson, CDX_FIELDS, type CdxQuery } from '../src/index.ts';

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
