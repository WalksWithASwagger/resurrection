/**
 * Per-asset capture resolution, end to end (issue #6).
 *
 * Every case the issue names is exercised against `fixtures/asset-site`: an
 * asset with no capture at its page's timestamp but one two years later, an
 * asset with captures on both sides of the page, an asset URL whose content
 * hash changed between captures, an asset with no capture anywhere, an asset
 * set that outruns the declared budget, and protocol-relative and root-relative
 * URLs that must resolve against the original host rather than the archive's.
 *
 * The property the design turns on is pinned here too: the site inventory is a
 * `matchType=domain` query, so resolving an asset it already described costs
 * zero additional index requests.
 *
 * No socket is opened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAcquisition, type EvidenceReport, type ProjectConfig } from '../src/index.ts';
import { assetHarness, requestedUrls, withTempDirectory, type Harness } from './helpers/acquisition.ts';

const HOME = 'http://assets.invalid/';
const PAGE2 = 'http://assets.invalid/page2.html';
const url = (path: string): string => `http://assets.invalid/${path}`;

async function acquire(
  directory: string,
  override: (config: ProjectConfig) => ProjectConfig = (config) => config,
): Promise<{ report: EvidenceReport; setup: Harness }> {
  const setup = await assetHarness(directory);
  const result = await runAcquisition({
    config: override(setup.config),
    transport: setup.handle.transport,
    resolver: setup.handle.resolver,
    clock: setup.clock,
  });
  return { report: result.report, setup };
}

const assetOf = (report: EvidenceReport, originalUrl: string) =>
  report.assets.resolved.find((entry) => entry.originalUrl === originalUrl);

test('an asset is resolved against its own captures, not against its page timestamp', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);
    const both = assetOf(report, url('both.gif'));

    // The page was captured on 1999-03-10. This asset has no capture then: one
    // is 68 days earlier, the other 22 days later, and the later one wins.
    assert.equal(both?.referringPageUrl, HOME);
    assert.equal(both?.referringTimestamp, '19990310000000');
    assert.equal(both?.resolvedTimestamp, '19990401000000');
    assert.equal(both?.candidateCount, 2);
    assert.equal(both?.deltaSeconds, 22 * 24 * 60 * 60);
    assert.equal(both?.temporallyDistant, false);
    assert.equal(
      requestedUrls(setup.handle).some((entry) => entry.includes('19990310000000id_/http://assets.invalid/both.gif')),
      false,
      "the referring page's timestamp must never be rewritten onto the asset",
    );
  });
});

test('the nearest capture wins even when it is earlier than the page', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const drift = assetOf(report, url('drift.gif'));

    // 37 days earlier beats 41 days later. Nearest means nearest, in either
    // direction; it is not a preference for whatever came after the page.
    assert.equal(drift?.resolvedTimestamp, '19990201000000');
    assert.equal(drift?.deltaSeconds, 37 * 24 * 60 * 60);
    assert.match(drift?.detail ?? '', /chose capture 19990201000000/u);
  });
});

test('an asset whose only capture is years later is acquired and flagged, not dropped', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const late = assetOf(report, url('late.gif'));
    const gap = report.gaps.find((entry) => entry.kind === 'temporally-distant-asset');

    assert.equal(late?.source, 'targeted-lookup');
    assert.equal(late?.resolvedTimestamp, '20010401000000');
    assert.equal(late?.servedTimestamp, '20010401000000');
    assert.equal(late?.temporallyDistant, true);
    assert.equal(late?.windowDays, 365);
    assert.equal(late?.status, 'fetched');
    // Flagged rather than silently accepted, and flagged rather than discarded:
    // it is the only surviving copy of this asset.
    assert.equal(gap?.originalUrl, url('late.gif'));
    assert.match(gap?.detail ?? '', /outside the declared 365-day window/u);
    assert.notEqual(gap?.remedy, '');
    assert.equal(report.assets.temporallyDistant, 1);
  });
});

test('every distinct content hash of an asset URL is recorded, with the selection explained', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const drift = assetOf(report, url('drift.gif'));
    const gap = report.gaps.find(
      (entry) => entry.kind === 'asset-content-drift' && entry.originalUrl === url('drift.gif'),
    );

    assert.deepEqual(drift?.distinctDigests, [
      { digest: 'DRIFTA', timestamps: ['19990201000000'] },
      { digest: 'DRIFTB', timestamps: ['19990420000000'] },
    ]);
    assert.equal(drift?.archiveDigest, 'DRIFTA');
    assert.equal(gap?.originalUrl, url('drift.gif'));
    assert.match(gap?.detail ?? '', /2 distinct content hashes/u);
    assert.match(gap?.detail ?? '', /DRIFTA@19990201000000; DRIFTB@19990420000000/u);
    assert.match(gap?.detail ?? '', /chose capture 19990201000000/u);
    // Every URL that served more than one hash is named, and only those: an
    // asset with a single capture is not reported as having drifted.
    assert.deepEqual(
      report.gaps.filter((entry) => entry.kind === 'asset-content-drift').map((entry) => entry.originalUrl),
      [url('both.gif'), url('drift.gif')],
    );
    assert.equal(assetOf(report, url('proto.gif'))?.distinctDigests.length, 1);
  });
});

test('an asset with no capture anywhere is a typed gap naming its referring page', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);
    const ghost = assetOf(report, url('ghost.gif'));
    const gap = report.gaps.find(
      (entry) => entry.kind === 'no-capture' && entry.originalUrl === url('ghost.gif'),
    );

    assert.equal(ghost?.resolvedTimestamp, null);
    assert.equal(ghost?.status, 'skipped');
    assert.equal(ghost?.source, 'targeted-lookup');
    assert.equal(report.assets.withoutCapture, 2);
    assert.match(gap?.detail ?? '', /returned no capture at all/u);
    assert.match(gap?.detail ?? '', /referenced from http:\/\/assets\.invalid\//u);
    // The live web is never the fallback: no replay request, and no request to
    // the original host, is made for a URL the archive does not hold.
    assert.equal(
      requestedUrls(setup.handle).some((entry) => entry.includes('ghost.gif') && !entry.includes('/cdx/')),
      false,
    );
    assert.equal(
      requestedUrls(setup.handle).some((entry) => new URL(entry).hostname !== 'web.archive.org'),
      false,
    );
  });
});

test('protocol-relative and root-relative asset URLs resolve against the original host', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);

    for (const name of ['proto.gif', 'root.gif']) {
      const entry = assetOf(report, url(name));
      assert.equal(entry?.originalUrl, url(name), `${name} must resolve against the original host`);
      assert.equal(entry?.resolvedTimestamp, '19990310000000');
      assert.equal(entry?.status, 'fetched');
    }
    // The archive host is where the bytes come from; it is never the host an
    // archived URL resolves against.
    assert.equal(report.assets.resolved.some((entry) => entry.originalUrl.includes('web.archive.org')), false);
    // An off-scope host in the markup is never queued, whatever form it took.
    // The test is the URL's host, not the text: a crafted attribute can put any
    // string it likes in a query value, and that is not a host.
    assert.equal(
      report.assets.resolved.some((entry) => new URL(entry.originalUrl).hostname !== 'assets.invalid'),
      false,
    );
    assert.equal(
      requestedUrls(setup.handle).some((entry) => new URL(entry).hostname !== 'web.archive.org'),
      false,
    );
  });
});

test('an asset the inventory already described costs zero additional index requests', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);
    const fromInventory = report.assets.resolved.filter((entry) => entry.source === 'inventory');

    // The site inventory is a matchType=domain query, so the captures of a
    // same-host asset are already on record. Four of this fixture's assets are
    // described by it, and resolving all four issues no index request at all.
    assert.deepEqual(
      fromInventory.map((entry) => entry.originalUrl).sort(),
      [url('both.gif'), url('drift.gif'), url('proto.gif'), url('root.gif')],
    );
    for (const entry of fromInventory) {
      assert.equal(
        report.assets.lookups.some((lookup) => lookup.originalUrl === entry.originalUrl),
        false,
        `${entry.originalUrl} was already in the inventory and must not be looked up`,
      );
    }
    assert.equal(report.assets.resolvedFromInventory, 4);
    // Four lookups, for the four URLs the bounded inventory did not describe.
    assert.equal(report.assets.lookups.length, 4);
    assert.equal(report.assets.lookupIndexRequests, 4);
    assert.equal(report.spend.indexRequests, report.inventory.queries.length + 4);
    for (const lookup of report.assets.lookups) {
      // The raw index response is retained by hash, exactly as an inventory
      // run's is: a lookup nobody can re-read is not evidence.
      assert.match(lookup.rawResponseHash ?? '', /^[0-9a-f]{64}$/u);
      assert.match(lookup.rawResponsePath ?? '', /^objects\//u);
      assert.equal(lookup.limitReached, false);
    }
  });
});

test('an asset referenced by two pages is looked up once', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);
    const lookups = report.assets.lookups.filter((lookup) => lookup.originalUrl === url('shared.gif'));
    const indexCalls = requestedUrls(setup.handle).filter(
      (entry) => entry.includes('/cdx/search/cdx') && entry.includes('shared.gif'),
    );

    assert.equal(report.fetched.filter((entry) => entry.originalUrl === url('shared.gif')).length, 1);
    assert.equal(lookups.length, 1);
    assert.equal(indexCalls.length, 1);
    // Both pages really do reference it; the second one adds no work.
    for (const page of [HOME, PAGE2]) {
      assert.equal(report.fetched.some((entry) => entry.originalUrl === page), true);
    }
  });
});

test('a crafted asset URL is data: it cannot rewrite the lookup query or leave scope', async () => {
  await withTempDirectory(async (directory) => {
    const { report, setup } = await acquire(directory);
    const hostile = 'http://assets.invalid/hostile.gif?matchType=domain&url=http://evil.invalid/';
    const lookup = report.assets.lookups.find((entry) => entry.originalUrl === hostile);
    const issued = new URL(lookup?.requestUrl ?? 'https://web.archive.org/');

    // The attribute is a URL to look up, never a set of parameters to obey.
    assert.equal(issued.hostname, 'web.archive.org');
    assert.deepEqual(issued.searchParams.getAll('url'), [hostile]);
    assert.deepEqual(issued.searchParams.getAll('matchType'), ['exact']);
    assert.equal(assetOf(report, hostile)?.resolvedTimestamp, null);
    assert.equal(
      requestedUrls(setup.handle).every((entry) => new URL(entry).hostname === 'web.archive.org'),
      true,
      'no request may leave the configured archive host',
    );
  });
});

test('the report records, per asset, the page time, the capture time and the delta', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory);

    // 4 since issue #8 added the fidelity section and the per-file digest.
    assert.equal(report.schemaVersion, 4);
    assert.equal(report.assets.windowDays, 365);
    assert.equal(report.assets.resolved.length, 8);
    for (const entry of report.assets.resolved) {
      assert.equal(entry.referringPageUrl, HOME);
      assert.equal(entry.referringTimestamp, '19990310000000');
      assert.equal(typeof entry.temporallyDistant, 'boolean');
      assert.notEqual(entry.detail, '');
      if (entry.resolvedTimestamp !== null) {
        assert.match(entry.resolvedTimestamp, /^\d{14}$/u);
        assert.equal(typeof entry.deltaSeconds, 'number');
      }
      if (entry.status === 'fetched') {
        assert.match(entry.bodyHash ?? '', /^[0-9a-f]{64}$/u);
        assert.match(entry.servedTimestamp ?? '', /^\d{14}$/u);
      }
    }
    // A page is not an asset: it keeps the declared-period selection of #7.
    assert.equal(report.assets.resolved.some((entry) => entry.originalUrl === HOME), false);
  });
});

test('an index budget that stops a lookup parks the asset and reports a partial run', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory, (config) => ({
      ...config,
      budgets: { ...config.budgets, maxIndexRequests: 1 },
    }));
    const parked = report.unattempted.find((entry) => entry.originalUrl === url('late.gif'));

    // The inventory spends the only index request, so the first asset it did
    // not describe cannot be looked up. That is an unattempted item with a
    // named reason, not a failure and not a silent omission.
    assert.equal(report.runState, 'paused');
    assert.equal(parked?.reason, 'budget-exhausted');
    assert.match(parked?.notes.join(' ') ?? '', /index budget stopped the capture lookup/u);
    assert.equal(report.assets.lookups.filter((lookup) => lookup.outcome === 'budget-exhausted').length, 1);
    assert.ok(report.counts.unattempted > 0);
    assert.equal(report.gaps.some((gap) => gap.kind === 'unattempted'), true);
    // The assets the inventory already described were still resolved and
    // acquired: a partial report, not a failed one.
    assert.equal(assetOf(report, url('both.gif'))?.status, 'fetched');
    assert.equal(report.counts.failed, 0);
  });
});

test('a request budget that runs out mid-collection parks the rest rather than failing', async () => {
  await withTempDirectory(async (directory) => {
    const { report } = await acquire(directory, (config) => ({
      ...config,
      budgets: { ...config.budgets, maxRequests: 6 },
    }));

    assert.equal(report.runState, 'paused');
    assert.equal(report.counts.failed, 0);
    assert.ok(report.counts.unattempted > 0);
    assert.ok(report.counts.fetched > 0, 'what was acquired before the budget ran out is kept');
    assert.equal(
      report.unattempted.every((entry) => entry.reason === 'budget-exhausted'),
      true,
    );
  });
});

test('resuming does not re-resolve or re-look-up an asset that is already settled', async () => {
  await withTempDirectory(async (directory) => {
    const first = await assetHarness(directory);
    await runAcquisition({
      config: { ...first.config, budgets: { ...first.config.budgets, maxRequests: 6 } },
      transport: first.handle.transport,
      resolver: first.handle.resolver,
      clock: first.clock,
    });

    const second = await assetHarness(directory);
    const result = await runAcquisition({
      config: second.config,
      transport: second.handle.transport,
      resolver: second.handle.resolver,
      clock: second.clock,
      resume: true,
    });
    const resumedIndexCalls = requestedUrls(second.handle).filter((entry) => entry.includes('/cdx/search/cdx'));

    assert.equal(result.report.runState, 'complete');
    // The inventory is complete, and every asset the first run resolved keeps
    // its resolution. Only the assets it never reached are looked up.
    assert.equal(resumedIndexCalls.some((entry) => entry.includes('matchType=domain')), false);
    assert.equal(assetOf(result.report, url('both.gif'))?.resolvedTimestamp, '19990401000000');
    assert.equal(assetOf(result.report, url('drift.gif'))?.resolvedTimestamp, '19990201000000');
  });
});
