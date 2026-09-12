/**
 * Reclassifying and re-decoding an acquired collection, at zero request cost.
 *
 * Two acceptance criteria meet here. Issue #5 requires that reclassifying an
 * existing collection needs no refetch, so a changed marker list or a changed
 * precedence rule is a cheap, auditable operation. Issue #4's last open
 * criterion requires the same of decoding: re-decoding an already-acquired
 * body must reuse the stored bytes and make no request.
 *
 * Both are asserted against the request counter of the very transport handle
 * the acquisition used, so "no requests" is a measurement rather than a claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  decodeBody,
  loadJob,
  reclassifyJob,
  runAcquisition,
  sha256,
  BodyStore,
  type JobState,
} from '../src/index.ts';
import { outcomeHarness, withTempDirectory, type Harness } from './helpers/acquisition.ts';

async function acquire(directory: string): Promise<{ state: JobState; setup: Harness }> {
  const setup = await outcomeHarness(directory);
  const result = await runAcquisition({
    config: setup.config,
    transport: setup.handle.transport,
    resolver: setup.handle.resolver,
    clock: setup.clock,
  });
  return { state: result.state, setup };
}

const outcomesOf = (state: JobState): Record<string, string> =>
  Object.fromEntries(state.items.map((item) => [item.originalUrl, item.outcome?.outcome ?? 'unclassified']));

test('reclassifying a cached collection makes no request and reaches the same verdicts', async () => {
  await withTempDirectory(async (directory) => {
    const { state, setup } = await acquire(directory);
    const before = setup.handle.calls.length;
    const original = outcomesOf(state);

    const { state: reclassified, summary } = await reclassifyJob(directory);

    assert.equal(setup.handle.calls.length, before, 'reclassification issued a request');
    assert.equal(summary.itemsClassified, 14);
    // Nine bodies, not seven: an interstitial and a zero-byte response are
    // retained as evidence of what the provider served even though neither
    // validated, and both are read back here.
    assert.equal(summary.storeReads, 9, 'every stored body should be read back');
    assert.equal(summary.missingBodies, 0);
    assert.deepEqual(outcomesOf(reclassified), original);
  });
});

test('the reclassified verdicts are what the job on disk now says', async () => {
  await withTempDirectory(async (directory) => {
    await acquire(directory);
    const { summary } = await reclassifyJob(directory);

    const persisted = await loadJob(directory);
    assert.ok(persisted !== null);
    assert.equal(
      persisted.items.filter((item) => item.outcome?.outcome === 'origin-soft-404').length,
      2,
    );
    assert.equal(summary.templates.length, 1);
    assert.equal(summary.templates[0]?.observedFrom, 'http://outcomes.invalid/gone.html');
  });
});

test('reclassification is idempotent: a second pass changes nothing', async () => {
  await withTempDirectory(async (directory) => {
    const { setup } = await acquire(directory);
    const after = setup.handle.calls.length;

    const first = await reclassifyJob(directory);
    const second = await reclassifyJob(directory);

    assert.equal(setup.handle.calls.length, after);
    assert.deepEqual(second.summary.counts, first.summary.counts);
    assert.deepEqual(outcomesOf(second.state), outcomesOf(first.state));
  });
});

/**
 * Issue #4's remaining criterion: "Re-decoding an already-acquired body
 * requires zero network requests and reuses the stored bytes."
 */
test('re-decoding an acquired body reuses the stored bytes and makes no request', async () => {
  await withTempDirectory(async (directory) => {
    const { state, setup } = await acquire(directory);
    const before = setup.handle.calls.length;
    const store = new BodyStore(join(directory, 'store'));

    let redecoded = 0;
    for (const item of state.items) {
      const hash = item.fetch?.bodyHash;
      if (hash == null || item.encoding === null) continue;

      const bytes = await store.read(hash);
      // The bytes came from the store, not from a response: their hash is the
      // one the acquisition recorded.
      assert.equal(sha256(bytes), hash);

      const decoded = decodeBody(bytes, { contentType: item.fetch?.contentType ?? null });
      assert.equal(decoded.kind, item.encoding.kind);
      assert.equal(decoded.chosenEncoding, item.encoding.chosenEncoding);
      assert.equal(decoded.chosenSource, item.encoding.chosenSource);
      assert.equal(decoded.declaredEncoding, item.encoding.declaredEncoding);
      assert.equal(decoded.replacementCount, item.encoding.replacementCount);
      assert.equal(decoded.degraded, item.encoding.degraded);
      redecoded += 1;
    }

    assert.equal(redecoded, 9, 'every acquired body should have been re-decoded from the store');
    assert.equal(setup.handle.calls.length, before, 're-decoding issued a request');
  });
});
