/**
 * The model-backed generation loop, against a scripted provider and a
 * deterministic stand-in browser. No model is called and nothing is spent:
 * these tests cover what the loop does with an answer, not whether a model
 * can write a good one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  buildReferenceBundle,
  buildSiteModel,
  createScriptedProvider,
  extractDocument,
  loadCollectionManifest,
  modernizeSite,
  rewriteBrief,
  sha256,
  signOffReferenceBundle,
  staticProblems,
  submitRewrite,
  transcribeSite,
  type ModelRequest,
  type ModernizationRecord,
  type ModernizeBudgets,
  type ScriptedAnswer,
} from '../src/index.ts';
import { withTempDirectory } from './helpers/acquisition.ts';
import { miniBrowser } from './helpers/mini-browser.ts';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const ONE = `<html><head><title>One</title></head><body bgcolor="#ffffff"><table><tr><td>
<img src="/images/masthead.gif"><h2>One</h2><p>Body text.</p><a href="/issue/two.html">next</a></td></tr></table></body></html>`;
const TWO = '<html><head><title>Two</title></head><body><h1>Two</h1><p>More text.</p><a href="one.html">back</a></body></html>';

const fenced = (document: string): string => `Here is the page.\n\n\`\`\`html\n${document}\n\`\`\`\n`;
const modern = (title: string, body: string, extra = ''): string =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0}</style></head><body${extra}>${body}</body></html>`;
const MODERN_ONE = modern('One', '<main><img src="../images/masthead.gif"><h2>One</h2><p>Body text.</p><a href="two.html">next</a></main>');
const MODERN_TWO = modern('Two', '<h1>Two</h1><p>More text.</p><a href="one.html">back</a>');

interface Setup {
  bundle: string;
  baseline: string;
  output: string;
}

async function setup(directory: string, sign = true): Promise<Setup> {
  const bodies: [string, Uint8Array, string][] = [
    ['http://www.demo.invalid/issue/one.html', Buffer.from(ONE), 'text/html'],
    ['http://www.demo.invalid/issue/two.html', Buffer.from(TWO), 'text/html'],
    ['http://www.demo.invalid/images/masthead.gif', GIF, 'image/gif'],
  ];
  const resources = [];
  for (const [index, [url, bytes, contentType]] of bodies.entries()) {
    const path = join(directory, 'collection', 'bytes', `${index}.bin`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    resources.push({ originalUrl: url, path, contentType, servedTimestamp: '20000615120000', sha256: sha256(new Uint8Array(bytes)) });
  }
  const manifest = join(directory, 'collection', 'collection.json');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, id: 'demo', period: null, resources }));
  const collection = await loadCollectionManifest(manifest);
  const model = await buildSiteModel(collection);

  const bundle = join(directory, 'refs');
  await buildReferenceBundle({ collection, model, renderer: miniBrowser(), outputDirectory: bundle, selection: 'all' });
  if (sign) await signOffReferenceBundle(bundle, { signedBy: 'reviewer', note: 'ok', signedAt: '2026-01-01T00:00:00.000Z' });
  const baseline = join(directory, 'baseline');
  await transcribeSite({ collection, model, outputDirectory: baseline });
  return { bundle, baseline, output: join(directory, 'modern') };
}

const isPageOne = (request: ModelRequest): boolean => (request.messages[0]?.text ?? '').includes('Title: "One"');
const attemptOf = (request: ModelRequest): number => (request.messages.length + 1) / 2;

async function run(
  directory: Setup,
  answer: (request: ModelRequest, callIndex: number) => ScriptedAnswer,
  budgets: Partial<ModernizeBudgets> = {},
): Promise<{ record: ModernizationRecord; requests: ModelRequest[] }> {
  const provider = createScriptedProvider(answer);
  const record = await modernizeSite({
    bundleDirectory: directory.bundle,
    baselineDirectory: directory.baseline,
    outputDirectory: directory.output,
    provider,
    renderer: miniBrowser(),
    budgets,
  });
  return { record, requests: provider.requests };
}

const outcomes = (record: ModernizationRecord): Record<string, string> =>
  Object.fromEntries(record.pages.map((page) => [page.path, page.outcome]));

test('a document is taken from the last html fence, or from a bare document', () => {
  assert.equal(extractDocument('```html\n<p>draft</p>\n```\nBetter:\n```html\n<!doctype html><p>final</p>\n```'), '<!doctype html><p>final</p>\n');
  assert.equal(extractDocument('  <!DOCTYPE html><p>bare</p>  '), '<!DOCTYPE html><p>bare</p>\n');
  assert.equal(extractDocument('I cannot do that.'), null);
});

test('a rewrite with scripts, handlers, layout tables or old presentational markup is rejected before rendering', () => {
  assert.deepEqual(staticProblems(MODERN_ONE), []);
  assert.deepEqual(staticProblems('<html><body><p>x</p></body></html>'), ['does not start with <!doctype html>', 'has no <meta charset="utf-8">']);
  assert.deepEqual(
    staticProblems(modern('x', '<script>x()</script><table><tr><td bgcolor="red"><font>a</font></td></tr></table><a href="#" onclick="x()">y</a>')),
    ['contains a script element', 'contains an inline event handler', 'uses table elements for layout', 'uses font or center elements', 'uses presentational attributes'],
  );
});

test('a rewrite that passes replaces the page; one that fails is repaired with the mismatch report', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(directory);

    const { record, requests } = await run(paths, (request) => {
      if (isPageOne(request)) return fenced(MODERN_ONE);
      return fenced(attemptOf(request) === 1 ? modern('Two', '<h1>Two</h1><p>More text.</p><a href="one.html">back</a>', ' data-paint="red"') : MODERN_TWO);
    });

    assert.deepEqual(outcomes(record), { 'issue/one.html': 'modernized', 'issue/two.html': 'modernized' });
    assert.deepEqual(record.summary, { modernized: 2, keptBaseline: 0, skipped: 0 });
    assert.equal(record.finalVerdict, 'pass');
    assert.equal(record.calls, 3);
    assert.equal(await readFile(join(paths.output, 'site/issue/one.html'), 'utf8'), `${MODERN_ONE}\n`);
    assert.equal(await readFile(join(paths.output, 'site/issue/two.html'), 'utf8'), `${MODERN_TWO}\n`);

    const two = record.pages.find((page) => page.path === 'issue/two.html');
    assert.deepEqual(two?.attempts.map((attempt) => [attempt.attempt, attempt.passed, attempt.failedChecks.map((entry) => entry.name)]), [
      [1, false, ['visual']],
      [2, true, []],
    ]);
    const repair = requests[2]?.messages[2]?.text ?? '';
    assert.match(repair, /did not pass/);
    assert.match(repair, /visual: 400 of 400 pixels differ/);
    assert.equal(requests[2]?.messages[1]?.role, 'assistant');
    assert.ok((await stat(join(paths.output, 'attempts', two?.pageId ?? '', '1', 'page.html'))).isFile());
  });
});

test('the first request carries the screenshot, the measured elements and the page source', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(directory);
    const { requests } = await run(paths, (request) => fenced(isPageOne(request) ? MODERN_ONE : MODERN_TWO));
    const first = requests.find(isPageOne);

    assert.match(first?.system ?? '', /Do not use table elements/);
    assert.equal(first?.messages[0]?.images?.[0]?.mediaType, 'image/png');
    assert.equal(Buffer.from(first?.messages[0]?.images?.[0]?.data ?? '', 'base64').subarray(1, 4).toString('latin1'), 'PNG');
    assert.match(first?.messages[0]?.text ?? '', /img#0 x=0 y=0 w=100 h=20 "\/images\/masthead.gif"/);
    assert.match(first?.messages[0]?.text ?? '', /<a href="two\.html">next<\/a>/);
  });
});

test('a page whose rewrites never pass keeps its transcribed version, and a static failure costs no render', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(directory);
    const baselineOne = await readFile(join(paths.baseline, 'site/issue/one.html'), 'utf8');

    const { record, requests } = await run(paths, (request) =>
      isPageOne(request) ? fenced(modern('One', '<table><tr><td>One</td></tr></table>')) : fenced(MODERN_TWO.replace('More text.', 'Other text.')),
    );

    assert.deepEqual(outcomes(record), { 'issue/one.html': 'kept-baseline', 'issue/two.html': 'kept-baseline' });
    assert.equal(record.calls, 6);
    assert.equal(record.finalVerdict, 'pass');
    assert.equal(await readFile(join(paths.output, 'site/issue/one.html'), 'utf8'), baselineOne);
    const one = record.pages.find((page) => page.path === 'issue/one.html');
    assert.deepEqual(one?.attempts.map((attempt) => attempt.staticProblems), Array(3).fill(['uses table elements for layout']));
    assert.deepEqual(one?.attempts.map((attempt) => attempt.failedChecks), [[], [], []]);
    const two = record.pages.find((page) => page.path === 'issue/two.html');
    assert.deepEqual(two?.attempts[2]?.failedChecks.map((entry) => entry.name), ['text']);
    assert.match(requests.filter(isPageOne)[1]?.messages[2]?.text ?? '', /the document uses table elements for layout/);
  });
});

test('a refusal, an empty answer and a cut-off answer are failed attempts, and a refusal is not retried', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(directory);

    const { record } = await run(paths, (request) => (isPageOne(request) ? { text: '', refused: true } : 'I would rather describe the page.'));

    const one = record.pages.find((page) => page.path === 'issue/one.html');
    const two = record.pages.find((page) => page.path === 'issue/two.html');
    assert.deepEqual([one?.outcome, one?.attempts.length, one?.attempts[0]?.staticProblems], ['kept-baseline', 1, ['the model declined to answer']]);
    assert.deepEqual([two?.outcome, two?.attempts.length, two?.attempts[0]?.staticProblems], ['kept-baseline', 3, ['the answer held no HTML document']]);
  });
});

test('the page limit and the token budget stop the loop and say so', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(join(directory, 'a'));
    const limited = await run(paths, (request) => fenced(isPageOne(request) ? MODERN_ONE : MODERN_TWO), { maxPages: 1 });
    assert.deepEqual(outcomes(limited.record), { 'issue/one.html': 'modernized', 'issue/two.html': 'skipped' });
    assert.equal(limited.record.stoppedEarly, 'page limit of 1 reached');
    assert.equal(limited.record.calls, 1);

    const broke = await run(await setup(join(directory, 'b')), () => fenced(MODERN_ONE), { maxInputTokens: 10 });
    assert.equal(broke.record.calls, 0);
    assert.deepEqual(broke.record.summary, { modernized: 0, keptBaseline: 0, skipped: 2 });
    assert.equal(broke.record.stoppedEarly, 'token budget reached');
    assert.equal(broke.record.finalVerdict, 'pass');

    const oversized = await run(await setup(join(directory, 'c')), () => fenced(MODERN_ONE), { maxPageBytes: 10 });
    assert.equal(oversized.record.calls, 0);
    assert.match(oversized.record.pages[0]?.reason ?? '', /larger than 10 bytes and was not cut down/);
  });
});

test('an unsigned reference bundle is refused before any model call', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(directory, false);
    const provider = createScriptedProvider(() => fenced(MODERN_ONE));

    await assert.rejects(
      modernizeSite({ bundleDirectory: paths.bundle, baselineDirectory: paths.baseline, outputDirectory: paths.output, provider, renderer: miniBrowser() }),
      /no sign-off/,
    );
    assert.equal(provider.requests.length, 0);
  });
});

test('a baseline that does not pass is refused before any model call', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(directory);
    const file = join(paths.baseline, 'site/issue/two.html');
    await writeFile(file, (await readFile(file, 'utf8')).replace('More text.', 'Edited text.'));
    const provider = createScriptedProvider(() => fenced(MODERN_ONE));

    await assert.rejects(
      modernizeSite({ bundleDirectory: paths.bundle, baselineDirectory: paths.baseline, outputDirectory: paths.output, provider, renderer: miniBrowser() }),
      /baseline candidate does not pass \(1 of 2 states fail\)/,
    );
    assert.equal(provider.requests.length, 0);
  });
});

async function submit(paths: Setup, page: string, document: string, name: string, maxAttempts = 3) {
  const file = join(paths.output, '..', name);
  await writeFile(file, document);
  return await submitRewrite({
    bundleDirectory: paths.bundle,
    baselineDirectory: paths.baseline,
    outputDirectory: paths.output,
    page,
    documentPath: file,
    author: 'session agent',
    renderer: miniBrowser(),
    maxAttempts,
  });
}

test('a submitted rewrite is judged by the same gate: a pass replaces the page, a failure puts the baseline back', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(directory);
    const url = 'http://www.demo.invalid/issue/two.html';
    const baselinePage = await readFile(join(paths.baseline, 'site/issue/two.html'), 'utf8');

    const wrong = await submit(paths, url, modern('Two', '<h1>Two</h1><p>More text.</p><a href="one.html">back</a>', ' data-paint="red"'), 'wrong.html');
    assert.equal(wrong.accepted, false);
    assert.deepEqual(wrong.record.failedChecks.map((entry) => entry.name), ['visual']);
    assert.equal(await readFile(join(paths.output, 'site/issue/two.html'), 'utf8'), baselinePage);

    const unsafe = await submit(paths, wrong.pageId, modern('Two', '<script>x()</script><h1>Two</h1>'), 'unsafe.html');
    assert.deepEqual(unsafe.record.staticProblems, ['contains a script element']);
    assert.deepEqual(unsafe.record.failedChecks, []);

    const right = await submit(paths, url, MODERN_TWO, 'right.html');
    assert.equal(right.accepted, true);
    assert.equal(right.attemptsUsed, 3);
    assert.equal(right.record.author, 'session agent');
    assert.equal(await readFile(join(paths.output, 'site/issue/two.html'), 'utf8'), MODERN_TWO);
    assert.equal(await readFile(join(paths.output, 'site/issue/one.html'), 'utf8'), await readFile(join(paths.baseline, 'site/issue/one.html'), 'utf8'));

    await assert.rejects(submit(paths, url, MODERN_TWO, 'again.html'), /already has an accepted rewrite/);
  });
});

test('a page has a fixed number of submissions, and an unsigned bundle or unknown page is refused', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(join(directory, 'a'));
    const url = 'http://www.demo.invalid/issue/two.html';
    const wrong = modern('Two', '<h1>Other</h1>');

    assert.equal((await submit(paths, url, wrong, 'w1.html', 1)).accepted, false);
    await assert.rejects(submit(paths, url, MODERN_TWO, 'w2.html', 1), /has used all 1 attempts/);
    await assert.rejects(submit(paths, 'http://www.demo.invalid/nowhere.html', MODERN_TWO, 'w3.html'), /no reference state/);

    const unsigned = await setup(join(directory, 'b'), false);
    await mkdir(unsigned.output, { recursive: true });
    await assert.rejects(submit(unsigned, url, MODERN_TWO, 'w4.html'), /no sign-off/);
  });
});

test('the brief gives an author the rules, the measurements and the input paths', async () => {
  await withTempDirectory(async (directory) => {
    const paths = await setup(directory);

    const brief = await rewriteBrief(paths.bundle, paths.baseline, 'http://www.demo.invalid/issue/one.html');

    assert.match(brief, /Page: http:\/\/www\.demo\.invalid\/issue\/one\.html/);
    assert.match(brief, /Title: "One"/);
    assert.ok(brief.includes(join(paths.baseline, 'site/issue/one.html')));
    assert.ok(brief.includes(join(paths.bundle, 'states')));
    assert.equal(brief.includes('fenced block'), false);
  });
});

test('a rewrite must keep the timed redirects of the page it replaces, and may not add one', () => {
  const refresh = '<meta http-equiv="refresh" content="18;URL=contents.html">';
  const old = `<html><head>${refresh}<title>x</title></head><body></body></html>`;
  const kept = MODERN_ONE.replace('<title>', '<META content="18; url=contents.html" HTTP-EQUIV=Refresh><title>');

  assert.deepEqual(staticProblems(kept, old), []);
  assert.deepEqual(staticProblems(MODERN_ONE, old), ['does not keep the page\'s meta refresh (content="18;url=contents.html")']);
  assert.deepEqual(staticProblems(kept, ONE), ['adds a meta refresh the page did not have']);
  assert.deepEqual(staticProblems(MODERN_ONE, ONE), []);
});
