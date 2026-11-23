/**
 * The transcribing generator: a candidate built from recovered markup with no
 * model call. The last test closes the loop in Chromium: reference, generate,
 * evaluate. It is skipped by name where no Chromium build is installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  buildReferenceBundle,
  buildSiteModel,
  createChromiumRenderer,
  evaluateCandidate,
  loadCandidate,
  loadCollectionManifest,
  sha256,
  signOffReferenceBundle,
  replaceTags,
  transcribeSite,
  type Collection,
  type GenerationRecord,
  type SiteModel,
} from '../src/index.ts';
import { withTempDirectory } from './helpers/acquisition.ts';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const ARTICLE = `<html><head><title>One</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<base href="http://www.demo.invalid/issue/">
<script src="/js/menu.js"></script><script>document.title = 'script ran';</script></head>
<body bgcolor="#ffffff" background="/images/masthead.gif" style="margin:0" onload="init()">
<noscript><p>Shown without script.</p></noscript>
<table width="600" cellpadding="0" cellspacing="0"><tr><td>
<img src="/images/masthead.gif" width="600" height="40"><img src="../images/lost.gif" width="20" height="20">
<img src="http://tracker.invalid/pixel.gif" width="1" height="1"></td></tr>
<tr><td><h2>Caf\xe9 \x93One\x94</h2>
<a href="two.html#top" onmouseover="swap(1)">next</a> <a href="http://WWW.demo.invalid:80/">home</a>
<a href="lost.html">lost</a> <a href="http://elsewhere.invalid/x">friend</a>
<a href="javascript:popup()">popup</a> <a href="mailto:editor@demo.invalid">mail</a> <a href="#top">top</a>
</td></tr></table></body></html>`;
const TWO = '<html><head><title>Two</title></head><body><a name="top"></a><h1>Two</h1><a href="one.html">back</a> <a href="#top">up</a></body></html>';
const HOME = '<html><head><title>Home</title></head><body><a href="issue/one.html">one</a></body></html>';

async function demo(directory: string): Promise<{ collection: Collection; model: SiteModel }> {
  const bodies: [string, Uint8Array, string][] = [
    ['http://www.demo.invalid/', Buffer.from(HOME, 'latin1'), 'text/html'],
    ['http://www.demo.invalid/issue/one.html', Buffer.from(ARTICLE, 'latin1'), 'text/html'],
    ['http://www.demo.invalid:80/issue/two.html', Buffer.from(TWO, 'latin1'), 'text/html'],
    ['http://demo.invalid/images/masthead.gif', GIF, 'image/gif'],
  ];
  const resources = [];
  for (const [index, [url, bytes, contentType]] of bodies.entries()) {
    const path = join(directory, 'bytes', `${index}.bin`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    resources.push({ originalUrl: url, path, contentType, servedTimestamp: '20000615120000', sha256: sha256(new Uint8Array(bytes)) });
  }
  await writeFile(join(directory, 'collection.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', period: null, resources }));
  const collection = await loadCollectionManifest(join(directory, 'collection.json'));
  return { collection, model: await buildSiteModel(collection) };
}

async function generate(directory: string): Promise<{ output: string; record: GenerationRecord; one: string }> {
  const { collection, model } = await demo(join(directory, 'collection'));
  const output = join(directory, 'candidate');
  const record = await transcribeSite({ collection, model, outputDirectory: output });
  return { output, record, one: await readFile(join(output, 'site/issue/one.html'), 'utf8') };
}

test('files mirror the original paths and the URL map covers every recovered resource', async () => {
  await withTempDirectory(async (directory) => {
    const { output } = await generate(directory);
    const candidate = await loadCandidate(output);

    assert.deepEqual([...candidate.keyByPath.keys()].sort(), ['images/masthead.gif', 'index.html', 'issue/one.html', 'issue/two.html']);
    assert.deepEqual(await readFile(join(output, 'site/images/masthead.gif')), GIF);
  });
});

test('archived scripts and inline handlers are removed and noscript content is kept', async () => {
  await withTempDirectory(async (directory) => {
    const { one, record } = await generate(directory);
    const page = record.pages.find((entry) => entry.path === 'issue/one.html');

    assert.equal(/<script|onload=|onmouseover=|<noscript|<base/i.test(one), false);
    assert.ok(one.includes('<p>Shown without script.</p>'));
    assert.deepEqual([page?.scriptsRemoved, page?.handlersRemoved], [2, 2]);
  });
});

test('links and resources become relative, with fragments kept and the base element honoured', async () => {
  await withTempDirectory(async (directory) => {
    const { one, output } = await generate(directory);

    assert.ok(one.includes('<a href="two.html#top">next</a>'));
    assert.ok(one.includes('<a href="../index.html">home</a>'));
    assert.ok(one.includes('background="../images/masthead.gif"'));
    assert.ok(one.includes('<img src="../images/masthead.gif" width="600" height="40">'));
    assert.ok(one.includes('<a href="mailto:editor@demo.invalid">mail</a>'));
    assert.ok(one.includes('<a href="#">popup</a>'));
    assert.ok(one.includes('<a href="http://elsewhere.invalid/x">friend</a>'));
    assert.ok((await readFile(join(output, 'site/issue/two.html'), 'utf8')).includes('<a href="#top">up</a>'));
  });
});

test('a missing page gets a labelled notice; missing and external resources are left unloaded, never fetched', async () => {
  await withTempDirectory(async (directory) => {
    const { one, record, output } = await generate(directory);
    const page = record.pages.find((entry) => entry.path === 'issue/one.html');

    const gapHref = /<a href="(\.\.\/_gaps\/[0-9a-f]{8}\.html)">lost<\/a>/.exec(one)?.[1];
    assert.ok(gapHref);
    const notice = await readFile(join(output, 'site/issue', gapHref), 'utf8');
    assert.ok(notice.includes('not part of the original site'));
    assert.ok(notice.includes('http://www.demo.invalid/issue/lost.html'));

    assert.equal((one.match(/src="data:,"/g) ?? []).length, 2);
    assert.deepEqual(page?.missingResources, ['http://www.demo.invalid/images/lost.gif']);
    assert.deepEqual(page?.omittedExternalResources, ['http://tracker.invalid/pixel.gif']);
    assert.equal(one.includes('tracker.invalid'), false);
    // With a base element, "#top" names the base document, which was not recovered.
    assert.match(one, /<a href="\.\.\/_gaps\/[0-9a-f]{8}\.html#top">top<\/a>/);
    assert.deepEqual([page?.gapLinks, record.gapNotices, record.model], [2, 2, null]);
  });
});

test('text is re-encoded as UTF-8 with one declaration and no doctype is added', async () => {
  await withTempDirectory(async (directory) => {
    const { one } = await generate(directory);

    assert.ok(one.includes('Café “One”'));
    assert.equal((one.match(/charset/gi) ?? []).length, 1);
    assert.ok(one.includes('<meta charset="utf-8">'));
    assert.equal(/<!doctype/i.test(one), false);
  });
});

test('generating twice produces the same candidate digest', async () => {
  await withTempDirectory(async (directory) => {
    const first = await loadCandidate((await generate(join(directory, 'a'))).output);
    const second = await loadCandidate((await generate(join(directory, 'b'))).output);

    assert.equal(first.digest, second.digest);
  });
});

test('Chromium end to end: a transcribed candidate matches its own reference on every check', async (t) => {
  const renderer = await createChromiumRenderer().catch(() => null);
  if (renderer === null) {
    t.skip('no Chromium build for playwright-core is installed on this machine');
    return;
  }
  try {
    await withTempDirectory(async (directory) => {
      const { collection, model } = await demo(join(directory, 'collection'));
      const bundle = join(directory, 'refs');
      await buildReferenceBundle({ collection, model, renderer, outputDirectory: bundle, selection: 'all' });
      await signOffReferenceBundle(bundle, { signedBy: 'reviewer', note: 'ok', signedAt: '2026-01-01T00:00:00.000Z' });
      const candidate = join(directory, 'candidate');
      await transcribeSite({ collection, model, outputDirectory: candidate });

      const report = await evaluateCandidate({ bundleDirectory: bundle, candidateDirectory: candidate, outputDirectory: join(directory, 'evaluation'), renderer });

      const failures = report.states.flatMap((state) => state.checks.filter((entry) => !entry.pass).map((entry) => `${state.originalUrl} ${entry.name}: ${entry.detail}`));
      assert.deepEqual(failures, []);
      assert.equal(report.verdict, 'pass');
      assert.equal(report.summary.states, 3);
    });
  } finally {
    await renderer.close();
  }
});

test('a quoted attribute value runs past a > to its closing quote, as a browser reads it', () => {
  const tags: string[] = [];
  const html = '<p>a <a href="http://x.invalid/n/>N</a> b">link</a> <img alt=\'x\' src=y.gif> <b title="never closed>c';
  const out = replaceTags(html, (tag) => {
    tags.push(tag);
    return tag.toUpperCase();
  });

  assert.deepEqual(tags, ['<p>', '<a href="http://x.invalid/n/>N</a> b">', "<img alt='x' src=y.gif>"]);
  assert.equal(out, '<P>a <A HREF="HTTP://X.INVALID/N/>N</A> B">link</a> <IMG ALT=\'X\' SRC=Y.GIF> <b title="never closed>c');
});

test('a folder URL and its index file share one file when their bytes match, and keep both versions when not', async () => {
  await withTempDirectory(async (directory) => {
    const build = async (name: string, folderBody: string): Promise<{ map: { originalUrl: string; path: string }[]; output: string }> => {
      const root = join(directory, name);
      const bodies: [string, string][] = [
        ['http://www.demo.invalid/issue/', folderBody],
        ['http://www.demo.invalid/issue/index.html', '<html><body>good intentional</body></html>'],
      ];
      const resources = [];
      for (const [index, [url, body]] of bodies.entries()) {
        const path = join(root, 'bytes', `${index}.bin`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body);
        resources.push({ originalUrl: url, path, contentType: 'text/html', servedTimestamp: '20000615120000', sha256: sha256(new Uint8Array(Buffer.from(body))) });
      }
      await writeFile(join(root, 'collection.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', period: null, resources }));
      const collection = await loadCollectionManifest(join(root, 'collection.json'));
      const output = join(root, 'candidate');
      await transcribeSite({ collection, model: await buildSiteModel(collection), outputDirectory: output });
      return { map: JSON.parse(await readFile(join(output, 'url-map.json'), 'utf8')).entries, output };
    };

    const same = await build('same', '<html><body>good intentional</body></html>');
    assert.deepEqual(same.map.map((entry) => entry.path), ['issue/index.html', 'issue/index.html']);

    const edited = await build('edited', '<html><body>good intentioned</body></html>');
    const paths = Object.fromEntries(edited.map.map((entry) => [entry.originalUrl, entry.path]));
    assert.equal(paths['http://www.demo.invalid/issue/index.html'], 'issue/index.html');
    assert.match(paths['http://www.demo.invalid/issue/'] ?? '', /^issue\/index__[0-9a-f]{8}\.html$/);
    assert.match(await readFile(join(edited.output, 'site', paths['http://www.demo.invalid/issue/'] ?? ''), 'utf8'), /intentioned/);
    assert.match(await readFile(join(edited.output, 'site/issue/index.html'), 'utf8'), /intentional/);
    await loadCandidate(edited.output);
  });
});
