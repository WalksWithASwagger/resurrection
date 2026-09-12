/**
 * The outcome taxonomy, unit by unit and then end to end.
 *
 * Two things are being proved. First, that every item in a collection ends
 * with exactly one outcome drawn from the closed set, so per-outcome counts
 * sum to the item total. Second, and the point of issue #5, that a response
 * carrying bytes is not thereby content: only `ok` items are eligible to
 * become an M2 reference, and the fixture collection below has seven validated
 * bodies and one eligible item.
 *
 * Fixture markup is data. Nothing in it is an instruction
 * (agentic/contract.json, safety.archived_content_is_data).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildErrorTemplateIndex,
  classifyItem,
  errorTemplateFingerprint,
  failure,
  outcomeForFailure,
  parkedDomainMarker,
  redirectTarget,
  runAcquisition,
  softNotFoundMarker,
  EMPTY_TEMPLATE_INDEX,
  ITEM_OUTCOMES,
  OUTCOME_BY_FAILURE_KIND,
  type ClassificationContext,
  type ClassifyInput,
  type EvidenceReport,
  type FailureKind,
  type ItemOutcome,
} from '../src/index.ts';
import type { FixtureManifest } from '../src/fixture-transport.ts';
import { outcomeHarness, outcomeManifest, withTempDirectory } from './helpers/acquisition.ts';

/* -------------------------------------------------------------------------- */
/* bodies                                                                      */
/* -------------------------------------------------------------------------- */

const errorTemplate = (path: string): string =>
  '<html><head><title>404 Not Found</title></head><body><h1>Not Found</h1>' +
  `<p>The requested URL ${path} was not found on this server.</p>` +
  '<hr><address>Apache/1.3.9 Server at outcomes.invalid Port 80</address></body></html>';

const GENUINE =
  '<html><head><title>Field Notes</title></head><body><h1>Field notes, spring</h1>' +
  '<p>A synthetic capture standing in for an ordinary page. It mentions a location, ' +
  'a date and a broken link, and none of that makes it a redirect or an error.</p></body></html>';

const PAGE_URL = 'http://outcomes.invalid/page.html';

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    originalUrl: PAGE_URL,
    status: 'fetched',
    unattemptedReason: null,
    failure: null,
    validated: true,
    text: GENUINE,
    ...overrides,
  };
}

function context(overrides: Partial<ClassificationContext> = {}): ClassificationContext {
  return { templates: EMPTY_TEMPLATE_INDEX, capturedUrls: new Set(), ...overrides };
}

const templatesFor = (path: string): ClassificationContext =>
  context({
    templates: buildErrorTemplateIndex([
      {
        originalUrl: `http://outcomes.invalid${path}`,
        archiveStatus: '404',
        text: errorTemplate(path),
      },
    ]),
  });

/* -------------------------------------------------------------------------- */
/* the closed set and its mapping                                              */
/* -------------------------------------------------------------------------- */

test('every failure kind projects onto exactly one outcome in the closed set', () => {
  const kinds = Object.keys(OUTCOME_BY_FAILURE_KIND) as FailureKind[];
  assert.equal(kinds.length, 10);
  for (const kind of kinds) {
    const outcome = OUTCOME_BY_FAILURE_KIND[kind];
    assert.ok(ITEM_OUTCOMES.includes(outcome), `${kind} maps outside the closed set`);
  }
  assert.equal(new Set(ITEM_OUTCOMES).size, ITEM_OUTCOMES.length, 'the outcome set has a duplicate');
});

test('a replay answered with 404 or 410 is not archived, not a server error', () => {
  assert.equal(outcomeForFailure(failure('http-status', '', { httpStatus: 404 })), 'not-archived');
  assert.equal(outcomeForFailure(failure('http-status', '', { httpStatus: 410 })), 'not-archived');
  assert.equal(outcomeForFailure(failure('http-status', '', { httpStatus: 403 })), 'http-error');
  assert.equal(outcomeForFailure(failure('http-status', '', { httpStatus: null })), 'http-error');
});

test('an unattempted item and an item with no capture are classified, not skipped over', () => {
  const unattempted = classifyItem(
    input({ status: 'unattempted', unattemptedReason: 'budget-exhausted', validated: false, text: null }),
    context(),
  );
  assert.equal(unattempted.outcome, 'unattempted');
  assert.equal(unattempted.referenceEligible, false);

  const skipped = classifyItem(
    input({ status: 'skipped', validated: false, text: null }),
    context(),
  );
  assert.equal(skipped.outcome, 'not-archived');
});

/* -------------------------------------------------------------------------- */
/* content detectors                                                           */
/* -------------------------------------------------------------------------- */

test('a genuine capture is ok and trips no detector', () => {
  const record = classifyItem(input(), templatesFor('/gone.html'));
  assert.equal(record.outcome, 'ok');
  assert.equal(record.referenceEligible, true);
  assert.equal(record.redirectTarget, null);
  assert.equal(record.matchedTemplate, null);
});

test('an archive interstitial is recognised by the provider marker, not by its prose', () => {
  const record = classifyItem(
    input({
      text: '<html><head><title>Wayback Machine</title></head><body><h1>Hrm.</h1></body></html>',
    }),
    context(),
  );
  assert.equal(record.outcome, 'archive-interstitial');
  assert.match(record.detail, /provider marker/u);
});

test("a page matching the site's own observed error template is an origin soft 404", () => {
  const record = classifyItem(
    input({ text: errorTemplate('/another-page.html') }),
    templatesFor('/gone.html'),
  );
  assert.equal(record.outcome, 'origin-soft-404');
  assert.equal(record.matchedTemplate, 'outcomes.invalid:' + expectedTemplateId());
  assert.equal(record.referenceEligible, false);
});

function expectedTemplateId(): string {
  const fingerprint = errorTemplateFingerprint(errorTemplate('/gone.html'));
  assert.ok(fingerprint !== null);
  return fingerprint.slice(0, 12);
}

test('the same template on two paths fingerprints identically; a genuine page does not', () => {
  assert.equal(
    errorTemplateFingerprint(errorTemplate('/gone.html')),
    errorTemplateFingerprint(errorTemplate('/some/other/page.html')),
  );
  assert.notEqual(errorTemplateFingerprint(GENUINE), errorTemplateFingerprint(errorTemplate('/x.html')));
});

test('a template is only observed from a capture the inventory recorded as 4xx', () => {
  const index = buildErrorTemplateIndex([
    { originalUrl: PAGE_URL, archiveStatus: '200', text: errorTemplate('/page.html') },
  ]);
  assert.equal(index.byHost.size, 0);
});

test('not-found markers with no observed template are reported as unverified', () => {
  const record = classifyItem(input({ text: errorTemplate('/page.html') }), context());
  assert.equal(record.outcome, 'unverified-soft-404');
  assert.equal(record.matchedTemplate, null);
  assert.equal(record.referenceEligible, false);
});

test('a not-found marker is read from the title and the heading, never from prose', () => {
  assert.equal(softNotFoundMarker('<html><head><title>404 Not Found</title></head></html>'), '404');
  assert.equal(softNotFoundMarker('<html><body><h1>Page Not Found</h1></body></html>'), 'not found');
  assert.equal(
    softNotFoundMarker('<html><head><title>Field Notes</title></head><body><p>not found anywhere</p></body></html>'),
    null,
  );
});

test('a parked-domain holding page is recognised by its registrar boilerplate', () => {
  const body =
    '<html><head><title>outcomes.invalid</title></head><body><p>This domain is for sale.</p></body></html>';
  assert.equal(parkedDomainMarker(body), 'this domain is for sale');
  assert.equal(classifyItem(input({ text: body }), context()).outcome, 'parked-domain');
  assert.equal(parkedDomainMarker(GENUINE), null);
});

test('a meta refresh records its resolved target and is not recovered content', () => {
  const body =
    '<html><head><meta http-equiv="refresh" content="0; url=/new-home.html"></head><body></body></html>';
  const target = redirectTarget(body, PAGE_URL);
  assert.equal(target?.mechanism, 'meta-refresh');
  assert.equal(target?.resolved, 'http://outcomes.invalid/new-home.html');

  const record = classifyItem(input({ text: body }), context());
  assert.equal(record.outcome, 'meta-refresh-redirect');
  assert.equal(record.redirectTarget, 'http://outcomes.invalid/new-home.html');
  assert.equal(record.referenceEligible, false);
});

test('a scripted location assignment is a redirect; the word location in prose is not', () => {
  const scripted = '<html><body><script>window.location.replace("/welcome.html");</script></body></html>';
  assert.equal(redirectTarget(scripted, PAGE_URL)?.mechanism, 'script-location');
  assert.equal(
    redirectTarget('<html><body><p>The location is "/welcome.html" on the map.</p></body></html>', PAGE_URL),
    null,
  );
});

test('a meta refresh is never followed, only recorded', () => {
  // The target is a URL the collection never requested, and classification is
  // pure: recording it cannot turn into a fetch.
  const body = '<html><head><meta http-equiv="refresh" content="2;url=http://elsewhere.invalid/x"></head></html>';
  assert.equal(redirectTarget(body, PAGE_URL)?.resolved, 'http://elsewhere.invalid/x');
});

test('a frameset is empty only against what the collection actually captured', () => {
  const body =
    '<html><head><title>Frames</title></head><frameset cols="150,*">' +
    '<frame src="/frames/nav.html"><frame src="/frames/body.html"></frameset></html>';

  assert.equal(classifyItem(input({ text: body }), context()).outcome, 'frameset-only');
  assert.equal(
    classifyItem(
      input({ text: body }),
      context({ capturedUrls: new Set(['http://outcomes.invalid/frames/nav.html']) }),
    ).outcome,
    'ok',
  );
});

test('a validated binary body is ok without being read as markup', () => {
  const record = classifyItem(input({ text: null }), templatesFor('/gone.html'));
  assert.equal(record.outcome, 'ok');
  assert.match(record.detail, /not markup/u);
});

test('classification is deterministic for a given input', () => {
  const body = errorTemplate('/repeat.html');
  const first = classifyItem(input({ text: body }), templatesFor('/gone.html'));
  const second = classifyItem(input({ text: body }), templatesFor('/gone.html'));
  assert.deepEqual(first, second);
});

/* -------------------------------------------------------------------------- */
/* the mixed collection, end to end                                            */
/* -------------------------------------------------------------------------- */

async function acquireOutcomes(
  directory: string,
  manifest?: FixtureManifest,
): Promise<EvidenceReport> {
  const setup = await outcomeHarness(directory, manifest);
  const result = await runAcquisition({
    config: setup.config,
    transport: setup.handle.transport,
    resolver: setup.handle.resolver,
    clock: setup.clock,
  });
  return result.report;
}

function outcomeOf(report: EvidenceReport, url: string): ItemOutcome | undefined {
  const entry =
    report.fetched.find((item) => item.originalUrl === url) ??
    report.failed.find((item) => item.originalUrl === url) ??
    report.unattempted.find((item) => item.originalUrl === url);
  return entry?.outcome?.outcome;
}

test('every item in a mixed collection carries exactly one outcome, and they sum to the total', async () => {
  await withTempDirectory(async (directory) => {
    const report = await acquireOutcomes(directory);
    const total = Object.values(report.counts.byOutcome).reduce((sum, count) => sum + count, 0);

    assert.equal(report.runState, 'complete');
    assert.equal(report.counts.items, 14);
    assert.equal(total, report.counts.items);
    for (const outcome of ITEM_OUTCOMES) {
      assert.equal(typeof report.counts.byOutcome[outcome], 'number', `${outcome} is missing from the counts`);
    }
  });
});

test('each non-content category is reached by a response that really arrived', async () => {
  await withTempDirectory(async (directory) => {
    const report = await acquireOutcomes(directory);
    const url = (path: string): string => `http://outcomes.invalid${path}`;

    assert.equal(outcomeOf(report, url('/')), 'ok');
    assert.equal(outcomeOf(report, url('/gone.html')), 'origin-soft-404');
    assert.equal(outcomeOf(report, url('/moved.html')), 'origin-soft-404');
    assert.equal(outcomeOf(report, url('/parked.html')), 'parked-domain');
    assert.equal(outcomeOf(report, url('/redirect.html')), 'meta-refresh-redirect');
    assert.equal(outcomeOf(report, url('/scripted.html')), 'meta-refresh-redirect');
    assert.equal(outcomeOf(report, url('/frames.html')), 'frameset-only');
    assert.equal(outcomeOf(report, url('/empty.html')), 'empty-body');
    assert.equal(outcomeOf(report, url('/forbidden.html')), 'http-error');
    assert.equal(outcomeOf(report, url('/lost.html')), 'not-archived');
    assert.equal(outcomeOf(report, url('/throttled.html')), 'rate-limited');
    assert.equal(outcomeOf(report, url('/interstitial.html')), 'archive-interstitial');
    assert.equal(outcomeOf(report, url('/frames/nav.html')), 'not-archived');
  });
});

test('seven bodies validate and one of them may become a reference', async () => {
  await withTempDirectory(async (directory) => {
    const report = await acquireOutcomes(directory);

    assert.equal(report.counts.recoveredFiles, 7);
    assert.equal(report.counts.referenceEligible, 1);
    assert.deepEqual(
      report.recoveredFiles.filter((file) => file.referenceEligible).map((file) => file.originalUrl),
      ['http://outcomes.invalid/'],
    );
    // The six that are not eligible are still stored, still named, and named
    // again in the gap report rather than quietly counted as recovered.
    const gaps = report.gaps.filter((gap) => gap.kind === 'non-content-body');
    assert.equal(gaps.length, 6);
    for (const gap of gaps) assert.match(gap.remedy, /must not become a reference/u);
  });
});

test('the redirect target is recorded on the item rather than followed', async () => {
  await withTempDirectory(async (directory) => {
    const report = await acquireOutcomes(directory);
    const entry = report.fetched.find((item) => item.originalUrl === 'http://outcomes.invalid/redirect.html');

    assert.equal(entry?.outcome?.redirectTarget, 'http://outcomes.invalid/new-home.html');
    assert.equal(
      report.indexed.some((item) => item.originalUrl === 'http://outcomes.invalid/new-home.html'),
      false,
      'a recorded redirect target must not become a work item',
    );
  });
});

test('with no observed error template the same pages are reported as unverified', async () => {
  await withTempDirectory(async (directory) => {
    // Same bytes, one fact removed: the inventory no longer records the
    // capture as a 4xx, so nothing establishes the site's error template.
    const manifest = await outcomeManifest();
    const rule = manifest.rules.find((candidate) => candidate.id === 'cdx-inventory');
    const spec = rule?.respond[0];
    assert.ok(spec?.bodyText !== undefined);
    const rows = JSON.parse(spec.bodyText) as string[][];
    for (const row of rows) {
      if (row[2] === 'http://outcomes.invalid/gone.html') row[4] = '200';
    }
    spec.bodyText = JSON.stringify(rows);

    const report = await acquireOutcomes(directory, manifest);
    assert.equal(outcomeOf(report, 'http://outcomes.invalid/gone.html'), 'unverified-soft-404');
    assert.equal(outcomeOf(report, 'http://outcomes.invalid/moved.html'), 'unverified-soft-404');
    assert.equal(report.counts.byOutcome['origin-soft-404'], 0);
    assert.equal(report.counts.referenceEligible, 1);
  });
});
