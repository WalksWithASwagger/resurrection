/**
 * Byte-level character-encoding resolution for archived responses.
 *
 * This module runs on raw response bytes before any HTML parsing. It is pure:
 * no I/O, no network, no global state. Its result is a flat JSON-serializable
 * record so an acquisition pipeline can write it straight into an evidence
 * report without reshaping it.
 *
 * Resolution order (docs/DECODING.md explains the reasoning):
 *   1. HTTP `Content-Type` charset
 *   2. in-document `meta charset` / `meta http-equiv`
 *   3. statistical detection
 *   4. the documented era default, `windows-1252`
 */

/** Decoded characters above this ratio of U+FFFD mark the body degraded. */
export const REPLACEMENT_RATIO_THRESHOLD = 0.01;

/**
 * Era default for 1998-2005 western captures. HTML 4 nominally defaulted to
 * ISO-8859-1, but era browsers decoded that declaration as windows-1252, so
 * windows-1252 is the behaviour-accurate default.
 */
export const ERA_DEFAULT_ENCODING = 'windows-1252';

/** WHATWG-style prescan window for `meta` charset declarations. */
const META_PRESCAN_BYTES = 1024;

/** Window inspected for binary signatures and stray NUL bytes. */
const BINARY_PRESCAN_BYTES = 1024;

/**
 * Multi-byte legacy candidates tried during detection, in tiebreak order.
 * Proves the path is not Latin-only. A wider candidate set belongs behind the
 * same interface, not in the caller.
 */
const DETECTION_CANDIDATES = ['shift_jis', 'euc-kr'] as const;

const REPLACEMENT_CHARACTER = '�';

export type EncodingSource =
  | 'http-header'
  | 'meta-charset'
  | 'meta-http-equiv'
  | 'detected'
  | 'era-default'
  | 'none';

export type DeclarationSource = 'http-header' | 'meta-charset' | 'meta-http-equiv';

export interface DecodeOptions {
  /** Raw HTTP `Content-Type` header value, if the response carried one. */
  contentType?: string | null;
}

export interface DecodeResult {
  /** `binary` bodies are never decoded to text. */
  kind: 'text' | 'binary';
  text: string | null;
  byteLength: number;
  /** Charset declared by the HTTP header, normalized, before validation. */
  httpCharset: string | null;
  /** Charset declared in the document prescan window, normalized. */
  metaCharset: string | null;
  /** The declaration that won the resolution order, before any upgrade. */
  declaredEncoding: string | null;
  declaredSource: DeclarationSource | null;
  /** Header and meta both declared a charset and they differ. */
  declarationConflict: boolean;
  /** A declaration was rejected by validation and a later source decided. */
  declarationOverridden: boolean;
  chosenEncoding: string | null;
  chosenSource: EncodingSource;
  /** 1 for a verified declaration, a heuristic score for detection, 0 otherwise. */
  detectionConfidence: number;
  cp1252UpgradeApplied: boolean;
  replacementCount: number;
  replacementRatio: number;
  replacementThreshold: number;
  /** replacementRatio > replacementThreshold. Consumers report the gap. */
  degraded: boolean;
  binaryReason: string | null;
  notes: string[];
}

const LABEL_ALIASES = new Map<string, string>([
  ['utf8', 'utf-8'],
  ['utf-8', 'utf-8'],
  ['unicode-1-1-utf-8', 'utf-8'],
  ['iso-8859-1', 'iso-8859-1'],
  ['iso8859-1', 'iso-8859-1'],
  ['iso_8859-1', 'iso-8859-1'],
  ['latin1', 'iso-8859-1'],
  ['latin-1', 'iso-8859-1'],
  ['l1', 'iso-8859-1'],
  ['us-ascii', 'us-ascii'],
  ['ascii', 'us-ascii'],
  ['ansi_x3.4-1968', 'us-ascii'],
  ['cp1252', 'windows-1252'],
  ['windows-1252', 'windows-1252'],
  ['x-sjis', 'shift_jis'],
  ['sjis', 'shift_jis'],
  ['shift-jis', 'shift_jis'],
  ['shift_jis', 'shift_jis'],
  ['ms_kanji', 'shift_jis'],
  ['euc-kr', 'euc-kr'],
  ['ks_c_5601-1987', 'euc-kr'],
]);

/** Labels whose 0x80-0x9F range era browsers treated as windows-1252. */
const CP1252_UPGRADE_LABELS = new Set(['iso-8859-1', 'us-ascii']);

const BINARY_SIGNATURES: ReadonlyArray<{ readonly name: string; readonly bytes: readonly number[] }> = [
  { name: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: 'GIF', bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
  { name: 'ZIP', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'GZIP', bytes: [0x1f, 0x8b] },
  { name: 'PDF', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { name: 'OLE compound document', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { name: 'Java class', bytes: [0xca, 0xfe, 0xba, 0xbe] },
];

export function normalizeEncodingLabel(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (trimmed === '') return null;
  return LABEL_ALIASES.get(trimmed) ?? trimmed;
}

function charsetFromContentType(contentType: string | null | undefined): string | null {
  if (contentType == null) return null;
  const match = /;\s*charset\s*=\s*("[^"]*"|'[^']*'|[^;\s]+)/i.exec(contentType);
  return normalizeEncodingLabel(match?.[1]);
}

function charsetFromMeta(bytes: Uint8Array): { label: string; source: DeclarationSource } | null {
  const window = Buffer.from(bytes.subarray(0, META_PRESCAN_BYTES)).toString('latin1');
  for (const tag of window.match(/<meta\b[^>]*>/gi) ?? []) {
    const httpEquiv = /http-equiv\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag);
    if (httpEquiv && /content-type/i.test(httpEquiv[1] ?? '')) {
      const content = /content\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag);
      const label = charsetFromContentType(content?.[1]?.replace(/^["']|["']$/g, ''));
      if (label) return { label, source: 'meta-http-equiv' };
      continue;
    }
    const shortForm = /\bcharset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(tag);
    const label = normalizeEncodingLabel(shortForm?.[1]);
    if (label) return { label, source: 'meta-charset' };
  }
  return null;
}

function binaryReasonFor(bytes: Uint8Array): string | null {
  for (const signature of BINARY_SIGNATURES) {
    if (signature.bytes.every((byte, index) => bytes[index] === byte)) {
      return `${signature.name} signature`;
    }
  }
  const window = bytes.subarray(0, BINARY_PRESCAN_BYTES);
  const nul = window.indexOf(0x00);
  if (nul !== -1) return `NUL byte at offset ${nul}`;
  return null;
}

function hasByteInRange(bytes: Uint8Array, low: number, high: number): boolean {
  for (const byte of bytes) {
    if (byte >= low && byte <= high) return true;
  }
  return false;
}

function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function supportsLabel(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode with an explicit label. `iso-8859-1` and `us-ascii` are decoded as
 * true Latin-1 here: the WHATWG Encoding Standard (and therefore TextDecoder)
 * aliases both labels to windows-1252, which would hide the cp1252 upgrade
 * decision this module has to record.
 */
function decodeWithLabel(bytes: Uint8Array, label: string): string {
  if (label === 'iso-8859-1' || label === 'us-ascii') {
    return Buffer.from(bytes).toString('latin1');
  }
  return new TextDecoder(label).decode(bytes);
}

function countReplacements(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === REPLACEMENT_CHARACTER) count += 1;
  }
  return count;
}

/** Characters only a correctly decoded CJK/Hangul body should contain. */
function hasMultiByteScriptPayload(text: string): boolean {
  return /[　-〿぀-ヿ一-鿿가-힯！-｠]/.test(text);
}

interface Detection {
  encoding: string;
  confidence: number;
  note: string;
}

/**
 * Bounded structural detection. It is a validity-and-plausibility heuristic,
 * not a trained statistical classifier: a candidate is accepted only when the
 * whole body decodes without a single replacement character and the result
 * carries script payload that the candidate alone explains. Anything it cannot
 * explain falls through to the era default rather than guessing.
 */
function detectEncoding(bytes: Uint8Array): Detection | null {
  if (bytes.length === 0) return null;
  const highBytes = hasByteInRange(bytes, 0x80, 0xff);
  if (isStrictUtf8(bytes)) {
    return highBytes
      ? { encoding: 'utf-8', confidence: 0.99, note: 'body is valid multi-byte utf-8' }
      : { encoding: 'us-ascii', confidence: 0.99, note: 'body is pure ascii' };
  }
  if (!highBytes) return null;
  const plausible = DETECTION_CANDIDATES.filter((candidate) => {
    const text = decodeWithLabel(bytes, candidate);
    return countReplacements(text) === 0 && hasMultiByteScriptPayload(text);
  });
  const winner = plausible[0];
  if (winner === undefined) return null;
  return plausible.length === 1
    ? { encoding: winner, confidence: 0.7, note: `only ${winner} decodes the high bytes plausibly` }
    : {
        encoding: winner,
        confidence: 0.55,
        note: `ambiguous between ${plausible.join(', ')}; first candidate in fixed order chosen`,
      };
}

function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

/**
 * Resolve and apply an encoding for one archived response body.
 *
 * This step records its own decision; it does not write a gap report. A
 * `degraded` result is the input to that report, which the acquisition
 * package owns.
 */
export function decodeBody(bytes: Uint8Array, options: DecodeOptions = {}): DecodeResult {
  const notes: string[] = [];
  const httpCharset = charsetFromContentType(options.contentType);
  const meta = charsetFromMeta(bytes);
  const metaCharset = meta?.label ?? null;

  const base: DecodeResult = {
    kind: 'text',
    text: null,
    byteLength: bytes.length,
    httpCharset,
    metaCharset,
    declaredEncoding: null,
    declaredSource: null,
    declarationConflict: httpCharset !== null && metaCharset !== null && httpCharset !== metaCharset,
    declarationOverridden: false,
    chosenEncoding: null,
    chosenSource: 'none',
    detectionConfidence: 0,
    cp1252UpgradeApplied: false,
    replacementCount: 0,
    replacementRatio: 0,
    replacementThreshold: REPLACEMENT_RATIO_THRESHOLD,
    degraded: false,
    binaryReason: null,
    notes,
  };

  if (base.declarationConflict) {
    notes.push(`http charset ${httpCharset} disagrees with meta charset ${metaCharset}`);
  }

  // A byte-order mark outranks every declaration and must be read before the
  // binary sniff, whose NUL-byte rule would otherwise reject utf-16 bodies.
  const bom = bomEncoding(bytes);
  if (bom !== null) {
    notes.push(`byte-order mark declares ${bom}`);
    return finishText(base, bytes, bom, 'detected', 1);
  }

  const binaryReason = binaryReasonFor(bytes);
  if (binaryReason !== null) {
    notes.push('body is binary and was not decoded as text');
    return { ...base, kind: 'binary', binaryReason, chosenSource: 'none' };
  }

  const declarations: Array<{ label: string; source: DeclarationSource }> = [];
  if (httpCharset !== null) declarations.push({ label: httpCharset, source: 'http-header' });
  if (meta !== null) declarations.push({ label: meta.label, source: meta.source });

  for (const declaration of declarations) {
    if (base.declaredEncoding === null) {
      base.declaredEncoding = declaration.label;
      base.declaredSource = declaration.source;
    }
    const accepted = acceptDeclaration(base, bytes, declaration.label, declaration.source, notes);
    if (accepted !== null) return accepted;
    base.declarationOverridden = true;
  }

  const detected = detectEncoding(bytes);
  if (detected !== null) {
    notes.push(`detection: ${detected.note}`);
    return finishText(base, bytes, detected.encoding, 'detected', detected.confidence);
  }

  notes.push(`no usable declaration or detection; applied era default ${ERA_DEFAULT_ENCODING}`);
  return finishText(base, bytes, ERA_DEFAULT_ENCODING, 'era-default', 0);
}

function acceptDeclaration(
  base: DecodeResult,
  bytes: Uint8Array,
  label: string,
  source: DeclarationSource,
  notes: string[],
): DecodeResult | null {
  if (label === 'utf-8') {
    if (!isStrictUtf8(bytes)) {
      notes.push(`declared utf-8 from ${source} does not decode cleanly; falling through`);
      return null;
    }
    return finishText(base, bytes, 'utf-8', source, 1);
  }

  if (CP1252_UPGRADE_LABELS.has(label)) {
    const c1Bytes = hasByteInRange(bytes, 0x80, 0x9f);
    const nonAscii = label === 'us-ascii' && hasByteInRange(bytes, 0x80, 0xff);
    if (c1Bytes || nonAscii) {
      notes.push(
        `declared ${label} from ${source} upgraded to windows-1252 (bytes in the 0x80-0x9f range are undefined in ${label})`,
      );
      return finishText(base, bytes, 'windows-1252', source, 1, true);
    }
    return finishText(base, bytes, label, source, 1);
  }

  if (!supportsLabel(label)) {
    notes.push(`declared encoding ${label} from ${source} is not supported; falling through`);
    return null;
  }
  return finishText(base, bytes, label, source, 1);
}

function finishText(
  base: DecodeResult,
  bytes: Uint8Array,
  encoding: string,
  source: EncodingSource,
  confidence: number,
  cp1252UpgradeApplied = false,
): DecodeResult {
  const text = decodeWithLabel(bytes, encoding);
  const replacementCount = countReplacements(text);
  const characterCount = [...text].length;
  const replacementRatio = characterCount === 0 ? 0 : replacementCount / characterCount;
  return {
    ...base,
    kind: 'text',
    text,
    chosenEncoding: encoding,
    chosenSource: source,
    detectionConfidence: confidence,
    cp1252UpgradeApplied,
    replacementCount,
    replacementRatio,
    degraded: replacementRatio > REPLACEMENT_RATIO_THRESHOLD,
  };
}
