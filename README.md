# Resurrection

**Bring a dead website back with modern code and its original character intact.**

Give Resurrection an old URL and an approximate period. It will discover surviving captures, retrieve pages and files, understand the site's layout and interactions, generate a working implementation, and compare the result with the historical evidence.

The target is the same visible site and visitor experience, implemented with maintainable current technology. Original typography, navigation, graphics, page structure and interaction details are product requirements.

## Current status

Early implementation. The bounded acquisition core, its CLI and its evidence report exist and run against local fixtures; see [bounded acquisition](docs/ACQUISITION.md). The site model, AI generation loop and browser tests have not been implemented, no live archive acquisition has been performed, and no pilot is marked complete.

Start with the [product and engineering specification](docs/SPEC.md), then the [implementation sequence](docs/ROADMAP.md). The [AI Wayback guide review](docs/GUIDE_REVIEW.md) checks the external breadcrumb against primary documentation. [Pilot declarations](benchmarks/pilots.json) record the test order and readiness conditions; they are planning data, not an executable scheduler.

## The build loop

1. Discover and acquire the surviving evidence.
2. Model the site's pages, assets, layout and behavior.
3. Generate a modern implementation against that model.
4. Compare screenshots, interactions, content and downloaded files.
5. Repair discrepancies and export the working source and website.

Every recovered item retains a source reference. Missing evidence stays visible. Generated code must earn a pass through independent tests.

## Pilots

| Order | Site | Status |
| --- | --- | --- |
| 1 | UncleWeed.net | First planned recovery and fidelity pilot; historical capture selection remains to be frozen. |
| 2 | spark-online.com, approximately 1998 | Deferred until the first pilot passes the readiness conditions. The requested year is a research starting point, not a verified site date. |

Resurrection should export an ordinary runnable project without depending on a Wayback iframe, a particular hosting account or live archive asset URLs. Existing private source collections remain outside this public repository.
