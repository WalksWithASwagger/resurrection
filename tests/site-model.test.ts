/**
 * The collection manifest and the site model built from it.
 *
 * Every body here is synthetic and written to a throwaway directory. Nothing
 * opens a socket: a model is derived from stored bytes only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildSiteModel,
  collectionFromJob,
  loadCollectionManifest,
  runAcquisition,
  sha256,
  siteKey,
  structuralSimilarity,
  structuralSkeleton,
  visibleText,
  writeSiteModel,
  type SiteModel,
} from '../src/index.ts';
import { harness, withTempDirectory } from './helpers/acquisition.ts';

const PERIOD = { from: '20000101000000', to: '20001231235959' };

interface Body {
  url: string;
  body: string;
  contentType?: string;
  timestamp?: string;
  provenance?: string;
}

const article = (title: string, paragraphs: number, extra = ''): string => `<html><head><title>${title}</title>
<script>function swap(){}</script></head>
<body bgcolor="#ffffff"><table width="600"><tr><td><img src="/images/masthead.gif"></td></tr>
<tr><td><a href="/issue/contents.html" onmouseover="swap()">contents</a></td></tr>
<tr><td><h2>${title}</h2>${'<p>Body <b>text</b> here.</p>'.repeat(paragraphs)}${extra}</td></tr>
<tr><td><hr><address>masthead</address></td></tr></table></body></html>`;

const CONTENTS = `<html><head><title>Contents</title></head><body>
<h1>Issue</h1><ul>
<li><a href="one.html">One</a></li><li><a href="http://www.demo.invalid:80/issue/two.html">Two</a></li>
<li><a href="three.html">Three (lost)</a></li></ul>
<form action="/cgi/search"><input type="text"></form>
<a href="http://elsewhere.invalid/">a friend</a>
<a href="/files/essay.pdf">essay</a></body></html>`;

const BODIES: Body[] = [
  { url: 'http://www.demo.invalid:80/issue/contents.html', body: CONTENTS },
  { url: 'http://www.demo.invalid/issue/one.html', body: article('One &amp; only', 3) },
  { url: 'http://demo.invalid/issue/two.html', body: article('Two', 14, '<img src="images/figure.gif">') },
  { url: 'http://www.demo.invalid/images/masthead.gif', body: 'GIF89a-masthead', contentType: 'image/gif' },
  {
    url: 'http://www.demo.invalid/issue/images/figure.gif',
    body: 'GIF89a-figure',
    contentType: 'image/gif',
    timestamp: '20020304050607',
    provenance: 'later capture of the exact URL',
  },
];

async function writeCollection(directory: string, bodies: readonly Body[], period: unknown = PERIOD): Promise<string> {
  await mkdir(join(directory, 'bytes'), { recursive: true });
  const resources = [];
  for (const [index, entry] of bodies.entries()) {
    const bytes = new Uint8Array(Buffer.from(entry.body, 'latin1'));
    const path = join('bytes', `${index}.bin`);
    await writeFile(join(directory, path), bytes);
    resources.push({
      originalUrl: entry.url,
      path,
      contentType: entry.contentType ?? 'text/html',
      servedTimestamp: entry.timestamp ?? '20000615120000',
      sha256: sha256(bytes),
      ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
    });
  }
  const manifestPath = join(directory, 'collection.json');
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, id: 'demo', period, resources }));
  return manifestPath;
}

async function demoModel(directory: string): Promise<SiteModel> {
  return await buildSiteModel(await loadCollectionManifest(await writeCollection(directory, BODIES)));
}

test('scheme, www, a default port and the fragment are aliases; path case and query are not', () => {
  assert.equal(siteKey('http://www.Demo.invalid:80/a/B.html#top'), siteKey('https://demo.invalid/a/B.html'));
  assert.notEqual(siteKey('http://demo.invalid/a/B.html'), siteKey('http://demo.invalid/a/b.html'));
  assert.notEqual(siteKey('http://demo.invalid/a?x=1'), siteKey('http://demo.invalid/a?x=2'));
  assert.notEqual(siteKey('http://demo.invalid:8080/a'), siteKey('http://demo.invalid/a'));
});

test('a manifest whose body no longer matches its recorded hash is refused', async () => {
  await withTempDirectory(async (directory) => {
    const manifestPath = await writeCollection(directory, BODIES);
    await writeFile(join(directory, 'bytes', '1.bin'), 'tampered');

    await assert.rejects(loadCollectionManifest(manifestPath), /does not match its recorded sha256/);
  });
});

test('a capture outside the period needs a recorded reason', async () => {
  await withTempDirectory(async (directory) => {
    const bodies = BODIES.map((entry) => ({ ...entry, provenance: undefined }));
    const manifestPath = await writeCollection(directory, bodies);

    await assert.rejects(loadCollectionManifest(manifestPath), /outside the period and has no provenance/);
  });
});

test('pages and assets are separated and every link is classified by what was recovered', async () => {
  await withTempDirectory(async (directory) => {
    const model = await demoModel(directory);

    assert.equal(model.pages.length, 3);
    assert.equal(model.assets.length, 2);
    assert.deepEqual(model.siteHosts, ['demo.invalid']);

    const contents = model.pages.find((page) => page.key.endsWith('/issue/contents.html'));
    assert.ok(contents);
    const targets = Object.fromEntries(contents.links.map((link) => [link.rawUrl, link.target]));
    assert.deepEqual(targets, {
      'one.html': 'page',
      'http://www.demo.invalid:80/issue/two.html': 'page',
      'three.html': 'missing',
      'http://elsewhere.invalid/': 'external',
      '/files/essay.pdf': 'missing',
    });
  });
});

test('a short and a long article share a family; the contents page does not join it', async () => {
  await withTempDirectory(async (directory) => {
    const model = await demoModel(directory);
    const familyOf = (suffix: string): string =>
      model.pages.find((page) => page.key.endsWith(suffix))?.familyId ?? 'absent';

    assert.equal(familyOf('/issue/one.html'), familyOf('/issue/two.html'));
    assert.notEqual(familyOf('/issue/one.html'), familyOf('/issue/contents.html'));
    assert.equal(model.families.length, 2);
    assert.equal(structuralSimilarity(structuralSkeleton(article('a', 1)), structuralSkeleton(article('b', 40))), 1);
  });
});

test('missing targets, date exceptions and unused variants are recorded as gaps', async () => {
  await withTempDirectory(async (directory) => {
    const variant: Body = { url: 'http://demo.invalid:80/issue/one.html', body: article('One, later', 2), timestamp: '20000901000000' };
    const model = await buildSiteModel(await loadCollectionManifest(await writeCollection(directory, [...BODIES, variant])));
    const kinds = model.gaps.map((gap) => `${gap.kind} ${gap.url}`).sort();

    assert.deepEqual(kinds, [
      'date-exception http://www.demo.invalid/issue/images/figure.gif',
      'missing-document http://www.demo.invalid/files/essay.pdf',
      'missing-page http://www.demo.invalid/issue/three.html',
      'unused-variant http://demo.invalid:80/issue/one.html',
    ]);
    const one = model.pages.find((page) => page.key.endsWith('/issue/one.html'));
    assert.equal(one?.servedTimestamp, '20000615120000');
    assert.equal(one?.title, 'One & only');
  });
});

test('navigation records local links, entry pages and external destinations', async () => {
  await withTempDirectory(async (directory) => {
    const model = await demoModel(directory);
    const idOf = (suffix: string): string => model.pages.find((page) => page.key.endsWith(suffix))?.id ?? 'absent';

    assert.deepEqual(
      model.navigation.edges.map((edge) => `${edge.from} ${edge.to}`).sort(),
      [
        `${idOf('/contents.html')} ${idOf('/one.html')}`,
        `${idOf('/contents.html')} ${idOf('/two.html')}`,
        `${idOf('/one.html')} ${idOf('/contents.html')}`,
        `${idOf('/two.html')} ${idOf('/contents.html')}`,
      ].sort(),
    );
    assert.deepEqual(model.navigation.entryPageIds, []);
    assert.deepEqual(model.navigation.external.map((entry) => entry.url), ['http://elsewhere.invalid/']);

    const masthead = model.assets.find((asset) => asset.key.endsWith('/images/masthead.gif'));
    assert.equal(masthead?.occurrences.length, 2);
  });
});

test('markup that implies behavior is recorded as static evidence, never as observed', async () => {
  await withTempDirectory(async (directory) => {
    const model = await demoModel(directory);
    const one = model.pages.find((page) => page.key.endsWith('/issue/one.html'));
    const contents = model.pages.find((page) => page.key.endsWith('/issue/contents.html'));

    assert.deepEqual(one?.features.map((feature) => `${feature.kind} ${feature.count} ${feature.evidence}`), [
      'inline-event-handler 1 static',
      'inline-script 1 static',
    ]);
    assert.deepEqual(contents?.features.map((feature) => feature.kind), ['form']);
  });
});

test('visible text drops scripts, styles and markup and decodes entities', () => {
  const text = visibleText('<title>t</title><style>p{}</style><p>Fish &amp; chips&nbsp;&#169; <b>2000</b></p><script>x()</script>');

  assert.equal(text, 'Fish & chips © 2000');
});

test('the same collection produces byte-identical model files with no absolute path', async () => {
  await withTempDirectory(async (directory) => {
    const first = await writeSiteModel(join(directory, 'a'), await demoModel(join(directory, 'one')));
    const second = await writeSiteModel(join(directory, 'b'), await demoModel(join(directory, 'two')));
    const text = await readFile(first, 'utf8');

    assert.equal(text, await readFile(second, 'utf8'));
    assert.equal(text.includes(directory), false);
  });
});

test('a job narrows to its reference-eligible bodies and models without a request', async () => {
  await withTempDirectory(async (directory) => {
    const setup = await harness(directory);
    const result = await runAcquisition({
      config: setup.config,
      transport: setup.handle.transport,
      resolver: setup.handle.resolver,
      clock: setup.clock,
    });
    const requests = setup.handle.calls.length;

    const collection = await collectionFromJob(result.state, directory);
    const model = await buildSiteModel(collection);

    assert.equal(setup.handle.calls.length, requests);
    assert.equal(collection.source, 'job');
    assert.ok(collection.resources.length > 0);
    const eligible = result.state.items.filter((item) => item.outcome?.referenceEligible === true && item.status === 'fetched');
    assert.equal(collection.resources.length, eligible.length);
    assert.ok(model.pages.length > 0);
    assert.equal(model.pages.length + model.assets.length + model.gaps.filter((gap) => gap.kind === 'unused-variant').length, collection.resources.length);
  });
});
