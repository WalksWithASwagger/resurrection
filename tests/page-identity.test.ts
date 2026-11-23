import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findItem, itemId, parseProjectConfig, reclassifyJob, runAcquisition, saveJob } from '../src/index.ts';
import { demoManifest, harness, withTempDirectory } from './helpers/acquisition.ts';

const home = 'http://demo.invalid/';
const about = 'http://demo.invalid/about.html';

test('capture identity ignores default ports and fragments while retaining significant URL differences', () => {
  assert.equal(itemId(home), itemId('http://DEMO.invalid:80/#top'));
  assert.equal(itemId('https://demo.invalid/page'), itemId('https://demo.invalid:443/page#top'));
  for (const url of ['https://demo.invalid/', 'http://demo.invalid:81/', home + '?v=2', about]) {
    assert.notEqual(itemId(home), itemId(url));
  }
  assert.notEqual(itemId(about), itemId(about.toUpperCase()));
});

test('the seed, inventory and followed links share page slots and fetch each selected URL once', async () => {
  await withTempDirectory(async (directory) => {
    const manifest = await demoManifest();
    const index = manifest.rules.find((rule) => rule.id === 'cdx-page-1')!.respond[0]!;
    index.bodyText = index.bodyText!.replaceAll('http://demo.invalid/', 'http://demo.invalid:80/');
    const { config, handle, clock } = await harness(directory, manifest);
    config.scope.seedUrls = [about, 'http://demo.invalid:80/about.html#top', home, home + '?extra=1'];
    config.budgets.maxPages = 2;
    config.discovery.followPageLinks = true;
    const result = await runAcquisition({ config, transport: handle.transport, resolver: handle.resolver, clock });

    const pages = result.state.items.filter((item) => item.kind === 'page');
    assert.deepEqual(pages.map((item) => item.originalUrl), [about, home]);
    assert.deepEqual(pages.map((item) => item.capture.servedTimestamp), ['19990401090000', '19990315120000']);
    assert.equal(handle.calls.filter((call) => call.ruleId === 'about-19990401').length, 1);
    assert.equal(handle.calls.filter((call) => call.ruleId === 'home-19990315').length, 1);
    assert.equal(findItem(result.state, 'http://demo.invalid:80/#top'), pages[1]);
    assert.ok(result.state.captureIndex.some((entry) => entry.originalUrl.endsWith('/style.css')));
  });
});

test('a seed takes priority over an earlier inventory row even at a one-page cap', async () => {
  await withTempDirectory(async (directory) => {
    const { config, handle, clock } = await harness(directory);
    config.budgets.maxPages = 1;
    config.scope.seedUrls = [about];
    config.discovery.followPageLinks = true;
    const { state } = await runAcquisition({ config, transport: handle.transport, resolver: handle.resolver, clock });
    assert.deepEqual(state.items.filter((item) => item.kind === 'page').map((item) => item.originalUrl), [about]);
    assert.ok(state.captureIndex.some((entry) => entry.originalUrl.endsWith('/papers/paper.pdf')));
  });
});

test('a legacy duplicate preserves its original fetch evidence without another fetch or score', async () => {
  await withTempDirectory(async (directory) => {
    const { config, handle, clock } = await harness(directory);
    const first = await runAcquisition({ config, transport: handle.transport, resolver: handle.resolver, clock });
    const original = findItem(first.state, home)!;
    const alias = structuredClone(original);
    alias.originalUrl = 'http://demo.invalid:80/';
    alias.id = 'legacy-raw-url-id';
    first.state.items.push(alias);
    await saveJob(directory, first.state);

    const classified = await reclassifyJob(directory, config.fidelity);
    assert.deepEqual(classified.state.supersededItems, [alias]);
    assert.equal(classified.summary.fidelity.scored, 2);
    assert.deepEqual(findItem(classified.state, alias.originalUrl)?.fidelity, original.fidelity);

    const next = await harness(directory);
    next.config.budgets.maxPages = 2;
    const resumed = await runAcquisition({
      config: next.config, transport: next.handle.transport, resolver: next.handle.resolver,
      clock: next.clock, resume: true,
    });
    assert.equal(next.handle.calls.length, 0);
    assert.deepEqual(resumed.state.supersededItems, [alias]);
    assert.deepEqual(resumed.state.spend.requests, first.state.spend.requests);
    next.config.budgets.maxPages = 1;
    await assert.rejects(runAcquisition({
      config: next.config, transport: next.handle.transport, resolver: next.handle.resolver,
      clock: next.clock, resume: true,
    }), /already contains 2 distinct pages/);
  });
});

test('a fractional page cap is rejected at the configuration boundary', async () => {
  await withTempDirectory(async (directory) => {
    const { config } = await harness(directory);
    assert.throws(() => parseProjectConfig({ ...config, budgets: { ...config.budgets, maxPages: 1.5 } }, 'test'), /maxPages/);
  });
});

test('resume selects a known capture from a superseded alias without repeating the inventory', async () => {
  await withTempDirectory(async (directory) => {
    const { config, handle, clock } = await harness(directory);
    config.budgets.maxRequests = 2;
    const { state } = await runAcquisition({ config, transport: handle.transport, resolver: handle.resolver, clock });
    const page = findItem(state, home)!;
    assert.equal(page.status, 'unattempted');
    const alias = structuredClone(page);
    alias.id = 'legacy-default-port-id';
    alias.originalUrl = 'http://demo.invalid:80/';
    const earliest = page.capture.candidates.find((capture) => capture.timestamp === '19980101000000')!;
    page.capture.candidates = [earliest];
    page.capture.alternatives = [earliest.timestamp];
    state.items.push(alias);
    await saveJob(directory, state);

    const next = await harness(directory);
    const resumed = await runAcquisition({
      config: next.config, transport: next.handle.transport, resolver: next.handle.resolver,
      clock: next.clock, resume: true,
    });
    const restored = findItem(resumed.state, home)!;
    assert.equal(restored.capture.servedTimestamp, '19990315120000');
    assert.deepEqual(restored.capture.candidates, [earliest, alias.capture.candidates[0]]);
    assert.deepEqual(restored.capture.alternatives, ['19980101000000', '19990315120000']);
    assert.deepEqual(resumed.state.supersededItems, [alias]);
    assert.equal(resumed.state.spend.indexRequests, state.spend.indexRequests);
  });
});
