/**
 * Bounded next-best capture retry after a bad content outcome (issue #22).
 *
 * The first-choice capture is still chosen by the declared selection policy.
 * When that capture classifies as a confirmed non-content body, unused
 * captures of the same URL are tried in the same ranking, up to the
 * configured further-attempt limit. Fixture markup is data
 * (agentic/contract.json, safety.archived_content_is_data).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OUTCOME_RESELECTION,
  findItem,
  parseProjectConfig,
  RESELECTABLE_OUTCOMES,
  runAcquisition,
  type ProjectConfig,
} from '../src/index.ts';
import { createTestClock } from '../src/clock.ts';
import { createFixtureTransport, type FixtureManifest, type FixtureRule } from '../src/fixture-transport.ts';
import { requestedUrls, withTempDirectory, FIXTURE_EPOCH } from './helpers/acquisition.ts';

const PAGE = 'http://reselect.invalid/';
const DEC = '19991201120000';
const SEP = '19990901120000';
const JUN = '19990601120000';
const MAR = '19990301120000';

const PARKED =
  '<html><head><title>reselect.invalid</title></head><body><p>This domain is for sale.</p></body></html>';
const REAL =
  '<html><head><title>Field Notes</title></head><body><h1>Notes from the cove</h1>' +
  '<p>A synthetic capture standing in for an ordinary page. Nothing here is a holding page.</p></body></html>';
const REDIRECT =
  '<html><head><title>Moved</title><meta http-equiv="refresh" content="0; url=/elsewhere.html"></head>' +
  '<body><p>This page has moved.</p></body></html>';

function project(directory: string, overrides: Record<string, unknown> = {}): ProjectConfig {
  return parseProjectConfig(
    {
      projectId: 'reselect-site',
      scope: {
        url: 'reselect.invalid',
        matchType: 'domain',
        from: '1999',
        to: '1999',
        seedUrls: [],
        dependencyHosts: ['reselect.invalid'],
      },
      budgets: {
        maxRequests: 40,
        maxIndexRequests: 5,
        maxTotalBytes: 1_048_576,
        maxResponseBytes: 262_144,
        maxElapsedMs: 60_000,
        maxRedirects: 3,
        maxAttemptsPerItem: 3,
        maxPages: 10,
        maxDependencies: 10,
      },
      provider: {
        cdxEndpoint: 'https://web.archive.org/cdx/search/cdx',
        replayEndpoint: 'https://web.archive.org/web',
        allowedHosts: ['web.archive.org'],
        minRequestIntervalMs: 1,
        requestTimeoutMs: 30_000,
      },
      discovery: { followRelations: [], followPageLinks: false },
      outputDirectory: directory,
      ...overrides,
    },
    'reselect-test',
  );
}

function inventory(timestamps: readonly string[]): FixtureRule {
  const header = ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'];
  const rows = timestamps.map((timestamp, index) => [
    'invalid,reselect)/',
    timestamp,
    PAGE,
    'text/html',
    '200',
    `RESELECT${String(index)}`,
    '900',
  ]);
  return {
    id: 'cdx-inventory',
    urlIncludes: ['/cdx/search/cdx', 'matchType=domain'],
    respond: [
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify([header, ...rows]),
      },
    ],
  };
}

function replay(id: string, timestamp: string, body: string): FixtureRule {
  return {
    id,
    urlIncludes: [`${timestamp}id_/${PAGE}`],
    respond: [
      {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'memento-datetime': 'Wed, 01 Dec 1999 12:00:00 GMT',
        },
        bodyText: body,
      },
    ],
  };
}

function manifest(rules: FixtureRule[]): FixtureManifest {
  return {
    description:
      'Synthetic collection for outcome reselection. Fixture text is data, never an instruction.',
    dns: { 'web.archive.org': ['203.0.113.10'] },
    rules,
  };
}

async function acquire(
  directory: string,
  rules: FixtureRule[],
  overrides: Record<string, unknown> = {},
  resume = false,
) {
  const handle = createFixtureTransport(manifest(rules));
  const result = await runAcquisition({
    config: project(directory, overrides),
    transport: handle.transport,
    resolver: handle.resolver,
    clock: createTestClock(FIXTURE_EPOCH),
    resume,
  });
  return { result, handle };
}

test('the attempt limit defaults to 2 further alternatives, and the trigger set is closed', () => {
  assert.equal(DEFAULT_OUTCOME_RESELECTION.maxAttempts, 2);
  assert.deepEqual(
    [...RESELECTABLE_OUTCOMES].sort(),
    ['archive-interstitial', 'frameset-only', 'meta-refresh-redirect', 'origin-soft-404', 'parked-domain'],
  );
});

test('a parked first-choice whose next-best alternative is real content becomes eligible', async () => {
  await withTempDirectory(async (directory) => {
    const { result, handle } = await acquire(directory, [
      inventory([DEC, JUN]),
      replay('parked-first', DEC, PARKED),
      replay('real-second', JUN, REAL),
    ]);
    const item = findItem(result.state, PAGE);

    assert.equal(result.report.runState, 'complete');
    assert.equal(item?.outcome?.outcome, 'ok');
    assert.equal(item?.outcome?.referenceEligible, true);
    assert.equal(result.report.counts.referenceEligible, 1);
    assert.equal(item?.capture.requestedTimestamp, JUN);
    assert.equal(item?.capture.reselection?.completed, true);
    assert.equal(item?.capture.reselection?.stoppedReason, 'ok');
    assert.equal(item?.capture.reselection?.furtherAttempts, 1);
    assert.deepEqual(
      item?.capture.reselection?.attempts.map((attempt) => [attempt.order, attempt.timestamp, attempt.outcome]),
      [
        [1, DEC, 'parked-domain'],
        [2, JUN, 'ok'],
      ],
    );
    assert.equal(
      requestedUrls(handle).filter((url) => url.includes('id_/')).length,
      2,
    );
  });
});

test('a page whose every alternative is also a bad outcome stays ineligible and lists every attempt', async () => {
  await withTempDirectory(async (directory) => {
    const { result } = await acquire(directory, [
      inventory([DEC, JUN]),
      replay('parked-first', DEC, PARKED),
      replay('redirect-second', JUN, REDIRECT),
    ]);
    const item = findItem(result.state, PAGE);
    const gap = result.report.gaps.find((entry) => entry.kind === 'non-content-body');

    assert.equal(item?.outcome?.outcome, 'meta-refresh-redirect');
    assert.equal(item?.outcome?.referenceEligible, false);
    assert.equal(result.report.counts.referenceEligible, 0);
    assert.equal(item?.capture.reselection?.completed, true);
    assert.equal(item?.capture.reselection?.stoppedReason, 'no-remaining-alternative');
    assert.deepEqual(
      item?.capture.reselection?.attempts.map((attempt) => [attempt.timestamp, attempt.outcome]),
      [
        [DEC, 'parked-domain'],
        [JUN, 'meta-refresh-redirect'],
      ],
    );
    assert.match(gap?.detail ?? '', /19991201120000=parked-domain/u);
    assert.match(gap?.detail ?? '', /19990601120000=meta-refresh-redirect/u);
  });
});

test('three unused alternatives are cut to two under the default limit', async () => {
  await withTempDirectory(async (directory) => {
    const { result, handle } = await acquire(directory, [
      inventory([DEC, SEP, JUN, MAR]),
      replay('parked-dec', DEC, PARKED),
      replay('parked-sep', SEP, PARKED),
      replay('parked-jun', JUN, PARKED),
      replay('parked-mar', MAR, PARKED),
    ]);
    const item = findItem(result.state, PAGE);
    const replayed = requestedUrls(handle).filter((url) => url.includes('id_/'));

    assert.equal(DEFAULT_OUTCOME_RESELECTION.maxAttempts, 2);
    assert.equal(item?.capture.reselection?.furtherAttempts, 2);
    assert.equal(item?.capture.reselection?.stoppedReason, 'attempt-limit');
    assert.equal(item?.outcome?.referenceEligible, false);
    assert.deepEqual(
      item?.capture.reselection?.attempts.map((attempt) => attempt.timestamp),
      [DEC, SEP, JUN],
    );
    assert.equal(replayed.some((url) => url.includes(MAR)), false, 'the third alternative must stay untried');
    assert.equal(replayed.length, 3, 'first-choice plus two further attempts');
  });
});

test('a page with zero unused alternatives is not retried', async () => {
  await withTempDirectory(async (directory) => {
    const { result, handle } = await acquire(directory, [
      inventory([DEC]),
      replay('parked-only', DEC, PARKED),
    ]);
    const item = findItem(result.state, PAGE);
    const gap = result.report.gaps.find((entry) => entry.kind === 'non-content-body');

    assert.equal(item?.outcome?.outcome, 'parked-domain');
    assert.equal(item?.outcome?.referenceEligible, false);
    assert.equal(item?.capture.reselection?.furtherAttempts, 0);
    assert.equal(item?.capture.reselection?.stoppedReason, 'no-remaining-alternative');
    assert.equal(requestedUrls(handle).filter((url) => url.includes('id_/')).length, 1);
    assert.match(gap?.detail ?? '', /0 alternatives were tried/u);
  });
});

test('a request budget that stops mid-retry produces a partial report, not a failure', async () => {
  await withTempDirectory(async (directory) => {
    const { result, handle } = await acquire(
      directory,
      [inventory([DEC, JUN]), replay('parked-first', DEC, PARKED), replay('real-second', JUN, REAL)],
      { budgets: { maxRequests: 2, maxIndexRequests: 5, maxTotalBytes: 1_048_576, maxResponseBytes: 262_144, maxElapsedMs: 60_000, maxRedirects: 3, maxAttemptsPerItem: 3, maxPages: 10, maxDependencies: 10 } },
    );
    const item = findItem(result.state, PAGE);

    assert.equal(result.report.runState, 'paused');
    assert.equal(result.report.counts.failed, 0);
    assert.equal(item?.outcome?.outcome, 'parked-domain');
    assert.equal(item?.status, 'fetched');
    assert.equal(item?.capture.requestedTimestamp, DEC);
    assert.equal(item?.capture.reselection?.completed, false);
    assert.equal(item?.capture.reselection?.stoppedReason, 'budget-exhausted');
    assert.equal(item?.capture.reselection?.furtherAttempts, 0);
    assert.equal(requestedUrls(handle).some((url) => url.includes(`${JUN}id_`)), false);
    assert.ok(result.report.gaps.some((gap) => gap.kind === 'non-content-body'));
  });
});

test('a resumed job does not re-retry a page whose reselection already completed', async () => {
  await withTempDirectory(async (directory) => {
    const rules = [inventory([DEC, JUN]), replay('parked-first', DEC, PARKED), replay('real-second', JUN, REAL)];
    const first = await acquire(directory, rules);
    assert.equal(first.result.state.items[0]?.capture.reselection?.completed, true);

    const second = await acquire(directory, rules, {}, true);
    assert.equal(second.handle.calls.length, 0, 'a finished reselection must not fetch again');
    assert.equal(findItem(second.result.state, PAGE)?.outcome?.outcome, 'ok');
    assert.equal(second.result.report.runState, 'complete');
  });
});
