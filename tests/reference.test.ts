/**
 * Reference bundles: page selection, answering requests from a collection,
 * freezing by digest, and one real render when Chromium is installed.
 *
 * The bundle logic runs against a scripted renderer, so it needs no browser.
 * The Chromium test proves the real renderer serves stored bytes, blocks
 * everything else and keeps page scripts off. It is skipped, by name and with
 * a reason, on a machine with no Chromium build; it never passes vacuously.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildReferenceBundle,
  buildSiteModel,
  collectionResponder,
  createChromiumRenderer,
  loadCollectionManifest,
  selectReferencePages,
  sha256,
  signOffReferenceBundle,
  verifyReferenceBundle,
  REFERENCE_BUNDLE_FILE,
  type Collection,
  type ReferenceRenderer,
  type RenderRequest,
  type SiteModel,
} from '../src/index.ts';
import { withTempDirectory } from './helpers/acquisition.ts';

const page = (title: string, paragraphs: number): string => `<html><head><title>${title}</title>
<script>document.title = 'script ran';</script></head>
<body bgcolor="#ffffff" style="margin:0"><table width="600" cellpadding="0" cellspacing="0"><tr><td>
<img src="/images/masthead.gif" width="600" height="40"></td></tr>
<tr><td><h2>${title}</h2>${'<p>Body text.</p>'.repeat(paragraphs)}
<a href="/issue/contents.html">contents</a><img src="/images/lost.gif" width="10" height="10">
<img src="http://tracker.invalid/pixel.gif" width="1" height="1"></td></tr></table></body></html>`;

const CONTENTS = `<html><head><title>Contents</title></head><body><h1>Issue</h1>
<ul><li><a href="one.html">One</a></li><li><a href="two.html">Two</a></li></ul></body></html>`;

// A 1x1 GIF, so Chromium has a real image to lay out.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function demo(directory: string): Promise<{ collection: Collection; model: SiteModel }> {
  await mkdir(join(directory, 'bytes'), { recursive: true });
  const entries: { url: string; bytes: Uint8Array; contentType: string }[] = [
    { url: 'http://www.demo.invalid/issue/contents.html', bytes: Buffer.from(CONTENTS), contentType: 'text/html' },
    { url: 'http://www.demo.invalid/issue/one.html', bytes: Buffer.from(page('One', 2)), contentType: 'text/html' },
    { url: 'http://www.demo.invalid/issue/two.html', bytes: Buffer.from(page('Two', 9)), contentType: 'text/html' },
    { url: 'http://www.demo.invalid:80/images/masthead.gif', bytes: GIF, contentType: 'image/gif' },
  ];
  const resources = [];
  for (const [index, entry] of entries.entries()) {
    const path = join('bytes', `${index}.bin`);
    await writeFile(join(directory, path), entry.bytes);
    resources.push({
      originalUrl: entry.url,
      path,
      contentType: entry.contentType,
      servedTimestamp: '20000615120000',
      sha256: sha256(new Uint8Array(entry.bytes)),
    });
  }
  const manifestPath = join(directory, 'collection.json');
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, id: 'demo', period: null, resources }));
  const collection = await loadCollectionManifest(manifestPath);
  return { collection, model: await buildSiteModel(collection) };
}

/** Records what it was asked for and answers with fixed measurements. */
function scriptedRenderer(calls: RenderRequest[]): ReferenceRenderer {
  return {
    async conditions(viewport) {
      return {
        browser: 'scripted', browserVersion: '0', platform: 'test', viewport, deviceScaleFactor: 1,
        locale: 'en-US', timezone: 'UTC', colorScheme: 'light', javaScriptEnabled: false, fullPage: true,
      };
    },
    async render(request) {
      calls.push(request);
      await request.respond(request.url);
      return {
        screenshot: new Uint8Array(Buffer.from(`pixels of ${request.url}`)),
        screenshotStable: true,
        documentSize: { width: 1024, height: 900 },
        title: 'scripted',
        text: 'scripted text',
        anchors: [{ tag: 'img', ordinal: 0, rect: { x: 0.4, y: 10.6, width: 600, height: 40 }, label: '/images/masthead.gif', target: null }],
        requests: [
          { url: request.url, disposition: 'served', sha256: 'a'.repeat(64) },
          { url: request.url, disposition: 'served', sha256: 'a'.repeat(64) },
        ],
        pageErrors: [],
      };
    },
    async close() {},
  };
}

test('by default one page per family is rendered; all renders every page', async () => {
  await withTempDirectory(async (directory) => {
    const { model } = await demo(directory);

    assert.equal(selectReferencePages(model, 'representatives').length, model.families.length);
    assert.equal(model.families.length, 2);
    assert.equal(selectReferencePages(model, 'all').length, 3);
  });
});

test('a request is served from stored bytes, reported missing, or blocked as external', async () => {
  await withTempDirectory(async (directory) => {
    const { collection } = await demo(directory);
    const respond = collectionResponder(collection);

    const served = await respond('https://demo.invalid/images/masthead.gif#x');
    assert.equal(served.disposition, 'served');
    assert.equal(served.disposition === 'served' && served.sha256, sha256(new Uint8Array(GIF)));
    const html = await respond('http://www.demo.invalid/issue/one.html');
    // Pure ASCII is labelled us-ascii, which browsers read as windows-1252.
    assert.equal(html.disposition === 'served' && html.contentType, 'text/html; charset=us-ascii');
    assert.equal(served.disposition === 'served' && served.contentType, 'image/gif');
    assert.equal((await respond('http://www.demo.invalid/images/lost.gif')).disposition, 'missing');
    assert.equal((await respond('http://tracker.invalid/pixel.gif')).disposition, 'blocked-external');
  });
});

test('a bundle records rounded anchors, deduplicated requests and screenshot hashes', async () => {
  await withTempDirectory(async (directory) => {
    const { collection, model } = await demo(directory);
    const calls: RenderRequest[] = [];
    const output = join(directory, 'refs');

    const bundle = await buildReferenceBundle({ collection, model, renderer: scriptedRenderer(calls), outputDirectory: output });

    assert.equal(bundle.kind, 'archive-render');
    assert.equal(bundle.modelDigest, model.collection.digest);
    assert.equal(bundle.states.length, 2);
    const state = bundle.states[0];
    assert.ok(state);
    assert.deepEqual(state.anchors[0]?.rect, { x: 0, y: 11, width: 600, height: 40 });
    assert.equal(state.requests.length, 1);
    const stored = await readFile(join(output, state.screenshot.path));
    assert.equal(sha256(new Uint8Array(stored)), state.screenshot.sha256);
    assert.deepEqual(calls.map((call) => call.viewport), [{ width: 1024, height: 768 }, { width: 1024, height: 768 }]);
  });
});

test('a bundle is frozen only by a sign-off that names its digest', async () => {
  await withTempDirectory(async (directory) => {
    const { collection, model } = await demo(directory);
    const output = join(directory, 'refs');
    await buildReferenceBundle({ collection, model, renderer: scriptedRenderer([]), outputDirectory: output });

    const before = await verifyReferenceBundle(output);
    assert.deepEqual([before.ok, before.frozen], [true, false]);

    await signOffReferenceBundle(output, { signedBy: 'reviewer', note: 'matches the archive', signedAt: '2026-01-01T00:00:00.000Z' });
    const after = await verifyReferenceBundle(output);
    assert.deepEqual([after.ok, after.frozen, after.signoff?.signedBy], [true, true, 'reviewer']);
  });
});

test('changing a screenshot or the bundle after sign-off breaks the freeze', async () => {
  await withTempDirectory(async (directory) => {
    const { collection, model } = await demo(directory);
    const output = join(directory, 'refs');
    const bundle = await buildReferenceBundle({ collection, model, renderer: scriptedRenderer([]), outputDirectory: output });
    await signOffReferenceBundle(output, { signedBy: 'reviewer', note: 'ok', signedAt: '2026-01-01T00:00:00.000Z' });

    await writeFile(join(output, bundle.states[0]?.screenshot.path ?? ''), 'different pixels');
    const tamperedImage = await verifyReferenceBundle(output);
    assert.equal(tamperedImage.frozen, false);
    assert.match(tamperedImage.problems.join(' '), /screenshot does not match its recorded hash/);

    const edited = { ...bundle, states: bundle.states.map((state) => ({ ...state, anchors: [] })) };
    await writeFile(join(output, REFERENCE_BUNDLE_FILE), JSON.stringify(edited));
    const tamperedBundle = await verifyReferenceBundle(output);
    assert.match(tamperedBundle.problems.join(' '), /bundle digest does not match its contents/);
  });
});

async function chromiumOrNull(): Promise<ReferenceRenderer | null> {
  try {
    return await createChromiumRenderer();
  } catch {
    return null;
  }
}

test('Chromium renders stored bytes with scripts off and no request leaving the collection', async (t) => {
  const renderer = await chromiumOrNull();
  if (renderer === null) {
    t.skip('no Chromium build for playwright-core is installed on this machine');
    return;
  }
  try {
    await withTempDirectory(async (directory) => {
      const { collection, model } = await demo(directory);
      const output = join(directory, 'refs');

      const bundle = await buildReferenceBundle({ collection, model, renderer, outputDirectory: output, selection: 'all' });
      const one = bundle.states.find((state) => state.originalUrl.endsWith('/issue/one.html'));
      assert.ok(one);

      assert.equal(one.title, 'One');
      assert.equal(one.screenshot.stable, true);
      const dispositions = Object.fromEntries(one.requests.map((record) => [record.url, record.disposition]));
      assert.deepEqual(dispositions, {
        'http://www.demo.invalid/issue/one.html': 'served',
        'http://www.demo.invalid/images/masthead.gif': 'served',
        'http://www.demo.invalid/images/lost.gif': 'missing',
        'http://tracker.invalid/pixel.gif': 'blocked-external',
      });
      const masthead = one.anchors.find((anchor) => anchor.tag === 'img' && anchor.ordinal === 0);
      assert.deepEqual(masthead?.rect, { x: 0, y: 0, width: 600, height: 40 });
      const png = await readFile(join(output, one.screenshot.path));
      assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');

      const again = await buildReferenceBundle({ collection, model, renderer, outputDirectory: join(directory, 'again'), selection: 'all' });
      assert.equal(again.digest, bundle.digest);
      assert.equal((await verifyReferenceBundle(output)).ok, true);
    });
  } finally {
    await renderer.close();
  }
});
