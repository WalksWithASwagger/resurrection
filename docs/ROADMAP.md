# Implementation sequence

Status: the first bounded live acquisition ran on 2026-11-19. It recovered
three distinct UncleWeed pages from December 26, 2005. A targeted follow-up
recovered their navigation and painting thumbnails. A second pass recovered ten more images. The three pages are available offline and in a hosted preview.
M2 reference freezing, generation and independent comparison remain open.

**Pilot order changed on 2026-11-23.** The owner made Spark Online the first
site for M2 through M4 and asked for every surviving Spark issue. All 27
are now recovered; see [M5](#m5-spark-online). UncleWeed follows on the same
engine. Live model calls need the owner's separate
approval. See [SPEC section 12](SPEC.md#12-pilot-order-and-release-boundary).

Milestone status is recorded per section below and mirrored in
[the pilot declarations](../benchmarks/pilots.json).

Follow the [specification](SPEC.md). Each slice should produce a focused PR with acceptance evidence. Split a slice further if it cannot be reviewed coherently. Start with the recovery core and a small real result before building the full workbench.

## M1: Bounded acquisition and portable evidence

**First live run, 2026-11-19.** The CLI queried Wayback for the homepage
and requested the homepage, Words and Paint. It used 30 of 45 allowed requests,
including all 12 index requests, and counted 230,690 bytes. It paused with
11 queued items unattempted and zero fetch failures. The evidence lists 15
validated records representing 14 distinct bodies: three HTML pages, one
stylesheet and ten images. All recovered bodies have a December 26, 2005
capture timestamp.

| Page | Served time (UTC) | Distinct directly referenced images recovered |
| --- | --- | --- |
| Homepage | 20:41:26 | 10 of 26 |
| Words | 23:01:35 | 7 of 11 |
| Paint | 23:42:00 | 7 of 14 |

The inventory returned an explicit default port on the homepage URL. The seed
omitted the port. The engine fetched both, counted four page records under a
three-page configuration and assigned different scores to identical HTML.
The repaired collector reconciles those records and applies one page budget to
seeds, inventory and followed links. Reclassifying a copy of the collection
produced three active page records, retained the alternate homepage fetch and
made zero requests. The image counts above describe the first acquisition. The private collection holds the job, original
bytes and per-item provenance.

Build one TypeScript package with a CLI, a project configuration, a Wayback discovery/fetch adapter, persistent work items and a local content-addressed store. Preserve source queries, raw responses, requested/resolved capture times, outcomes and hashes. Recover linked documents and assets within an explicit budget.

First use deterministic local fixtures. Include query variants, a redirect to a different capture, an HTML error with status 200, missing assets, throttling, interruption and an attempted private-network redirect. Requests to Spark Online are outside this slice.

Done when pause/resume retains completed work, budgets cover retries, hashes validate and a portable evidence report distinguishes indexed, fetched, failed and unattempted items. Run a small logged UncleWeed acquisition only after fixture and fetch-isolation tests pass. Provider failures produce a partial report, not a test claim.

## M2: Frozen references and a site model

**Offline review on 2026-11-19.** A second, Wayback-only pass recovered the
three missing navigation GIFs and four painting thumbnails. It used 26 requests
(seven index), 85,627 response bytes and 45 seconds. The shared GIFs came from
December 26, 2005. Archived Flickr redirects led to February 21–22, 2007
thumbnail bytes matching the four original identifiers, filenames and dimensions.
The December 2005 thumbnail pixels remain unverified.

A desktop browser rendered the local homepage, Words and Paint at 1024 × 768, with
JavaScript disabled and zero external page requests. The respective pages
loaded 14 of 26, 10 of 11 and 14 of 14 distinct image URLs. The three links
between pilot pages worked from each page. Uncollected destinations have local
gap notes. The private review bundle retains the complete image and link
inventories, screenshots, and a standalone three-page ZIP. Reference sign-off
and the site model remain pending.

**Site model, 2026-11-23.** `resurrection model` builds the static half of
the [site model](SITE-MODEL.md) from stored bodies: page inventory, page
families, asset catalogue, navigation graph, static behavior evidence and
gaps. It accepts a job directory or a portable collection manifest and makes
no request. Run on the September 2000 Spark collection (71 resources) it
found 37 pages in five families: the cover, the contents page, 17 articles,
17 print editions and one figure page. It recorded 27 same-site links with
no recovered target and five date exceptions.

**Rendered references, 2026-11-23.** `resurrection reference` renders
recovered pages in pinned Chromium with scripts off and every request
answered from stored bytes, then writes a [reference bundle](REFERENCES.md):
screenshots, measured anchors, text and request records, frozen by a digest
and a human sign-off. For the same September issue it rendered one page per
family (five states) with no missing and no external request, and a second
run produced the same digest. No Spark bundle is signed off yet. Interactive
states are not captured.

From a bounded UncleWeed collection, select a coherent historical period and at least three representative pages. Record references and dependencies, identify page families, measure important layout anchors and write supported interaction contracts. Capture initial and relevant interactive states in an isolated environment.

Done when every reference has a source chain, rendering conditions and known gaps; observed behavior and inferred behavior remain separate. Keep private source material outside the public repository. Use shareable synthetic fixtures for CI when real materials cannot be published.

## M3: Generate, compare and repair one page family

**Evaluator, 2026-11-23.** `resurrection evaluate` renders a built candidate
under a signed-off bundle's conditions and checks route, title, text, pixels,
geometry, links and runtime. See [evaluation](EVALUATION.md). It is proven on
synthetic pages: an identical candidate passes and a shifted, recoloured one
fails its visual and geometry checks. The thresholds are uncalibrated.

**Transcribing generator, 2026-11-23.** `resurrection generate` builds a
candidate from the recovered markup with no model call. See
[generation](GENERATION.md). For the September 2000 Spark issue it wrote 37
pages and the evaluator passed all 37 states with no differing pixel, against
an unsigned bundle. The first run failed two pages and exposed a decoder bug
(a Western page read as Shift_JIS), now fixed. This proves the pipeline end
to end; it is not newly written layout code.

**Model-backed generator, 2026-11-23.** `resurrection modernize` asks a
model to rewrite each referenced page in current HTML and CSS and keeps a
rewrite only when the evaluator passes it; otherwise the transcribed page
stays. It is proven against a scripted provider: pass, repair, exhausted
attempts, refusal, budgets and refused setups. No live model call has been
made. Layout tables are no longer measured anchors, so a rewrite may use
different containers. The pass rate on real pages is unmeasured.

**First live rewrites, 2026-11-23.** `brief` and `submit` open the same gate
to any author, so rewrites can be written in a Claude Code session on a
subscription instead of through the paid API. Trial on September 2000 Spark,
one page per family (splash, contents, article, image page, print-friendly):
5 of 5 accepted on the first submission, each with no differing pixel and
every measured element within 2px, against an unsigned bundle. The splash
rewrite had dropped the page's `meta refresh` and still passed; rewrites
must now keep it, and that page was resubmitted with it restored. The paid
API path has still made no live call.

**Whole issue rewritten, 2026-11-23.** All 37 September 2000 pages were
rewritten by agents in a Claude Code session and judged by `submit`: 32
accepted on the first submission and 5 on the second, none exhausted. The
assembled candidate evaluates `pass-against-unfrozen-reference` on all 37
states. 29 are pixel-identical; 8 differ within the 1% tolerance, the largest
0.44% (media/hansen.html), and one of those (miscing/english.html) had an
unstable capture. Every measured element is within 2px, and its pages contain no table or font
element. Second submissions were caught by the evaluator: a cell margin
quirks mode drops, collapsed non-breaking spaces that changed wrapping, a
missing trailing space, an unaligned header and a link box 8px off. Agents
reused one accepted page per family as a template. The bundle is still
unsigned.

**Every recovered Spark issue rewritten, 2026-11-23.** 24 issues (October
1999 to issue 25, 871 pages; March 2000 was not recovered and issues 26 and
27 survive only in 2002 captures) were rebuilt, referenced, transcribed and
then rewritten by agents in a Claude Code session through `submit`, one
agent per issue, at most three at once. Every issue's assembled candidate
evaluates `pass-against-unfrozen-reference` on all its states. 867 pages are
rewritten (760 on the first submission); 4 used all three submissions and
keep their transcription. 524 states are pixel-identical; the rest differ
within the 1% tolerance, the worst by 0.98%. Agents built table-to-grid
converters from reference measurements, and some pages hard-code measured
row heights. Running the later issues found four engine faults, fixed
before any rewrite: placeholder images for missing resources moved layout,
folder and index URLs sharing a file broke link checks, undeclared pages
rendered in a guessed encoding, and tags were split at a `>` inside quotes.
No bundle is signed off.

**Top-up after the final recovery pass, 2026-11-23.** The recovery
session's last pass added pages to six issues and stories for issues 26 and
27, which survive only in captures from early 2002 (each with recorded
provenance). Those six issues were rebuilt and their accepted rewrites
resubmitted unchanged; 8 needed only links repointed from gap notices to
newly recovered pages, and one needed a recovered image. Totals across 26
issues: 923 pages, 919 rewritten, every issue passing all its states, 576
pixel-identical, worst 0.98%. March 2000 was never recovered.

**Gallery, home and forum rebuilt, 2026-11-23.** The three collections
outside the issue folders were rebuilt by transcription, with no model
call, and evaluated against unsigned references. Gallery: 41 of 41 pages
pass, 40 pixel-identical. Home and masthead: 18 of 18, all pixel-identical.
Forum: 502 of 502, 500 pixel-identical, worst 0.89%. The forum needed two
general fixes: a page served as HTML from a script name such as
`Ultimate.cgi` now gets an `.html` file name, and the evaluator cuts the
candidate's anchors at the same 1,500 cap the reference uses, which three
long threads exceed. The forum's 43,716 links to reply, profile and search
forms that were never archived lead to 25,484 gap notices.

**Gallery, home and forum rewritten, 2026-11-23.** Coding agents rewrote
the same 561 pages in modern HTML and CSS through the submit gate, with
three attempts per page. Gallery: 41 of 41 rewritten, with no layout tables
left. Home and masthead: 17 of 18; the awards page used its three attempts
and keeps its transcription. Forum: 499 of 502 accepted, 479 on the first
attempt, from one converter that uses an HTML5 tree builder so misnested
board markup parses as Chromium parses it. A full evaluation then failed
the control panel frameset: the accepted rewrite of `controlpanel.html`
passed alone at 1024px but broke inside the frameset's narrower frame.
That file keeps its transcription, so 498 forum pages use rewrites. All
561 states pass, worst 0.92%. The gate checks a page only on its own;
checking the framesets that embed a submitted page is open work.


Implement the model adapter, constrained code-generation workspace, static output and independent browser evaluator. Recreate original layout and supported interactions with local assets. Add bounded repair iterations and frozen accepted source files.

Done when visual, text, geometry, navigation and file checks pass for the scoped family. The generator must not edit golden images or loosen test tolerances. No unexpected live network traffic is allowed. A fresh build from the locked package needs no additional archive or AI calls.

## M4: Complete the first pilot and a minimal workbench

**Status: not started.**


Apply the reusable pipeline to the selected UncleWeed pages and required interactions. Add source inspection, side-by-side reference/candidate views, mismatch reports, capture selection, repair history and exports. Preserve historical appearance when adding keyboard access and viewport containment.

Done when readiness conditions R1 through R5 below pass with retained evidence. Avoid a broad UI build before the core can produce a faithful export.

## Readiness conditions for the second site

| ID | Required evidence | Status |
| --- | --- | --- |
| R1 | UncleWeed has a bounded, source-linked reference bundle and declared unresolved regions. | Open. Three pages rendered with a gap inventory. Reference selection and sign-off remain pending. |
| R2 | All required scoped visual and interaction checks pass for the first pilot, with no unacknowledged critical mismatch. | Not met. Depends on M3. |
| R3 | A clean export rebuilds and runs without archive/model calls or required remote assets. | Not met. No export step exists. |
| R4 | Missing-source, retry/resume, budget, untrusted-input and network-isolation tests pass. | **Met.** Covered across `tests/`, including the isolation suite and a crafted-URL case. |
| R5 | The engine runs from configuration with no UncleWeed-specific branches; evaluation evidence names the code and fixture revisions. | **Met.** `evidence.json` `revisions` records the embedded `CODE_REVISION` (overridable with `--code-revision`, never a runtime git lookup) and the SHA-256 of the fixture manifest, or `null` for a live run. |

These conditions measure engineering readiness. They do not introduce another user permission step.

## M5: Spark Online

On November 19, 2026 the owner requested a bounded archive trial for
`www.spark-online.com` during 1998–2001. This advanced second-site discovery
while R1–R3 for the first pilot remained open. The archived catalog numbers
October 1999 as issue 1.0. March 2000 (issue 6.0) had the largest editorial
set among the issues with complete indexed first-party artwork in a comparison
of 22 contents pages.
The pass spent 160 Wayback requests, including 20 index requests, and received
2,208,262 bytes. The recovered issue contains 51 historical HTML pages and
33 images. Two site-owned thumbnail URLs have no indexed in-period captures.
A follow-up reconstructed both sidebar thumbnails from the original cover artwork. The restored issue and offline export include all 26 stories and 23 linked print versions. See the [pilot record](../benchmarks/pilots.json) for coverage.

May 2000, issue 8.0 ranked second. All 25 linked articles and all ten first-party contents images had in-window index records and replayed successfully. Its 25 print versions are included in the two-issue export. Both covers, contents pages and readers link the issues together.

April 2000, issue 7.0 joins March and May on the same site. All 30 editorial links from the contents page open recovered stories. All 29 linked print versions and all 48 embedded first-party artwork URLs were recovered. One Trends essay has no located print edition. Two sidebar graphics and the full-size comic rely on later captures. The Visto advertisement is labelled and its tracking pixel is omitted.

June 2000, issue 9.0 extends the published run to four consecutive issues. June includes all 21 articles, 21 verified print editions and both enlarged comic illustrations. All 57 first-party images used by the restored pages were recovered. The June gallery lists 12 works. Passing a Light plays locally and the remaining 11 are catalog entries. The enlarged comic comes from 2002 and the A/B music loops come from later copies of the original players.

July 2000, issue 10.0 extends the published run to five consecutive issues. July includes all 21 editorial articles, all 21 linked print editions, and all 33 images referenced by its pages. Seven print editions use 2002 captures and one uses a 2003 capture. Their texts match the corresponding articles. July links to the shared gallery using the surviving June catalog, where 11 Flash or video works have catalog entries only.

August 2000, issue 11.0 extends the published run to six consecutive issues. August includes all 19 stories, all 19 matching print editions and all 32 original images. All 19 article captures date to 2000. Fourteen print editions and seven images come from 2001. The two Chasing Sublimity links now open the same article. No August gallery catalog surfaced in the dated search, so the gallery link identifies the surviving June edition.

September 2000, issue 12.0 extends the published run to seven consecutive issues. September includes all 17 articles, 17 text-matched print editions and 34 referenced images. The full-size 673 by 862 comic and three navigation or section graphics use 2002 captures. The full cover comes from 2006 and visually matches the earlier thumbnail. No September-dated shared gallery catalog was found.

**Every surviving issue, 2026-11-23.** The remaining 20 issues were recovered
with the September method, one bounded collection per issue: October 1999 to
February 2000 (1.0 to 5.0) and October 2000 to December 2001 (13.0 to 27.0).
Each collection stayed inside 210 requests, 22 index requests and 32 MB. The
20 collections hold 1,207 items: 320 of 321 linked stories and 253 of 255
linked print versions. One December 1999 story link returns 404 and two print
versions were never archived. 166 items come from 2002 to 2010 captures that
passed the exact-path and text-match checks. 21 of those are 2002 captures
accepted because their own title names the issue version; the magazine was
still publishing in early 2002, so parts of issues 21 to 27 exist only that
way. They are labelled and can be filtered out.

At a pace of 650 ms the Wayback Machine refused connections after about 60
requests in a minute. The pace was raised to 1,600 ms with a 90-second pause
after a refusal and a stop after three. Folder index lookups never answered
for November 1999 and issues 21, 23 and 26, so unlinked files in those four
folders are unknown.

The discussion board, the digital gallery and the home and masthead pages
were collected the same way. The board holds 476 thread pages: 221 captured
from 1999 to 2001 and 255 captured in 2002 and 2003, while the board was
still live. 37 linked threads return 404, and the reply, profile and search
forms were never archived. The gallery pages hold 86 of 92 linked images;
its seven Flash works do not play. Shared artwork under two site folders
exists only as 2024 captures, made after the domain lapsed, and was
rejected. Across the 28 collections the run spent 3,173 requests, 117 of
them index requests, and about 44 MB.

All 27 issues, the board, the gallery and the masthead were then assembled
into one static site: 1,535 pages and 991 graphics at their original paths,
with scripts removed and forms inert. Every internal link and image
reference resolves, checked with exact letter case. 328 pages come from
captures made after 2001 and are recorded as such. 161 image references
point at graphics that were never archived and show a labelled placeholder.
This site was assembled by a one-off script that reuses the September
sanitizer. It did not go through `generate` or `evaluate`, has no reference
bundle and was checked by eye on four pages only. Replacing it with engine
output is the remaining M5 work.

Run the same pipeline with a second project configuration. Record the actual structure and behaviors encountered rather than assuming them in advance. If it needs new support, add a general capability with fixtures and regression coverage instead of a Spark-specific engine fork.

Done when the second site's scoped fidelity report and portable export pass, or when a precise evidence/support limitation is documented. A sparse archive may support only a partial reconstruction; that is a valid finding, not a reason to invent missing material.

## Immediate assignment

Spark first. All 27 issues are recovered and assembled outside the engine.
Sign off a rendered reference bundle for one Spark issue. With
the owner's approval, run a one-page-per-family model trial on that issue
and record the pass rate. Build the clean export (R3). The UncleWeed reference
decisions below wait until the engine has passed on Spark.

Review the three offline renders and choose the regions to freeze for comparison.
Decide whether the February 2007 painting thumbnails can serve as dated
substitutions. Prioritize the missing homepage photographs and the linked
documents needed for the scoped visitor journeys. The site model and independent
reconstruction checks follow that reference decision.
