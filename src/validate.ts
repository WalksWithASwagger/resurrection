/**
 * Response and content validation.
 *
 * A 200 is not evidence that a capture arrived. The archive serves its own
 * error documents with a success status, and a missing image is routinely
 * answered with an HTML page. Bytes that fail here are recorded as a failure
 * with a reason; they never become a recovered file.
 *
 * This is the fetch axis only: whether usable bytes arrived. Whether those
 * bytes are content is decided afterwards by src/classify.ts, over the whole
 * collection. Keep the two apart: a check here makes an item a failure the
 * resume logic may retry, which is not what "this page is a 404 template"
 * means.
 */

import type { DecodeResult } from './decode.ts';
import type { LinkRelation } from './discover.ts';
import { failure, type Failure } from './outcomes.ts';
import { archiveErrorMarker } from './wayback.ts';

export interface ValidationInput {
  relation: LinkRelation | 'page';
  contentType: string | null;
  decoded: DecodeResult;
  truncated: boolean;
  byteLength: number;
}

/** Relations whose bytes must not be markup. */
const BINARY_RELATIONS = new Set<LinkRelation | 'page'>(['image', 'media', 'object']);
/** Relations whose bytes must be markup. */
const MARKUP_RELATIONS = new Set<LinkRelation | 'page'>(['page', 'frame']);

const HTML_HEAD = /^\s*(?:<!doctype html|<html|<head|<body|<!--)/i;

export function validateBody(input: ValidationInput): Failure | null {
  if (input.truncated) {
    return failure('oversized-body', `body exceeded the response byte cap after ${input.byteLength} bytes`);
  }
  if (input.byteLength === 0) {
    return failure('empty-body', 'response carried no bytes');
  }

  const text = input.decoded.kind === 'text' ? (input.decoded.text ?? '') : null;

  if (text !== null) {
    const marker = archiveErrorMarker(text);
    if (marker !== null) {
      return failure('archive-error-page', `provider error document detected by marker "${marker}"`);
    }
  }

  if (BINARY_RELATIONS.has(input.relation) && text !== null && HTML_HEAD.test(text)) {
    return failure(
      'content-type-mismatch',
      `${input.relation} URL returned markup instead of binary content (content-type ${input.contentType ?? 'absent'})`,
    );
  }

  if (MARKUP_RELATIONS.has(input.relation) && input.decoded.kind === 'binary') {
    return failure(
      'content-type-mismatch',
      `page URL returned binary content (${input.decoded.binaryReason ?? 'unknown signature'})`,
    );
  }

  return null;
}
