# Site model

The site model is the contract between acquisition and generation
([SPEC section 4](SPEC.md#4-understand-the-site-before-generating-it)). This
page describes the part that exists: the static model built from stored
bodies. Rendered references and measured layout anchors are not implemented.

## Command

```bash
node src/cli.ts model --job <dir>
node src/cli.ts model --manifest <collection.json> [--output <dir>]
```

The command reads bodies already on disk and opens no socket. It writes
`site-model.json` and prints a summary. The same collection and code revision
produce a byte-identical file. The file holds no clock reading and no absolute
path.

## Input: a collection

A collection is the set of recovered bodies a model is built from. It has two
sources.

- **A job directory.** Only items whose outcome is reference-eligible are
  used. An error page, a parked domain or a soft 404 never reaches a model.
- **A collection manifest.** A portable JSON file for evidence gathered
  outside a job:

```json
{
  "schemaVersion": 1,
  "id": "example-2000",
  "period": { "from": "19980101000000", "to": "20011231235959" },
  "resources": [
    {
      "originalUrl": "http://www.example.invalid/index.html",
      "path": "bytes/0a1b",
      "contentType": "text/html",
      "servedTimestamp": "20000615120000",
      "sha256": "<64 hex characters>",
      "provenance": null
    }
  ]
}
```

`path` is absolute or relative to the manifest. Loading verifies every body
against its recorded SHA-256 and refuses a mismatch. A capture outside the
period is refused unless `provenance` states why it was admitted.

## Identity

Acquisition keeps `http://www.example.invalid:80/a` and
`http://example.invalid/a` as separate records, because the archive indexes
them separately. A visitor saw one page. The model links by a site key that
treats scheme, a leading `www.`, a default port and the fragment as aliases.
Path case and the query string are kept.

When two resources share a key, the model uses the in-period capture, then the
earliest. The other is recorded as an `unused-variant` gap.

## What the model holds

| Part | Contents |
| --- | --- |
| `pages` | Original URL, capture time, body hash, title, chosen encoding, visible-text length and hash, family, classified links, static features |
| `assets` | Every non-page body with its type, hash, size and the pages that reference it |
| `families` | Pages grouped by structure, with a representative |
| `navigation` | Local page-to-page links, entry pages with no inbound link, external destinations |
| `gaps` | Missing pages, assets and documents; date exceptions; unused variants; degraded decoding |

Each link is classified by what was recovered: `page`, `asset`, `missing` or
`external`. A host is part of the site when the collection holds a body from
it. A link to a site host with no body is a gap, never a silent omission.

## Page families

A page's structural skeleton is its opening tags in document order, with
text-level tags (`b`, `font`, `a`, `br` and similar) dropped and immediate
repeats collapsed. Twelve paragraphs and three paragraphs are the same
structure. Two pages are compared by the Jaccard similarity of their
four-tag shingle sets.

Pages are visited in key order. Each joins the most similar existing family
when its similarity to that family's representative is at least 0.6;
otherwise it starts a family.

The 0.6 threshold was set on one collection, the September 2000 Spark issue.
There the article pages score 0.90 to 1.00 against each other and 0.54 to
0.57 against the contents page, which shares their navigation shell. It is a
starting value to recalibrate as more sites are modeled, not a measured
constant.

## Static behavior evidence

The model records markup that implies behavior: inline event handlers, inline
and external scripts, forms, image maps, framesets, embedded objects, meta
refresh and background sound. Each record carries a count, a truncated sample
and `"evidence": "static"`.

Static means the handler or element is present in the bytes. It does not mean
the behavior was observed running. Observed behavior belongs to a rendered
reference, which this model does not yet include.

## Limits

- Extraction is a bounded scan, the same approach as dependency discovery, not
  a full HTML parse. Malformed markup can hide a link or a tag from it.
- URLs referenced only from stylesheets or scripts are not followed.
- Families describe structure, not appearance. Two pages with the same
  skeleton and different stylesheets share a family.
- Nothing here is a fidelity claim. The model says what was recovered and how
  it connects.
