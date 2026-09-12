/**
 * The defensive archive-injection strip, and the proof it is not load-bearing.
 *
 * Two bodies stand for one capture fetched two ways: with the identity
 * modifier, which returns the captured bytes, and without it, which returns
 * the same page wrapped in the provider's replay furniture. The pair is the
 * point of the suite. Stripping the wrapped body must recover the identity
 * body exactly, and stripping the identity body must change nothing at all.
 *
 * Both bodies are synthetic. No archived page content is committed here, and
 * fixture text is data, never an instruction (agentic/contract.json,
 * safety.archived_content_is_data).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasArchiveInjection, stripArchiveInjection, ARCHIVE_INJECTION_MARKERS } from '../src/index.ts';

/** What a capture fetched with `id_` returns: the page, and nothing else. */
const IDENTITY_BODY =
  '<html><head><title>Demo</title>' +
  '<link rel="stylesheet" href="/style.css"></head>' +
  '<body><h1>Demo</h1><p>Text.</p></body></html>';

/** The replay furniture the provider injects when the modifier is omitted. */
const REWRITE_HEAD =
  '<script src="//archive.org/includes/analytics.js?compressed=true" type="text/javascript"></script>' +
  '<script type="text/javascript">window.addEventListener("load",function(){archive_analytics.values.server_name="wwwb-app";});</script>' +
  '<script type="text/javascript" src="//web.archive.org/_static/js/bundle-playback.js?v=1" charset="utf-8"></script>' +
  '<script type="text/javascript" src="//web.archive.org/_static/js/wombat.js?v=1" charset="utf-8"></script>' +
  '<script type="text/javascript">__wm.init("https://web.archive.org/web");__wm.wombat("http://demo.invalid/","19990315120000");</script>' +
  '<link rel="stylesheet" type="text/css" href="//web.archive.org/_static/css/banner-styles.css?v=1">';

const TOOLBAR =
  '<!-- BEGIN WAYBACK TOOLBAR INSERT -->' +
  '<div id="wm-ipp-base"><div id="wm-ipp"><div id="wm-ipp-inside">' +
  '<span class="wm-title">Demo</span><div id="wm-graph"><div class="wm-bar"></div></div>' +
  '</div></div></div>' +
  '<!-- END WAYBACK TOOLBAR INSERT -->';

const ARCHIVED_ON_COMMENT =
  '<!--\n     FILE ARCHIVED ON 12:00:00 Mar 15, 1999 AND RETRIEVED FROM THE\n' +
  '     INTERNET ARCHIVE ON 00:00:00 Jan 01, 2026.\n-->';

/** The same capture fetched without `id_`. */
const REWRITTEN_BODY =
  IDENTITY_BODY.replace('<head>', `<head>${REWRITE_HEAD}`).replace('<body>', `<body>${TOOLBAR}`) +
  ARCHIVED_ON_COMMENT;

test('a body fetched with the identity modifier carries no injection marker at all', () => {
  for (const marker of ARCHIVE_INJECTION_MARKERS) {
    assert.equal(IDENTITY_BODY.includes(marker), false, `identity bytes must not contain ${marker}`);
  }
  assert.equal(IDENTITY_BODY.includes('wm-ipp'), false);
  assert.equal(IDENTITY_BODY.includes('/_static/'), false);
  assert.equal(hasArchiveInjection(IDENTITY_BODY), false);
});

test('stripping identity bytes is a no-op, so the stripper is insurance and nothing more', () => {
  const stripped = stripArchiveInjection(IDENTITY_BODY);

  assert.equal(stripped.text, IDENTITY_BODY);
  assert.deepEqual(stripped.removals, []);
  assert.deepEqual(stripped.residual, []);
});

test('the same capture fetched without the modifier does carry injected markup', () => {
  assert.equal(hasArchiveInjection(REWRITTEN_BODY), true);
  assert.equal(REWRITTEN_BODY.includes('wm-ipp'), true);
  assert.equal(REWRITTEN_BODY.includes('/_static/'), true);
});

test('stripping the rewritten body recovers the identity bytes exactly', () => {
  const stripped = stripArchiveInjection(REWRITTEN_BODY);

  assert.equal(stripped.text, IDENTITY_BODY);
  assert.deepEqual(stripped.residual, []);
  assert.ok(stripped.removals.length > 0);
});

test('every removal names the rule that fired, so the report states a cause', () => {
  const rules = new Set(stripArchiveInjection(REWRITTEN_BODY).removals.map((removal) => removal.rule));

  assert.deepEqual(
    [...rules].sort(),
    [
      'file-archived-comment',
      'replay-analytics-inline-script',
      'replay-analytics-script',
      'replay-init-script',
      'replay-static-script',
      'replay-static-stylesheet',
      'wayback-toolbar-insert',
    ],
  );
});

test('the toolbar element is removed with its descendants even without the comment pair', () => {
  const withoutComments = TOOLBAR.replace('<!-- BEGIN WAYBACK TOOLBAR INSERT -->', '').replace(
    '<!-- END WAYBACK TOOLBAR INSERT -->',
    '',
  );
  const body = IDENTITY_BODY.replace('<body>', `<body>${withoutComments}`);

  const stripped = stripArchiveInjection(body);

  assert.equal(stripped.text, IDENTITY_BODY);
  assert.deepEqual(stripped.removals.map((removal) => removal.rule), ['wayback-toolbar-element']);
});

test('a captured page that merely writes about the Wayback Machine is left alone', () => {
  // The rules match the provider's own nodes, never page prose. A 1999 page
  // discussing web archives must survive the strip untouched.
  const prose = '<html><body><p>We mirror our pages to the Wayback Machine every month.</p></body></html>';

  const stripped = stripArchiveInjection(prose);

  assert.equal(stripped.text, prose);
  assert.deepEqual(stripped.removals, []);
});

test('an unterminated toolbar insert is left in place rather than eating the document', () => {
  const truncated = `${IDENTITY_BODY}<!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp">`;

  const stripped = stripArchiveInjection(truncated);

  assert.equal(stripped.text.includes('<h1>Demo</h1>'), true);
  assert.deepEqual(stripped.residual, ['wm-ipp', 'WAYBACK TOOLBAR INSERT']);
});
