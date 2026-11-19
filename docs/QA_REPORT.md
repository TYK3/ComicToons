# QA report — protected art and recap navigation
2026-10-27 · codex/e2e-hardening · narrow checks only; Manager runs full gate.

| Check | Result | Evidence |
|---|---|---|
|Typecheck, ESLint,21 unit/contract/export tests|PASS|npm run check; local log `panelcast-protected-check-final.log`|
|All 16 assets, studio,390/1440/1920|PASS: 48 combinations|lettering/studio-*-results.json|
|All 16 assets, overlay,390/1440/1920|PASS: 48 combinations|lettering/overlay-*-results.json|
|All 16 assets, recap,390/1440/1920|PASS: 48 combinations|lettering/recap-*-results.json|
|All 16 assets, standalone,390/1440/1920|PASS: 48 combinations|lettering/standalone-*-results.json|
|All 16 assets, share,390/1440/1920|PASS: 48 combinations|lettering/share-*-results.json|
|Deliberately unsafe bubble over face|PASS:guard rejects it|face protection guard Playwright test|
|Populated/standalone axe,11 cases|PASS:zero violations|artifacts/ui-after/axe-results.json|
|M1 app-owned recap redirect and actual full PNG|PASS3runs|affected flow+2 repeat runs|
|Keyboard edit/reject/undo/approve/speed/toggle/panic/export|PASS|studio-keyboard.spec.ts|
|Independent visual review|Accepted|fresh studio/share long-dialogue JPEGs; docs/UI_AUDIT.md|

Every matrix combination checks manifest faceBox/faceBoxes/subjectBox intersections, stronger no-lettering-on-any-art protection, original1280x720 image dimensions,16:9 frame ratio, exact full English/RTL/emoji dialogue, text bounds, ancestor clipping, no ellipsis, lettering collisions and horizontal reflow. All 16 asset names must appear in each view/width test, preventing vacuous coverage. Per-case report files live under artifacts/ui-after/lettering/.

## Bugs found and fixes
- Competing app location.assign and test page.goto caused recap ERR_ABORTED. The app's first recap request was HTTP200 and began~4ms before the test tried again. Await the app redirect; assert one recap navigation. No timeout increase.
- Image-overlay lettering had no relation to faces/subject geometry. Visually map all 16 assets; no dense image area approved. Move all lettering to an expanding external rail.
- Library art was cropped by portrait/variant frames. Use16:9 everywhere; move queue labels and cover sticker outside image too.
- Export shortened dialogue and a fixed1350px capture could cut off full rails. Preserve every line and capture full document; assert actual PNG dimensions cover it.
- Export number inherited line-height too short for Barlow glyph bounds. Add readable line-height/padding.
- Waiting for offscreen animation.finished could stall a geometry snapshot. Finish/cancel animations for terminal-state assertions rather than wait indefinitely.

The former absolute-position test stop is preserved in docs/BLOCKERS.md and resolved by this new Manager-authorized approach. This report does not claim broader60-case chaos, SQLite/job recovery, Firefox/WebKit or remote-provider coverage; those belong to the still-pending broader pipeline task.

## Wow landing focused review

New `tests/wow.spec.ts` checks landing at390/768/1440/1920 for both styles, decoded real1280x720 library art, protected lettering, horizontal reflow, zero serious/critical axe, primary demo route, selected style in demo URL, bounded assembly/pause/replay and stable layout geometry. Published studio/recap checked at all four widths. Existing letter matrix covers all16assets ×5surfaces ×3widths with long English/RTL/emoji, plus negative control. Existing M1 continues verifying actual PNG export and single recap navigation; keyboard, empty/loading/error/offline and component-state regressions are included in the affected UI run.

Bugs found/fixed: exact-text test selector matched a composite status incorrectly; dark moment label inherited paper-color contrast; dark preview metadata inherited paper-color contrast; mobile evidence scrolled to an incomplete hero; mobile art order obscured the chat→highlight→panel explanation and hid continuation. No remote provider calls. No new dependencies. Physical-device60fps, Firefox/WebKit and full gate are not claimed by this focused unit.

Executed result: `npm run check` PASS21tests/types/lint. Combined affected Playwright run22PASS/1FAIL(1.6m): empty studio canvas inherited paper foregrounds on dark background. Fixed with scoped empty-canvas text tokens; UI-state-only rerun1PASS(28.5s). All23affected cases therefore pass at final relevant source. Landing axe JSON covers8width/style combinations; existing state/populated reports cover final checked views. Fresh artifacts deliberately committed, including replacements for Manager gate screenshot drift where the affected spec refreshed them.
