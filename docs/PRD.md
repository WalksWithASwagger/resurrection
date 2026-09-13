# PRD: Personal Agentic Scraper (origin document)

Status: historical. Not the current spec — see [SPEC.md](SPEC.md) for that.
Drafted 2026-09-06, saved here 2026-09-13.

## Provenance

This is the product brief that started this repository. Kris asked how to
build "the perfect modern agentic AI scraper in 2026" and sketched a PRD for a
general-purpose tool: fetch a page, live or archived, escalate through
fetch → headless → real browser only as needed, and return clean, offline-usable
content in one run.

That brief was broader than what `resurrection` became. Reading it now, split
it into two halves:

| Half | What it asks for | In this repo? |
| --- | --- | --- |
| Archive recovery | Wayback CDX discovery, raw-byte replay (`id_`/`if_`), toolbar stripping, offline-usable output, a confidence score | **Yes.** This is what M1 (#3, #4, #5, #6, #7, #8) built. |
| Live-page fetching | curl/fetch first, headless only if JS needed, a real browser with a persistent profile for Cloudflare-class challenges, unwrapping tracking URLs, rate-limiting a live target | **No, and not by accident.** |

The live-page half is excluded by design, not left undone. `agentic/contract.json`'s
`safety.no_live_origin_fetch` rule states it plainly: "This repository acquires
from archive providers only. Do not fetch the live origin of a pilot domain."
[SPEC.md](SPEC.md) narrowed the product to dead-URL recovery before any code
existed. Escalating to a real, cookie-carrying browser against a live site is
also a materially different trust boundary than replaying archived bytes, and
mixing the two into one tool was a mistake worth not making twice.

If the live-page scraper is still wanted, it is a different product and
belongs in a different repository — not an issue against this one. Nothing
below revives that half; it is preserved only so the original ambition is not
lost to an expired scratch file.

## Original draft, verbatim

### Goal

Lightweight agent that fetches pages (live or Wayback) and returns clean,
usable data/HTML with minimal human intervention.

### Core Capabilities

1. Input: URL or domain + optional date (for Wayback).
2. Escalation ladder:
   - curl/fetch first
   - Headless only if JS needed
   - Real browser + persistent profile for Cloudflare/challenges
3. Wayback support:
   - Use CDX for snapshots
   - Prefer `id_` / `if_` for raw original bytes
   - Strip archive toolbar/junk
4. Output:
   - Clean text or HTML
   - Local assets rewritten to relative paths
   - Optional modernized markup via LLM
5. Always unwrap tracking URLs first.
6. Rate-limit + cache results locally.
7. Verify extraction (confidence score + source URL).

### Constraints (personal use only)

- Respect robots.txt and terms
- No CAPTCHA solving automation
- No paywall circumvention
- Desktop/local run preferred (not cloud IP)
- Serial requests with pauses

### Non-goals

- Full site rebuild as a production app
- Multi-user SaaS
- Aggressive parallel crawling

### Success

Given a dead 2000s site or blocked live page, the agent returns clean,
offline-usable content in one run with zero or one human click.

## What actually got built, mapped back to the brief

| Brief item | Resurrection equivalent |
| --- | --- |
| "Use CDX for snapshots" | [ACQUISITION.md](ACQUISITION.md), `src/cdx.ts` — pinned query shape, `collapse=digest`, pagination |
| "Prefer `id_`/`if_` for raw original bytes" | `src/wayback.ts` — `IDENTITY_MODIFIER`, `IFRAME_MODIFIER`, chosen per relation |
| "Strip archive toolbar/junk" | `src/toolbar.ts` — defensive stripper, proven a no-op on correct `id_` bytes |
| "Local assets rewritten to relative paths" | Per-asset resolution exists (`src/resolve-asset.ts`); the rewrite step itself is M3, not yet built |
| "Verify extraction (confidence score + source URL)" | [FIDELITY.md](FIDELITY.md) — a computed, deterministic composite; every field carries its source |
| "Rate-limit + cache results locally" | Content-addressed store, provider rate limiting, resumable jobs (M1 core) |
| Escalation ladder for **live** pages | Not built. Excluded — see Provenance above. |
| "Always unwrap tracking URLs first" | Not applicable here; archive URLs are not tracking-wrapped the way live search/social links are |
| "Optional modernized markup via LLM" | Not built. Would be M3's generation step, gated behind frozen references (M2) that do not exist yet |

The non-goals held better than the goals did: this repo never became a
multi-user SaaS or an aggressive parallel crawler, and it still respects
robots.txt-equivalent politeness through the archive provider's own rate
limits.
