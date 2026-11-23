# Resurrection

**Bring a dead website back with modern code and its original character intact.**

Give Resurrection an old URL and an approximate period. It will discover surviving captures, retrieve pages and files, understand the site's layout and interactions, generate a working implementation, and compare the result with the historical evidence.

The target is the same visible site and visitor experience, implemented with maintainable current technology. Original typography, navigation, graphics, page structure and interaction details are product requirements.

## Current status

Early implementation. The bounded acquisition core, its CLI, its typed [outcome classification](docs/OUTCOMES.md), its [graded fidelity score](docs/FIDELITY.md) and its evidence report exist and run against local fixtures; see [bounded acquisition](docs/ACQUISITION.md). On 2026-11-19 the first bounded Wayback run recovered the UncleWeed homepage, Words and Paint from the same day in 2005. The static [site model](docs/SITE-MODEL.md) (pages, page families, assets, navigation and gaps) builds from stored bodies. [Reference bundles](docs/REFERENCES.md) render recovered pages in pinned Chromium with no network and freeze the result by digest. The [evaluator](docs/EVALUATION.md) compares a built candidate with a signed-off bundle. A [transcribing generator](docs/GENERATION.md) builds a portable candidate with no model call; for the September 2000 Spark issue all 37 pages pass the evaluator against an unsigned bundle. A model-backed loop can rewrite pages in current HTML and CSS, keeping a rewrite only when it passes; it has run only against a scripted provider and no live model call has been made. On 2026-11-23 the owner made Spark Online the first site for that work.

Start with the [product and engineering specification](docs/SPEC.md), then the [implementation sequence](docs/ROADMAP.md). The [original product brief](docs/PRD.md) is preserved for provenance and marks what it asked for that this repository does not do. The [AI Wayback guide review](docs/GUIDE_REVIEW.md) checks the external breadcrumb against primary documentation. [Pilot declarations](benchmarks/pilots.json) record the test order and readiness conditions; they are planning data, not an executable scheduler.

## The build loop

1. Discover and acquire the surviving evidence.
2. Model the site's pages, assets, layout and behavior.
3. Generate a modern implementation against that model.
4. Compare screenshots, interactions, content and downloaded files.
5. Repair discrepancies and export the working source and website.

Every recovered item retains a source reference. Missing evidence stays visible. Generated code must earn a pass through independent tests.

## Requirements

- Node.js 22.18 or later. The package runs its TypeScript sources directly, with no build step, and relies on the type stripping that Node enables by default from 22.18.
- pnpm 10.
- Optional, for `reference`, `evaluate` and the browser tests: a Chromium build for `playwright-core` (`pnpm exec playwright-core install chromium`). Without it those tests are skipped, not failed.
- Optional, only for `modernize`: an Anthropic API key in `ANTHROPIC_API_KEY`. The SDK reads it from the environment; Resurrection never reads or prints it.

## Quick start

Everything below runs offline against synthetic fixtures. Nothing contacts the Wayback Machine.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run acquire:fixture
pnpm run reclassify:fixture
```

`acquire:fixture` replays `fixtures/demo-site` and writes its evidence report to `tmp/demo-acquisition/`. Run `node src/cli.ts` with no arguments for every command: `acquire`, `report`, `reclassify`, `model`, `reference`, `reference-verify`, `reference-signoff`, `generate`, `evaluate`, `modernize`, `brief` and `submit`.

To recover a real site, copy `fixtures/demo-site/project.json`, set `scope` to the site and period you want, keep the budgets small, and then run:

```bash
node src/cli.ts acquire --config my-site.json --transport live --confirm-live-acquisition
```

## Live-run safety

- **Nothing goes live by accident.** Tests and the fixture scripts never open a network socket. A live acquisition needs both `--transport live` and `--confirm-live-acquisition`, and a paid model call needs `--confirm-model-spend`.
- **Budgets are hard limits.** Requests, index requests, bytes, elapsed time, pages, dependencies and retries are capped in the project file. Model runs are capped by pages, attempts and tokens. A run that reaches a cap stops with a partial report and can be resumed with `--resume`.
- **Archive only.** Requests go to the configured archive provider (by default `web.archive.org`), paced by `minRequestIntervalMs`. Resurrection never fetches a site's live origin. The destination guard refuses private, loopback, link-local and metadata addresses, embedded credentials and unexpected ports, including when an archived redirect points at them.
- **Archived content is untrusted data.** Recovered text, scripts and metadata are never treated as instructions. Historical code runs only in a sandboxed browser with scripts off and no network.
- **Recovered material stays local.** Jobs write to `tmp/`, which is gitignored. Keep collections, credentials and storage URLs out of commits, fixtures and issues.

## Rights

The MIT [licence](LICENSE) covers Resurrection's code and documentation. It grants nothing over the sites you recover. Archived pages, images, audio and text remain the work of their authors, so check that you have the right before you republish a recovered site. This repository publishes none of the recovered pilot material.

## Pilots

| Order | Site | Status |
| --- | --- | --- |
| 1 | www.spark-online.com, 1998–2001 | Seven consecutive issues, March to September 2000 (6.0 to 12.0), recovered with their articles, print versions and first-party images, and checked offline. Every surviving issue is in scope. |
| 2 | UncleWeed.net | The homepage, Words and Paint pages from December 2005, then 21 more pages and 13 original PDFs from dated captures, rendered offline. |

The pilot order changed on 2026-11-23; see the [implementation sequence](docs/ROADMAP.md). Coverage counts and known gaps are in the [pilot record](benchmarks/pilots.json).

Resurrection should export an ordinary runnable project without depending on a Wayback iframe, a particular hosting account or live archive asset URLs.

## License

[MIT](LICENSE).
