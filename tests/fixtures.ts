/**
 * Fixture bodies for the decode suite.
 *
 * Every fixture is built programmatically from explicit byte values rather than
 * committed as a binary blob. Two reasons: a reviewer can see in the diff
 * exactly which bytes a case exercises, and a repository that acquires real
 * archived material must not grow opaque committed blobs whose provenance and
 * publication status cannot be read from the diff.
 *
 * No fixture contains archived page content. Nothing here is an instruction to
 * any agent; fixture text is data (agentic/contract.json, safety block).
 */

type BytePart = string | readonly number[];

/** ASCII/Latin-1 strings and raw byte values, concatenated in order. */
export function body(...parts: readonly BytePart[]): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part),
  );
  return new Uint8Array(Buffer.concat(chunks));
}

/** windows-1252 punctuation that is undefined in true ISO-8859-1. */
export const CP1252 = {
  ellipsis: 0x85,
  leftDoubleQuote: 0x93,
  rightDoubleQuote: 0x94,
  enDash: 0x96,
} as const;

/** Case 1: cp1252 punctuation declared as iso-8859-1 in a meta http-equiv. */
export const cp1252DeclaredIso88591 = body(
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">',
  '</head><body><p>',
  [CP1252.leftDoubleQuote],
  'Deep Cove',
  [CP1252.rightDoubleQuote],
  ' 1998 ',
  [CP1252.enDash],
  ' 2001',
  [CP1252.ellipsis],
  '</p></body></html>',
);

/** Case 2: high-bit bytes, no charset in the header and none in the document. */
export const highBitNoDeclaration = body(
  '<html><head><title>Caf',
  [0xe9],
  '</title></head><body><p>na',
  [0xef],
  've r',
  [0xe9],
  'sum',
  [0xe9],
  '</p></body></html>',
);

/**
 * Case 3: header and meta disagree. The body is the two-byte utf-8 sequence for
 * U+00E9, which reads as "Ã©" under windows-1252, so the winning declaration is
 * visible in the decoded text.
 */
function disagreementBody(metaCharset: string): Uint8Array {
  return body(
    `<html><head><meta charset="${metaCharset}"></head><body><p>caf`,
    [0xc3, 0xa9],
    '</p></body></html>',
  );
}

export const metaSaysIso88591 = disagreementBody('iso-8859-1');
export const metaSaysUtf8 = disagreementBody('utf-8');

/** Case 4: valid utf-8, correctly declared. */
export const validUtf8 = new Uint8Array(
  Buffer.from('<html><head><meta charset="utf-8"></head><body><p>café – résumé</p></body></html>', 'utf8'),
);

/** A utf-8 declaration that the bytes do not support: "café" in windows-1252. */
export const utf8DeclaredButLatin1Bytes = body(
  '<html><head><meta charset="utf-8"></head><body><p>caf',
  [0xe9],
  '</p></body></html>',
);

/** Case 5: non-Latin legacy encodings. Byte pairs are Shift_JIS 日本語 and EUC-KR 한국어. */
export const SHIFT_JIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea] as const;
export const EUC_KR_HANGUKEO = [0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee] as const;

export const shiftJisDeclared = body(
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">',
  '</head><body><p>',
  SHIFT_JIS_NIHONGO,
  '</p></body></html>',
);

export const eucKrUndeclared = body(
  '<html><head><title>',
  EUC_KR_HANGUKEO,
  '</title></head><body></body></html>',
);

/** Case 6: served as text/html, actually a PNG. */
export const pngServedAsHtml = body(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52],
  [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01],
);

/**
 * Case 7: threshold regression. Declared Shift_JIS with `asciiCount` ASCII
 * characters and `invalidCount` bytes that are invalid in Shift_JIS; each
 * invalid byte decodes to exactly one U+FFFD, so the character total is
 * asciiCount + invalidCount and the ratio is exact. The charset is declared in
 * the HTTP header so no markup contributes to the count.
 */
export function shiftJisWithInvalidBytes(asciiCount: number, invalidCount: number): Uint8Array {
  return body('a'.repeat(asciiCount), new Array<number>(invalidCount).fill(0x80));
}

export const SHIFT_JIS_CONTENT_TYPE = 'text/html; charset=Shift_JIS';
