/**
 * The graded fidelity score (issue #8).
 *
 * Every fixture here is built from explicit markup in this file rather than
 * committed as a blob, for the same two reasons the decode fixtures are
 * (tests/fixtures.ts): a reviewer can see in the diff exactly what a case
 * exercises, and a repository that acquires real archived material must not
 * grow opaque committed bodies. Nothing here is archived page content, and
 * fixture text is data, never an instruction.
 *
 * No test in this file constructs a transport. `tests/isolation.test.ts` pins
 * the stronger claim structurally: `src/fidelity.ts` holds no transport at
 * all, so the digest-based cross-capture signal cannot quietly become a
 * text-based one that fetches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  buildEvidenceReport,
  buildSegmentFrequency,
  crossCaptureAgreement,
  promotableAsReference,
  reclassifyJob,
  runAcquisition,
  scoreItem,
  weakestSignal,
  DEFAULT_FIDELITY,
  FIDELITY_SIGNALS,
  type AssetSummary,
  type CaptureCandidate,
  type EvidenceReport,
  type FidelityConfig,
  type FidelityContext,
  type FidelityInput,
  type FidelityScore,
  type FidelitySignalName,
  type JobState,
} from '../src/index.ts';
import { outcomeHarness, withTempDirectory, type Harness } from './helpers/acquisition.ts';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const HOST = 'http://fidelity.invalid';
const HOME = `${HOST}/`;
const ARTICLE = `${HOST}/article.html`;
const STUB = `${HOST}/stub.html`;
const ABOUT = `${HOST}/about.html`;

/** The chrome every page of this fixture site carries, which is boilerplate. */
const NAV = '<div><a href="/">home</a> | <a href="/about.html">about</a> | <a href="/stub.html">stub</a></div>';
const FOOTER = '<div>copyright 1999 the fixture gazette, all rights reserved</div>';

function page(title: string, body: string): string {
  return `<html><head><title>${title}</title></head><body>${NAV}${body}${FOOTER}</body></html>`;
}

/** Roughly 700 characters of prose that appears on exactly one page. */
const ARTICLE_BODY =
  '<p>the ferry left the dock at a quarter past six and the fog closed over the inlet behind it, ' +
  'so that the lights of the village went out one at a time rather than all together.</p>' +
  '<p>we had been told the crossing would take forty minutes and it took an hour and ten, which ' +
  'nobody on board seemed to think worth remarking on, least of all the deckhand.</p>' +
  '<p>by the time we tied up the rain had turned to something closer to sleet and the road up ' +
  'from the terminal was a long grey smear of headlights going nowhere in particular.</p>';

const ARTICLE_PAGE = page('the winter crossing', ARTICLE_BODY);
const STUB_PAGE = page('untitled', '<p>coming soon</p>');
const BARE_STUB_PAGE = `<html><head></head><body>${NAV}<p>tbd</p>${FOOTER}</body></html>`;
const ABOUT_PAGE = page('about', '<p>a fixture site that exists to be measured and nothing else.</p>');

/** A page whose five signals all land at different values, for the weight guard. */
const MIXED_PAGE = page(
  'mixed',
  '<p>a shorter piece, long enough to be a page and short enough not to be an article.</p>' +
    `<p>${'the ferry left the dock at a quarter past six and the fog closed over the inlet behind it, '}</p>`,
);

const COLLECTION = [ARTICLE_PAGE, STUB_PAGE, BARE_STUB_PAGE, ABOUT_PAGE, MIXED_PAGE];
const CAPTURED = new Set([HOME, ARTICLE, STUB, ABOUT]);

function context(overrides: Partial<FidelityConfig> = {}): FidelityContext {
  return {
    config: { ...DEFAULT_FIDELITY, ...overrides },
    segmentFrequency: buildSegmentFrequency(COLLECTION),
    capturedUrls: CAPTURED,
  };
}

function capture(timestamp: string, digest: string | null): CaptureCandidate {
  return { timestamp, digest, statusCode: '200', mimetype: 'text/html', length: 900, excludedBy: null };
}

const ONE_CAPTURE = [capture('19990601120000', 'FIDELITYDIGEST01')];
const AGREEING = [capture('19990601120000', 'SAMEDIGEST'), capture('19991201120000', 'SAMEDIGEST')];
const DISAGREEING = [capture('19990601120000', 'SAMEDIGEST'), capture('19991201120000', 'OTHERDIGEST')];

function input(overrides: Partial<FidelityInput> = {}): FidelityInput {
  return {
    originalUrl: ARTICLE,
    relation: 'page',
    outcome: 'ok',
    text: ARTICLE_PAGE,
    replacementRatio: 0,
    captures: ONE_CAPTURE,
    chosenTimestamp: '19990601120000',
    assets: [],
    ...overrides,
  };
}

function score(overrides: Partial<FidelityInput> = {}, config: Partial<FidelityConfig> = {}): FidelityScore {
  const result = scoreItem(input(overrides), context(config));
  assert.ok(result !== null, 'expected this input to be scoreable');
  return result;
}

function valueOf(result: FidelityScore, name: FidelitySignalName): number | null {
  return result.signals.find((signal) => signal.name === name)?.value ?? null;
}

function assets(count: number, resolved: number): AssetSummary[] {
  return Array.from({ length: count }, (_unused, index) => ({
    originalUrl: `${HOST}/image-${String(index)}.gif`,
    resolved: index < resolved,
    acquired: index < resolved,
    temporallyDistant: false,
  }));
}

/* -------------------------------------------------------------------------- */
/* bands                                                                       */
/* -------------------------------------------------------------------------- */

test('a rich content page scores in the accept band', () => {
  const result = score();

  assert.equal(result.band, 'accept');
  assert.ok(result.score >= DEFAULT_FIDELITY.thresholds.accept, `score was ${String(result.score)}`);
  assert.equal(result.promotionBlocked, false);
  assert.equal(valueOf(result, 'structure'), 1);
  assert.equal(valueOf(result, 'boilerplate'), 1);
});

test('a near-empty stub scores in the review-required band', () => {
  const result = score({ originalUrl: STUB, text: STUB_PAGE });

  assert.equal(result.band, 'review-required');
  assert.ok(result.score < DEFAULT_FIDELITY.thresholds.acceptWithWarning, `score was ${String(result.score)}`);
  assert.equal(weakestSignal(result)?.name, 'boilerplate');
  // The stub's own words are two of the roughly ninety visible characters on
  // the page; everything else is the navigation bar and the footer.
  const boilerplate = result.signals.find((signal) => signal.name === 'boilerplate');
  assert.ok((boilerplate?.measurements['uniqueRatio'] as number) < 0.2);
});

test('a stub with no title at all scores below a stub that has one', () => {
  const titled = score({ originalUrl: STUB, text: STUB_PAGE });
  const bare = score({ originalUrl: STUB, text: BARE_STUB_PAGE });

  assert.ok(bare.score < titled.score, `${String(bare.score)} should be below ${String(titled.score)}`);
  assert.equal(bare.signals.find((signal) => signal.name === 'structure')?.measurements['hasTitle'], false);
});

/* -------------------------------------------------------------------------- */
/* individual signals                                                          */
/* -------------------------------------------------------------------------- */

test('heavy mojibake moves the replacement-character signal and the score', () => {
  const clean = score({ replacementRatio: 0 });
  const damaged = score({ replacementRatio: 0.04 });
  const ruined = score({ replacementRatio: 0.2 });

  assert.equal(valueOf(clean, 'encoding'), 1);
  assert.equal(valueOf(damaged, 'encoding'), 0.2);
  assert.equal(valueOf(ruined, 'encoding'), 0);
  assert.ok(damaged.score < clean.score);
  assert.ok(ruined.score < damaged.score);
  // The signal moves the band, not only the number: the same structurally
  // perfect article falls out of `accept` and then out of acceptance entirely.
  assert.deepEqual(
    [clean.band, damaged.band, ruined.band],
    ['accept', 'accept-with-warning', 'review-required'],
  );
  // Same markup, same links, same collection: only the ratio changed.
  assert.equal(valueOf(ruined, 'structure'), valueOf(clean, 'structure'));
});

test('a page whose assets are mostly unresolved moves the asset signal and the score', () => {
  const complete = score({ assets: assets(4, 4) });
  const mostlyMissing = score({ assets: assets(4, 1) });

  assert.equal(valueOf(complete, 'assets'), 1);
  assert.equal(valueOf(mostlyMissing, 'assets'), 0.25);
  assert.ok(mostlyMissing.score < complete.score);
  assert.equal(
    mostlyMissing.signals.find((signal) => signal.name === 'assets')?.measurements['unresolved'],
    3,
  );
});

test('a page that references no dependency has no asset signal rather than a free one', () => {
  const result = score({ assets: [] });
  const signal = result.signals.find((entry) => entry.name === 'assets');

  assert.equal(signal?.value, null);
  assert.equal(signal?.contribution, 0);
  assert.match(signal?.detail ?? '', /no completeness to measure/u);
  // The weight it would have carried is not in the denominator either: only
  // structure, boilerplate and the replacement ratio were measurable here.
  const { structure, boilerplate, encoding } = DEFAULT_FIDELITY.weights;
  assert.equal(result.appliedWeight, structure + boilerplate + encoding);
});

/* -------------------------------------------------------------------------- */
/* cross-capture agreement                                                     */
/* -------------------------------------------------------------------------- */

test('two adjacent captures with the same digest corroborate the acquired bytes', () => {
  const agreement = crossCaptureAgreement(AGREEING, '19990601120000');

  assert.equal(agreement.state, 'identical');
  assert.equal(agreement.captureCount, 2);
  assert.equal(agreement.comparedTimestamp, '19991201120000');
  assert.equal(valueOf(score({ captures: AGREEING }), 'cross-capture'), 1);
});

test('a differing digest is recorded as a difference and scored as no evidence at all', () => {
  const agreement = crossCaptureAgreement(DISAGREEING, '19990601120000');
  const result = score({ captures: DISAGREEING });
  const signal = result.signals.find((entry) => entry.name === 'cross-capture');

  assert.equal(agreement.state, 'different');
  assert.equal(agreement.comparedTimestamp, '19991201120000');
  // The limitation, asserted: a digest proves difference, never magnitude, so
  // the signal contributes nothing rather than inventing a penalty.
  assert.equal(signal?.value, null);
  assert.equal(signal?.contribution, 0);
  assert.equal(signal?.measurements['state'], 'different');
  assert.equal(result.score, score({ captures: ONE_CAPTURE }).score);
});

test('a page with exactly one capture reports the single-capture state', () => {
  const agreement = crossCaptureAgreement(ONE_CAPTURE, '19990601120000');
  const signal = score({ captures: ONE_CAPTURE }).signals.find((entry) => entry.name === 'cross-capture');

  assert.equal(agreement.state, 'single-capture');
  assert.equal(agreement.captureCount, 1);
  assert.equal(agreement.comparedTimestamp, null);
  assert.equal(signal?.value, null);
  assert.match(signal?.detail ?? '', /nothing to compare against/u);
});

test('a missing provider digest is reported as unavailable, not as agreement', () => {
  const agreement = crossCaptureAgreement(
    [capture('19990601120000', null), capture('19991201120000', 'SOMEDIGEST')],
    '19990601120000',
  );

  assert.equal(agreement.state, 'digest-unavailable');
  assert.equal(agreement.captureCount, 2);
});

test('agreement corroborates: the same page scores higher when an adjacent capture matches', () => {
  const corroborated = score({ captures: AGREEING, replacementRatio: 0.03 });
  const alone = score({ captures: ONE_CAPTURE, replacementRatio: 0.03 });

  assert.ok(corroborated.score > alone.score, `${String(corroborated.score)} should exceed ${String(alone.score)}`);
});

/* -------------------------------------------------------------------------- */
/* the #5 gate                                                                 */
/* -------------------------------------------------------------------------- */

test('an item whose outcome is not ok is never scored', () => {
  for (const outcome of ['origin-soft-404', 'parked-domain', 'archive-interstitial', 'unattempted'] as const) {
    assert.equal(scoreItem(input({ outcome }), context()), null, `${outcome} must not be scored`);
  }
});

test('a validated binary body is not scored, because there is no page to score', () => {
  assert.equal(scoreItem(input({ text: null }), context()), null);
});

test('a stylesheet is not a page, even though it decodes as text and classifies as ok', () => {
  // A stylesheet has no title and no outgoing links. Scoring it as a page
  // would report it as review-required for both, which is true of every
  // stylesheet ever written and useless as a fidelity verdict.
  for (const relation of ['stylesheet', 'script', 'image', 'document'] as const) {
    assert.equal(scoreItem(input({ relation, text: 'body { color: #000; }' }), context()), null, relation);
  }
  assert.notEqual(scoreItem(input({ relation: 'frame', text: ARTICLE_PAGE }), context()), null);
});

test('a review-required page is blocked from promotion until an override is recorded', () => {
  const blocked = score({ originalUrl: STUB, text: STUB_PAGE });
  assert.equal(blocked.promotionBlocked, true);
  assert.equal(blocked.override, null);

  const overridden = score(
    { originalUrl: STUB, text: STUB_PAGE },
    {
      overrides: [
        { originalUrl: STUB, reason: 'the only surviving capture of this page', recordedBy: 'fixture-operator' },
      ],
    },
  );
  assert.equal(overridden.band, 'review-required', 'an override lifts the block, never the band');
  assert.equal(overridden.promotionBlocked, false);
  assert.equal(overridden.override?.recordedBy, 'fixture-operator');
});

test('an override recorded for a page the score already accepts changes nothing', () => {
  const result = score(
    {},
    { overrides: [{ originalUrl: ARTICLE, reason: 'not needed', recordedBy: 'fixture-operator' }] },
  );

  assert.equal(result.band, 'accept');
  assert.equal(result.promotionBlocked, false);
  assert.equal(result.override, null, 'an override is only recorded where it actually lifted a block');
});

/* -------------------------------------------------------------------------- */
/* the weights are not decorative                                              */
/* -------------------------------------------------------------------------- */

const MIXED: Partial<FidelityInput> = {
  originalUrl: `${HOST}/mixed.html`,
  text: MIXED_PAGE,
  replacementRatio: 0.02,
  captures: AGREEING,
  assets: assets(4, 2),
};

test('every weight matters: changing any one of them changes the score', () => {
  const baseline = score(MIXED);
  // The guard is only meaningful if every signal was actually measured here.
  assert.equal(
    baseline.signals.filter((signal) => signal.value === null).length,
    0,
    'this fixture must measure all five signals',
  );

  for (const name of FIDELITY_SIGNALS) {
    const bumped = score(MIXED, {
      weights: { ...DEFAULT_FIDELITY.weights, [name]: DEFAULT_FIDELITY.weights[name] + 0.2 },
    });
    assert.notEqual(bumped.score, baseline.score, `changing the ${name} weight did not change the score`);
  }
});

test('the composite is exactly the weighted mean of the signals it reports', () => {
  const result = score(MIXED);
  const applied = result.signals.filter((signal) => signal.value !== null);
  const total = applied.reduce((sum, signal) => sum + signal.contribution, 0);
  const weight = applied.reduce((sum, signal) => sum + signal.weight, 0);

  assert.equal(result.appliedWeight, Math.round(weight * 10_000) / 10_000);
  assert.ok(Math.abs(result.score - total / weight) < 1e-4, 'the composite must be reconstructible by hand');
  for (const signal of applied) {
    assert.ok(Math.abs(signal.contribution - (signal.value ?? 0) * signal.weight) < 1e-4);
  }
});

test('a band can be moved by changing thresholds alone, and the thresholds travel with the score', () => {
  const strict = score(MIXED, { thresholds: { accept: 0.99, acceptWithWarning: 0.98 } });

  assert.equal(strict.band, 'review-required');
  assert.deepEqual(strict.thresholds, { accept: 0.99, acceptWithWarning: 0.98 });
});

/* -------------------------------------------------------------------------- */
/* end to end, over an acquired collection                                     */
/* -------------------------------------------------------------------------- */

async function acquire(directory: string): Promise<{ state: JobState; report: EvidenceReport; setup: Harness }> {
  const setup = await outcomeHarness(directory);
  const result = await runAcquisition({
    config: setup.config,
    transport: setup.handle.transport,
    resolver: setup.handle.resolver,
    clock: setup.clock,
  });
  return { state: result.state, report: result.report, setup };
}

test('the report carries the full per-signal breakdown, not only the composite', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);

    assert.equal(report.schemaVersion, 4);
    assert.equal(report.fidelity.counts.scored, 1, 'only the one ok page is scored');
    const scored = report.fidelity.scored[0];
    assert.ok(scored !== undefined);
    assert.equal(scored.originalUrl, 'http://outcomes.invalid/');
    assert.equal(scored.gateOutcome, 'ok');
    assert.deepEqual(
      scored.signals.map((signal) => signal.name),
      [...FIDELITY_SIGNALS],
    );
    for (const signal of scored.signals) {
      assert.equal(typeof signal.weight, 'number');
      assert.ok(signal.detail.length > 0, `${signal.name} must say what it measured`);
      assert.ok(Object.keys(signal.measurements).length > 0, `${signal.name} must carry its measurements`);
    }
  });
});

test('a score is never emitted for an item whose outcome is not ok', async () => {
  await withTempDirectory(async (directory) => {
    const { state, report } = await acquire(directory);

    for (const item of state.items) {
      if (item.outcome?.outcome === 'ok') continue;
      assert.equal(item.fidelity, null, `${item.originalUrl} has outcome ${String(item.outcome?.outcome)}`);
    }
    assert.equal(
      report.fidelity.scored.every((entry) => entry.gateOutcome === 'ok'),
      true,
    );
  });
});

test('promotion composes with issue 5 rather than competing with it', async () => {
  await withTempDirectory(async (directory) => {
    const { state, report } = await acquire(directory);

    // Issue #5's rule is untouched and still the outcome axis on its own.
    assert.equal(report.counts.referenceEligible, 1);
    for (const item of state.items) {
      if (!promotableAsReference(item)) continue;
      assert.equal(item.outcome?.referenceEligible, true, 'promotion never widens the outcome gate');
    }
    // And the composed count never exceeds it.
    assert.ok(report.fidelity.counts.promotable <= report.counts.referenceEligible);
  });
});

test('rescoring a cached collection makes no request and reaches the same scores', async () => {
  await withTempDirectory(async (directory) => {
    const { state, setup } = await acquire(directory);
    const before = setup.handle.calls.length;
    const original = state.items.map((item) => item.fidelity?.score ?? null);

    const first = await reclassifyJob(directory);
    const second = await reclassifyJob(directory);

    assert.equal(setup.handle.calls.length, before, 'rescoring issued a request');
    assert.deepEqual(
      first.state.items.map((item) => item.fidelity?.score ?? null),
      original,
    );
    assert.deepEqual(second.summary.fidelity, first.summary.fidelity);
    assert.equal(first.summary.fidelity.scored + first.summary.fidelity.gatedByOutcome, 14);
  });
});

test('a recorded override travels from project configuration into the report', async () => {
  await withTempDirectory(async (directory) => {
    const { setup } = await acquire(directory);
    const url = 'http://outcomes.invalid/';
    const before = setup.handle.calls.length;

    // Thresholds that no page can meet, so the one ok page is blocked, and an
    // override recorded against it. Both come from configuration, so the
    // decision is reviewable in a diff rather than a runtime gesture.
    const blocked = await reclassifyJob(directory, {
      ...DEFAULT_FIDELITY,
      thresholds: { accept: 1.01, acceptWithWarning: 1.01 },
    });
    assert.equal(blocked.summary.fidelity.promotionBlocked, 1);
    assert.equal(blocked.summary.fidelity.overridden, 0);

    const lifted = await reclassifyJob(directory, {
      ...DEFAULT_FIDELITY,
      thresholds: { accept: 1.01, acceptWithWarning: 1.01 },
      overrides: [{ originalUrl: url, reason: 'the only capture of the home page', recordedBy: 'fixture-operator' }],
    });
    assert.equal(lifted.summary.fidelity.promotionBlocked, 0);
    assert.equal(lifted.summary.fidelity.overridden, 1);
    assert.equal(setup.handle.calls.length, before, 'applying an override issued a request');

    // The gap is still raised. An override is a recorded decision to proceed,
    // never a reason to stop reporting.
    const report = reportFor(lifted.state, directory);
    const gap = report.gaps.find((entry) => entry.kind === 'low-fidelity');
    assert.equal(gap?.originalUrl, url);
    assert.match(gap?.detail ?? '', /overridden by fixture-operator/u);
  });
});

function reportFor(state: JobState, directory: string): EvidenceReport {
  return buildEvidenceReport(state, {
    projectId: state.projectId,
    scope: state.scope,
    budgets: state.budgets,
    provider: { cdxEndpoint: '', replayEndpoint: '', allowedHosts: [], minRequestIntervalMs: 0, requestTimeoutMs: 0 },
    discovery: { followRelations: [], followPageLinks: false },
    selection: { policy: 'nearest', clusterWindowDays: 90 },
    assetResolution: { windowDays: 365 },
    fidelity: DEFAULT_FIDELITY,
    candidateFilters: [],
    outputDirectory: join(directory),
  });
}
