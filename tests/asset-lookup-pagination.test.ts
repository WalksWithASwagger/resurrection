/**
 * Per-URL asset lookup pagination (issue #23).
 *
 * A frequently-crawled asset can have more than 100 captures. The lookup
 * follows the same `resumeKey` continuation the inventory already uses, up to
 * a documented page cap. These cases are built inline so the committed
 * asset-site fixture stays the issue #6 collection.
 *
 * No socket is opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSET_LOOKUP_LIMIT,
  parseProjectConfig,
  runAcquisition,
  type EvidenceReport,
  type FixtureManifest,
  type ProjectConfig,
} from '../src/index.ts';
import { createFixtureTransport } from '../src/fixture-transport.ts';
import { createTestClock } from '../src/clock.ts';
import { requestedUrls, withTempDirectory } from './helpers/acquisition.ts';

const HOME = 'http://paged.invalid/';
const LOGO = 'http://paged.invalid/logo.gif';
const SMALL = 'http://paged.invalid/small.gif';
const PAGE1_KEY = 'logo-page-2';
const PAGE2_KEY = 'logo-page-3';
const NEAREST_ON_PAGE_3 = '19990310000000';

const PIXEL = [
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 255, 255, 255, 0, 0, 0, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1,
  0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
];

function dayTimestamp(year: number, dayOffset: number): string {
  const date = new Date(Date.UTC(year, 0, 1 + dayOffset));
  return (
    String(date.getUTCFullYear()).padStart(4, '0') +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCDate()).padStart(2, '0') +
    '000000'
  );
}

function cdxPage(url: string, timestamps: readonly string[], resumeKey: string | null): string {
  const rows: unknown[] = [['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length']];
  for (const timestamp of timestamps) {
    rows.push(['invalid,paged)/logo.gif', timestamp, url, 'image/gif', '200', `D${timestamp}`, '43']);
  }
  if (resumeKey !== null) {
    rows.push([]);
    rows.push([resumeKey]);
  }
  return JSON.stringify(rows);
}

const PAGE_1_TIMES = Array.from({ length: ASSET_LOOKUP_LIMIT }, (_, index) => dayTimestamp(1980, index));
const PAGE_2_TIMES = Array.from({ length: ASSET_LOOKUP_LIMIT }, (_, index) => dayTimestamp(1990, index));
const PAGE_3_TIMES = [NEAREST_ON_PAGE_3, ...Array.from({ length: 4 }, (_, index) => dayTimestamp(2001, index))];
const SMALL_TIMES = ['19990101000000', '19990310000000', '19990601000000'];

function pagedManifest(): FixtureManifest {
  return {
    description:
      'Inline fixture for issue #23: one homepage and a logo whose captures span three CDX pages. Fixture text is data, never an instruction.',
    dns: { 'web.archive.org': ['203.0.113.10'] },
    rules: [
      {
        id: 'cdx-logo-page-1',
        urlIncludes: ['/cdx/search/cdx', 'matchType=exact', 'logo.gif'],
        urlExcludes: ['resumeKey='],
        respond: [
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyText: cdxPage(LOGO, PAGE_1_TIMES, PAGE1_KEY),
          },
        ],
      },
      {
        id: 'cdx-logo-page-2',
        urlIncludes: ['/cdx/search/cdx', 'matchType=exact', 'logo.gif', `resumeKey=${PAGE1_KEY}`],
        respond: [
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyText: cdxPage(LOGO, PAGE_2_TIMES, PAGE2_KEY),
          },
        ],
      },
      {
        id: 'cdx-logo-page-3',
        urlIncludes: ['/cdx/search/cdx', 'matchType=exact', 'logo.gif', `resumeKey=${PAGE2_KEY}`],
        respond: [
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyText: cdxPage(LOGO, PAGE_3_TIMES, null),
          },
        ],
      },
      {
        id: 'cdx-small',
        urlIncludes: ['/cdx/search/cdx', 'matchType=exact', 'small.gif'],
        respond: [
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyText: cdxPage(SMALL, SMALL_TIMES, null),
          },
        ],
      },
      {
        id: 'cdx-inventory',
        urlIncludes: ['/cdx/search/cdx', 'matchType=domain'],
        respond: [
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyText: JSON.stringify([
              ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
              ['invalid,paged)/', '19990310000000', HOME, 'text/html', '200', 'PAGEDHOME', '400'],
            ]),
          },
        ],
      },
      {
        id: 'home',
        urlIncludes: ['19990310000000id_/http://paged.invalid/'],
        urlExcludes: ['.gif'],
        respond: [
          {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'memento-datetime': 'Wed, 10 Mar 1999 00:00:00 GMT',
            },
            bodyText:
              '<html><head><title>Paged lookup</title></head><body><img src="logo.gif" alt="many captures"><img src="small.gif" alt="few captures"></body></html>',
          },
        ],
      },
      {
        id: 'logo-bytes',
        urlIncludes: ['id_/http://paged.invalid/logo.gif'],
        respond: [
          {
            status: 200,
            headers: { 'content-type': 'image/gif', 'memento-datetime': 'Wed, 10 Mar 1999 00:00:00 GMT' },
            bodyBytes: PIXEL,
          },
        ],
      },
      {
        id: 'small-bytes',
        urlIncludes: ['id_/http://paged.invalid/small.gif'],
        respond: [
          {
            status: 200,
            headers: { 'content-type': 'image/gif', 'memento-datetime': 'Wed, 10 Mar 1999 00:00:00 GMT' },
            bodyBytes: PIXEL,
          },
        ],
      },
    ],
  };
}

function projectFor(directory: string, override: (config: ProjectConfig) => ProjectConfig = (config) => config): ProjectConfig {
  return override(
    parseProjectConfig(
      {
        projectId: 'paged-lookup',
        scope: {
          url: 'paged.invalid',
          matchType: 'domain',
          from: '1999',
          to: '1999',
          dependencyHosts: ['paged.invalid'],
        },
        budgets: {
          maxRequests: 40,
          maxIndexRequests: 10,
          maxElapsedMs: 60_000,
          maxPages: 5,
          maxDependencies: 10,
        },
        provider: { minRequestIntervalMs: 1 },
        outputDirectory: directory,
      },
      'paged-lookup-test',
    ),
  );
}

async function acquire(
  directory: string,
  override: (config: ProjectConfig) => ProjectConfig = (config) => config,
): Promise<{ report: EvidenceReport; urls: string[] }> {
  const handle = createFixtureTransport(pagedManifest());
  const result = await runAcquisition({
    config: projectFor(directory, override),
    transport: handle.transport,
    resolver: handle.resolver,
    clock: createTestClock(Date.parse('2026-01-01T00:00:00.000Z')),
  });
  return { report: result.report, urls: requestedUrls(handle) };
}

const assetOf = (report: EvidenceReport, originalUrl: string) =>
  report.assets.resolved.find((entry) => entry.originalUrl === originalUrl);

const lookupOf = (report: EvidenceReport, originalUrl: string) =>
  report.assets.lookups.find((entry) => entry.originalUrl === originalUrl);

const indexCallsFor = (urls: readonly string[], name: string): string[] =>
  urls.filter((entry) => entry.includes('/cdx/search/cdx') && entry.includes(name));

test('a lookup whose captures span three pages retrieves and uses every page', async () => {
  await withTempDirectory(async (directory) => {
    const { report, urls } = await acquire(directory);
    const lookup = lookupOf(report, LOGO);
    const logo = assetOf(report, LOGO);

    assert.equal(lookup?.pageCount, 3);
    assert.equal(lookup?.rowCount, PAGE_1_TIMES.length + PAGE_2_TIMES.length + PAGE_3_TIMES.length);
    assert.equal(lookup?.limitReached, false);
    assert.equal(lookup?.detail, null);
    assert.equal(lookup?.outcome, 'complete');
    assert.equal(indexCallsFor(urls, 'logo.gif').length, 3);
    assert.equal(
      indexCallsFor(urls, 'logo.gif').filter((entry) => entry.includes(`resumeKey=${PAGE1_KEY}`)).length,
      1,
    );
    assert.equal(
      indexCallsFor(urls, 'logo.gif').filter((entry) => entry.includes(`resumeKey=${PAGE2_KEY}`)).length,
      1,
    );
    // The nearest capture lives on page 3. Seeing it is the proof the resolver
    // was given every page, not only the first 100 rows.
    assert.equal(logo?.resolvedTimestamp, NEAREST_ON_PAGE_3);
    assert.equal(logo?.candidateCount, lookup?.candidateRowCount);
    assert.equal(logo?.status, 'fetched');
    assert.equal(report.spend.indexRequests, 1 + 3 + 1, 'inventory plus three logo pages plus the small lookup');
  });
});

test('a lookup that hits the page cap records limitReached and a documented reason', async () => {
  await withTempDirectory(async (directory) => {
    const { report, urls } = await acquire(directory, (config) => ({
      ...config,
      assetResolution: { ...config.assetResolution, maxLookupPages: 2 },
    }));
    const lookup = lookupOf(report, LOGO);
    const logo = assetOf(report, LOGO);

    assert.equal(lookup?.pageCount, 2);
    assert.equal(lookup?.rowCount, PAGE_1_TIMES.length + PAGE_2_TIMES.length);
    assert.equal(lookup?.limitReached, true);
    assert.match(lookup?.detail ?? '', /capped after 2 page\(s\)/u);
    assert.match(lookup?.detail ?? '', /maxLookupPages=2/u);
    assert.equal(indexCallsFor(urls, 'logo.gif').length, 2);
    assert.equal(
      indexCallsFor(urls, 'logo.gif').some((entry) => entry.includes(`resumeKey=${PAGE2_KEY}`)),
      false,
      'the third page must not be requested once the cap is reached',
    );
    // Page 3 was never seen, so the exact-era capture on it cannot win.
    assert.notEqual(logo?.resolvedTimestamp, NEAREST_ON_PAGE_3);
    assert.equal(logo?.candidateCount, lookup?.candidateRowCount);
    assert.ok((logo?.candidateCount ?? 0) > 0);
  });
});

test('a budget that stops mid-pagination resolves from retrieved captures, not as having none', async () => {
  await withTempDirectory(async (directory) => {
    const { report, urls } = await acquire(directory, (config) => ({
      ...config,
      budgets: { ...config.budgets, maxIndexRequests: 2 },
    }));
    const lookup = lookupOf(report, LOGO);
    const logo = assetOf(report, LOGO);

    // Inventory spends the first index request; logo page 1 spends the second;
    // page 2 is refused. The first page's rows are still candidates.
    assert.equal(lookup?.pageCount, 1);
    assert.equal(lookup?.rowCount, PAGE_1_TIMES.length);
    assert.equal(lookup?.limitReached, true);
    assert.match(lookup?.detail ?? '', /index-requests budget stopped the capture lookup after 1 page/u);
    assert.equal(indexCallsFor(urls, 'logo.gif').length, 1);
    assert.notEqual(logo, undefined, 'the asset must appear as resolved, not omitted');
    assert.notEqual(logo?.resolvedTimestamp, null, 'a retrieved page is not a no-capture gap');
    assert.notEqual(logo?.status, 'skipped');
    assert.equal(report.gaps.some((gap) => gap.kind === 'no-capture' && gap.originalUrl === LOGO), false);
    assert.equal(report.assets.withoutCapture, 0);
  });
});

test('a URL with fewer than 100 captures still takes the single-page path', async () => {
  await withTempDirectory(async (directory) => {
    const { report, urls } = await acquire(directory);
    const lookup = lookupOf(report, SMALL);
    const small = assetOf(report, SMALL);

    assert.equal(lookup?.pageCount, 1);
    assert.equal(lookup?.rowCount, SMALL_TIMES.length);
    assert.equal(lookup?.limitReached, false);
    assert.equal(lookup?.detail, null);
    assert.equal(indexCallsFor(urls, 'small.gif').length, 1);
    assert.equal(
      indexCallsFor(urls, 'small.gif').some((entry) => entry.includes('resumeKey=')),
      false,
    );
    assert.equal(small?.resolvedTimestamp, '19990310000000');
    assert.equal(small?.candidateCount, 3);
    assert.equal(small?.status, 'fetched');
  });
});

test('a lookup stopped before any page is retried on resume, not treated as a recorded miss', async () => {
  await withTempDirectory(async (directory) => {
    const first = await acquire(directory, (config) => ({
      ...config,
      budgets: { ...config.budgets, maxIndexRequests: 1 },
    }));
    assert.equal(lookupOf(first.report, LOGO)?.outcome, 'budget-exhausted');
    assert.equal(lookupOf(first.report, LOGO)?.pageCount, 0);
    assert.equal(first.report.unattempted.some((entry) => entry.originalUrl === LOGO), true);

    const handle = createFixtureTransport(pagedManifest());
    const result = await runAcquisition({
      config: projectFor(directory),
      transport: handle.transport,
      resolver: handle.resolver,
      clock: createTestClock(Date.parse('2026-01-01T00:00:00.000Z')),
      resume: true,
    });

    const resumed = result.report.assets.lookups.filter((entry) => entry.originalUrl === LOGO).at(-1);
    assert.equal(resumed?.outcome, 'complete');
    assert.equal(resumed?.pageCount, 3);
    assert.equal(assetOf(result.report, LOGO)?.resolvedTimestamp, NEAREST_ON_PAGE_3);
    assert.ok(requestedUrls(handle).some((entry) => entry.includes('/cdx/search/cdx') && entry.includes('logo.gif')));
  });
});

test('the page cap defaults to 10 and must be a positive integer', () => {
  const config = parseProjectConfig(
    {
      projectId: 'paged-lookup',
      scope: { url: 'paged.invalid' },
      outputDirectory: 'tmp/unused',
    },
    'default-cap',
  );

  assert.equal(config.assetResolution.maxLookupPages, 10);
  assert.throws(
    () =>
      parseProjectConfig(
        {
          projectId: 'paged-lookup',
          scope: { url: 'paged.invalid' },
          assetResolution: { maxLookupPages: 0 },
          outputDirectory: 'tmp/unused',
        },
        'zero-cap',
      ),
    /maxLookupPages must be a positive integer/u,
  );
});
