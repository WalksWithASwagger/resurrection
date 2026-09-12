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

There are no site-specific branches anywhere in the engine; a second pilot is a
second configuration file (roadmap readiness condition R5).

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
chain, the replay modifier, the attempt count, the local SHA-256 and the
encoding decision from [`decode.ts`](DECODING.md): declared encoding and its
source, chosen encoding and its source, detection confidence, and whether a
cp1252 upgrade or a declaration override was applied.

The report is portable: relative store paths, no operator filesystem layout, no
credentials and no private collection URLs.

### Gaps

The gap report names, with a remedy for each: failed fetches, unattempted
items, URLs with no known capture, validated bodies that carry no content
(`non-content-body`), bodies whose replacement-character ratio exceeded the
documented threshold (`degraded`), truncated bodies, and captures served far
outside the requested era.

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

- Capture selection policy and CDX query hardening (issue #7). The adapter
  issues one declared query shape and keeps every alternative timestamp it saw;
  it does not yet choose between them by policy.
- Per-asset nearest-capture resolution (issue #6). A dependency is currently
  requested at its referring page's capture time, and the redirect chain plus
  the served timestamp record what the provider actually returned.
- A fidelity score (issue #8), the site model (M2), generation (M3) and the
  workbench (M4).
