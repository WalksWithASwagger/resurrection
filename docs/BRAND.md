# Brand recovery: the Spark Online pass

On 2026-11-23 Resurrection's second pilot, Spark Online (issues 1.0 to 27.0, October 1999 to December 2001), got a pass that the build loop does not have yet: recovering the site's *visual identity* as a reusable specification, not only its pages. This note records how that pass was done, what it found and which parts should become engine capabilities. The outputs themselves (photographs, logo files, screenshots and the brand book) are not published with this repository.

## What was recovered

| Item | Count | Notes |
| --- | --- | --- |
| Cover pages (splash) | 27 of 27 | Screenshots of every issue's landing page, taken from the paths listed on Spark's own `masthead/archives.html`. |
| Contents pages | 18 of 18 | Issues 1.0 to 18.0. From issue 19.0 the cover and the contents are one page. |
| Original cover photographs | 27 of 27 | Recovered at native size, not cropped from screenshots, except issue 7.0 (see below). |
| Logo files | 3 GIFs | The October 1999 plug mark, the March 2000 and April 2000 variants, and the barcode date strip. |
| Section headers and contents art | 7 GIFs | Era III `tt_` section titles and the right-hand contents art for 19.0 and 23.0. |

## Method

1. **Find the issue list from the site, not from the CDX index.** Spark's archives page links every cover. Its filenames are irregular (`index_old_october.htm`, `nov_index.htm`, `feb00_index.html`, then `issue19/` to `issue27/`), so guessing paths would have missed most of them.
2. **Use the capture modes on purpose.** `if_` gives a rewritten page without the Wayback toolbar, which is right for screenshots. `id_` returns the original bytes, and `im_` serves images. Screenshots and byte recovery need different modes.
3. **Expect empty pages under throttling.** For issues 15.0 to 27.0 the archive returned empty HTML during the run. The pages used stable asset names (`images/splash_index.jpg`, `images/feature_contents.jpg`), so the photographs were fetched by known path while the HTML retried later.
4. **Fall back to the CDX index for single assets.** Issue 1.0's photo came from a 2001-06-22 capture and issue 18.0's from a 2006 GIF capture. Neither was in the capture nearest the issue date.
5. **Accept sliced images as a known gap.** Issue 7.0's cover was served as table-cell slices. It was rebuilt from the page screenshot and is marked as such.
6. **Catalogue each photograph.** For each of the 27 photographs, record its subject, lighting, colour cast, any text on the image, black and white clipping, and the page colour ("field") Spark chose. This catalogue is what turns screenshots into a specification that a person or an agent can use.

## Findings

- **Three eras.** Era I (1.0 to 7.0) is a dark room on black. Era II (8.0 to 18.0) puts the photo on a field of solid colour, and from 11.0 the contents page is a monochrome of that field. Era III (19.0 to 27.0) is an 850px magazine cover that is also the contents page.
- **The field was chosen by eye.** The rule that matched Spark's own choices best (black for a dark room, else the strongest saturated colour, snapped to the web-safe palette) matched only 14 of 27 issues. Automatic sampling is a suggestion for an editor, not a rule. When rebuilding the archive, use the recorded field, not a sampled one.
- **In Eras I and II the wordmark is part of the photograph.** A rebuild must not lay HTML type over those images, or the name appears twice.
- **Some original colour pairs fail today's contrast checks.** The white headline is under 3:1 on four Era III blocks, and some tag and byline colours fall to between 2:1 and 3.5:1. Faithful rebuilds keep them; new work does not copy them.
- **The vector trace needs a human pass.** Traced on the GIF's 154 × 50 grid, the plug mark matched 96.2% of pixels, yet it copied a flaw. The spark's left arm sits a few degrees off the cord line, and a human reviewer corrected it: the arm continues the cord. A pixel match against the source is evidence, not approval.

## What became of it

The pass produced a brand book, a design system and a prototype issue. They, and the recovered source files, are not published with this repository.

## Engine capabilities this suggests

These are candidates for the roadmap, not commitments. Each should arrive as a general capability with fixtures, per the M5 rule against Spark-specific forks.

1. **Issue discovery from a site's own index pages**, alongside CDX discovery.
2. **Native-size asset recovery**, preferring the original image bytes over screenshot crops, with the capture-mode choice recorded in evidence.
3. **A palette and field extractor** that records the page colour a site actually used next to the colour a sampler proposes, so the gap stays visible.
4. **An identity catalogue** written as structured data (photo metrics, palettes, type, marks) that the generation loop and its evaluator can read.
5. **Contrast reporting** on recovered colour pairs, so faithful rebuilds and modern extensions can make different, deliberate choices.
