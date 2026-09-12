# Outcomes

An archived response can return HTTP 200, carry bytes that decode cleanly, pass
every validation M1 performs, and still contain no recovered content. The
origin's own 404 template was captured and is replayed as a success. The
provider answers with an interstitial. The domain died and a registrar's
holding page was captured in its place. The page is a soft redirect, or a
frameset whose frames were never captured.

Without a typed verdict each of those is stored as a recovered page, frozen
into a golden reference at M2, and faithfully reproduced at M3. The failure is
silent and it compounds. This document defines the verdict.

## Two axes, one mapping

[`src/outcomes.ts`](../src/outcomes.ts) carries both, and they are never
merged:

| | Question | Used for |
| --- | --- | --- |
| `FailureKind` | Did the request produce usable bytes? | retry, resume, the failure report |
| `ItemOutcome` | Does this item hold recovered content? | reference eligibility, the gap report |

They overlap without being the same thing, which is why `ItemOutcome` is not a
second copy of `FailureKind` with extra members bolted on. A failure is a
complete answer on the first axis and a partial one on the second: knowing that
a fetch returned 200 with valid bytes says nothing about whether those bytes
are the page. So every `FailureKind` **projects onto exactly one**
`ItemOutcome` through `OUTCOME_BY_FAILURE_KIND`, which is typed as a total
record: adding a failure kind without deciding what it means for content is a
compile error, not a silent gap.

| `FailureKind` | `ItemOutcome` |
| --- | --- |
| `destination-refused` | `destination-refused` |
| `transport-error` | `transport-error` |
| `provider-throttled` | `rate-limited` |
| `redirect-limit` | `redirect-unresolved` |
| `redirect-loop` | `redirect-unresolved` |
| `http-status` | `http-error`, or `not-archived` for 404 and 410 |
| `archive-error-page` | `archive-interstitial` |
| `content-type-mismatch` | `content-type-mismatch` |
| `empty-body` | `empty-body` |
| `oversized-body` | `oversized-body` |

The 404 and 410 refinement is the one place the status matters as well as the
kind: a replay answered with either says the provider holds no capture at that
URL, which is a different fact from an error while serving one.

Identifiers are kebab-case throughout, matching the rest of the codebase. Issue
#5 spells the same categories snake_case; the names here are the repository's.

## The closed set

Every item ends with exactly one of these, so per-outcome counts sum to the
item total. The set is closed: adding a category is a deliberate change with a
fixture behind it.

| Outcome | Meaning |
| --- | --- |
| `ok` | Validated bytes that carry the captured content. **The only outcome eligible to become an M2 reference.** |
| `archive-interstitial` | A provider error or interstitial document, by Wayback's own markers. |
| `origin-soft-404` | Matched an error template observed elsewhere on the same host. |
| `unverified-soft-404` | Carries not-found markers, but no template for that host was observed. |
| `parked-domain` | A registrar or parking holding page captured after the site died. |
| `meta-refresh-redirect` | A `meta refresh` or a scripted location assignment, with its target recorded. |
| `frameset-only` | A frameset whose referenced frames hold no validated bytes in this collection. |
| `empty-body` | A success status with a zero-length body. |
| `http-error` | A status that carried no usable body. |
| `not-archived` | The provider holds no capture: a 404 or 410 replay, or no known capture time. |
| `rate-limited` | The provider kept refusing within the retry budget. |
| `transport-error` | The connection or adapter failed before a response arrived. |
| `destination-refused` | The destination guard refused the URL or a redirect target. |
| `redirect-unresolved` | A redirect chain hit the hop limit or returned to a visited URL. |
| `content-type-mismatch` | The body did not match the type the referring markup implied. |
| `oversized-body` | The body exceeded the per-response byte cap. |
| `unattempted` | No request happened. |

## How the verdict is reached

Classification runs on decoded text plus response metadata and is deterministic
for a given input: same bytes, same collection, same verdict. There is no model
call and no scoring. Text comes from [`decode.ts`](DECODING.md); there is no
second decoder and nothing calls `TextDecoder` on a body directly.

Precedence runs strongest evidence first, so a page carrying two signals is
classified by the one that is hardest to fake:

1. **The provider's own interstitial markers.** Reused from
   [`wayback.ts`](../src/wayback.ts), which is what M1 already validates
   against. Wayback's markers, never an inference from page prose.
2. **An exact match against an observed error template for the host.**
3. **A literal parked-domain marker** in a bounded head window.
4. **A recorded redirect target**, from a `meta refresh` or from a location
   assignment inside a `<script>` block.
5. **A frameset with nothing captured behind it.**
6. **A not-found marker with no template to confirm it**, which is the weakest
   signal here and therefore the last one consulted.
7. Otherwise `ok`.

A binary body that validated is `ok` without being read as markup.

### Soft 404s are decided by comparison

A soft 404 is the origin's own error page replayed with a success status. It is
identified by comparison with that error page, not by suspicion about what a
page says.

The only thing that establishes a template is the provider's own inventory
metadata: a capture whose CDX row records a 4xx **at crawl time**, whose
replayed body is therefore the page the origin served for a missing URL. That
body's shape fingerprint becomes the host's error template. Nothing in a page's
prose can promote it to a template.

The fingerprint normalizes away what a template echoes back — URLs, paths,
digits — and keeps the remaining word shape, so one template matches across
every path it was served for while a genuine page does not collide with it. A
normalized text too thin to identify anything produces no fingerprint at all,
so near-empty pages cannot match each other.

When markers say not-found and no template has been observed for that host, the
item is `unverified-soft-404`. That is an honest "probably, unconfirmed", and
it is not eligible to become a reference either.

### Redirects are recorded, never followed

A `meta refresh` or a scripted location assignment records its resolved target
on the item and classifies as `meta-refresh-redirect`. The target does not
become a work item and nothing fetches it. Deciding what to do about it, such
as selecting the capture it points at, is out of scope here.

### A frameset is empty relative to the collection

A frameset classifies as `frameset-only` when none of the frames it declares
hold validated bytes in this collection. Frame extraction reuses the
acquisition link scanner, so a frame means the same thing here as it does
during discovery.

## Eligibility, and what the report says

`evidence.json` carries:

- `counts.byOutcome`, every outcome in the closed set, zero-filled, summing to
  `counts.items`
- `counts.referenceEligible`, the subset of `recoveredFiles` an M2 reference
  may be frozen from
- `outcome` on every fetched, failed and unattempted entry, with the reason it
  was reached
- `referenceEligible` on every recovered file
- a `non-content-body` gap for every validated body that is not `ok`

`recoveredFiles` keeps its M1 meaning: a stored body hash and a passed
validation. Issue #5 does not narrow it, because a soft 404 that was really
served is evidence and deleting it would hide what happened. What #5 adds is
that validated bytes are no longer sufficient for the next milestone to use
them. **M2 selects from `referenceEligible` items and from nothing else.**

Marking eligibility is where this stops. Freezing the reference bundle is M2,
and choosing an alternative capture for a bad outcome is issue #6 and issue #7.

Fidelity scoring (issue #8, [FIDELITY.md](FIDELITY.md)) composes with this rule
rather than competing with it, and this rule wins. An item whose outcome is not
`ok` is never scored at all, so no number can argue with the verdict above. A
score can only narrow what is already eligible, through
`promotableAsReference`, and `counts.referenceEligible` here is untouched by
it.

## Reclassifying costs nothing

Classification is a pass over bytes already in the content-addressed store, run
after the fetch loop rather than inside it, because two of its questions are
collection-wide: whether a host's error template was observed anywhere, and
whether a frameset's frames were captured anywhere.

That is also what makes it cheap to revise. Changing a marker list or a
precedence rule is a reclassification, not a re-acquisition:

```
pnpm run reclassify:fixture
```

or, for any job on disk:

```
node src/cli.ts reclassify --job <dir>
```

The pass holds no transport at all, so it cannot make a request even by
mistake; [`tests/isolation.test.ts`](../tests/isolation.test.ts) asserts that
structurally and [`tests/reclassify.test.ts`](../tests/reclassify.test.ts)
asserts the request counter stays where it was.

## Fixtures

[`fixtures/outcome-site/`](../fixtures/outcome-site/) is a deterministic
collection in which most responses arrive with bytes and carry no content: an
origin error template plus a second page serving it, a parked domain, a `meta
refresh`, a scripted redirect, a frameset with uncaptured frames, a zero-byte
success, a forbidden status, an absent capture, persistent throttling, an
interstitial, and one genuine page that must trip no detector.

Fourteen items, seven validated bodies, **one** eligible to become a reference.
That ratio is the whole point of the issue.

Fixture bodies are synthetic. No archived page content is committed, and
nothing in a fixture is ever treated as an instruction
(`agentic/contract.json`, `safety.archived_content_is_data`).
