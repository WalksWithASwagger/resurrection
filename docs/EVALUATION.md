# Evaluation

The evaluator renders a built candidate site under a reference bundle's own
conditions and compares the two
([SPEC section 8](SPEC.md#8-fidelity-and-usability-evaluation)). It is
independent of whatever produced the candidate: it owns the thresholds, and it
reads golden images only from a [reference bundle](REFERENCES.md) it has first
verified.

## Command

```bash
node src/cli.ts evaluate --bundle <dir> --candidate <dir> --output <dir>
```

It writes `evaluation.json` and a difference image for every state where a
pixel differed. It exits 0 only when every state passes. It opens no socket.

## A candidate

```text
<candidate>/site/...        built pages and local assets
<candidate>/url-map.json    which original URL each file stands for
```

```json
{ "schemaVersion": 1, "entries": [ { "originalUrl": "http://www.example.invalid/a.html", "path": "a.html" } ] }
```

A candidate is served from its own files under the reserved origin
`http://candidate.invalid`. A request for anything else is refused and counted
against it. Candidate scripts run, because generated code is part of what is
judged; the render has no network to reach.

## What it refuses to do

- Evaluate against a bundle that does not verify.
- Evaluate against a bundle with no sign-off, unless
  `--allow-unfrozen-reference` is given. The verdict is then
  `pass-against-unfrozen-reference`, which verifies nothing.
- Evaluate when the browser, platform or viewport differ from the bundle's
  recorded conditions.

## Checks, per state

| Check | Passes when |
| --- | --- |
| `route` | The URL map has an entry for the page. |
| `title` | The rendered title equals the reference title. |
| `text` | The rendered text hash equals the reference text hash. |
| `visual` | The screenshots have the same size and at most 1% of pixels differ at a per-pixel threshold of 0.1. |
| `geometry` | Every reference anchor (image, heading, link, form, rule, frame) exists and its position and size are within 2 CSS pixels; no unexpected anchor appears. |
| `links` | Every reference link leads to the same place, fragment included. |
| `runtime` | Every request was served from the candidate's files and no script error was raised. |

The thresholds are the initial criteria from the specification. They have not
been calibrated on a pilot, so a pass is a pass against these values, not a
verified fidelity claim.

### Links to unrecovered pages

A reference link whose target was never recovered is a gap. The candidate may
send it to a local path that is not in the URL map, such as a gap notice. It
may not send it to a different recovered page. The report counts these links
separately.

### Script links

A reference link with a `javascript:` target is script behavior, which no
reference state covers. It is counted and not compared.

### Pixel comparison

Two pixels differ when their YIQ colour distance exceeds the threshold. Area
present in only one image counts as differing. No anti-aliasing allowance is
applied. The difference image shows the reference faded to grey with
differing pixels in red.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `pass` | Every state passed against a signed-off bundle. |
| `pass-against-unfrozen-reference` | Every state passed, but the bundle has no sign-off. |
| `fail` | At least one check failed, or the bundle holds no state. |

A pass covers the states in the bundle under its recorded conditions. It says
nothing about pages or states the bundle does not contain.

## Limits

- Initial state only. Interaction, history and download behavior are not
  checked.
- Typography is checked through pixels, geometry and text, not by inspecting
  computed fonts.
- A reference state that was not stable (an animated image) can produce pixel
  differences that are animation. The report says when a capture was not
  stable.
