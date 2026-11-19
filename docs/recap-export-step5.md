# Recap export Step 5

## Gap check before implementation

| Criterion | Existing Step 3 behavior | Step 5 change |
| --- | --- | --- |
| `/recap/:id` opens the saved manga without studio chrome, using only its URL | Already implemented in main.tsx, Recap.tsx and the persisted `/api/recaps/:id` snapshot; `/r/:id` is a compatibility route | No route or saved-recap implementation change. Added a fresh-browser regression after clearing the live studio. |
| Per-page PNG downloads and full saved-issue PNG | Already supplied by server Playwright rendering, via pageUrls/shareUrl | Retained. These do not satisfy the browser-generation criterion. |
| `/studio` click produces `comictoons-recap-<id>.png`, greater than 50KB, in the client browser | Missing: End stream saved on the server then navigated to the recap; existing downloads used server filenames | Added the explicit Download recap PNG button and local SVG/canvas renderer. |

## Implementation

`apps/web/src/lib/recapPng.tsx` snapshots only approved panels. It reuses MangaPage/ComicPanel and their shared layout policy, so long dialogue still expands into continuation pages. It embeds vetted same-origin artwork, measures the complete issue in a sandboxed offscreen document with its own reset and page CSS, and freezes resolved styles through `pngSheet.ts`. No studio stylesheet is inherited. The self-contained SVG is drawn into a browser canvas and encoded through canvas.toBlob. The button triggers a Blob URL download without calling `/api/end`, `/exports` or any server PNG renderer. This module loads only when the button is used.

Sentinel found that the first implementation's SVG laid out differently from its measurement DOM and fell back to a wide font. The correction explicitly loads and verifies Barlow Condensed700/700italic and DM Sans400 FontFaces in the measurement document and the native canvas renderer. Each visible text leaf is rasterized at2x using DOM line positions and the loaded face, then included as a transparent bitmap background in the frozen sheet. SVG composition therefore does not depend on SVG web-font loading. Letter spacing, direction, uppercase transformation, wrapping, strokes and simple text shadows are carried into the native glyph render. Original lettering boxes and balloon tails remain shared HTML/CSS geometry. Both ink and Festival exports use the corrected path.

The filename is exactly `comictoons-recap-<id>.png`, where `<id>` is the persisted recap ID served by `/recap/:id`. Before rendering, the studio calls `POST /api/recaps` to persist the approved snapshot and uses that returned snapshot for the PNG. This endpoint writes metadata only; it does not launch Chromium or create server PNGs. A failed save prevents the download and retains approved panels.

Generated IDs are32hexadecimal story-identity characters, without an additional `recap-` prefix. Thus a new filename is exactly `comictoons-recap-0123456789abcdef0123456789abcdef.png`, with `/recap/0123456789abcdef0123456789abcdef` as its URL. Older generated `recap-<hash>` IDs remain read aliases; the store can recover their JSON without deleting or rewriting old export directories and returns the canonical bare ID for subsequent saves/downloads. An existing saved address is retained when it belongs to the same story.

Both metadata save and end-stream export return the canonical `/recap/<id>` address in their API responses, studio state and persisted JSON. Cold reads and cached reads normalize older `/r/<id>` metadata to that prefix. The `/r/<id>` browser alias remains readable for existing links, while new navigation uses `/recap/<id>` consistently. RID-URL checks disk/cache normalization; EX-ROUTE checks both API paths, current/saved state and the standalone legacy alias. Mouse and keyboard end-stream flows assert canonical navigation.

Spec's caption-edit ruling is implemented: lettering, title and palette edits are revisions of the same story, so they keep the recap ID and PNG filename. Curated stories use their fixture identity; live chat uses its existing immutable IRC-session panel-id prefix. Other legacy sources use immutable source frame IDs. A different sample story or live session gets a different ID. Queue contents, clocks and approval-mode flags do not define identity. Existing saved addresses are reused only for the same story; records from a different story cannot take over that address.

The separate full-content signature still fences stale studio-state updates. Per Spec's O2-OBS1 ruling, the first saved story at an id is retained: later approval, caption or palette changes return the existing saved version without rewriting recap.json. In-flight requests for that story serialize, and restart reads recover that same version. Edits made before the first save are included. End-stream rendering may add export URLs/status to the first approved snapshot; reapproval does not replace its content or clear those URLs. Persistence uses a temporary file and atomic rename, and unapproved queue content is excluded.

The local download includes all issue pages in one composite; existing saved per-page downloads remain available after end-stream export. The output width is1080px. A16384px height guard rejects issues beyond the supported composite size instead of silently cropping them, pointing to saved per-page downloads.

The offscreen document and temporary FontFaces are removed in finally, approved state is never mutated, and temporary Blob URLs are revoked after the download starts. Missing images/fonts fail visibly and release the button for retry. Duplicate clicks are fenced while generation is active. React escapes all text; the isolated frame permits no scripts. Labels preserve Sample Data or the appropriate live-source provenance. No new dependencies or lockfile changes.

## Regression evidence

- EX-PNG: actual browser download, exact filename tied to an already-readable persisted recap, repeat-click/reload filename equality, PNG signature, greater than50KB, width1080, full content height, substantial nonblank raster content, native canvas invocation and zero server PNG/end requests. Both20px raster margins must have less than1% dark pixels. Actual title ink width must match native Barlow within4px and differ from the fallback sans by more than30px. Glyph-paint calls verify loaded display faces also render balloon/SFX text. An observer proves each measurement frame was added and removed. Approved content stays unchanged. Export control fits1280px and390px without horizontal overflow.
- EX-ROUTE: `/recap/:id` loads six saved scene frames in a fresh context with no storage or `/api/state` access after panic-clearing the studio; no studio chrome. Existing per-page downloads remain. A local download using that saved ID has the exact expected filename.
- EX-CONTINUATION: edited long Unicode/untrusted text yields a composite over1800px high with continuation pages; text is not executed. Live preview and the exact frozen HTML supplied to SVG must have complete visual rows, with only the intended gutters between frames. The downloaded PNG must show a dark panel border at the right edge of every row.
- EX-ERROR: an unavailable artwork returns a visible error, produces no download, preserves approval state and releases the control.
- EX-PERSIST-ERROR: failed metadata save produces a visible error and no PNG, retaining approvals.
- EX-BUSY: a component contract probe supplies the hook's undefined mutation result, proving the download displays an announced retry message, produces no file and restores the button without changing approved panels. It uses a test-only controller fixture served by Vite, with no production test switch or timing race.
- EX-CAPTION: real undo-approval, caption edit and reapproval retain the first saved recap JSON, actual PNG bytes and stable filename/id. The studio draft still displays the later edit while the standalone URL displays the first saved caption. Both files exceed50KB and retain Sample Data.
- RID-STABLE / RID-EDITION / RID-CAPTION / RID-FIRST-SAVE / RID-API: concurrent and cold saves, JSON-only persistence, stable story identity, first-save byte/content retention after reapproval, distinct sample/live sessions, and preserved export metadata. Empty issues remain refused. Export browser scenarios use separate local app instances and temporary recap directories so immutable stories from another test cannot determine the palette/caption under test; existing exports are never deleted.

Evidence lives in `artifacts/recap-export/`: the actual PNG, continuation.png, png-proof.json, studio-1280.jpg and browser-png.jpg. Two JPEGs were opened for visual review: manga scenes, in-panel balloons/chat and provenance are present. The JPEG shows a viewport crop; the downloadable PNG contains the full measured issue. Native command logs, source hashes and final gate result live in `artifacts/tmp/recap-export/`.

The first narrow typecheck exposed a JSX xmlns property and a browser-test element type; both were corrected before browser checks. No browser assertion was relaxed. No server export/recap behavior was replaced.

API reference: [HTMLCanvasElement.toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob).

## First-saved navigation and caption divergence (O-A / O-B)

The Studio keeps a navigation target for the saved issue independently of the
current approval/caption state. A revised approval or save returns the original
saved record and retains its canonical link. Browser reload, replay and off-air
state do not hide the latest saved issue. The preloaded Sample Data snapshot
carries the same read-only metadata, including while its source POST is held.
If the browser's cached sample predates saving, its immediate fallback view
retains the current saved URL. A divergence flag from a different saved target
is discarded until the source response supplies fresh state.
On server startup the local library's
most recently modified readable recap supplies that link; this recovery reads
metadata and never saves or changes a recap. Legacy directory names use their
canonical local recap URL. Export metadata is still fenced by the content
signature; discovering a saved navigation target does not require caption equality.

When approved on-air panel captions differ from the saved panel captions, a
visible status notice says exactly **Saved issue differs from on-air caption**
and supplies **Open saved issue**. A pending edit alone does not change the on-air
caption. The notice reads server state; it never submits a save. With no approved
on-air panels, the divergence notice is absent while the saved-issue link stays.

REC-O-A covers revision, an explicit re-save, reload, panic hide and a cached
Sample Data switch with its POST held, asserting
the first saved target remains visible and opens the original issue. REC-O-B
revises without re-saving, checks the exact notice/link and current on-air text,
waits for multiple state polls and asserts zero browser save requests and an
unchanged saved record. RID-STUDIO-NAV checks canonical state metadata and byte
retention through a cold application start. The two browser regressions failed
against the earlier behavior before this change.

Visual review of artifacts/recap-observations/divergence-1280.jpg and
divergence-390.jpg confirms a readable lavender status banner and underlined
saved-issue link near the page heading. The notice wraps on mobile, does not
obstruct controls and causes no horizontal overflow. Serious/critical axe
findings are checked at both sizes. Existing on-air and first-save behavior stays
covered by the full export suite. No INGEST source or chaos test is part of this
Step5 follow-up.

## Continuation layout correction and handover

Dense dialogue frames remain full width. Neighbouring frames are paired chronologically and their preferred widths are balanced to fill each row; a lone frame expands to fill its row. A page holds at most three complete rows, with excess frames continuing onto the next page. The standard six-shot layout keeps its existing widths. This shared policy drives React, server HTML/per-page exports and browser PNGs; no filler panels, dropped comments or reordered scenes are introduced.

STORY-ROWS checks 1,152 combinations of frame counts and dense-frame positions, with exact order/content preservation and full row coverage. STORY-CONTINUATION also measures the server document's real row geometry. Raster/geometry proof is saved in artifacts/recap-export/continuation-rows.json; server geometry in artifacts/manga-story/continuation-rows.json.

Known issue F2 remains open: mixed Arabic/Latin continuation lettering can split words across frames and show reordered/clipped glyphs, as reported by Sentinel. Automatic direction is already set on both React and server balloons; resolving this also needs word-aware segmentation and mixed-direction glyph-placement review. It is not a small direction-attribute correction, so it is deliberately deferred under the manager's non-blocking ruling. Unicode text is retained and escaped; no claim of correct Arabic typesetting is made. The manager should carry this limitation into the canonical handover.
