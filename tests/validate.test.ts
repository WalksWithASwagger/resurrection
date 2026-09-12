/**
 * Content validation.
 *
 * The rule these cases defend: bytes only become a recovered file when they
 * are what the referring markup asked for. A success status is not enough.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeBody, validateBody, type LinkRelation } from '../src/index.ts';

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

function check(relation: LinkRelation | 'page', body: Uint8Array, contentType: string | null = null) {
  return validateBody({
    relation,
    contentType,
    decoded: decodeBody(body, { contentType }),
    truncated: false,
    byteLength: body.length,
  });
}

test('a genuine capture validates', () => {
  assert.equal(check('page', bytes('<html><body><h1>Demo</h1></body></html>')), null);
  assert.equal(check('stylesheet', bytes('body { color: #000; }'), 'text/css'), null);
});

test('an archive error page served with status 200 never validates', () => {
  const body = bytes('<html><body>The Wayback Machine has not archived that URL.</body></html>');

  assert.equal(check('page', body)?.kind, 'archive-error-page');
});

test('an image URL that answers with markup is a content-type mismatch', () => {
  const body = bytes('<!doctype html><html><body>not an image</body></html>');

  assert.equal(check('image', body, 'text/html')?.kind, 'content-type-mismatch');
});

test('a page URL that answers with binary content is a content-type mismatch', () => {
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);

  assert.equal(check('page', gif, 'text/html')?.kind, 'content-type-mismatch');
});

test('an empty success response is not a zero-byte recovered file', () => {
  assert.equal(check('image', bytes(''))?.kind, 'empty-body');
});

test('a body cut off at the byte cap is oversized, not partial evidence', () => {
  const body = bytes('x'.repeat(64));
  const result = validateBody({
    relation: 'document',
    contentType: 'application/pdf',
    decoded: decodeBody(body, {}),
    truncated: true,
    byteLength: body.length,
  });

  assert.equal(result?.kind, 'oversized-body');
});

test('a mismatch message names the relation and the content type it saw', () => {
  const failure = check('image', bytes('<html><body>x</body></html>'), 'text/html');

  assert.match(failure?.message ?? '', /image/u);
  assert.match(failure?.message ?? '', /text\/html/u);
});
