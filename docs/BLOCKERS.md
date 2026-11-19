# Blockers — lettering and face protection

Historical stop record (073636c),2026-10-27. The previous unit was NOT DONE.

## Resolution — new Manager-authorized protected-art unit
RESOLVED by changing approach, not continuing absolute-position tuning. All 16 artworks were visually inspected; reviewed percent face/subject maps and explicit empty image lettering zones now live in the manifest. Entire16:9 images remain visible and all lettering uses expanding external rails. Full dialogue survives in web/export; actual API PNG uses full-document capture.

Verification: npm run check21 pass;15 protected-art tests pass(29.8s),240 asset/view/width combinations; positive-control guard passes; affected axe/M1/keyboard specs3 pass(36.0s); M1 repeated twice more2 pass(26.4s), each asserting one app-owned recap navigation and complete API PNG dimensions. Eleven populated/standalone axe cases:zero violations. Independent bounded reviewer accepted fresh studio and share stress captures. Manager full gate pending; no Lead gate/push.

The stop record below is retained for provenance. Its unfinished items and earlier working-tree state are superseded by this resolution.

## Stop condition reached
AGENTS.md says: “If the same test fails 3 times, stop and report instead of retrying blindly.” The new tests/lettering.spec.ts regression failed three consecutive runs during this unit. No further retry was run after recognizing the third failure. Full gate was never run by Lead.

## Confirmed recap navigation root cause and correction
- Manager gate log: local log `gate-7627ca7.log` (not committed).
- The retained trace showed POST /api/end HTTP200, then the app's recap document request at monotonic32873.725ms (HTTP200), then the test's competing page.goto at32877.860ms.
- Studio.endStream already calls location.assign. The M1 test incorrectly initiated a second navigation while that redirect was in flight.
- Working-tree correction starts waitForURL before clicking End stream, awaits the app-owned redirect, checks the resulting URL against API state, and asserts exactly one recap document navigation. No timeout was raised.
- Corrected M1 spec passed in11.8s in the affected three-spec run.

## Lettering regression attempts
| Attempt | Evidence | Finding |
|---|---|---|
|1|local log `panelcast-recap-fix-browser.log`|M1 passed; populated and long-text geometry checks failed. Initial scrollHeight checks incorrectly counted a visible pseudo-element tail; SFX glyph line boxes also overhang their own CSS line box.|
|2|local log `panelcast-lettering-final.log` (subsequently overwritten by attempt3)|Populated/standalone accessibility passed20.1s; long-text overlay390 failed: SFX escaped art. Direct DOM measurements showed art192.219px vs required254.219px lettering height.|
|3|local log `panelcast-lettering-final.log`|After introducing an intrinsic ratio spacer and normal-flow lettering, long-dialogue geometry still failed. It reached the assertions in tests/lettering.spec.ts:26, with text/SFX bounds outside the art. Further work stopped per rule.|

Latest trace: artifacts/playwright/lettering-long-dialogue-*/trace.zip (ignored runtime artifact). Narrow npm run check passed19tests before the last CSS-only spacer revision; the last revision is not represented as checked/green.

## Owner's latest face-protection requirement — pending
The Owner added a stricter success condition during the third run: inspect all 16 generated panels; add per-asset bubbleZones/sfxZones/captionZone plus faceBox/subjectBox; no lettering intersects protected faces or the main subject in studio/overlay/recap/standalone/share at 390/1440/1920.
- Four2x2 JPEG contact sheets were requested via a local script (`panelcast-contact-sheets.mjs`, not committed) under artifacts/ui-after/lettering/. Their completion/contents have not yet been reviewed.
- No per-asset face/subject map has been authored or claimed verified.
- Recommended next implementation: treat dense art as protected. Move dialogue, SFX, panel number and export timestamp into a dedicated rail outside the art whenever a safe image zone cannot hold full lettering. Preserve all dialogue, and keep original16:9 art visible. This removes image/lettering collision by layout instead of continually adjusting absolute positions.
- Add manifest-driven face/subject intersection assertions for every asset in every output at all three requested widths, and explicitly test long dialogue in standalone/share as well as web views.

## Working tree / screenshot ownership
- At task start,20 tracked screenshots had gate-run drift. They were deliberately restored from HEAD before new checks.
- Affected M1/populated/lettering checks then refreshed task-owned evidence. This evidence is not yet accepted by design review and remains uncommitted with the incomplete implementation.
- Read-only Luna reviewer confirmed the navigation correction and warned that fixed export art sizing could still clip long dialogue. Its screenshot observations were explicitly stale/potentially stale. No final design acceptance is claimed.
- Existing untracked .agents/, docs/DESIGN_SKILLS.md and docs/IMAGEGEN_RESEARCH.md remain Manager-owned and untouched.
- No full gate, push or git config change. Next wow-landing unit has not started because this unit remains incomplete.
