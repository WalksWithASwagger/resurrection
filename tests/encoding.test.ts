import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeBody,
  ERA_DEFAULT_ENCODING,
  REPLACEMENT_RATIO_THRESHOLD,
  type DecodeResult,
} from '../src/index.ts';
import * as fixtures from './fixtures.ts';

test('cp1252 bytes declared iso-8859-1 are upgraded to windows-1252', () => {
  const result = decodeBody(fixtures.cp1252DeclaredIso88591);

  assert.equal(result.kind, 'text');
  assert.equal(result.declaredEncoding, 'iso-8859-1');
  assert.equal(result.declaredSource, 'meta-http-equiv');
  assert.equal(result.chosenEncoding, 'windows-1252');
  assert.equal(result.cp1252UpgradeApplied, true);
  assert.match(result.text ?? '', /“Deep Cove” 1998 – 2001…/u);
  assert.equal(result.replacementCount, 0);
  assert.equal(result.degraded, false);
});

test('a strict iso-8859-1 decode of the same bytes would produce C1 controls', () => {
  // The upgrade is a real decoding change, not only a recorded field: the
  // WHATWG label iso-8859-1 aliases to windows-1252, so this asserts against
  // true Latin-1 to show what era browsers declined to do.
  const strictLatin1 = Buffer.from(fixtures.cp1252DeclaredIso88591).toString('latin1');

  assert.match(strictLatin1, /Deep Cove/u);
  assert.doesNotMatch(strictLatin1, /“/u);
});

test('iso-8859-1 without C1 bytes is kept, so the upgrade stays conditional', () => {
  const bytes = fixtures.body(
    '<html><head><meta charset="iso-8859-1"></head><body>caf',
    [0xe9],
    '</body></html>',
  );
  const result = decodeBody(bytes);

  assert.equal(result.chosenEncoding, 'iso-8859-1');
  assert.equal(result.cp1252UpgradeApplied, false);
  assert.match(result.text ?? '', /café/u);
});

test('high-bit bytes with no declaration anywhere fall back to the era default', () => {
  const result = decodeBody(fixtures.highBitNoDeclaration);

  assert.equal(result.httpCharset, null);
  assert.equal(result.metaCharset, null);
  assert.equal(result.declaredEncoding, null);
  assert.equal(result.chosenEncoding, ERA_DEFAULT_ENCODING);
  assert.equal(result.chosenSource, 'era-default');
  assert.equal(result.detectionConfidence, 0);
  assert.match(result.text ?? '', /Café/u);
  assert.match(result.text ?? '', /naïve résumé/u);
});

test('the HTTP header outranks a disagreeing meta declaration', () => {
  const headerWinsUtf8 = decodeBody(fixtures.metaSaysIso88591, {
    contentType: 'text/html; charset=utf-8',
  });

  assert.equal(headerWinsUtf8.declarationConflict, true);
  assert.equal(headerWinsUtf8.httpCharset, 'utf-8');
  assert.equal(headerWinsUtf8.metaCharset, 'iso-8859-1');
  assert.equal(headerWinsUtf8.declaredSource, 'http-header');
  assert.equal(headerWinsUtf8.chosenEncoding, 'utf-8');
  assert.equal(headerWinsUtf8.chosenSource, 'http-header');
  assert.match(headerWinsUtf8.text ?? '', /café/u);

  const headerWinsLatin1 = decodeBody(fixtures.metaSaysUtf8, {
    contentType: 'text/html; charset=iso-8859-1',
  });

  assert.equal(headerWinsLatin1.declarationConflict, true);
  assert.equal(headerWinsLatin1.chosenEncoding, 'iso-8859-1');
  assert.equal(headerWinsLatin1.chosenSource, 'http-header');
  assert.match(headerWinsLatin1.text ?? '', /cafÃ©/u);
});

test('valid utf-8, correctly declared, is accepted as declared', () => {
  const result = decodeBody(fixtures.validUtf8, { contentType: 'text/html; charset=UTF-8' });

  assert.equal(result.chosenEncoding, 'utf-8');
  assert.equal(result.chosenSource, 'http-header');
  assert.equal(result.detectionConfidence, 1);
  assert.equal(result.declarationOverridden, false);
  assert.equal(result.replacementCount, 0);
  assert.match(result.text ?? '', /café – résumé/u);
});

test('a utf-8 declaration the bytes do not support falls through', () => {
  const result = decodeBody(fixtures.utf8DeclaredButLatin1Bytes);

  assert.equal(result.declaredEncoding, 'utf-8');
  assert.equal(result.declarationOverridden, true);
  assert.equal(result.chosenEncoding, ERA_DEFAULT_ENCODING);
  assert.equal(result.chosenSource, 'era-default');
  assert.match(result.text ?? '', /café/u);
  assert.equal(result.replacementCount, 0);
});

test('a declared non-Latin legacy encoding decodes through the same path', () => {
  const result = decodeBody(fixtures.shiftJisDeclared);

  assert.equal(result.declaredEncoding, 'shift_jis');
  assert.equal(result.chosenEncoding, 'shift_jis');
  assert.equal(result.chosenSource, 'meta-http-equiv');
  assert.match(result.text ?? '', /日本語/u);
  assert.equal(result.degraded, false);
});

test('an undeclared non-Latin legacy body is detected, not forced to Latin-1', () => {
  const result = decodeBody(fixtures.eucKrUndeclared);

  assert.equal(result.declaredEncoding, null);
  assert.equal(result.chosenEncoding, 'euc-kr');
  assert.equal(result.chosenSource, 'detected');
  assert.ok(result.detectionConfidence > 0 && result.detectionConfidence < 1);
  assert.match(result.text ?? '', /한국어/u);
});

test('a body declared HTML that is actually binary is never decoded as text', () => {
  const result = decodeBody(fixtures.pngServedAsHtml, { contentType: 'text/html' });

  assert.equal(result.kind, 'binary');
  assert.equal(result.text, null);
  assert.equal(result.chosenEncoding, null);
  assert.equal(result.chosenSource, 'none');
  assert.equal(result.binaryReason, 'PNG signature');
  assert.equal(result.degraded, false);
});

test('the replacement-character threshold is pinned at its documented value', () => {
  assert.equal(REPLACEMENT_RATIO_THRESHOLD, 0.01);

  const atThreshold = decodeBody(fixtures.shiftJisWithInvalidBytes(99, 1), {
    contentType: fixtures.SHIFT_JIS_CONTENT_TYPE,
  });
  assert.equal(atThreshold.replacementCount, 1);
  assert.equal(atThreshold.replacementRatio, 0.01);
  assert.equal(atThreshold.degraded, false, 'a ratio equal to the threshold is not degraded');

  const aboveThreshold = decodeBody(fixtures.shiftJisWithInvalidBytes(98, 2), {
    contentType: fixtures.SHIFT_JIS_CONTENT_TYPE,
  });
  assert.equal(aboveThreshold.replacementCount, 2);
  assert.equal(aboveThreshold.replacementRatio, 0.02);
  assert.equal(aboveThreshold.degraded, true);
  assert.equal(aboveThreshold.replacementThreshold, REPLACEMENT_RATIO_THRESHOLD);
});

test('the result serializes into an evidence record without reshaping', () => {
  const result = decodeBody(fixtures.cp1252DeclaredIso88591);
  const round = JSON.parse(JSON.stringify(result)) as DecodeResult;

  assert.deepEqual(Object.keys(round).sort(), [
    'binaryReason',
    'byteLength',
    'chosenEncoding',
    'chosenSource',
    'cp1252UpgradeApplied',
    'declarationConflict',
    'declarationOverridden',
    'declaredEncoding',
    'declaredSource',
    'degraded',
    'detectionConfidence',
    'httpCharset',
    'kind',
    'metaCharset',
    'notes',
    'replacementCount',
    'replacementRatio',
    'replacementThreshold',
    'text',
  ]);
  assert.deepEqual(round, result);
  assert.equal(round.byteLength, fixtures.cp1252DeclaredIso88591.length);
});

test('decode.ts stays dependency-free, so a decode needs no network and no I/O', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/decode.ts', import.meta.url), 'utf8');
  const imports = source.match(/^\s*import\s.+$/gmu) ?? [];

  assert.deepEqual(imports, []);
});
