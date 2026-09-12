# Implementation sequence

Status: M1 delivered against fixtures. The acquisition core, its CLI and its
evidence report exist and are verified; see [bounded acquisition](ACQUISITION.md).
No live archive acquisition has been performed, no AI generator exists and no
pilot has passed. M2 onward have not been started.

Milestone status is recorded per section below and mirrored in
[the pilot declarations](../benchmarks/pilots.json).

Follow the [specification](SPEC.md). Each slice should produce a focused PR with acceptance evidence. Split a slice further if it cannot be reviewed coherently. Start with the recovery core and a small real result before building the full workbench.

## M1: Bounded acquisition and portable evidence

**Status: delivered against fixtures, except the live acquisition gate.**
Shipped by #12, #14, #15, #16, #17 and #18. Everything below is implemented and
covered by tests, and the work went past this milestone's original text: typed
[outcome classification](OUTCOMES.md) (#5), per-asset capture resolution (#6),
[pinned CDX query shape, replay modifiers and capture selection policy](ACQUISITION.md) (#7)
and a [graded fidelity score](FIDELITY.md) (#8).

**Remaining:** the small logged UncleWeed acquisition described at the end of
this section. Fixture and fetch-isolation tests pass, so that gate is open, but
the acquisition itself is a human-approved action under
`safety.network_isolation` in `agentic/contract.json`. The CLI refuses a live
run without `--transport live --confirm-live-acquisition`. Issue #3 stays open
until it is performed.


Build one TypeScript package with a CLI, a project configuration, a Wayback discovery/fetch adapter, persistent work items and a local content-addressed store. Preserve source queries, raw responses, requested/resolved capture times, outcomes and hashes. Recover linked documents and assets within an explicit budget.

First use deterministic local fixtures. Include query variants, a redirect to a different capture, an HTML error with status 200, missing assets, throttling, interruption and an attempted private-network redirect. Requests to Spark Online are outside this slice.

Done when pause/resume retains completed work, budgets cover retries, hashes validate and a portable evidence report distinguishes indexed, fetched, failed and unattempted items. Run a small logged UncleWeed acquisition only after fixture and fetch-isolation tests pass. Provider failures produce a partial report, not a test claim.

## M2: Frozen references and a site model

**Status: not started.**


From a bounded UncleWeed collection, select a coherent historical period and at least three representative pages. Record references and dependencies, identify page families, measure important layout anchors and write supported interaction contracts. Capture initial and relevant interactive states in an isolated environment.

Done when every reference has a source chain, rendering conditions and known gaps; observed behavior and inferred behavior remain separate. Keep private source material outside the public repository. Use shareable synthetic fixtures for CI when real materials cannot be published.

## M3: Generate, compare and repair one page family

**Status: not started.** No AI generator or browser evaluator exists.


Implement the model adapter, constrained code-generation workspace, static output and independent browser evaluator. Recreate original layout and supported interactions with local assets. Add bounded repair iterations and frozen accepted source files.

Done when visual, text, geometry, navigation and file checks pass for the scoped family. The generator must not edit golden images or loosen test tolerances. No unexpected live network traffic is allowed. A fresh build from the locked package needs no additional archive or AI calls.

## M4: Complete the first pilot and a minimal workbench

**Status: not started.**


Apply the reusable pipeline to the selected UncleWeed pages and required interactions. Add source inspection, side-by-side reference/candidate views, mismatch reports, capture selection, repair history and exports. Preserve historical appearance when adding keyboard access and viewport containment.

Done when readiness conditions R1 through R5 below pass with retained evidence. Avoid a broad UI build before the core can produce a faithful export.

## Readiness conditions for the second site

| ID | Required evidence | Status |
| --- | --- | --- |
| R1 | UncleWeed has a bounded, source-linked reference bundle and declared unresolved regions. | Not met. No acquisition has run. |
| R2 | All required scoped visual and interaction checks pass for the first pilot, with no unacknowledged critical mismatch. | Not met. Depends on M3. |
| R3 | A clean export rebuilds and runs without archive/model calls or required remote assets. | Not met. No export step exists. |
| R4 | Missing-source, retry/resume, budget, untrusted-input and network-isolation tests pass. | **Met.** Covered across `tests/`, including the isolation suite and a crafted-URL case. |
| R5 | The engine runs from configuration with no UncleWeed-specific branches; evaluation evidence names the code and fixture revisions. | Partly met. The engine has no site-specific branches, but the evidence report carries no code or fixture revision field. |

These conditions measure engineering readiness. They do not introduce another user permission step.

## M5: Spark Online, when ready

**Status: not started.** Blocked on R1 through R5.


After R1 through R5 pass, inspect `spark-online.com` using approximately 1998 as the owner's requested starting point. Verify actual capture dates and site identity before fixing the test period. Do not substitute a later unrelated site if early evidence is absent.

Run the same pipeline with a second project configuration. Record the actual structure and behaviors encountered rather than assuming them in advance. If it needs new support, add a general capability with fixtures and regression coverage instead of a Spark-specific engine fork.

Done when the second site's scoped fidelity report and portable export pass, or when a precise evidence/support limitation is documented. A sparse archive may support only a partial reconstruction; that is a valid finding, not a reason to invent missing material.

## Immediate assignment

M1 is delivered against fixtures. Two things stand between here and M2:

1. **Perform the bounded UncleWeed acquisition** (issue #3). Human-approved,
   logged and budget-bounded. An archive failure is a partial result, never a
   substituted synthetic success.
2. **Record code and fixture revisions in the evidence report**, the one
   outstanding half of R5.

Then begin M2 from the acquired collection. Do not build account management,
hosted billing, a redesigned site template, broad CMS integrations or the Spark
Online recovery.
