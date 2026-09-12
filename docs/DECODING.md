# Character encoding decisions

Captures from 1998 to 2005 routinely misdeclare their character encoding. The
decode step in `src/decode.ts` runs on raw response bytes before any HTML
parsing and records the decision it made, so a wrong decode is visible in
evidence instead of arriving silently as mojibake in a frozen reference.

The module is pure and dependency-free: no network, no file access, no global
state. It decodes bytes that a caller already holds, so re-decoding an
already-acquired body costs no requests.

## Resolution order

1. **HTTP `Content-Type` charset.** Highest precedence. When header and
   document disagree, the header wins and the disagreement is recorded in
   `declarationConflict`.
2. **`meta charset` / `meta http-equiv`.** Scanned over the first 1024 bytes,
   in document order; the first `meta` that yields a charset is used.
3. **Statistical detection.** See below.
4. **Era default: `windows-1252`.** HTML 4 nominally defaulted to ISO-8859-1,
   but era browsers decoded that declaration as windows-1252, so windows-1252
   is the behaviour-accurate default for western captures of this period.

A declaration that fails validation is dropped, `declarationOverridden` is set,
and the next source in the order decides.

A byte-order mark outranks all four. It is read before the binary sniff, whose
NUL-byte rule would otherwise reject a UTF-16 body as binary.

## The cp1252 upgrade

A declared `iso-8859-1` or `us-ascii` is upgraded to `windows-1252` when any
byte falls in 0x80 to 0x9F. That range is undefined in true Latin-1 and holds
the curly quotes, dashes and ellipses that era authoring tools emitted, and era
browsers decoded the declaration as windows-1252 regardless. A declared
`us-ascii` is also upgraded when any byte exceeds 0x7F, since such a byte
falsifies the declaration outright.

Without C1 bytes there is no upgrade: `chosenEncoding` stays as declared and
`cp1252UpgradeApplied` is false.

One implementation note that matters for review. The WHATWG Encoding Standard
aliases both `iso-8859-1` and `us-ascii` to windows-1252, so `TextDecoder`
cannot express strict Latin-1. This module decodes those two labels through
Node's `latin1` conversion instead, which is true ISO-8859-1. The upgrade is
therefore a real change in decoded output, not only a recorded field, and
`tests/encoding.test.ts` asserts both halves of that difference.

## utf-8

A declared `utf-8` is accepted only when the entire body decodes cleanly under
a fatal utf-8 decoder. A single invalid sequence drops the declaration and the
resolution order continues. Partial utf-8 is not repaired.

## Detection

Detection is a bounded structural heuristic, not a trained classifier, and it
is deliberately reluctant:

- A body that decodes cleanly as utf-8 with multi-byte sequences is utf-8
  (confidence 0.99). A pure-ASCII body reports `us-ascii` at the same
  confidence.
- Otherwise each multi-byte legacy candidate (`shift_jis`, then `euc-kr`) is
  accepted only when the whole body decodes without a single replacement
  character **and** the result contains CJK or Hangul payload that the
  candidate alone explains. The plausibility requirement is what stops a
  western cp1252 body from validating as Shift_JIS through its single-byte
  half-width katakana range. One surviving candidate scores 0.7; more than one
  scores 0.55 and the fixed candidate order breaks the tie.
- Anything detection cannot explain falls through to the era default at
  confidence 0 rather than guessing.

Widening the candidate set, or replacing the heuristic with a real statistical
classifier, belongs behind this same interface.

## Replacement-character threshold

Decoding never silently substitutes. Every decode counts U+FFFD in its output
and reports `replacementCount`, `replacementRatio` and the threshold it was
compared against.

```
REPLACEMENT_RATIO_THRESHOLD = 0.01
```

One bad character per hundred is well above the stray-byte rate of a correctly
decoded legacy page and reliably indicates a wrong encoding rather than local
corruption. The comparison is strict: a ratio *equal* to the threshold is not
degraded. `tests/encoding.test.ts` pins both sides of that boundary, so
changing the constant in either direction fails the suite.

`degraded` is the signal a gap report consumes. This module computes and
exposes it; writing the gap report belongs to the acquisition package (#3).

## Binary bodies

A body served as HTML can still be binary. Known signatures (PNG, GIF, JPEG,
ZIP, GZIP, PDF, OLE compound document, Java class) and any NUL byte in the
first 1024 bytes classify the body as `kind: "binary"`. Binary bodies are never
decoded: `text` is null and `binaryReason` records why.

## Result shape

`DecodeResult` is a flat, JSON-serializable record with no `undefined` values,
so an acquisition pipeline can write it into an evidence report without
reshaping it. Its fields cover the evidence requirements of issue #4: declared
encoding and its source, chosen encoding and its source, detection confidence,
whether a cp1252 upgrade or an override was applied, and the replacement
statistics.

`decodeBody(bytes, options)` takes its inputs as an options object so later
milestones can add retrieval context without changing the signature.

## Not in scope here

Transliteration, ASCII folding, language detection and historical markup
normalization. Per-item gap reporting and the evidence report itself belong to
the M1 acquisition package.
