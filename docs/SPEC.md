# Resurrection: product and engineering specification

Version 0.2 · 6 September 2026 · Status: proposed implementation

This specification incorporates the product owner's clarification: recover a dead website, understand how it looked and worked, and generate a faithful implementation using modern technology. It supersedes the earlier three-mode product direction. A new visual design is outside the initial product scope.

## 1. Product contract

**A dead URL becomes a working website that reproduces its evidenced appearance and visitor behavior.**

Resurrection discovers surviving archive captures, acquires the available pages and files, builds a structured understanding of the site, writes maintainable code, and iterates against visual and functional tests.

The output includes the original content and assets that were recovered, a new implementation, a source map and a report of remaining gaps. A captured document remains downloadable. A navigation control goes to the intended local page. An evidenced rollover behaves like the original. The original graphic style remains intact.

The ambition is broad website resurrection. Fidelity can only be verified for the states and artifacts supported by surviving evidence. When the archive lacks a page, image or behavior, the product must identify that gap and distinguish any reconstructed replacement.

The initial customer is a site owner, artist, publisher or creative technologist recovering a body of work. The first supported sites are older content sites with bounded navigation and presentation behavior. Server databases and unavailable external services cannot be recovered from rendered pages alone; documented replacement behavior can be implemented separately. [Internet Archive's account of archival limitations](https://help.archive.org/help/using-the-wayback-machine/)

## 2. What fidelity means

| Dimension | Required outcome |
| --- | --- |
| Appearance | Reproduce evidenced page geometry, typography, colors, graphics, backgrounds, borders, image crops, spacing and visible states. |
| Content | Preserve recovered wording, headings, credits, links and document relationships. Keep uncertain dates and conflicting versions distinguishable. |
| Navigation | Preserve the information hierarchy, link destinations, fragments, route behavior, history and relevant frame or popup interactions. |
| Interaction | Recreate supported hover, focus, click, keyboard, playback and local search behavior from documented evidence. |
| Portability | Run the generated website from its export without fetching required content from Wayback or the dead origin. |
| Maintainability | Deliver understandable source, local assets, dependency locks and build instructions using current supported tooling. |

Historical oddities can be part of the design: fixed widths, tiled backgrounds, image maps, sliced graphics, narrow columns and unusual menus. Do not replace them with generic cards, a new brand system or a fashionable layout. Modern implementation techniques must satisfy the visual and behavior contract.

Fidelity is scoped to named reference states and controlled rendering conditions. “Looks exactly the same” is the target; a passing report names what was compared, the tolerance and any exceptions. It never implies verification of unseen pages or states.

## 3. Core user journey

The user enters a domain or historical URL and an approximate period. Optional inputs include known successor URLs, screenshots and locally held files. The system proposes useful capture periods with previews and an inventory of observed pages, assets and gaps.

The user selects a target period and the system creates a bounded recovery plan. Retrieval shows real progress, byte/request budgets, retries and unresolved dependencies. Index discovery and file acquisition are separate states.

The workbench presents the selected reference beside the generated website. A synchronized page tree and interaction-state selector let the user compare more than the homepage. A source drawer explains the origin of a page, image, document or behavior. A visual difference overlay highlights specific mismatches.

An action such as “fix this menu” proposes a scoped code patch supported by the reference. The system runs the relevant tests, shows the difference and retains rollback history. It can perform routine repairs automatically within the declared budget; it pauses the repair loop when evidence or convergence is inadequate.

The final export contains working source, a built website, local assets, an evidence manifest and validation results. Public hosting is optional and separate from creating a private working reconstruction.

## 4. Understand the site before generating it

The engine must create a **site model** from HTML, styles, scripts, navigation, files, captures and rendered evidence. The model is the contract between acquisition and code generation.

| Part of the model | Contents |
| --- | --- |
| Page inventory | Original URLs, variants, chosen captures, page families, titles and content regions |
| Asset catalogue | Images, fonts, style sheets, scripts, documents, audio/video and their occurrences |
| Layout description | Reference images, measured anchors, sizes, colors, typography and repeatable components |
| Navigation graph | Local routes, fragments, frames, popups, downloads and external destinations |
| Behavior contracts | Starting state, user action, expected visible state, URL changes, side effects and supporting evidence |
| Content assertions | Source-backed text and metadata, separate publication/capture/event dates and unresolved conflicts |
| Gaps | Missing bodies, uncertain behavior, failed requests, unsupported formats and possible remedies |

A visual language model can help infer page families, describe graphics and locate mismatches. Static analysis can identify linked scripts, image swaps and event handlers. Neither method establishes that a behavior was observed running. Distinguish observed, statically supported and inferred behavior.

Reference screenshots may be supplied historical images or new renders of selected archived bytes. Record which kind they are, how they were produced and any missing dependencies or replay effects. A modern render of an archive is not evidence of an exact 1998 browser rendering.

## 5. Discovery and acquisition

### 5.1 Inventories with declared scope

Retain raw index responses, exact queries, collection time, continuation state and truncation. Preserve historical URL variants, query strings and useful error/redirect records. Choose working candidates from that evidence rather than discarding all unsuccessful records at discovery time.

CDX supports exact, prefix, host and domain scopes, date bounds and result continuation. An exact URL query is not a domain inventory. Digest collapse removes adjacent duplicates and is not proof of complete unique-content coverage. Discover within a budget and keep alternative dates needed for reconstruction. [Internet Archive CDX documentation](https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md)

A quick Availability API response can identify a nearby accessible snapshot. It does not enumerate a site. [Wayback API documentation](https://archive.org/help/wayback_api.php)

### 5.2 Coherent capture selection

Prefer a selected page and compatible dependencies from one visual era. Record the requested time, actual returned capture time and date distance for every acquired component. Avoid parked domains, unrelated redesigns and error pages using explicit evidence and explainable rules.

For missing dependencies, try other captures within the permitted period, then explicit date exceptions, identified successor sources or supplied files. Each substitution records its origin and reason. A successor publication does not silently become a historical capture.

### 5.3 Keep bytes before interpreting them

Store immutable downloaded bodies, response metadata, redirects, retrieval time and local SHA-256 hashes. Validate media type and content: a 200 response can still contain an archive error page. Keep archive digests separate from local hashes and record the bytes each hash covers.

Archive replay modifiers require provider-specific handling. pywb documents identity retrieval without content rewriting, qualified header behavior and a separate image hint; these distinctions guide adapter tests and do not guarantee every public deployment behaves identically. Record the actual retrieval mode and inspect the returned body. [pywb rewriter documentation](https://pywb.readthedocs.io/en/latest/manual/rewriter.html)

Do not use live Wayback asset URLs as the finished site's dependencies. Save usable assets locally. An audio pointer, document title or media URL is a discovery record until the body has been acquired and validated.

### 5.4 Retrieve documents and files as first-class outputs

Discover PDFs, office documents, text files, feeds, downloadable archives and directly linked media alongside HTML and graphics. Preserve original bytes and filenames as metadata, record hashes and detected type, and map downloads to safe local paths. Text extraction or previews are derivatives with their own hashes.

Do not execute downloaded files. Archive extraction is optional, sandboxed and bounded; an archive file can be retained as a download without unpacking it. Missing or oversized media stays explicitly pending or unavailable rather than becoming a fake recovered file.

### 5.5 Persistent, bounded work

Use a durable queue with pause, cancel, resume, retry and partial-result states. Limit requests, bytes, redirects, response size and elapsed time. Enforce a shared provider rate limit across projects, honor Retry-After where present and back off on repeated denial. Do not evade restrictions.

Proposed pilot defaults are 30 selected pages, 500 dependency URLs and 200 MB of response bodies, with a separate index budget. These are product limits to tune, not archive service limits. Expansion preserves completed work and explicitly updates the declared scope.

## 6. Generate modern code against the reference

Start with a representative page family and its shared components. Give the coding model the site model, bounded source excerpts, local asset manifest, reference states and acceptance contracts. Generate current HTML/CSS and typed JavaScript where needed; preserve the old appearance.

The default export should be a small static build with local runtime modules. Add framework or server complexity only when supported behavior requires it. The product's operator workbench can use React; generated sites do not all need to become React applications.

The generation loop is:

1. Freeze reference evidence, selected captures and test expectations.
2. Generate or patch a narrowly scoped set of source files.
3. Run structural, content, asset, screenshot and interaction checks.
4. Present the mismatch report to the coding model with the relevant evidence.
5. Repeat within iteration and cost limits, keeping the best passing checkpoint.

Generators cannot change their own golden images, expected outcomes, tolerances or masks. A separate test runner produces acceptance results. Reference corrections have explicit provenance and review records. Tests may be revised when evidence changes, never silently to accommodate a failed implementation.

Proposed repair budget: three scoped attempts before marking the mismatch unresolved, with a configurable project cost cap. Every patch records inputs, model identifier, prompt-template version, changed files and test results. Accepted generated files become fixed build inputs; subsequent builds do not need another model call.

Acquisition, inspection and evidence export should work without an AI provider. Code generation uses an explicit provider adapter and bounded context. Nothing requires a particular chat service, Lovable account or GitHub integration to run the exported project.

## 7. Restore behavior deliberately

| Historical feature | Modern reconstruction |
| --- | --- |
| Image rollover or menu state | Reuse acquired image states or recreate evidenced CSS behavior, with keyboard access and matching pointer appearance. |
| Frames and image maps | Preserve visible geometry and navigation semantics through a tested implementation; map hotspots accurately. |
| Article links and downloads | Route to the local recovered item while preserving meaningful URLs, query variants and fragments. |
| Local search | Use recovered content with the original evidenced search interface; label the search engine as a replacement when historical ranking is unavailable. |
| Audio/video playback | Use a compatible local player and evidenced controls when media is available; report absent media honestly. |
| Guestbook, contact or commerce form | Reproduce appearance and supported validation; treat live submission, storage and transactions as separately configured behavior. Never show fake success. |
| External service or obsolete plugin | Record the dependency and evidence. Build an explicit replacement only within the supported scope; otherwise report the unsupported behavior. |

Useful interactions should work in the generated output. Historical code is evidence to inspect; it must not execute with the operator application's credentials. New runtime code can implement the observed behavior in a sandboxed generated-site origin.

“Same behavior” applies to the stated contract. A replaced search engine or unavailable backend does not acquire historical authenticity because the input box looks right.

## 8. Fidelity and usability evaluation

### Controlled reference conditions

Pin the browser build, operating environment, viewport, device pixel ratio, zoom, locale, fonts and test data. Wait for assets/fonts and define animation times. Use the same conditions for reference and candidate renders. Playwright documents screenshot baselines and warns that render results depend on the environment. [Visual comparison guidance](https://playwright.dev/docs/test-snapshots)

Choose the viewport from evidence where possible. Otherwise record a chosen comparison viewport without claiming it was the historical viewing size. Keep the historical desktop geometry; mobile containment and keyboard access must not silently replace the reference layout with a redesigned responsive page.

### Proposed acceptance thresholds

These defaults must be calibrated on the first fixture before results are called verified. They are not measurements of an existing implementation.

| Check | Initial criterion |
| --- | --- |
| Content and files | Recovered copy and linked document bytes match their frozen references, except explicitly recorded transformations. |
| Visual comparison | At most 1% differing pixels at a pinned per-pixel threshold of 0.1, plus dedicated checks for critical regions. A ratio passing alone is insufficient. |
| Geometry | Critical anchors such as header, navigation, content columns and image boxes are within 2 CSS pixels of measured reference positions. |
| Typography | Required font families/fallbacks, sizes, line heights and critical text wrapping match the reference contract. |
| Behavior | Every required scoped transition passes, including URL/history, menu state, download target and keyboard behavior. |
| Runtime | No uncaught application errors or unexpected external network requests; all required local resources resolve. |
| Export | A clean unzip can build and run without fresh archive or model calls. Website file hashes are repeatable for identical locked inputs. |

The pixel ratio and per-pixel color threshold are distinct settings in Playwright; pin both. Masks require a named reason and must not cover content or an unresolved regression. [Screenshot assertion options](https://playwright.dev/docs/api/class-pageassertions)

Freeze time only for static comparison. Test required animation behavior separately at named times. Distinguish CSS animation handling from GIF, canvas and video behavior; disabling CSS animations does not establish that all media is stable.

Use at least a homepage and two structurally different inner pages, with required initial and interactive states, for the first real pilot. A homepage screenshot alone cannot pass a website resurrection. Validate all scoped routes and files even if detailed visual inspection uses page families.

When a historical reference is incomplete, classify the affected region as unverified or reconstructed. Do not turn a model-generated guess into a golden historical reference. Reports can say “partial reconstruction” while identifying the components that did pass.

## 9. Architecture and records

Start with one TypeScript application containing a reusable core and CLI, a persistent worker and a small API for the later workbench. Use SQLite plus a content-addressed local file store for the single-operator pilot. Avoid separate microservices until deployment or workload evidence requires them.

The core owns discovery adapters, retrieval, parsing, selection, source relationships, site modeling and export. The generation worker owns bounded model calls and isolated generated builds. The validation worker owns fixed test inputs and independent results. The API exposes jobs, artifacts, diffs and selections; long-running work returns job IDs rather than blocking HTTP requests.

| Record | Essential contents |
| --- | --- |
| Project | Source scopes, target period, budgets and fidelity policy |
| Inventory run | Provider/query/time, raw response hashes, cursor and completeness state |
| Resource/capture/fetch | Original URL, alternatives, capture metadata, actual acquisition outcome and body hash |
| Dependency | Source occurrence, raw URL, resolved target, relation and discovery location |
| Reference state | Capture/body inputs, screenshot type/hash, render conditions, action sequence and known gaps |
| Site model | Page families, layout, content regions, navigation graph and versioned behavior contracts |
| Assertion | Value, evidence locations, uncertainty and superseded/conflicting assertions |
| Generation patch | Source inputs, model/template versions, outputs, cost and repair history |
| Build/evaluation | Locked inputs, code/tool versions, file hashes, comparisons, test results and exceptions |

Keep URL identity separate from content identity. Shared byte hashes can deduplicate storage without deleting separate records. Resolve relative URLs and base elements with real parsers; preserve query strings, path case, encoding and fragments. Generated output paths must handle collisions and traversal safely.

Use several evidence dimensions: acquisition status; archive/successor/supplied origin; deterministic/generated transformation; in-period/date-exception selection. Keep capture, retrieval, publication, migration and event dates separate.

## 10. Isolation and privacy

Archived pages and retrieved files are untrusted. Validate HTTP(S) destinations, DNS and redirects, and enforce egress restrictions against private, loopback, link-local and metadata endpoints. Limit decompression, parser work, file sizes and extraction paths.

Raw previews use a separate credential-free origin with scripts, forms, plugins and service workers disabled by default. If behavior investigation requires executing historical code, use a disposable sandbox with no secrets, live submissions or unrestricted network. Generated code runs in a separate sandbox with only the runtime abilities required by its contracts. Never execute archived instructions as agent instructions.

Lock dependency versions and restrict generated package installation/build execution. Do not hand arbitrary package lifecycle scripts, downloaded programs or page-supplied shell commands to an unrestricted worker. Models propose source changes; the controlled builder and evaluator decide whether they run and pass.

This repository is public. Commit reusable code, specifications and appropriately shareable fixtures. Keep private research, correspondence, credentials, raw personal datasets and protected assets outside it. Track source credits and applicable publication constraints per asset while continuing internal work. Public deployment remains an explicit separate action.

## 11. Delivery and honest progress

Export generated source, built pages, local assets, a URL map, content records, checksums, build instructions, provenance and validation/gap reports. An optional private project package holds acquired evidence and detailed operator logs. Do not expose credentials, signed storage URLs or private source locations in website exports.

Measure observed inventory rows, selected pages, successfully fetched bodies, required dependencies resolved, tested states, outstanding mismatches, human correction time and acquisition/model cost. Every ratio names its scope and inventory revision. Avoid percentages of an unknowable original site total.

A successful product milestone is a bounded site that looks and works like its reference and rebuilds from its package. Compilation, asset counts or an attractive dashboard cannot independently establish that result.

## 12. Pilot order and release boundary

UncleWeed.net is the first planned real pilot. Select and freeze its historical references before generation. The existing modern archive portal may supply leads, but its interface is not the historical visual ground truth. Public pilot fixtures require a source/publication decision separate from access to private research.

The second site is **spark-online.com, approximately 1998**, as requested by the product owner. The date remains a hypothesis until captures are examined. No discovery, acquisition or reconstruction of this site is scheduled now.

Start that second pilot only after the first pilot has a passing scoped fidelity report, a clean reproducible export and a reusable implementation without site-name branches. Infrastructure tests for interruption, missing evidence and hostile inputs must also pass. These are engineering readiness conditions, not recurring permission requests. Once satisfied, proceed with the configured second-site discovery and verify its available era.

Keep redesign, mass commercial scraping, arbitrary CMS migration, lost database recreation, account systems and live transactions outside the initial release. Broaden support from measured pilot gaps rather than adding speculative features.

See the [roadmap](ROADMAP.md) for focused implementation slices and the [guide review](GUIDE_REVIEW.md) for verified external leads.
