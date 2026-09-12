# Graded fidelity

Issue #8. M3's acceptance checks pass or fail a page family, which is the right
gate but says nothing about degree and runs late. Between acquisition and
generation nothing said "this page is a stub, not an article", so weak material
could reach M2 and be frozen as a reference.

This adds a graded, per-page score computed from signals that already exist in
the job. It does not replace M3's binary checks, it does not drive repair, and
no part of it is produced by a model.

## What the score is made of

Six signals were named when the issue was written. Five of them are weighted
terms. The sixth, the outcome, is the gate.

| Signal | Where the input comes from | Shipped by |
| --- | --- | --- |
| Outcome | `item.outcome.outcome` | #5 — the gate, see below |
| (relation) | `item.relation` | M1 — also a gate, see below |
| Structure | the decoded body and the collection's captured URLs | #8 |
| Boilerplate | the decoded bodies of the whole collection | #8 |
| Replacement ratio | `item.encoding.replacementRatio` | #4 |
| Asset completeness | `item.capture.resolution` on each dependency | #6 |
| Cross-capture agreement | `item.capture.candidates[].digest` | #6 retained the rows |

Nothing is recomputed. The encoding ratio is read off the record the decoder
wrote, asset state is read off the resolutions the resolver wrote, and the
candidate captures are the rows the inventory already returned.

### Why the outcome is the gate, not a weighted term

A score is only ever computed for an item whose outcome is `ok`. Inside that
population the outcome is constant by construction, so a weighted term for it
would be a decorative number that every scored page scores identically on.
`scoreItem` returns `null` for anything else, so there is no score to argue
with issue #5's verdict. See "Composition with #5" below.

### What counts as a page

Two further conditions, both returning `null` rather than a low score:

- the relation must be `page` or `frame`, the same pair `src/validate.ts`
  calls markup
- the body must have decoded as text

The relation check matters more than it looks. A stylesheet decodes as text and
classifies as `ok`, so without it a stylesheet is scored as a page and reported
as review-required for having no `<title>` and no outgoing links — a true
statement about every stylesheet ever written and a useless fidelity verdict.
Using the pipeline's own notion of a document, rather than sniffing the body,
keeps that decision in one place.

### Structure

Three graded sub-checks, averaged:

- a non-empty `<title>`
- visible body characters, rising linearly to 1 at `tuning.bodyTextTarget`
  (400 by default)
- at least one `<a href>` that resolves to a URL this collection holds bytes
  for

The third check is dropped, rather than failed, when the collection holds one
captured page: there is nowhere for an internal link to point, and scoring that
as a failure would penalise a page for the size of its collection.

`src/validate.ts` is untouched. It answers whether usable bytes arrived, which
is pass/fail on the fetch axis. This is a graded question about a page that has
already passed it.

### Boilerplate

Boilerplate is defined by what repeats, not by taste. The decoded body is split
at block boundaries into normalized text segments; a segment that appears on at
least `tuning.boilerplateMinDocuments` pages of the collection is boilerplate.
The measured ratio is the share of a page's visible characters that is *not*
boilerplate, scaled from `boilerplateZeroRatio` to `boilerplateFullRatio`.

Segment frequency is built over every decoded body the job holds, including
ones that classified as non-content: a site's navigation bar is no less its
navigation bar for appearing on a page that turned out to be a 404 template.

No prose is read for meaning. That is what keeps a hostile capture from being
able to talk its way into a high score.

### Cross-capture agreement, and its limitation

**This signal is binary and it can only corroborate.** That is a deliberate
choice, and the limitation is reported rather than hidden.

Agreement as originally worded compares the *text* of adjacent captures. An
adjacent capture's body is usually not acquired, so comparing text would mean
one extra replay request per adjacent capture per page. That breaks this
issue's own zero-network criterion and the acquisition budget with it, and
skipping the pages it could not afford would leave the signal quietly absent
across most of a collection.

CDX rows carry the provider's `digest`, and issue #6 retained every row on the
job. So the comparison is by digest:

| State | Meaning | Contributes |
| --- | --- | --- |
| `identical` | an adjacent capture has the same digest: identical bytes | 1 |
| `different` | an adjacent capture has a different digest | nothing |
| `single-capture` | the job knows one capture of this URL | nothing |
| `digest-unavailable` | a digest is missing on one side | nothing |

A digest proves difference but never magnitude: a corrected typo and a
replacement by a parking page are the same observation. Scoring `different` as
a penalty would invent a number the digest cannot support, so it contributes
nothing at all. The state is always written to the report, so `different` is
never read as a measured disagreement.

### Unmeasured signals

A signal's `value` is `null` when it could not be measured for that page, and a
null signal is dropped from the weighted mean rather than scored. `weight` still
records what it would have counted for, and `appliedWeight` on the score records
the denominator that was actually used.

This matters more than it looks. A page that references no dependency has no
asset completeness to measure; awarding it a free 1 would hand every stub a
sixth of a point it did not earn, and free credit on dimensions that do not
distinguish content is exactly how a composite comes to rank garbage highly.

## Weights, thresholds and tuning

All of it is configuration, under `fidelity` in the project config. Defaults and
their reasoning live in `src/fidelity.ts`.

```jsonc
{
  "fidelity": {
    "weights": {
      "structure": 0.3,
      "boilerplate": 0.25,
      "encoding": 0.25,
      "assets": 0.15,
      "cross-capture": 0.1
    },
    "thresholds": { "accept": 0.85, "acceptWithWarning": 0.7 },
    "tuning": {
      "encodingZeroRatio": 0.05,
      "bodyTextTarget": 400,
      "boilerplateMinDocuments": 2,
      "boilerplateZeroRatio": 0.1,
      "boilerplateFullRatio": 0.5
    },
    "overrides": []
  }
}
```

Ordering is the claim, not the exact decimals. Structure ranks highest because
it is the one signal that asks whether this is a page at all. Boilerplate and
the replacement ratio tie behind it, because they are two ways of failing at
the same thing: a page made of other pages' words and a page whose own words
are unreadable both yield no usable prose. Assets rank lower because a missing
image is a recorded gap rather than a reason to distrust the text, and every
one is already named in the gap report. Cross-capture agreement is lowest
because it is binary by construction.

The composite is a weighted mean over the measured signals, so the weights need
not sum to one, and changing any one of them changes the score of any page whose
measured signals are not all equal. `tests/fidelity.test.ts` asserts exactly
that for every signal, so a weight cannot quietly become inert.

### Where the bands cut, and why not at a half

A weighted mean of these signals does not bottom out at zero for a bad page,
because several of them measure damage rather than merit. A placeholder that is
cleanly encoded, references nothing and sits beside an identical adjacent
capture scores full marks on three of five signals while carrying eleven
characters of its own text. Cut the bands at a half and that page reads as
acceptable.

Observed distribution for four fixture pages at three replacement ratios, which
is what the defaults were calibrated against:

| Page | ratio 0 | ratio 0.04 | ratio 0.2 |
| --- | --- | --- | --- |
| a three-paragraph article | 1.000 accept | 0.750 warning | 0.688 review |
| a short but real about page | 0.873 accept | 0.623 review | 0.560 review |
| a "coming soon" stub with a nav bar | 0.612 review | 0.362 review | 0.300 review |
| a bare untitled stub | 0.462 review | 0.212 review | 0.149 review |

Moving the thresholds is therefore an argument about this distribution rather
than a preference.

## Composition with issue #5

`src/outcomes.ts` keeps the single point of truth about whether an item carries
recovered content: `referenceEligible: outcome === 'ok'`. That rule is
unchanged, and **it wins**. There is no second eligibility field.

```ts
// src/job.ts
export function promotableAsReference(item: WorkItem): boolean {
  return referenceEligible(item) && item.fidelity?.promotionBlocked !== true;
}
```

The order is the claim:

1. An item whose outcome is not `ok` is never scored. There is no number that
   can argue with the outcome.
2. A score can only *narrow* what is already eligible. `counts.referenceEligible`
   in the report is untouched, and `fidelity.counts.promotable` can never exceed
   it.
3. `promotionBlocked` is set only for the `review-required` band.

### Overrides

A page in the `review-required` band cannot be promoted to an M2 frozen
reference unless an override is recorded for its URL under
`fidelity.overrides`, with both a `reason` and a `recordedBy`. An override
without a stated reason and a named person is not a recorded decision, it is a
silent one, so the config parser requires both.

An override lifts the fidelity block and nothing else. It never lifts the
outcome gate, it never changes the band, and it never suppresses the
`low-fidelity` gap: the gap is still raised and names the override, because a
recorded decision to proceed is not a reason to stop reporting.

## What the report carries

`evidence.json` at schema version 4 adds:

- `fidelity.scored[]` — the full record per page: the composite, the band, the
  thresholds it was cut at, the applied weight, and every signal with its
  `value`, `weight`, `contribution`, a one-line `detail` and the
  `measurements` the value was derived from
- `fidelity.counts` — scored, per band, promotable, overridden
- `fidelity` on every recovered file — the score, band, block and override
  state in one line, beside the untouched `referenceEligible`
- a `low-fidelity` gap for every `review-required` page, naming its weakest
  measured signal

The full breakdown is written, not only the composite, so a reviewer can see
*which* signal moved a score.

The job state version stays at 3. A version 3 job carries no `fidelity` on its
items, which is a visible absence — it reports zero scored pages — and one
`reclassify` run fills it in from bytes already on disk, for zero requests. The
2 to 3 bump was different in kind: a version 2 job would have reported every
asset as having zero captures, which reads as a fact rather than a gap.

## Rescoring costs nothing

Scoring runs inside the same collection-wide pass as classification
(`src/reclassify.ts`), over the same decoded texts, so it costs one store read
per body and no requests at all.

```
pnpm run reclassify:fixture                    # defaults
node src/cli.ts reclassify --job <dir> --config <file>   # a project's own policy
```

`src/fidelity.ts` holds no transport, and `tests/isolation.test.ts` asserts
that structurally alongside `classify.ts`, `reclassify.ts`, `resolve-asset.ts`,
`select.ts` and `toolbar.ts`. That is what pins the digest decision above: a
text-based cross-capture signal would need a fetch, and there is nothing here
to fetch with.

## Out of scope

- M3's binary acceptance checks, which this does not replace or modify
- automatic repair driven by the score
- any model-generated confidence value
- the #5 outcome taxonomy, #7's selection default and #6's asset resolution
