/**
 * Pause, cancel, interruption, budget exhaustion and resume.
 *
 * The invariant under test throughout: a run that stops for any reason keeps
 * every body it already acquired, and the run that continues it does not spend
 * a single request re-fetching that work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadJob, runAcquisition, type JobState } from '../src/index.ts';
import { harness, requestedUrls, withTempDirectory } from './helpers/acquisition.ts';

function hashesByUrl(state: JobState): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const item of state.items) {
    if (item.status === 'fetched' && item.fetch?.bodyHash != null) {
      hashes.set(item.originalUrl, item.fetch.bodyHash);
    }
  }
  return hashes;
}

test('a paused run parks the remaining items and keeps what it already fetched', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await harness(directory);
    let seen = 0;

    const result = await runAcquisition({
      config: setup.config,
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
      signal: () => (++seen > 2 ? 'pause' : 'continue'),
    });

    assert.equal(result.report.runState, 'paused');
    assert.equal(result.report.counts.fetched, 2);
    assert.ok(result.report.counts.unattempted > 0);
    assert.ok(result.report.unattempted.every((entry) => entry.reason === 'paused'));
    assert.equal(result.report.counts.recoveredFiles, 2);
  });
});

test('a cancelled run records the cancellation and still keeps acquired evidence', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await harness(directory);
    let seen = 0;

    const result = await runAcquisition({
      config: setup.config,
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
      signal: () => (++seen > 1 ? 'cancel' : 'continue'),
    });

    assert.equal(result.report.runState, 'cancelled');
    assert.equal(result.report.counts.recoveredFiles, 1);
    assert.ok(result.report.unattempted.every((entry) => entry.reason === 'cancelled'));
    assert.ok(result.report.events.some((event) => event.kind === 'cancelled'));
  });
});

test('an interrupted process leaves a resumable job on disk', async () => {
  await withTempDirectory(async (directory) => {
    const first = await harness(directory);
    let seen = 0;

    await assert.rejects(
      runAcquisition({
        config: first.config,
        transport: first.handle.transport,
        resolver: first.handle.resolver,
        clock: first.clock,
        signal: () => {
          if (++seen > 3) throw new Error('simulated interruption');
          return 'continue';
        },
      }),
      /simulated interruption/u,
    );

    const state = await loadJob(directory);
    assert.notEqual(state, null);
    assert.equal(state?.runState, 'interrupted');
    assert.equal(hashesByUrl(state as JobState).size, 3);
  });
});

test('a resumed job preserves previously fetched body hashes and re-requests nothing', async () => {
  await withTempDirectory(async (directory) => {
    const first = await harness(directory);
    let seen = 0;
    await assert.rejects(
      runAcquisition({
        config: first.config,
        transport: first.handle.transport,
        resolver: first.handle.resolver,
        clock: first.clock,
        signal: () => {
          if (++seen > 3) throw new Error('simulated interruption');
          return 'continue';
        },
      }),
      /simulated interruption/u,
    );
    const before = hashesByUrl((await loadJob(directory)) as JobState);

    const second = await harness(directory);
    const result = await runAcquisition({
      config: second.config,
      transport: second.handle.transport,
      resolver: second.handle.resolver,
      clock: second.clock,
      resume: true,
    });

    const after = hashesByUrl(result.state);
    for (const [url, hash] of before) {
      assert.equal(after.get(url), hash, `${url} must keep its acquired body hash`);
    }
    for (const url of before.keys()) {
      assert.equal(
        requestedUrls(second.handle).some((requested) => requested.endsWith(url)),
        false,
        `${url} was already acquired and must not be requested again`,
      );
    }
    assert.equal(result.report.runState, 'complete');
    assert.equal(result.report.counts.fetched, 7);
    assert.ok(result.report.events.some((event) => event.kind === 'resumed'));
  });
});

test('the inventory is not re-issued on resume once it has completed', async () => {
  await withTempDirectory(async (directory) => {
    const first = await harness(directory);
    let seen = 0;
    await runAcquisition({
      config: first.config,
      transport: first.handle.transport,
      resolver: first.handle.resolver,
      clock: first.clock,
      signal: () => (++seen > 1 ? 'pause' : 'continue'),
    });

    const second = await harness(directory);
    const result = await runAcquisition({
      config: second.config,
      transport: second.handle.transport,
      resolver: second.handle.resolver,
      clock: second.clock,
      resume: true,
    });

    assert.equal(
      requestedUrls(second.handle).some((url) => url.includes('/cdx/search/cdx')),
      false,
    );
    assert.equal(result.report.inventory.runs.length, 2);
  });
});

test('an exhausted request budget parks items as unattempted rather than failed', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await harness(directory);
    const config = { ...setup.config, budgets: { ...setup.config.budgets, maxRequests: 6 } };

    const result = await runAcquisition({
      config,
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
    });

    assert.equal(result.report.runState, 'paused');
    assert.equal(result.report.spend.requests, 6);
    assert.ok(result.report.counts.unattempted > 0);
    assert.ok(result.report.unattempted.some((entry) => entry.reason === 'budget-exhausted'));
    assert.ok(
      result.report.gaps.some(
        (gap) => gap.kind === 'unattempted' && gap.remedy.includes('raise the declared budget'),
      ),
    );
  });
});

test('raising the declared budget on resume finishes the work without redoing it', async () => {
  await withTempDirectory(async (directory) => {
    const first = await harness(directory);
    const narrow = { ...first.config, budgets: { ...first.config.budgets, maxRequests: 6 } };
    const stopped = await runAcquisition({
      config: narrow,
      transport: first.handle.transport,
      resolver: first.handle.resolver,
      clock: first.clock,
    });
    const before = hashesByUrl(stopped.state);

    const second = await harness(directory);
    const result = await runAcquisition({
      config: second.config,
      transport: second.handle.transport,
      resolver: second.handle.resolver,
      clock: second.clock,
      resume: true,
    });

    // The carried spend still counts against the raised budget.
    assert.ok(result.report.spend.requests > 6);
    assert.equal(result.report.spend.requests, 6 + second.handle.calls.length);
    assert.equal(result.report.runState, 'complete');
    for (const [url, hash] of before) {
      assert.equal(hashesByUrl(result.state).get(url), hash);
    }
  });
});

test('a failed item is only retried when a resume asks for it', async () => {
  await withTempDirectory(async (directory) => {
    const first = await harness(directory);
    await runAcquisition({
      config: first.config,
      transport: first.handle.transport,
      resolver: first.handle.resolver,
      clock: first.clock,
    });

    const second = await harness(directory);
    const plain = await runAcquisition({
      config: second.config,
      transport: second.handle.transport,
      resolver: second.handle.resolver,
      clock: second.clock,
      resume: true,
    });

    assert.equal(second.handle.calls.length, 0, 'a settled job makes no requests on resume');
    assert.equal(plain.report.counts.failed, 3);
    assert.equal(plain.report.counts.recoveredFiles, 7);
  });
});
