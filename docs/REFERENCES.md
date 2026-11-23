# Reference bundles

A reference state is what a recovered page looks like when its archived bytes
are rendered under pinned conditions
([SPEC section 8](SPEC.md#8-fidelity-and-usability-evaluation)). A reference
bundle is a set of those states, frozen by a digest. It is what a generated
page will be compared against.

Only the initial state of a page is captured. Interactive states (hover,
click, playback) are not implemented.

## What a reference is and is not

Every state in a bundle has kind `archive-render`: a new render of archived
bytes in a current browser. It is not a screenshot from the period and makes
no claim about how a browser of the period drew the page.

## Commands

```bash
node src/cli.ts reference --manifest <collection.json> --output <dir>
node src/cli.ts reference-verify --bundle <dir>
node src/cli.ts reference-signoff --bundle <dir> --by <name> --note <text>
```

`reference` also accepts `--job <dir>`, `--pages representatives|all`
(default: one page per family) and `--viewport <width>x<height>` (default
`1024x768`).

## Render conditions

| Condition | Value |
| --- | --- |
| Browser | Chromium, the build `playwright-core` is pinned to; its version is recorded |
| Viewport | 1024 x 768 unless overridden, device scale factor 1 |
| Locale, timezone | `en-US`, `UTC` |
| Color scheme, motion | light, reduced |
| Page scripts | off |
| Service workers | blocked |
| Capture | full page, CSS animations disabled, caret hidden |

The viewport is a chosen comparison size. It is not a claim about the size
visitors used. Fonts come from the machine that renders, and the platform is
recorded, so a bundle rendered on another operating system is a different
bundle.

## No network

Every request a page makes is intercepted and answered from the collection.

| Disposition | Meaning |
| --- | --- |
| `served` | The collection holds a body for the URL. Its hash is recorded. |
| `missing` | The URL is on a site host and the collection has no body. The request is aborted. |
| `blocked-external` | The URL is not on a site host. The request is aborted and never fetched. |

An HTML page whose recorded content type has no charset is served with the
encoding the engine's decoder chose for it, normally the era default
windows-1252. Without it, Chromium guesses from the bytes and can read a
short Western page as Central European, turning a copyright sign into `Š`.

Page scripts are off because archived code is untrusted. A behavior that
depended on a script is therefore absent from the reference. The site model
lists such markup as static evidence.

## What a state records

- The screenshot, with its SHA-256, and whether a second capture matched it.
  A page with an animated image can be unstable; the state says so.
- Document size, title, and the length and hash of the rendered text.
- Anchors: the position and size, in whole CSS pixels, of every image,
  heading, link, form, rule and frame, capped at 1,500 per page. Layout
  containers such as tables are not anchors: a rebuilt page may use different
  containers, and their effect shows in the positions of the content.
- Every request and its disposition.

## Freezing

The bundle digest is a SHA-256 over the conditions and every state.
`reference-verify` re-derives each screenshot hash and the digest from disk.

A bundle is frozen when it verifies and `signoff.json` names its digest. The
sign-off is a human record: who approved, when, and a note. Changing a
screenshot, an anchor or a condition changes the digest, so the sign-off
stops applying. Nothing can edit a golden image and keep the approval.

## Limits

- One browser engine. No comparison against a historical browser.
- Initial state only. No hover, focus, click or playback states.
- Frames render as their frameset page; inner frame documents are not
  captured as separate states unless they are pages in the model.
- Bundles hold screenshots of recovered pages. Keep them with the private
  collection, outside this repository.
