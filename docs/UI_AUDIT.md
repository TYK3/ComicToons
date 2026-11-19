# UI overhaul: baseline and acceptance audit

## Reproduce

Baseline captured from the running React/Vite application at `http://127.0.0.1:4173` before frontend or art edits. The application was already React; the baseline problem is its implementation and design, not a missing framework. `node tests/capture-ui.mjs before` replayed tabletop-night at 60×, approved three panels, captured dashboard and transparent overlay, exported the issue, and captured recap. All nine saved files were opened with `view_image` before findings were recorded.

Capture required approved escalation because sandbox Chromium terminated with `shutdown: Operation not permitted`. After approval, the script completed successfully. This environment restriction is not an application failure. The requested pstack process is applied as reproduce → explicit criteria → justified change → recheck; the lead found no installed `pstack` executable.

| View | 1440 × 900 | 1920 × 1080 | 390 × 844 |
| --- | --- | --- | --- |
| Dashboard | [baseline](evidence/baseline-dashboard-1440x900.png) | [baseline](../artifacts/README.md) | [baseline](evidence/baseline-dashboard-390x844.png) |
| Overlay | [baseline](../artifacts/README.md) | [baseline](../artifacts/README.md) | [baseline](../artifacts/README.md) |
| Recap | [baseline](../artifacts/README.md) | [baseline](../artifacts/README.md) | [baseline](../artifacts/README.md) |

Viewport values describe the browser viewport; dashboard and recap screenshots use full-page capture, so their PNG heights can exceed the viewport.

## Evidence and changes justified by it

1. **Dashboard hierarchy — needs revision.** At 1440 the decorative heading occupies roughly the first 230px before useful comic content, while approval is below the preview and export is far down the right column. Supporting text is visibly tiny. Replace the promotional hero with concise stream status, readable controls, and a clearly prioritized queue.
2. **Mobile operation — needs revision.** At 390px the replay controls begin roughly 900px down the page, and the preview shows one panel while saying “3 panels on air.” Put essential controls early and make every panel reachable through a visible carousel or stacked layout. Do not hide story panels without an explicit navigation cue.
3. **Storytelling — needs revision.** Every baseline image shows the same explorer portrait and mountain scene, even when captions describe a familiar stealing a key or an impossible dice roll. Vary scene action, camera framing, composition, and bubble placement to express the event.
4. **Overlay — partially healthy.** Transparency and lower-right placement preserve the stream canvas. Desktop lettering is readable, but three miniature columns at 390px produce very small captions and squeezed bubbles. Preserve the desktop OBS canvas and provide deliberate narrow-screen preview reflow.
5. **Recap identity — needs revision.** The title is repeated immediately as the subtitle. Three identical equal-width portrait panels have no cover, featured moment, event metadata, or editorial rhythm. Use a true issue header, a featured composition, distinct panel sizes, and a useful transcript/download area.
6. **Accessibility — unverified baseline risk.** Small low-emphasis labels and microcopy present visible readability risks. Screenshots cannot prove measured contrast, keyboard order, focus containment, or announcement behavior. Run axe serious/critical checks, keyboard-only operation, reduced-motion, and zoom/reflow tests after changes.
7. **Interaction confidence — needs evidence.** Baseline supports bulk approval and hide, but has no per-panel editing/rejection, undo, or live speed change. Add these interactions with disabled/loading/error feedback and prove each through the actual UI.
8. **State quality — missing evidence.** These baseline captures are populated happy paths. Empty, pending/loading, server error, offline, editing, rejection/undo, and export states require deliberate screenshot and behavioral verification.

## Recheck policy

Owner acceptance is tracked in eight groups: (1) modular React/Vite, tokens, local OFL display/text fonts, minimum type sizes and focus; (2) complete component states, 120–200ms transitions, action variants and Radix interactions; (3) studio hierarchy, ink motion, queue A/E/R and undo, transport, reduced motion; (4) six genuinely different original CC0 compositions, HTML bubbles/SFX and no text in SVG; (5) magazine recap, featured moment, sticky share actions, standalone export, safe transparent OBS strip; (6) empty/loading/error/offline across routes plus 390/1920 reflow; (7) zero serious/critical axe findings, keyboard-only studio operation, live announcements; (8) meaningful new interaction e2e and full gate green.

Use the same fixture, approval state, three routes, and three viewports for `artifacts/ui-after/`. Run real UI actions and verify server state; API preparation can seed the fixture but must not substitute for testing the controls. Keep text as text and confirm overlay transparency after the overhaul. Axe results supplement rather than replace manual visual inspection and keyboard testing. Full accessibility compliance is outside the claim of this review.

The completed independent verdict and exact acceptance mapping are recorded below.

## Verification plan

| Acceptance | Evidence required before approval |
| --- | --- |
| 1. Foundations | Source inspection of modules/tokens/local font imports and licence files; browser text/focus inspection; no external font requests |
| 2. Components | Default, hover, active, focus, disabled, loading, tooltip and toast captures; real replay/copy actions; 120–200ms transition tokens |
| 3. Studio | Same-size before/after captures, keyboard A/E/R, editable caption saved server-side, rejection undo, live speed/approval toggle, panic hide, reduced-motion check |
| 4. Artwork | Six-scene contact sheet opened by reviewer; unique scene data and payload tests; text-free SVG tests; HTML bubbles/SFX inspected |
| 5. Recap and OBS | Cover/featured moment/grid, share actions and standalone export inspected; safe margins and transparent root regression |
| 6. States and reflow | Nine populated captures plus all three views × empty/loading/error/offline; no horizontal overflow at 390/1440/1920 |
| 7. Accessibility | Axe scans with zero serious/critical violations and saved findings; keyboard-only flow, dialog focus, polite panel announcements |
| 8. Gate | M1 export remains valid; new UI tests and existing contracts pass; lead runs and records complete `npm run gate` |

Initial execution: baseline capture and 13 unit/contract/state-model tests passed before browser integration. Final executed checks and additional export regressions are recorded below.

### Artwork recheck

The six-scene [contact sheet](../artifacts/README.md) was rendered from the actual SVG files and opened for independent review. Accepted: a wide vault approach, close familiar/key action, foreshortened dice throw, group celebration, mid-air platform leap, and kitchen pancake flip have different silhouettes, subject positions, actions, backgrounds, and palettes. This resolves the baseline repeated-portrait finding. The core tests verify six distinct payloads and alt texts, no SVG lettering/scripts/remote images, no baked SFX, and valid scene metadata. Final UI crop and bubble placement still require review in the populated routes.

## Final independent design review

A bounded read-only Luna reviewer rechecked the eight acceptance groups after implementation, inspecting the actual desktop dashboard and mobile recap JPEGs and the recorded axe findings. The reviewer requested visible headline spacing, readable mobile download text, and a cover sticker that fits its circle. All were fixed, followed by a passing browser run. The prior API/body compatibility and keyboard-focus defects were also reproduced and corrected rather than hidden by changed expectations.

| Owner criterion | Verdict and direct evidence |
| --- | --- |
| 1. React and foundations | Pass: separate Studio/Overlay/Recap/UI/ComicPanel components, API hook and types; CSS color/type/space/radius/shadow/motion tokens; local Barlow Condensed/DM Sans; runtime body14/label12 floor, visible focus and axe contrast checks. |
| 2. Components | Pass: five requested Radix primitives, Lucide, four button variants, 140/180ms transitions; default/hover/active/focus/disabled/loading/tooltip/copy captures and reduced-motion assertion. Export confirmation is carried into the recap instead of disappearing on navigation. Dependency licenses and audit are recorded in DEPENDENCIES.md. |
| 3. Studio | Pass: dominant readable comic strip, compact transport, panel arrival/highlight, on-air status, stacked queue, caption dialog, A/E/R, undo, live speed changes, approval switch and visible Panic hide. Keyboard-only browser flow passed. |
| 4. Original artwork | Pass: six different text-free compositions, scene-specific alt text, HTML speech and SFX; contact-sheet review and uniqueness/safety tests. No image generation was added after the cost-rule reset. |
| 5. Recap and OBS | Pass: cover, featured Moment of the Stream, page grid, sticky desktop/mobile actions; self-contained HTML, embedded fonts/license bundle and PNG export checked. Standalone/share layouts use actual approved-panel count. Transparent root and safe OBS inset preserved. |
| 6. States and reflow | Pass: nine populated view captures plus 24 empty/loading/error/offline cases at 390/1920; skeletons, retry/friendly copy, mobile stacking and bottom actions; no horizontal overflow at all requested sizes. |
| 7. Accessibility | Pass for tested scope: 11 populated/standalone plus24 state scans report zero serious/critical findings (zero violations overall after heading fixes); keyboard-only review/edit/undo/speed/toggle/hide/export and polite announcements verified. |
| 8. Verification | Five relevant Playwright specs passed together (57.7s). Narrow `npm run check` passed with15 tests; focused keyboard/export (4.3s) and populated/standalone/export (19.4s) follow-ups also passed. Full gate is explicitly left to the Manager under the updated Owner rules. |

### Before/after evidence

The original requested viewport is retained in each filename. New captures are JPEGs capped at1280px width and capture the viewport, per the later cost rules; the earlier before PNGs remain as historical evidence. Product share cards remain PNG exports, not UI screenshot captures.

| View | 1440 ×900 | 1920 ×1080 | 390 ×844 |
| --- | --- | --- | --- |
| Dashboard | [after](../artifacts/README.md) | [after](../artifacts/README.md) | [after](../artifacts/README.md) |
| Overlay | [after](../artifacts/README.md) | [after](../artifacts/README.md) | [after](../artifacts/README.md) |
| Recap | [after](../artifacts/README.md) | [after](../artifacts/README.md) | [after](../artifacts/README.md) |

Additional evidence: [standalone desktop](../artifacts/README.md), [standalone mobile](../artifacts/README.md), [share card](../artifacts/README.md), [populated axe report](../artifacts/README.md), [state axe report](../artifacts/README.md), and component/keyboard/state JPEGs under `artifacts/ui-after/states/`.

### Findings fixed during recheck

- Optional-body approval requests were rejected by the new schema: normalize absent bodies before validation, preserving the M1 API contract.
- Panic's visible label differed from its accessible name: include both visible Panic hide and explanatory hide text in the name.
- Busy approval toggle lost keyboard focus: keep it focusable with guarded aria-disabled state while its mutation is pending.
- Mobile download inherited cream text on lime (axe contrast1.07:1): explicitly use ink text; serious finding cleared.
- Headline lacked a space before its emphasis, and the sticker's type exceeded its circle: add real whitespace and resize/pad the sticker; fit has a DOM regression assertion.
- Missing route/loading headings produced moderate findings: add screen-reader headings; final axe reports are entirely clear.
- Export notification disappeared during navigation: carry the confirmation into the saved issue and assert the visible toast.
- Share-card artwork review caught a fixed four-panel label/empty grid slot on a three-panel issue: use actual count and fill remaining grid columns dynamically; add count and export-XSS regressions.

**Independent verdict: accepted for the local mock-data UI-overhaul scope.** Real OBS compositing over gameplay, live Twitch/OAuth, real AI moderation, a full assistive-technology audit and long-duration stability remain outside this review. Passing these checks is not a claim of complete WCAG conformance or a substitute for the Manager's full gate.

## Owner follow-up: generated art was disconnected (2026-10-27)
**Before:** all prior screens used the six procedural explorer SVGs; generated WebP assets existed on disk but were never selected by replay. The Owner was correct that the intended art improvement was absent.
**After:** default dev/demo replay uses LibraryProvider, caches small local asset URLs, and selects unique assets by manifest tags, mood and style. The inspector identifies AI-generated library art and its exact file/style. All three current samples x two styles get four unique images; speedrun/kitchen/raid matching has explicit assertions. The generated library is committed for fresh clones.

| Before | After | Why |
|---|---|---|
| Explorer SVG in every view | Actual generated WebP in studio/overlay/recap | The comic is the product and must be visible |
| Old familiar/key captions on streamer art | Scene-aligned story captions and HTML SFX | Avoid misleading visual storytelling |
| No source information | Discreet expandable provenance below each panel | Honest generated-art attribution without covering faces |
| Export only accepted data art | Allow-listed local WebP inlined into both export layouts | Standalone export and share PNG keep the same art offline |
| README sent Owner to a stale branch | Exact branch/install/dev steps at top; dashboard opens | Reproducible route to the shipped interface |

Narrow validation: npm run check19pass; M1 and populated/standalone accessibility specs2 pass (31.7s); final refreshed capture rerun after caption corrections. All eleven populated/standalone axe cases had zero violations. Independent Luna review confirmed library selection excludes repeats and export uses generated WebP; flagged semantic weakness addressed through caption/SFX alignment. Lead viewed dashboard1440 and mobile recap, then standalone/overlay separately.
Evidence: refreshed artifacts/ui-after/dashboard-*.jpg, overlay-*.jpg, recap-*.jpg, standalone-*.jpg and the actual share-card.png. JPEG widths<=1280; product PNG retained at export resolution. Existing state/component captures outside this unit are historical and are not represented as new review evidence.
Limit: generated library has finite authored subjects. Matching chooses the closest available scene rather than claiming a new bespoke generation; the inspector exposes actual style. Live remote image generation and broader pipeline work remain separate milestones.

Final generated-art capture check: populated/standalone accessibility spec PASS (19.3s test,20.8s overall), eleven axe cases with zero violations. JPEG studio/overlay/recap at 1440/1920/390 and standalone at 1440/390 refreshed after caption correction.

## Protected-art lettering review — accepted(2026-10-27)
Manager approved a new rail approach after the earlier three-failure stop. All 16 assets were visually inspected and annotated; docs/LETTERING_MAPS.md contains coordinates and the per-image derivation. All image zones are protected, so no text fit is guessed.

| Before | After | Why |
|---|---|---|
| Independent absolute bubbles and SFX clipped/collided and covered faces | All dialogue/SFX/numbers/timestamps/captions in an expanding external rail | No lettering can cover any image region |
| Portrait/variant frames cropped landscape subjects | Full16:9 source and matching frame in every output | Faces, companions and main props stay visible |
| Dialogue used only first line; export shortened it | Every dialogue line renders fully, with dir=auto and wrapping | English/RTL/emoji remain intact |
| Fixed-height share screenshot could cut off long rails | Full-document PNG capture, validated against required document height | Keep text instead of silently crop it |
| M1 test competed with app recap redirect | Await app-owned URL and assert one document navigation | Remove trace-confirmed ERR_ABORTED race |
| Screenshot drift obscured evidence ownership | Gate-only drift restored, affected normal/stress evidence refreshed and committed | Review current output deliberately |

Verification:21 unit/contract/export checks;15 matrix cases across240 asset/view/width combinations; negative-control face-overlap guard; populated/standalone axe/M1/keyboard3 pass plus2 M1repeats. Eleven axe cases, zero violations. PNG actual width/height verified. No full gate run by Lead.
Independent bounded read-only Luna reviewer accepted fresh long-dialogue studio and share captures, finding no visual blocker. Reviewer explicitly distinguished viewport captures from full-document completeness; the latter has automated actual API PNG dimensions and DOM clipping assertions. Lead additionally viewed normal dashboard and full actual PNG. All four contact sheets were inspected in two-image batches.
Evidence: artifacts/ui-after/lettering/{studio,overlay,recap,standalone,share}-{390,1440}.jpg, fifteen *-results.json reports, contact-sheet-1..4.jpg; refreshed normal UI JPEGs and product share-card.png. All new JPEGs<=1280px.
Tradeoff: longer issues yield taller share PNGs rather than enforcing4:5 by truncating dialogue. In-image placement is intentionally disabled for the reviewed library; it requires an approved zone and full-fit verification before enabling later.

## Owner-priority wow landing unit (2026-10-27)

Direction: a generated-art story machine on `/`, a quieter operating workspace on `/studio`, and a magazine issue with an opening spread. `/dashboard` remains a compatibility alias. No dependencies added; bundled Barlow Condensed / DM Sans and lucide remain the typography/icon system. Design references were used only as guidance; no vendor commands or downloads were executed.

| Before | After | Why |
| --- | --- | --- |
| Root immediately opened a studio with no introduction | Art-led promise, invented chat → highlight → three original panels, primary demo CTA | Explain the product in five seconds with the actual artifact |
| Large studio welcome slogan displaced useful content | Compact Live studio heading, neutral chrome, real-art style thumbnails, moment timeline | Give the comic and editorial controls priority |
| Vector empty illustration and color-block style samples | Generated library art in the empty state and both style previews | Keep the visual promise consistent with the shipped panels |
| Same-size recap cells | Large cover type, opening two-column spread, dark Moment of the Stream splash | Establish magazine hierarchy without cropping any art |
| Potentially perpetual explanatory motion | Bounded three-step sequence;180ms chat and240ms panel state transitions, transform/opacity only | Explain a state change without a continuous render loop |
| Incomplete mobile screenshot and hidden extra panels | Top-of-page capture, compact chat/highlight cue before all three stacked panels | Preserve causal order and the complete sample story |
| Inherited labels on new dark surfaces | Explicit accessible foregrounds on strip metadata and moment label | Fix contrast regressions caught by axe |

Independent read-only Luna review accepted the desktop promise/CTA/art direction and source-level protected-art/motion approach. It identified stale mobile evidence and a reversed mobile causal order; both were corrected before final capture. Lead reviews fresh mobile, studio, cover and style screenshots. Evidence: `artifacts/ui-wow/`, JPEGs capped at1280px. No promise of measured60fps on physical phones: code animates only transform/opacity, and the browser test verifies stable panel layout throughout assembly. Existing protected-art English/RTL/emoji tests remain the stress fixture, not a production data switch.

Disclosure: the timeline markers use actual detected panel timestamps. The sparkline is expressly labeled illustrative sample chat velocity because the current API does not expose a measured velocity series. Real Twitch is still planned. See recap jumps to the magazine preview; publishing/downloading a real issue remains the studio End stream flow.

Final evidence review: Luna inspected fresh390landing and1440studio, confirmed full mobile heading/CTA, compact chat/highlight-before-art ordering, real-art style thumbnails and clear desktop controls, with no obvious collision. Mobile chat lines are intentionally condensed to the chat/highlight cue; full lines remain on wider layouts. Reviewer did not inspect lower-page/recap runtime; Lead and Playwright cover those. Final state-spec contrast repair uses scoped empty-canvas text tokens;1PASS after22other affected cases already passed.
