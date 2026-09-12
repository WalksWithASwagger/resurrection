# AI Wayback guide: source check

Checked 6 September 2026. Scope: technical claims relevant to Resurrection, not a comprehensive review of the publisher, its examples or its legal/marketing advice. No commands from the guide were executed.

**Verdict:** useful discovery lead, with errors and overstatements that make it unsuitable as an implementation specification.

The [AI Wayback guide](https://aiwayback.com/guide/) proposes finding captures, retrieving source and assets, and using an AI agent to reconstruct pages. That workflow is relevant to Resurrection. Its modernization emphasis does not define our fidelity target, and its example recovery speed is an unverified anecdote.

| Guide point | Verification and consequence |
| --- | --- |
| A downloader `--timestamp` option | The inspected upstream option parser supports date bounds and all-timestamps mode, but does not declare that flag. Use supported options and test the pinned version. An individual exact capture needs an explicit request and verification of the resolved timestamp. [Upstream CLI source](https://github.com/hartator/wayback-machine-downloader/blob/master/bin/wayback_machine_downloader) |
| Broad raw-file guarantees using replay modifiers | pywb distinguishes identity retrieval from the image hint, which can still defer to rewriting decisions based on content type. Original headers are not guaranteed. This is first-party pywb documentation, not proof of universal Wayback behavior; write adapter tests against actual responses. [Rewriter documentation](https://pywb.readthedocs.io/en/latest/manual/rewriter.html) |
| A short CDX sample as a reconstruction starting point | The sample is useful reconnaissance. CDX defaults to exact URL scope; result limits and collapse affect coverage. It does not establish a complete domain inventory or the best full-page dependency set. Retain explicit scope, continuation and raw responses. [CDX documentation](https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md) |
| Archive URLs as final image dependencies | This leaves the rebuilt page dependent on a remote archive. Resurrection should retrieve, validate and store acquired assets locally, then prove that the export works without archive calls. This is a portability requirement derived from our product goal. |
| Broad claims that dynamic material is absent | Distinguish unavailable original server logic from surviving captured outputs. Inspect indexed URLs and responses before classifying a page or state as missing. Internet Archive documents difficulties with origin-dependent behavior, not evidence about every URL in a particular collection. [Archive limitations](https://help.archive.org/help/using-the-wayback-machine/) |
| A universal current robots.txt rule | Internet Archive has documented changes and collection-specific handling over time. A historical policy discussion cannot establish today's behavior for every capture. Preserve restriction/error evidence and do not encode the guide's blanket rule or attempt to bypass exclusions. [Internet Archive policy discussion](https://blog.archive.org/2017/04/17/robots-txt-meant-for-search-engines-dont-work-well-for-web-archives/) |

The decisive addition is an independent evaluation loop. Retrieval and plausible code generation do not establish visual or behavioral equivalence. Freeze reference states and run screenshot, navigation, content and file checks before declaring a reconstruction faithful. [Playwright visual comparison guidance](https://playwright.dev/docs/test-snapshots)

The replay-modifier and CDX-scope points above are now pinned behaviour rather than open questions: the query shape, the `id_`/`if_` choice, the defensive strip and the capture selection policy are specified in [bounded acquisition](ACQUISITION.md) and held in place by fixtures (issue #7).

Adopt the useful acquisition leads, verify provider behavior, and build the generation process around evidence and tests. Hosting, SEO, rights assurances and speed claims from the guide are not product guarantees. Current provider capacity and a live end-to-end run remain untested.
