/**
 * The evaluator: pixel comparison, candidate loading and every check.
 *
 * The checks run against a scripted renderer that returns chosen pixels,
 * anchors and requests, so each failure mode is exercised exactly and without
 * a browser. One end-to-end test then renders a real reference and real
 * candidates in Chromium; it is skipped by name where no Chromium build is
 * installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  buildReferenceBundle,
  buildSiteModel,
  candidateResponder,
  compareImages,
  createChromiumRenderer,
  decodePng,
  encodePng,
  evaluateCandidate,
  loadCandidate,
  loadCollectionManifest,
  sha256,
  signOffReferenceBundle,
  CANDIDATE_ORIGIN,
  type Anchor,
  type Collection,
  type EvaluationReport,
  type Image,
  type ReferenceRenderer,
  type RenderResult,
  type SiteModel,
} from '../src/index.ts';
import { withTempDirectory } from './helpers/acquisition.ts';

function solid(width: number, height: number, rgb: readonly [number, number, number]): Image {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set([...rgb, 255], index * 4);
  return { width, height, data };
}

function withBlock(image: Image, x0: number, y0: number, size: number, rgb: readonly [number, number, number]): Image {
  const data = new Uint8Array(image.data);
  for (let y = y0; y < y0 + size; y += 1) for (let x = x0; x < x0 + size; x += 1) data.set([...rgb, 255], (y * image.width + x) * 4);
  return { ...image, data };
}

test('a PNG survives an encode and decode round trip', () => {
  const image = withBlock(solid(7, 5, [10, 200, 30]), 2, 1, 2, [250, 0, 128]);

  const decoded = decodePng(encodePng(image));

  assert.deepEqual([decoded.width, decoded.height], [7, 5]);
  assert.deepEqual(decoded.data, image.data);
});

test('a file that is not a supported PNG is refused, not approximated', () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), /not a PNG/);
  const interlaced = Buffer.from(encodePng(solid(2, 2, [0, 0, 0])));
  interlaced[28] = 1;
  assert.throws(() => decodePng(new Uint8Array(interlaced)), /unsupported PNG/);
});

test('differing pixels are counted, bounded and drawn; a faint change is under the threshold', () => {
  const reference = solid(20, 10, [255, 255, 255]);

  const changed = compareImages(reference, withBlock(reference, 4, 3, 2, [0, 0, 0]), 0.1);
  assert.equal(changed.differingPixels, 4);
  assert.equal(changed.ratio, 4 / 200);
  assert.deepEqual(changed.bounds, { x: 4, y: 3, width: 2, height: 2 });
  assert.deepEqual([...changed.diff.data.subarray((3 * 20 + 4) * 4, (3 * 20 + 4) * 4 + 4)], [255, 0, 0, 255]);

  const faint = compareImages(reference, withBlock(reference, 4, 3, 2, [250, 250, 250]), 0.1);
  assert.equal(faint.differingPixels, 0);
  assert.equal(faint.bounds, null);
});

test('area present in only one image counts as differing', () => {
  const comparison = compareImages(solid(10, 10, [255, 255, 255]), solid(10, 12, [255, 255, 255]), 0.1);

  assert.equal(comparison.sameSize, false);
  assert.equal(comparison.differingPixels, 20);
  assert.equal(comparison.ratio, 20 / 120);
});

const PAGE_ONE = 'http://www.demo.invalid/issue/one.html';
const PAGE_TWO = 'http://www.demo.invalid/issue/two.html';

const html = (title: string, body: string): string =>
  `<html><head><title>${title}</title></head><body bgcolor="#ffffff" style="margin:0">${body}</body></html>`;
const ONE_BODY = `<table width="600" cellpadding="0" cellspacing="0"><tr><td><img src="/images/masthead.gif" width="600" height="40"></td></tr>
<tr><td><h2>One</h2><p>Body text.</p><a href="/issue/two.html#top">next</a> <a href="/issue/lost.html">lost</a>
<a href="http://elsewhere.invalid/">friend</a></td></tr></table>`;
const TWO_BODY = '<h1>Two</h1><ul><li><a href="one.html">back</a></li></ul>';
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function writeFiles(root: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function demoCollection(directory: string): Promise<{ collection: Collection; model: SiteModel }> {
  const bodies: [string, Uint8Array, string][] = [
    [PAGE_ONE, Buffer.from(html('One', ONE_BODY)), 'text/html'],
    [PAGE_TWO, Buffer.from(html('Two', TWO_BODY)), 'text/html'],
    ['http://www.demo.invalid/images/masthead.gif', GIF, 'image/gif'],
  ];
  const resources = [];
  for (const [index, [url, bytes, contentType]] of bodies.entries()) {
    await writeFiles(directory, { [`bytes/${index}.bin`]: bytes });
    resources.push({ originalUrl: url, path: `bytes/${index}.bin`, contentType, servedTimestamp: '20000615120000', sha256: sha256(new Uint8Array(bytes)) });
  }
  await writeFile(join(directory, 'collection.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', period: null, resources }));
  const collection = await loadCollectionManifest(join(directory, 'collection.json'));
  return { collection, model: await buildSiteModel(collection) };
}

/** A candidate that mirrors the original paths, so root-relative links keep working. */
async function writeCandidate(directory: string, overrides: Readonly<Record<string, string>> = {}, omitFromMap: string[] = []): Promise<string> {
  await writeFiles(join(directory, 'site'), {
    'issue/one.html': overrides['one'] ?? html('One', ONE_BODY),
    'issue/two.html': overrides['two'] ?? html('Two', TWO_BODY),
    'images/masthead.gif': GIF,
  });
  const entries = [
    { originalUrl: PAGE_ONE, path: 'issue/one.html' },
    { originalUrl: PAGE_TWO, path: 'issue/two.html' },
    { originalUrl: 'http://www.demo.invalid/images/masthead.gif', path: 'images/masthead.gif' },
  ].filter((entry) => !omitFromMap.includes(entry.originalUrl));
  await writeFile(join(directory, 'url-map.json'), JSON.stringify({ schemaVersion: 1, entries }));
  return directory;
}

const anchor = (tag: string, ordinal: number, x: number, y: number, target: string | null = null): Anchor => ({
  tag, ordinal, rect: { x, y, width: 100, height: 20 }, label: `${tag}${ordinal}`, target,
});

const REFERENCE_ANCHORS: Anchor[] = [
  anchor('img', 0, 0, 0),
  anchor('a', 0, 0, 60, 'http://www.demo.invalid/issue/two.html#top'),
  anchor('a', 1, 0, 80, 'http://www.demo.invalid/issue/lost.html'),
  anchor('a', 2, 0, 100, 'http://elsewhere.invalid/'),
];
const CANDIDATE_ANCHORS: Anchor[] = [
  anchor('img', 0, 0, 0),
  anchor('a', 0, 0, 60, `${CANDIDATE_ORIGIN}/issue/two.html#top`),
  anchor('a', 1, 0, 80, `${CANDIDATE_ORIGIN}/issue/lost.html`),
  anchor('a', 2, 0, 100, 'http://elsewhere.invalid/'),
];
const WHITE = solid(40, 30, [255, 255, 255]);

type Scripted = Partial<RenderResult>;

/** Returns the reference result for original URLs and a chosen result for candidate URLs. */
function scriptedRenderer(candidateResult: Scripted = {}, browserVersion = '1'): ReferenceRenderer {
  const result = (anchors: Anchor[], overrides: Scripted): RenderResult => ({
    screenshot: encodePng(WHITE), screenshotStable: true, documentSize: { width: 40, height: 30 }, title: 'One',
    text: 'One Body text.', anchors, requests: [], pageErrors: [], ...overrides,
  });
  return {
    async conditions(viewport) {
      return {
        browser: 'scripted', browserVersion, platform: 'test', viewport, deviceScaleFactor: 1, locale: 'en-US',
        timezone: 'UTC', colorScheme: 'light', javaScriptEnabled: false, fullPage: true,
      };
    },
    async render(request) {
      return request.url.startsWith(CANDIDATE_ORIGIN) ? result(CANDIDATE_ANCHORS, candidateResult) : result(REFERENCE_ANCHORS, {});
    },
    async close() {},
  };
}

interface Setup {
  bundle: string;
  candidate: string;
  output: string;
}

/** A signed-off bundle of the article page only, plus a faithful candidate. */
async function scriptedSetup(directory: string, sign = true): Promise<Setup> {
  const { collection, model } = await demoCollection(join(directory, 'collection'));
  const onlyOne = { ...model, families: model.families.filter((family) => model.pages.find((page) => page.id === family.representativePageId)?.originalUrl === PAGE_ONE) };
  const bundle = join(directory, 'refs');
  await buildReferenceBundle({ collection, model: onlyOne, renderer: scriptedRenderer(), outputDirectory: bundle });
  if (sign) await signOffReferenceBundle(bundle, { signedBy: 'reviewer', note: 'ok', signedAt: '2026-01-01T00:00:00.000Z' });
  return { bundle, candidate: await writeCandidate(join(directory, 'candidate')), output: join(directory, 'evaluation') };
}

async function evaluateScripted(setup: Setup, candidateResult: Scripted = {}): Promise<EvaluationReport> {
  return await evaluateCandidate({
    bundleDirectory: setup.bundle,
    candidateDirectory: setup.candidate,
    outputDirectory: setup.output,
    renderer: scriptedRenderer(candidateResult),
  });
}

const failed = (report: EvaluationReport): string[] =>
  report.states.flatMap((state) => state.checks.filter((entry) => !entry.pass).map((entry) => entry.name));

test('a faithful candidate passes every check against a frozen reference', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await scriptedSetup(directory);

    const report = await evaluateScripted(setup);

    assert.equal(report.verdict, 'pass');
    assert.deepEqual(report.summary, { states: 1, passed: 1, failed: 0 });
    assert.deepEqual(failed(report), []);
    const links = report.states[0]?.checks.find((entry) => entry.name === 'links');
    assert.deepEqual(links?.metrics, { links: 3, wrong: 0, unrecoveredTargets: 1, scriptLinksNotCompared: 0 });
    assert.deepEqual(JSON.parse(await readFile(join(setup.output, 'evaluation.json'), 'utf8')), report);
  });
});

test('each kind of difference fails its own check and no other', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await scriptedSetup(directory);
    const moved = CANDIDATE_ANCHORS.map((entry) => (entry.tag === 'img' ? anchor('img', 0, 0, 3) : entry));
    const retargeted = CANDIDATE_ANCHORS.map((entry) => (entry.ordinal === 0 && entry.tag === 'a' ? anchor('a', 0, 0, 60, `${CANDIDATE_ORIGIN}/issue/one.html`) : entry));
    const gapToRealPage = CANDIDATE_ANCHORS.map((entry) => (entry.ordinal === 1 ? anchor('a', 1, 0, 80, `${CANDIDATE_ORIGIN}/issue/two.html`) : entry));
    const lostFragment = CANDIDATE_ANCHORS.map((entry) => (entry.ordinal === 0 && entry.tag === 'a' ? anchor('a', 0, 0, 60, `${CANDIDATE_ORIGIN}/issue/two.html`) : entry));

    assert.deepEqual(failed(await evaluateScripted(setup, { title: 'Uno' })), ['title']);
    assert.deepEqual(failed(await evaluateScripted(setup, { text: 'One Body text, edited.' })), ['text']);
    assert.deepEqual(failed(await evaluateScripted(setup, { screenshot: encodePng(withBlock(WHITE, 0, 0, 10, [0, 0, 0])) })), ['visual']);
    assert.deepEqual(failed(await evaluateScripted(setup, { screenshot: encodePng(solid(40, 31, [255, 255, 255])) })), ['visual']);
    assert.deepEqual(failed(await evaluateScripted(setup, { anchors: moved })), ['geometry']);
    assert.deepEqual(failed(await evaluateScripted(setup, { anchors: CANDIDATE_ANCHORS.slice(1) })), ['geometry']);
    assert.deepEqual(failed(await evaluateScripted(setup, { anchors: retargeted })), ['links']);
    assert.deepEqual(failed(await evaluateScripted(setup, { anchors: gapToRealPage })), ['links']);
    assert.deepEqual(failed(await evaluateScripted(setup, { anchors: lostFragment })), ['links']);
    assert.deepEqual(failed(await evaluateScripted(setup, { requests: [{ url: 'http://tracker.invalid/p.gif', disposition: 'blocked-external', sha256: null }] })), ['runtime']);
    assert.deepEqual(failed(await evaluateScripted(setup, { pageErrors: ['boom'] })), ['runtime']);
  });
});

test('pixel differences inside the allowed ratio pass and leave a difference image', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await scriptedSetup(directory);

    const report = await evaluateScripted(setup, { screenshot: encodePng(withBlock(WHITE, 0, 0, 3, [0, 0, 0])) });

    assert.equal(report.verdict, 'pass');
    const state = report.states[0];
    assert.equal(state?.diffImage, `diffs/${state?.pageId}.png`);
    assert.equal(decodePng(new Uint8Array(await readFile(join(setup.output, state?.diffImage ?? '')))).width, 40);
  });
});

test('a link to a file that two original URLs share leads to the same place', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await scriptedSetup(directory);
    const entries = [
      { originalUrl: 'http://www.demo.invalid/issue/', path: 'issue/two.html' },
      { originalUrl: PAGE_ONE, path: 'issue/one.html' },
      { originalUrl: PAGE_TWO, path: 'issue/two.html' },
      { originalUrl: 'http://www.demo.invalid/images/masthead.gif', path: 'images/masthead.gif' },
    ];
    await writeFile(join(setup.candidate, 'url-map.json'), JSON.stringify({ schemaVersion: 1, entries }));

    assert.deepEqual(failed(await evaluateScripted(setup)), []);
  });
});

test('a page the candidate does not map fails its route', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await scriptedSetup(directory);
    await writeCandidate(setup.candidate, {}, [PAGE_ONE]);

    const report = await evaluateScripted(setup);

    assert.equal(report.verdict, 'fail');
    assert.deepEqual(failed(report), ['route']);
  });
});

test('an unsigned or altered reference, or a different browser, is refused', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await scriptedSetup(directory, false);
    await assert.rejects(evaluateScripted(setup), /no sign-off/);

    const unfrozen = await evaluateCandidate({
      bundleDirectory: setup.bundle, candidateDirectory: setup.candidate, outputDirectory: setup.output,
      renderer: scriptedRenderer(), requireFrozenReference: false,
    });
    assert.equal(unfrozen.verdict, 'pass-against-unfrozen-reference');

    await assert.rejects(
      evaluateCandidate({
        bundleDirectory: setup.bundle, candidateDirectory: setup.candidate, outputDirectory: setup.output,
        renderer: scriptedRenderer({}, '2'), requireFrozenReference: false,
      }),
      /render conditions differ/,
    );

    const bundleFile = join(setup.bundle, 'references.json');
    await writeFile(bundleFile, (await readFile(bundleFile, 'utf8')).replace('"title": "One"', '"title": "Uno"'));
    await assert.rejects(evaluateScripted(setup), /does not verify/);
  });
});

test('a candidate is served only from its own files', async () => {
  await withTempDirectory(async (directory) => {
    const candidate = await loadCandidate(await writeCandidate(directory));
    const respond = candidateResponder(candidate);

    assert.equal((await respond(`${CANDIDATE_ORIGIN}/issue/one.html`)).disposition, 'served');
    assert.equal((await respond(`${CANDIDATE_ORIGIN}/issue/absent.html`)).disposition, 'missing');
    assert.equal((await respond(`${CANDIDATE_ORIGIN}/../url-map.json`)).disposition, 'missing');
    assert.equal((await respond(`${CANDIDATE_ORIGIN}/%2e%2e/url-map.json`)).disposition, 'missing');
    assert.equal((await respond('http://www.demo.invalid/issue/one.html')).disposition, 'blocked-external');

    await writeFile(join(directory, 'url-map.json'), JSON.stringify({ schemaVersion: 1, entries: [{ originalUrl: PAGE_ONE, path: '../escape.html' }] }));
    await assert.rejects(loadCandidate(directory), /safe relative path/);
  });
});

test('Chromium end to end: an identical candidate passes, a shifted and recoloured one fails', async (t) => {
  const renderer = await createChromiumRenderer().catch(() => null);
  if (renderer === null) {
    t.skip('no Chromium build for playwright-core is installed on this machine');
    return;
  }
  try {
    await withTempDirectory(async (directory) => {
      const { collection, model } = await demoCollection(join(directory, 'collection'));
      const bundle = join(directory, 'refs');
      await buildReferenceBundle({ collection, model, renderer, outputDirectory: bundle, selection: 'all' });
      await signOffReferenceBundle(bundle, { signedBy: 'reviewer', note: 'ok', signedAt: '2026-01-01T00:00:00.000Z' });

      const faithful = await evaluateCandidate({
        bundleDirectory: bundle,
        candidateDirectory: await writeCandidate(join(directory, 'faithful')),
        outputDirectory: join(directory, 'evaluation-faithful'),
        renderer,
      });
      assert.equal(faithful.verdict, 'pass');
      assert.deepEqual(failed(faithful), []);
      assert.equal(faithful.states.every((state) => state.diffImage === null), true);

      const shifted = html('One', `<div style="height:7px;background:#336699"></div>${ONE_BODY}`);
      const broken = await evaluateCandidate({
        bundleDirectory: bundle,
        candidateDirectory: await writeCandidate(join(directory, 'broken'), { one: shifted }),
        outputDirectory: join(directory, 'evaluation-broken'),
        renderer,
      });
      assert.equal(broken.verdict, 'fail');
      assert.deepEqual(failed(broken).sort(), ['geometry', 'visual']);
      assert.deepEqual(broken.summary, { states: 2, passed: 1, failed: 1 });
    });
  } finally {
    await renderer.close();
  }
});
