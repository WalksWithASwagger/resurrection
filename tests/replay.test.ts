/**
 * The pinned query shape, the replay modifiers and the timeline, end to end.
 *
 * The unit suites prove each rule in isolation. This one proves the rules are
 * actually wired into an acquisition: that the query really carries the pinned
 * parameters, that an excluded capture is really never requested while still
 * appearing in the record, that a frame really goes out with `if_` while a
 * page goes out with `id_`, and that a run which filled its index limit is
 * never reported as a complete inventory.
 *
 * Every byte comes from `fixtures/replay-site`. No socket is opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAcquisition, type EvidenceReport } from '../src/index.ts';
import { replayHarness, requestedUrls, withTempDirectory, type Harness } from './helpers/acquisition.ts';

const HOME = 'http://replay.invalid/';
const FRAMED = 'http://replay.invalid/framed.html';
const REWRITTEN = 'http://replay.invalid/rewritten.html';

async function acquire(directory: string): Promise<{ report: EvidenceReport; setup: Harness }> {
  const setup = await replayHarness(directory);
  const result = await runAcquisition({
    config: setup.config,
    transport: setup.handle.transport,
    resolver: setup.handle.resolver,
    clock: setup.clock,
  });
  return { report: result.report, setup };
}

test('the issued CDX query is recorded verbatim and carries the pinned parameters', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const [query] = report.inventory.queries;

    assert.equal(report.inventory.queries.length, 1);
    const parameters = new URL(query ?? '').searchParams;
    assert.equal(parameters.get('output'), 'json');
    assert.equal(parameters.get('fl'), 'urlkey,timestamp,original,mimetype,statuscode,digest,length');
    assert.equal(parameters.get('collapse'), 'digest');
    assert.equal(parameters.get('matchType'), 'domain');
    assert.equal(parameters.get('limit'), '12');
    assert.equal(parameters.get('showResumeKey'), 'true');
    // Not sent upstream on purpose: the provider would drop the very rows the
    // timeline is built from.
    assert.deepEqual(parameters.getAll('filter'), []);
  });
});

test('the candidate rule applied to the rows is named in the report', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);

    assert.deepEqual(report.inventory.candidateFilters, ['statuscode:200']);
    const [run] = report.inventory.runs;
    assert.equal(run?.rowCount, 12);
    assert.equal(run?.candidateRowCount, 10);
    assert.equal(run?.timelineRowCount, 2);
  });
});

test('non-200 captures are retained as timeline evidence and never requested', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);

    assert.equal(report.counts.timelineRows, 2);
    assert.deepEqual(
      report.inventory.timeline.map((entry) => [entry.timestamp, entry.statusCode]),
      [
        ['19990601000000', '302'],
        ['19991101000000', '404'],
      ],
    );
    for (const entry of report.inventory.timeline) {
      assert.equal(entry.originalUrl, HOME);
      assert.equal(entry.excludedBy, 'statuscode:200');
      assert.equal(entry.digest === '', false, 'an excluded row keeps its full metadata');
      assert.equal(
        requestedUrls(setup.handle).some((url) => url.includes(entry.timestamp)),
        false,
        `${entry.timestamp} is evidence, not an acquisition candidate`,
      );
    }
  });
});

test('the excluded captures are still on the item, so reselection needs no index request', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const home = report.indexed.find((entry) => entry.originalUrl === HOME);

    assert.deepEqual(home?.alternatives, [
      '19990201000000',
      '19990901000000',
      '19990601000000',
      '19991101000000',
    ]);
    assert.equal(home?.requestedTimestamp, '19990901000000');
    assert.equal(home?.selection?.policy, 'nearest');
    assert.equal(home?.selection?.target, '19991231235959');
    assert.equal(home?.selection?.consideredCount, 2, 'only the two 200 captures were in the pool');
    assert.equal(home?.selection?.fromExcludedCapture, false);
  });
});

test('a page goes out with id_ and a frame with if_, and each item records which', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);
    const home = report.fetched.find((entry) => entry.originalUrl === HOME);
    const framed = report.fetched.find((entry) => entry.originalUrl === FRAMED);

    assert.equal(home?.replayModifier, 'id_');
    assert.equal(framed?.replayModifier, 'if_');
    assert.match(home?.requestUrl ?? '', /\/19990901000000id_\/http:\/\/replay\.invalid\/$/u);
    assert.match(framed?.requestUrl ?? '', /\/19990901000000if_\/http:\/\/replay\.invalid\/framed\.html$/u);
    assert.equal(
      requestedUrls(setup.handle).some((url) => url.includes('id_/http://replay.invalid/framed.html')),
      false,
      'a frame must not be requested with the identity modifier',
    );
  });
});

test('identity-fetched bytes carry no injected markup, so the strip does nothing', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const home = report.fetched.find((entry) => entry.originalUrl === HOME);

    assert.equal(home?.archiveInjection?.scanned, true);
    assert.equal(home?.archiveInjection?.removedNodes, 0);
    assert.equal(home?.archiveInjection?.removedCharacters, 0);
    assert.deepEqual(home?.archiveInjection?.residualMarkers, []);
  });
});

test('a body that does carry replay furniture is stripped, gapped and still stored', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const rewritten = report.fetched.find((entry) => entry.originalUrl === REWRITTEN);
    const gap = report.gaps.find((entry) => entry.kind === 'archive-injection');

    assert.ok((rewritten?.archiveInjection?.removedNodes ?? 0) > 0);
    assert.deepEqual(rewritten?.archiveInjection?.residualMarkers, []);
    assert.equal(gap?.originalUrl, REWRITTEN);
    assert.match(gap?.detail ?? '', /removed \d+ archive-injected node\(s\)/u);
    // The raw bytes stay exactly as they arrived: an injected body is evidence
    // of what the provider served, and rewriting the store would destroy it.
    assert.match(rewritten?.bodyHash ?? '', /^[0-9a-f]{64}$/u);
  });
});

test('an inventory that filled its limit is never reported as complete', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const [run] = report.inventory.runs;

    // The provider returned no continuation key, so the run itself ended
    // cleanly. It still filled the declared limit, and nothing then proves the
    // limit was not the cut.
    assert.equal(run?.outcome, 'complete');
    assert.equal(run?.resumeKey, null);
    assert.equal(run?.limitReached, true);
    assert.equal(report.inventory.partial, true);
    assert.equal(
      report.inventory.partialReasons.some((reason) => reason.includes('filled its declared limit')),
      true,
    );
    assert.equal(report.gaps.some((gap) => gap.kind === 'partial-inventory'), true);
  });
});

test('switching the declared policy switches the capture, on the same inventory', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await replayHarness(directory);
    const result = await runAcquisition({
      config: { ...setup.config, selection: { policy: 'earliest-largest', clusterWindowDays: 90 } },
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
    });
    const home = result.report.indexed.find((entry) => entry.originalUrl === HOME);
    const rewritten = result.report.indexed.find((entry) => entry.originalUrl === REWRITTEN);

    // Under `nearest` these are 19990901000000 and 19991010000000. The rows are
    // identical; only the declared policy changed, so the policy is what chose.
    assert.equal(home?.requestedTimestamp, '19990201000000');
    assert.equal(home?.selection?.policy, 'earliest-largest');
    assert.match(home?.selection?.reason ?? '', /largest of the 1 capture\(s\) within 90 days/u);
    assert.equal(rewritten?.requestedTimestamp, '19990310000000');
    assert.match(rewritten?.selection?.reason ?? '', /largest of the 3 capture\(s\) within 90 days/u);
    assert.equal(result.report.spend.indexRequests, 1, 'selecting differently costs no extra index request');
  });
});
