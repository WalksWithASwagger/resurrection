import { test } from 'node:test';
import assert from 'node:assert/strict';

import { discoverLinks, localPathFor } from '../src/index.ts';

const PAGE_URL = 'http://demo.invalid/section/page.html';

test('assets, documents and page links are discovered with their relation and location', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="../style.css">
    <script src="/js/menu.js"></script>
    </head><body background="/bg.gif">
    <img src="logo.gif">
    <a href="/papers/report.pdf">report</a>
    <a href="/about.html">about</a>
    </body></html>`;

  const links = discoverLinks(html, PAGE_URL);
  const byUrl = new Map(links.map((link) => [link.resolvedUrl, link]));

  assert.equal(byUrl.get('http://demo.invalid/style.css')?.relation, 'stylesheet');
  assert.equal(byUrl.get('http://demo.invalid/js/menu.js')?.relation, 'script');
  assert.equal(byUrl.get('http://demo.invalid/bg.gif')?.relation, 'image');
  assert.equal(byUrl.get('http://demo.invalid/section/logo.gif')?.relation, 'image');
  assert.equal(byUrl.get('http://demo.invalid/papers/report.pdf')?.relation, 'document');
  assert.equal(byUrl.get('http://demo.invalid/about.html')?.relation, 'link');
  assert.equal(byUrl.get('http://demo.invalid/section/logo.gif')?.location, '<img src>');
});

test('a base element changes what relative URLs resolve to', () => {
  const html = '<html><head><base href="http://demo.invalid/other/"></head><body><img src="a.gif"></body></html>';

  const links = discoverLinks(html, PAGE_URL);

  assert.equal(links[0]?.resolvedUrl, 'http://demo.invalid/other/a.gif');
});

test('script, mail and fragment targets are not dependencies', () => {
  const html = `<a href="javascript:void(0)">x</a><a href="mailto:someone@demo.invalid">y</a>
    <a href="#top">z</a><img src="data:image/gif;base64,AAAA">`;

  assert.deepEqual(discoverLinks(html, PAGE_URL), []);
});

test('a query string keeps its own local file instead of colliding with the bare path', () => {
  const plain = localPathFor('http://demo.invalid/header.gif');
  const variantA = localPathFor('http://demo.invalid/header.gif?v=1');
  const variantB = localPathFor('http://demo.invalid/header.gif?v=2');

  assert.equal(plain, 'site/demo.invalid/header.gif');
  assert.notEqual(variantA, plain);
  assert.notEqual(variantA, variantB);
  assert.ok(variantA.endsWith('.gif'));
});

test('a directory URL maps to an index document', () => {
  assert.equal(localPathFor('http://demo.invalid/'), 'site/demo.invalid/index.html');
  assert.equal(localPathFor('http://demo.invalid/section/'), 'site/demo.invalid/section/index.html');
  assert.equal(localPathFor('http://demo.invalid/section'), 'site/demo.invalid/section/index.html');
});

test('traversal and encoded separators cannot escape the export directory', () => {
  const mapped = localPathFor('http://demo.invalid/a/..%2f..%2f..%2fetc%2fpasswd');
  const segments = mapped.split('/');

  assert.ok(mapped.startsWith('site/demo.invalid/'));
  // An interior '..' inside one segment is inert; a '..' that is its own
  // segment is the escape, and sanitisation never produces one.
  assert.equal(segments.includes('..'), false);
  assert.equal(segments.includes('.'), false);
  assert.equal(segments.includes('etc'), false);
});

test('characters a filesystem cannot carry are replaced, and the escape is kept', () => {
  // The space arrives percent-encoded, which is part of the historical URL's
  // identity, so it is sanitised rather than decoded away.
  assert.equal(localPathFor('http://demo.invalid/pages/a b;c/x.html'), 'site/demo.invalid/pages/a_20b_c/x.html');
});
