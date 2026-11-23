# Generation

Generation turns a collection into a candidate site that the
[evaluator](EVALUATION.md) can judge
([SPEC section 6](SPEC.md#6-generate-modern-code-against-the-reference)).

Two generators exist. `transcribe` calls no model. `modernize` asks a model
to rewrite pages in current HTML and CSS; it has run only against a scripted
provider in tests. No live model call has been made, and one needs the
owner's approval.

## Command

```bash
node src/cli.ts generate --manifest <collection.json> --output <dir>
```

It also accepts `--job <dir>`. It writes a candidate (`site/` and
`url-map.json`) and a `generation.json` record. It opens no socket.

## The transcribing generator

It builds the candidate from the recovered markup itself. It does not
modernise anything. It makes recovered pages portable.

| Change | Why |
| --- | --- |
| Files are written at their original paths, the host dropped when the site has one host | Meaningful URLs survive |
| Every recovered link and resource URL becomes relative, fragment kept | The site runs from any folder with no archive or origin request |
| Text is re-encoded as UTF-8 with one declaration | One encoding for the export |
| Archived scripts and inline event handlers are removed; `noscript` content is unwrapped | Archived code is untrusted and never runs in a candidate |
| A `javascript:` link becomes `#` | Same reason |
| The `base` element is resolved and removed | Its effect is carried by the rewritten URLs |
| A same-site page link with no recovered target goes to a gap notice | A missing page is named, not hidden |
| A missing same-site resource, or any resource on another host, gets the source `data:,`, which fails without a request | It renders as the broken image the reference shows, at the size its attributes and alt text give; a loadable placeholder would have its own size |

No doctype is added. Adding one would move a quirks-mode page into standards
mode and change its layout.

A gap notice says it was added by the reconstruction and names the original
address. `generation.json` lists, per page, what was removed, rewritten and
replaced.

## What a pass by this generator means

The reference is a render of the archived bytes, and this candidate is made
from the same bytes. A pass therefore shows that the portability changes did
not alter what a visitor sees, and that the pipeline runs end to end. It is
not evidence that newly written code reproduces the page, because no new
layout code was written.

It is still a real test. On its first run against the September 2000 Spark
issue it failed two of 37 pages: the decoder had read a Western page with a
curly quote and two copyright signs as Shift_JIS. That decoder bug is fixed.

## Result on September 2000 Spark

37 pages, 34 assets, 27 gap notices. 449 links rewritten and 388 links to
pages outside this one-issue collection sent to gap notices. One script and
two inline handlers removed. Two external images left unloaded.

Evaluated against a 37-state bundle: every state passed every check with no
differing pixel. The bundle has no sign-off, so the verdict is
`pass-against-unfrozen-reference`.

## The model-backed generator

```bash
node src/cli.ts modernize --bundle <dir> --baseline <dir> --output <dir> --confirm-model-spend
```

This command calls a paid model API. It refuses to run without
`--confirm-model-spend`, reads credentials only from the environment, and
stops at its token budget.

It starts from a baseline candidate that already passes, normally the
transcribed site. For each page with a reference state:

1. The model receives the page's portable source, its reference screenshot
   and the measured position of its images, headings, links, forms and rules.
2. The answer is checked before any render. It must be one HTML document
   with a doctype and a UTF-8 declaration, and it may not contain scripts,
   inline handlers, table elements, `font` or `center` elements, or
   presentational attributes. It must keep the page's `meta refresh`, which
   a still render cannot see.
3. The evaluator judges the page against the frozen reference.
4. A page that passes every check replaces the baseline page. A page that
   fails goes back to the model with the mismatch report, up to three
   attempts in all.
5. If no attempt passes, the transcribed page stays.

The finished candidate is evaluated in full. Because a rewrite is kept only
when it passes, the result always passes; `modernization.json` says how many
pages are newly written, how many kept their transcribed version, and why.

Before the first call the loop verifies the bundle, requires its sign-off and
confirms the baseline passes. A setup that would be refused costs nothing.

### Rewrites written without the paid API

`modernize` reaches a model through the paid API, which is billed apart from
a Claude subscription. The same gate is open to any other author:

```bash
node src/cli.ts brief  --bundle <dir> --baseline <dir> --page <id|url>
node src/cli.ts submit --bundle <dir> --baseline <dir> --output <dir> \
  --page <id|url> --file <page.html> --author <name>
```

`brief` prints what an author needs for one page: the rules, the measured
elements, and the paths of the portable source and the reference screenshot.
`submit` judges one document exactly as the loop does. It is checked
statically, then by the evaluator, and it replaces the baseline page only on
a full pass. A failed submission puts the baseline page back and prints the
mismatch report. A page has three submissions and every one is recorded in
`submissions/<pageId>.json` with its author and hash.

`submit` calls no model, so it needs no spend confirmation. An agent in a
Claude Code session, which runs on the subscription, can write pages and
submit them. So can a person.

### What the model cannot do

It proposes source for one page. It cannot change the reference bundle, the
thresholds, the evaluator or any other page: the loop writes only inside the
output candidate, and the evaluator re-verifies the bundle on every run.
Page text is passed as data to reproduce, not as instructions.

### Records

Each attempt records the model that answered, token use, the output hash,
static problems and failed checks. Every answer is kept under
`attempts/<page>/<n>/` with its evaluation and difference image.

### Budgets

| Limit | Default |
| --- | --- |
| Attempts per page | 3 |
| Pages | 30 |
| Input tokens, whole run | 2,000,000 |
| Output tokens, whole run | 1,000,000 |
| Output tokens per call | 32,000 |
| Largest page sent | 150,000 bytes; a larger page is left as it is, never cut down |

`--one-per-family` rewrites only the first page of each family, for a small
trial.

### What is not known

Whether a model can meet the 2-pixel and 1% criteria for a 2000-era table
layout in standards-mode CSS has not been measured. The loop is proven; the
pass rate is not. The honest first step is a small trial.

## Limits

- Rewriting is a bounded tag scan, like discovery. URLs inside stylesheets
  and scripts are not rewritten.
- Behavior that depended on a removed script is gone and is not replaced.
- Form targets are left as they were.
