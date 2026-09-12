/**
 * The bounded acquisition, end to end, against the committed fixture site.
 *
 * Every case the issue names is exercised here: inventory continuation, a
 * redirect to a different capture, an archive error page served with status
 * 200, a missing asset, throttling, a private-network redirect attempt, and
 * the separation of indexed, fetched, failed and unattempted items in the
 * evidence report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAcquisition, type EvidenceReport } from '../src/index.ts';
import { harness, requestedUrls, withTempDirectory, type Harness } from './helpers/acquisition.ts';

async function acquire(directory: string): Promise<{ report: EvidenceReport; setup: Harness }> {
  const setup = await harness(directory);
  const result = await runAcquisition({
    config: setup.config,
    transport: setup.handle.transport,
    resolver: setup.handle.resolver,
    clock: setup.clock,
  });
  return { report: result.report, setup };
}

const find = <T extends { originalUrl: string }>(entries: T[], url: string): T | undefined =>
  entries.find((entry) => entry.originalUrl === url);

test('the run completes and names indexed, fetched, failed and unattempted separately', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);

    assert.equal(report.runState, 'complete');
    assert.equal(report.counts.indexed, 10);
    assert.equal(report.counts.fetched, 7);
    assert.equal(report.counts.failed, 3);
    assert.equal(report.counts.unattempted, 0);
    assert.equal(report.counts.skipped, 0);
    assert.equal(
      report.counts.fetched + report.counts.failed + report.counts.unattempted + report.counts.skipped,
      report.counts.items,
    );
  });
});

test('the inventory is continued through its resume key and its raw responses are retained', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const [first, second] = report.inventory.runs;

    assert.equal(report.inventory.runs.length, 2);
    assert.equal(first?.outcome, 'continued');
    assert.equal(first?.resumeKey, 'invalid,demo)/about.html 19990401090000');
    assert.equal(second?.outcome, 'complete');
    assert.equal(second?.resumeKey, null);
    assert.equal(report.inventory.partial, false);
    for (const run of report.inventory.runs) {
      assert.match(run.rawResponseHash ?? '', /^[0-9a-f]{64}$/u);
      assert.match(run.rawResponsePath ?? '', /^objects\//u);
      assert.match(run.requestUrl, /matchType=domain/u);
    }
  });
});

test('an indexed URL keeps its alternative captures for later reselection', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const home = find(report.indexed, 'http://demo.invalid/');

    assert.deepEqual(home?.alternatives, ['19990315120000', '19980101000000']);
    assert.equal(home?.requestedTimestamp, '19990315120000');
    assert.equal(home?.archiveDigest, 'DEMOHOMEDIGEST1');
    // The capture is a declared choice, not row order: the project's period
    // ends in 1999 and the default policy aims at that bound.
    assert.equal(home?.selection?.policy, 'nearest');
    assert.equal(home?.selection?.target, '19991231235959');
    assert.equal(home?.selection?.consideredCount, 2);
    assert.equal(home?.selection?.fromExcludedCapture, false);
  });
});

test('every acquired body is scanned for archive injection and every scan comes back clean', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const textBodies = report.fetched.filter((entry) => entry.encoding?.kind === 'text');

    assert.ok(textBodies.length > 0);
    for (const entry of textBodies) {
      assert.equal(entry.archiveInjection?.scanned, true, `${entry.originalUrl} must be scanned`);
      assert.equal(
        entry.archiveInjection?.removedNodes,
        0,
        `${entry.originalUrl} was fetched with ${entry.replayModifier} and must carry no injected markup`,
      );
    }
    assert.equal(report.gaps.some((gap) => gap.kind === 'archive-injection'), false);
  });
});

test('the whole inventory came back, so no capture is held back as timeline evidence', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);

    assert.deepEqual(report.inventory.candidateFilters, ['statuscode:200']);
    assert.equal(report.counts.timelineRows, 0, 'every demo capture is a 200');
    assert.deepEqual(report.inventory.partialReasons, []);
    for (const query of report.inventory.queries) {
      assert.match(query, /output=json/u);
      assert.match(query, /collapse=digest/u);
      assert.match(query, /showResumeKey=true/u);
    }
  });
});

test('a redirect to a different capture records both times and the chain', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const logo = find(report.fetched, 'http://demo.invalid/logo.gif');

    assert.equal(logo?.requestedTimestamp, '19990315120000');
    assert.equal(logo?.servedTimestamp, '19990820101010');
    assert.ok((logo?.captureDistanceSeconds ?? 0) > 0);
    assert.equal(logo?.redirectChain.length, 1);
    assert.equal(logo?.redirectChain[0]?.status, 302);
    assert.equal(logo?.attempts, 2);
    assert.equal(logo?.replayModifier, 'id_');
  });
});

test('an archive error page served with status 200 is a failure, not a recovered file', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const banner = find(report.failed, 'http://demo.invalid/banner.gif');

    assert.equal(banner?.failure.kind, 'archive-error-page');
    assert.equal(find(report.recoveredFiles, 'http://demo.invalid/banner.gif'), undefined);
    assert.equal(find(report.fetched, 'http://demo.invalid/banner.gif'), undefined);
    // The bytes are still retained: the error document is evidence of what the
    // provider served.
    assert.match(banner?.bodyHash ?? '', /^[0-9a-f]{64}$/u);
  });
});

test('a missing asset is a typed failure with its status, and never a recovered file', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const missing = find(report.failed, 'http://demo.invalid/missing.gif');

    assert.equal(missing?.failure.kind, 'http-status');
    assert.equal(missing?.failure.httpStatus, 404);
    assert.equal(missing?.failure.retryable, false);
    assert.equal(missing?.attempts, 1, 'a 404 is a definite answer and is not retried');
    assert.equal(find(report.recoveredFiles, 'http://demo.invalid/missing.gif'), undefined);
  });
});

test('a throttled asset is retried after its Retry-After and both attempts are charged', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);
    const slow = find(report.fetched, 'http://demo.invalid/slow.gif');

    assert.equal(slow?.attempts, 2);
    assert.equal(slow?.httpStatus, 200);
    assert.equal(setup.handle.calls.filter((call) => call.ruleId === 'throttled-then-served').length, 2);
    // The Retry-After of two seconds was waited out, not ignored.
    assert.ok(setup.clock.elapsed() >= 2000);
  });
});

test('a redirect at a private address is refused before any connection is attempted', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);
    const tracker = find(report.failed, 'http://demo.invalid/tracker.gif');

    assert.equal(tracker?.failure.kind, 'destination-refused');
    assert.match(tracker?.failure.message ?? '', /10\.0\.0\.7/u);
    assert.equal(
      requestedUrls(setup.handle).some((url) => url.includes('evil.web.archive.org')),
      false,
      'the guard must refuse the private destination before the transport sees it',
    );
  });
});

test('an off-scope host in the markup is never queued', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);

    assert.equal(report.indexed.some((entry) => entry.originalUrl.includes('elsewhere.invalid')), false);
    assert.equal(requestedUrls(setup.handle).some((url) => url.includes('elsewhere.invalid')), false);
  });
});

test('every recovered file has acquired, validated, hashed bytes and a local path', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);

    assert.equal(report.counts.recoveredFiles, 7);
    for (const file of report.recoveredFiles) {
      assert.match(file.bodyHash, /^[0-9a-f]{64}$/u);
      assert.ok(file.byteLength > 0);
      assert.match(file.storePath, /^objects\//u);
      assert.match(file.localPath, /^site\//u);
    }
    assert.equal(
      report.recoveredFiles.length,
      report.fetched.filter((entry) => entry.bodyHash !== null).length,
    );
  });
});

test('a linked document is a first-class recovered file, not only a page', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const pdf = find(report.recoveredFiles, 'http://demo.invalid/papers/paper.pdf');

    assert.equal(pdf?.localPath, 'site/demo.invalid/papers/paper.pdf');
    assert.equal(pdf?.contentType, 'application/pdf');
  });
});

test('a shared body is stored once while both URLs keep their own records', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const logo = find(report.recoveredFiles, 'http://demo.invalid/logo.gif');
    const header = find(report.recoveredFiles, 'http://demo.invalid/header.gif?v=2');

    assert.equal(logo?.bodyHash, header?.bodyHash);
    assert.notEqual(logo?.localPath, header?.localPath);
    assert.equal(header?.localPath.endsWith('.gif'), true);
  });
});

test('the encoding decision for every fetched body is recorded in the evidence report', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const home = find(report.fetched, 'http://demo.invalid/');
    const logo = find(report.fetched, 'http://demo.invalid/logo.gif');

    assert.equal(home?.encoding?.declaredEncoding, 'iso-8859-1');
    assert.equal(home?.encoding?.declaredSource, 'meta-http-equiv');
    assert.equal(home?.encoding?.declarationConflict, false);
    assert.equal(home?.encoding?.chosenEncoding, 'windows-1252');
    assert.equal(home?.encoding?.cp1252UpgradeApplied, true);
    assert.equal(home?.encoding?.declarationOverridden, false);
    assert.equal(home?.encoding?.detectionConfidence, 1);
    assert.equal(home?.encoding?.degraded, false);
    assert.equal(logo?.encoding?.kind, 'binary');
    assert.equal(logo?.encoding?.binaryReason, 'GIF signature');
    for (const entry of report.fetched) {
      assert.notEqual(entry.encoding, null, `${entry.originalUrl} must carry an encoding decision`);
    }
  });
});

test('the gap report names one gap per failure with a remedy', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const failedGaps = report.gaps.filter((gap) => gap.kind === 'failed-fetch');

    assert.equal(failedGaps.length, report.counts.failed);
    for (const gap of report.gaps) {
      assert.notEqual(gap.remedy, '');
      assert.notEqual(gap.detail, '');
    }
  });
});

test('the report carries no absolute paths and no credentials', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const serialized = JSON.stringify(report);

    assert.equal(serialized.includes(directory), false);
    assert.doesNotMatch(serialized, /https?:\/\/[^"/]*:[^"/]*@/u);
    assert.doesNotMatch(serialized, /(?:api[_-]?key|access[_-]?token|password)/iu);
  });
});

test('budget accounting covers every attempt the run made, retries included', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);

    assert.equal(report.spend.requests, setup.handle.calls.length);
    assert.equal(report.spend.indexRequests, 2);
    assert.ok(report.spend.bytes > 0);
    assert.ok(report.spend.elapsedMs > 0);
  });
});

test('a second run refuses to overwrite an existing job without an explicit resume', async () => {
  await withTempDirectory(async (directory) => {
    await acquire(directory);
    const setup = await harness(directory);

    await assert.rejects(
      runAcquisition({
        config: setup.config,
        transport: setup.handle.transport,
        resolver: setup.handle.resolver,
        clock: setup.clock,
      }),
      /pass resume to continue it/u,
    );
  });
});
