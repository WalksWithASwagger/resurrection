# Bounded acquisition

The M1 acquisition package turns an archive provider and a declared scope into
a durable, inspectable collection of bytes plus an evidence report that says
exactly what was and was not recovered. It is the first half of the build loop
in [the specification](SPEC.md); it does not model, generate or compare
anything.

Everything below runs against deterministic local fixtures. A live provider
call is a separate, human-approved, logged and bounded action, described at the
end of this document.

## The shape of a run

```
project config
      |
      v
 inventory (CDX)  ->  work items  ->  guarded fetch  ->  store + decode + validate
      |                    ^                                      |
   raw responses           |                                      v
   retained by hash        +-------------- discovered dependencies
                                                                  |
                                                                  v
                                                    job.json + evidence.json
```

Inventory and acquisition are separate states. An inventory run records what
the provider said exists; the fetch loop records what actually arrived. The two
are never merged into one success number.

## What a project declares

`fixtures/demo-site/project.json` is a complete example. A project declares:

| Field | Meaning |
| --- | --- |
| `scope.url` + `scope.matchType` | The inventory query. An exact-URL query is not a domain inventory. |
| `scope.from` / `scope.to` | The target period, as CDX timestamps. |
| `scope.seedUrls` | Pages selected regardless of inventory order. |
| `scope.dependencyHosts` | Hosts whose dependencies may be followed. |
| `budgets` | Requests, index requests, bytes, time, redirects, attempts, pages, dependencies. |
| `provider` | Endpoints, the host allowlist, the rate limit and the request timeout. |
| `discovery` | Which link relations are followed. |
| `selection` | Which capture is chosen when the inventory offers several. |
| `assetResolution.windowDays` | How far a dependency's capture may sit from its referring page before it is flagged. |
| `candidateFilters` | CDX filter expressions a capture must satisfy to be acquirable. |

There are no site-specific branches anywhere in the engine; a second pilot is a
second configuration file (roadmap readiness condition R5).

## The CDX query shape

The query is declared explicitly and recorded verbatim, because an exact-URL
query is not a domain inventory and a report that does not say which was issued
cannot be audited for coverage. Every run issues:

| Parameter | Why it is pinned |
| --- | --- |
| `output=json` | The row shape is parsed, not scraped. |
| `fl=urlkey,timestamp,original,mimetype,statuscode,digest,length` | Bounds the response instead of taking the provider's default columns, and names exactly the fields selection and the timeline read. |
| `collapse=digest` | Suppresses consecutive captures with identical content. A weekly-crawled page otherwise returns hundreds of redundant rows and the budget goes on inventory. It collapses *adjacent* duplicates only, so it is not proof of unique-content coverage. |
| `matchType` | The declared scope. An exact-URL query is not a host or domain inventory. |
| `from` / `to` | The declared period. |
| `limit` | Derived from the page budget, so one query cannot outrun the run. |
| `showResumeKey=true` | Continuation, so a host with many captures is paged rather than truncated. |

Every issued query string appears in `evidence.json` under `inventory.queries`,
and the raw index response is retained in the object store by hash.

### Why `filter=statuscode:200` is not sent upstream

`filter=statuscode:200` would make the provider drop redirect and error rows.
Those rows are exactly the evidence of *when a page moved or died*, so sending
the filter would delete the site's timeline to save a few rows of bandwidth.

The same expression is instead declared as `candidateFilters` and applied to
the rows after they arrive. A capture that fails it is:

- **excluded** from acquisition candidates, so it is never fetched while the
  URL has a capture that passed, and
- **retained** in `evidence.json` under `inventory.timeline`, with its
  timestamp, status, mimetype, digest and length, and the filter expression it
  failed.

Both facts are visible in the report: `inventory.candidateFilters` names the
rule, each inventory run carries `candidateRowCount` and `timelineRowCount`,
and `counts.timelineRows` totals what was held back.

The rule ranks captures *within* a URL. It does not decide which URLs exist. A
URL whose every capture failed the filter is still acquired, from an excluded
capture, and the report says so through `selection.fromExcludedCapture` and an
`excluded-capture-only` gap. Dropping it would delete the origin's own error
page, and that page is the single thing that establishes a site error template
for soft-404 detection (see [outcomes](OUTCOMES.md)).

## Replay modifiers

| Modifier | Used for |
| --- | --- |
| `id_` | Pages, assets and documents. Returns the captured bytes with no replay banner and no rewritten links. |
| `if_` | Frames and iframes. The provider's variant for framed replay. |

The choice is made per fetch from the relation the link was discovered through,
and the modifier that was actually used is recorded on the item and in the
report. Getting this wrong means every acquired page carries injected archive
markup that then has to be stripped heuristically.

### The defensive strip, and why it should do nothing

A short, literal rule list removes archive-injected nodes from decoded markup:
the toolbar comment pair and its element, `/_static/` scripts and stylesheets,
the analytics and `__wm.` init scripts, and the trailing `FILE ARCHIVED ON`
comment. Every rule matches the provider's own nodes, never page prose, so a
captured page that merely *writes about* the Wayback Machine is left alone.

On a correct `id_` fetch it removes nothing, and that is the point. The
fixtures assert the pair: stripping a rewritten body recovers the identity
bytes exactly, and stripping identity bytes is a byte-for-byte no-op. The
stripper is insurance; the tests are what keep it from quietly becoming
load-bearing.

The stored bytes are never rewritten. An injected body is still evidence of
what the provider served, so the store keeps exactly what arrived and the
report records what the strip *would* remove: how many nodes, which rules, how
many characters, and any marker still present afterwards. A body that needed
stripping raises an `archive-injection` gap, because injected markup in
acquired bytes means the modifier did not reach the provider.

## Capture selection policy

The inventory offers several captures per URL and the fetch loop can ask for
one. Which one is a declared policy, recorded per item with its reason, not an
accident of row order.

| Policy | Chooses |
| --- | --- |
| `nearest` (default) | The capture closest to the declared period's end bound, or its start bound when no end is declared, or the latest capture when the project declares no period at all. |
| `earliest-largest` | The largest body among the captures clustered within `selection.clusterWindowDays` (default 90) of the earliest one. |

**The default is `nearest`, and the reason is that it is the only policy that
cannot silently contradict the period the operator declared.** A project that
declares `from`/`to` is saying which era it wants; `nearest` aims at that bound
and never drifts outside it. `earliest-largest` ranks by body length, and
treating length as a completeness signal is a fidelity judgement — that
judgement belongs to the fidelity score (issue #8), not to a default that
applies to every project silently.

**Switch to `earliest-largest` for a site that is fully dead.** Early captures
of a site that later died are the least link-rotted: the assets still resolved,
the outbound links still worked, and the page had not yet been replaced by a
placeholder or a parking page. Within one such cluster the largest body is the
most complete rendering rather than a stub. Both halves of the rule matter:
earliest alone can land on a one-line placeholder, largest alone can land years
late.

Selection runs over the candidates the inventory already returned, so changing
the policy and reselecting costs **zero index requests** — the same property
that makes reclassification cheap. Every capture the inventory offered stays on
the item, with the filter verdict for each, and an item that already holds
validated bytes is never re-pointed.

## Per-asset capture resolution

A dependency is not a copy of the page that referenced it. An image linked from
a 1999 page may have no 1999 capture at all while a perfectly good one exists
from 2001, and an asset URL may have been reused for different content over the
site's life. Requesting a dependency at its referring page's timestamp records
the first case as missing and silently substitutes the wrong bytes in the
second. So **every discovered dependency is resolved against its own captures**,
and the capture it is resolved to, the page that referenced it and the distance
between the two are recorded per asset.

The target differs from the page policy above, and that is the whole point.
Page selection aims at the **declared period bound**, because that is the era
the operator asked for. Asset resolution aims at **the referring page's
capture**, because that is the moment the asset was actually on the page. The
selector in `src/select.ts` is shared; only the target is parameterised.

### It costs no index requests for an in-scope asset

The site inventory is issued with `matchType=domain`, so it already describes
the captures of same-host assets. Every row it returns is kept in the job's
capture index, whether or not it becomes a page of its own, and an asset the
inventory described is resolved from those rows for **zero additional index
requests**. The fixture demo resolves all eight of its dependencies this way
and issues exactly the two index requests its inventory needed.

A per-URL lookup is issued only when the inventory cannot answer:

| Case | Why the inventory cannot answer |
| --- | --- |
| The asset is on another host | A domain inventory of one host never described it. |
| The inventory is partial | A truncated inventory proves nothing about what it did not return. |
| The inventory was period-bounded | `from`/`to` bound the query, so it says nothing about captures outside them — which is exactly where a late capture of an early asset lives. |

Only when the inventory is **complete, unbounded and covers the host** is its
silence treated as proof that a URL has no captures, and then no request is
made at all. Each URL is looked up at most once: the result is recorded in the
capture index even when it is empty, so several pages referencing one asset
cause one lookup, and a resumed run re-issues none of them. Every lookup is
charged to the same index and request budgets as the inventory, and a lookup a
budget stops leaves the asset **unattempted** with the reason
`budget-exhausted` — a partial report, not a failure.

### Rows that are assets are not seeded as pages

A domain inventory describes images, stylesheets and documents alongside pages.
Those rows go into the capture index but are not seeded as pages in their own
right: seeding them would spend the page budget on assets and validate an image
against the markup rules. A row the provider could not type stays a page, so an
untyped URL is never silently dropped from the inventory.

### The window, and what a flag means

`assetResolution.windowDays` (default 365) is a **declaration threshold, not a
filter**. A capture further than the window from its referring page is still
acquired — it is often the only surviving copy of the asset — and the asset is
flagged `temporally_distant` in the report with a `temporally-distant-asset`
gap, so nothing downstream can treat it as contemporaneous with the page. The
flag follows the bytes that arrived, not only the capture that was asked for: a
replay redirect can land further out than the resolver chose.

When an asset URL served more than one content hash across its captures, every
distinct hash is recorded with the captures that carry it, and an
`asset-content-drift` gap names them and repeats why the chosen capture won.

An asset with **no capture anywhere** is never requested. It becomes a skipped
item with a `no-capture` gap naming the original URL and the page that
referenced it. The live origin is not a fallback, here or anywhere else.

## Pagination honesty

A truncated inventory is never reported as complete. `inventory.partial` is
true, `inventory.partialReasons` says why in words, and a `partial-inventory`
gap names it, whenever:

- no inventory run was recorded at all,
- the last run stopped holding an unused continuation key,
- any run failed, or
- any run filled its declared row limit.

The last one is the subtle case: a run can end with no continuation key and
still have filled its limit, and nothing then proves the limit was not the cut.
Reporting that as a complete inventory would turn "we never asked" into "there
was nothing there".

## Budgets, including retries

Every HTTP attempt is charged to the ledger: first attempts, retries and
redirect hops alike. A retry that is not charged bounds nothing. Index requests
have their own counter and are also charged to the shared request total, so one
number still bounds provider load.

The budget is checked *before* each attempt and charged *after* it, so a
refusal never consumes the attempt it refused. When a budget stops an item, the
item is recorded as **unattempted** with the reason `budget-exhausted` — it is
not a failure, because nothing was tried.

Spend is persisted with the job. A resumed run continues the same accounting
rather than starting from zero; raising a budget and resuming is an explicit
change to the declared scope, and the report records the budget actually in
force.

## The destination guard

Order inside a retrieval is:

```
budget check -> destination guard -> rate limit -> request
```

The guard runs before a socket exists and again for **every redirect target**,
because an archived redirect is the cheapest way to aim a fetch at a private
address. It refuses:

- non-`http(s)` schemes, embedded credentials and non-standard ports
- hosts outside the configured provider allowlist, which is what keeps the
  engine from fetching the live origin of a dead domain
- literal loopback, private, carrier-grade NAT, link-local (including the cloud
  metadata address), benchmarking, multicast and reserved addresses, in IPv4,
  IPv6 and IPv4-mapped IPv6 form
- any hostname where *any* resolved address falls in those ranges

Name resolution is injected, so the guard is deterministic under test. The live
transport uses `node:http`/`node:https` rather than `fetch` so it can pin the
connection to the addresses the guard already cleared; resolving twice would
leave a window in which the second answer differs from the first.

## Evidence

`evidence.json` names four states separately and never collapses them:

| State | Meaning |
| --- | --- |
| `indexed` | The provider said this URL exists, with its capture alternatives. |
| `fetched` | Bytes arrived and passed response and content validation. |
| `failed` | A request happened and produced no usable bytes, with a typed reason. |
| `unattempted` | No request happened, with the reason it did not. |

`recoveredFiles` is the strict subset of `fetched` items that have a stored
body hash and a passed validation. A discovered URL, an indexed row and a local
path mapping are none of them a recovered file. That is the invariant behind
"an asset URL is never reported as a recovered file without acquired and
validated bytes".

Validated bytes are still not the same thing as recovered content. Every item
also carries exactly one typed outcome, and only an `ok` outcome is eligible to
become an M2 reference: see [outcomes](OUTCOMES.md). The report counts items by
outcome, names the eligible subset, and raises a `non-content-body` gap for
every validated body that is not content.

Per fetched item the report records the requested capture time, the capture
time the provider actually served, the distance between them, the redirect
chain, the replay modifier that was used, the selection policy that chose the
capture and its reason, the attempt count, the local SHA-256, the
archive-injection scan, and the encoding decision from
[`decode.ts`](DECODING.md): declared encoding and its source, chosen encoding
and its source, detection confidence, and whether a cp1252 upgrade or a
declaration override was applied.

`inventory` carries the query strings issued, the candidate filters applied,
the timeline of captures held back, and whether the inventory is partial.

`fidelity` carries the graded per-page score (issue #8) with its full
per-signal breakdown, so a reviewer can see which signal moved a score rather
than only its composite. It is an additional graded signal, not a replacement
for M3's binary acceptance checks, and it narrows promotion without touching
`counts.referenceEligible` above: see [fidelity](FIDELITY.md).

`assets` carries, per dependency: the page that referenced it and that page's
capture time, the capture the resolver chose, the capture the provider served,
both distances in seconds, the declared window, the flag state, whether it came
from the inventory or from a per-URL lookup, every distinct content hash the
URL served, the provider's digest for the chosen capture and the local SHA-256
of the bytes that arrived. It also carries every per-URL lookup issued and the
index requests they cost, so a reader can see what asset resolution spent.

The report is portable: relative store paths, no operator filesystem layout, no
credentials and no private collection URLs.

### Gaps

The gap report names, with a remedy for each: failed fetches, unattempted
items, URLs with no known capture, validated bodies that carry no content
(`non-content-body`), bodies whose replacement-character ratio exceeded the
documented threshold (`degraded`), truncated bodies, captures served far
outside the requested era, bodies that carried archive-injected markup
(`archive-injection`), URLs whose only captures failed the candidate filter
(`excluded-capture-only`), assets acquired from outside the declared window
(`temporally-distant-asset`), asset URLs that served more than one content hash
(`asset-content-drift`), and an inventory that cannot be shown to be complete
(`partial-inventory`).

## Typed failure states

The set is closed. Adding one is a deliberate change with a fixture behind it.

`destination-refused`, `transport-error`, `provider-throttled`,
`redirect-limit`, `redirect-loop`, `http-status`, `archive-error-page`,
`content-type-mismatch`, `empty-body`, `oversized-body`.

A 4xx is a definite answer and is not retried. A 429 or 503 is retried after
its `Retry-After`, and a 5xx after a backoff, both within the per-item attempt
budget. `archive-error-page` is what catches a provider error document served
with status 200.

This set answers whether a request produced usable bytes. Whether the bytes are
content is a separate closed set on a separate axis, with a documented mapping
from every kind above: see [outcomes](OUTCOMES.md).

## Pause, cancel, resume

Job state is written through after every item, so a pause, a cancel and a
process that simply dies all leave the same durable record. A resumed run:

- keeps every previously acquired body hash
- makes no request for an item that already holds validated bytes
- does not re-issue an inventory that already completed
- retries a failed item only when the resume asks for it

## Storage

Bodies are content-addressed by the SHA-256 of exactly the bytes received. That
is deliberately a different thing from the archive's own digest: the archive
digest describes what the provider says it holds, the local hash describes what
arrived here. Both are recorded, separately.

URL identity and content identity stay separate. Two URLs that receive the same
bytes share one stored object and keep two records.

Original URLs map to local export paths through a sanitiser that cannot emit a
traversal segment, and that keeps a query string as part of the file's identity
so two URLs differing only by query never collide.

## Running it

Against the committed fixtures, with no network at all:

```
pnpm run acquire:fixture
```

That command owns `tmp/demo-acquisition` as disposable demo output and clears
it before each run, but only when the job there is the demo's own, so a listed
verification command never depends on prior working-tree state and never
deletes a job it did not create.

Re-render a report from a job already on disk, which makes no requests:

```
node src/cli.ts report --job tmp/demo-acquisition
```

Re-run outcome classification over bytes already stored, which also makes no
requests:

```
pnpm run reclassify:fixture
```

## The live acquisition gate

The transport is an explicit argument with no default, and a live run needs a
second flag on top of it:

```
node src/cli.ts acquire \
  --config <project>.json \
  --transport live \
  --confirm-live-acquisition
```

Omitting `--confirm-live-acquisition` refuses the run and explains why. This is
the contract's `safety.network_isolation` rule made mechanical: a live provider
call is a human-approved, logged, bounded action, not something a run can do by
leaving a flag off.

The first such acquisition against the first pilot has **not** been performed.
It is a human decision, and its actual result — including a provider failure,
which stays a partial result rather than being replaced with synthetic success
— belongs in the pull request that performs it.

## Deliberately not here

- A fidelity score (issue #8), the site model (M2), generation (M3) and the
  workbench (M4).
