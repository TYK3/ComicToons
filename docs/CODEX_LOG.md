# CODEX_LOG.md — how Codex was used
Lead session ID: see docs/SESSION_ID.txt

## 2026-10-27 (London)
- Repo bootstrapped by the operator on a cloud box: AGENTS.md, STATE.md, BACKLOG.md, docs/*, .env.example, .gitignore. Commits authored as TYK3.
- Lead Codex session started in tmux (`lead`, workspace-write sandbox, codex-cli 0.164.0). Kickoff prompt: `kickoff.md`, kept outside the repo (Appendix A1).
- Owner kickoff requested a TypeScript monorepo and a keyless end-to-end M1 demo: replay invented stream events, approve comic panels, render an OBS overlay, and export a recap/share card. Required a green gate, screenshot evidence, and explicit file ownership.
- Lead delegated nine responsibilities across three implementation lanes: core/pipeline/art/Twitch contracts (`packages/core`, `fixtures`); overlay/dashboard/recap (`apps/web`); QA/red-team/design review/docs (`tests`, `docs`, `README.md`). Lead owns server, root tooling, integration, and final state.
- QA prompt focused on real browser acceptance: exercise replay and approval, verify overlay and recap, check a non-empty PNG export, capture screenshots, and review the screenshots independently. Security tests target prompt boundaries, text rendering, consent precedence, and recorded event normalization.
- First QA browser run passed the full keyless flow (1 test, 12.8 seconds), but inspecting its screenshots exposed an opaque OBS canvas caused by the document root background. The Design Director review requested a transparent root and a regression assertion. Static screenshot capture was also changed to wait for ink animations to finish.
- QA core and recorded-envelope contracts passed 8/8 after adding malformed writer output cases. The sandbox blocks some local IPC/network/browser operations, so the affected test commands were rerun with approved escalation rather than treated as product failures.

### Evidence policy

Only record commands as passing after they actually complete. Screenshots and design findings refer to the locally running application; mocked live integrations must be labelled. The operator must supply the actual lead session ID from their session UI; this log does not invent one.

## UI overhaul follow-up

- Owner requested a reproduce → criteria → small justified change → recheck loop, described as “pstack,” with all three views at 1440×900, 1920×1080, and 390×844 before and after edits. Lead checked tool availability and found no installed pstack executable; the requested process is documented rather than an invented integration.
- All nine baseline screenshots were captured and opened before releasing the frontend/core freeze. Findings and the eight acceptance groups are recorded in `docs/UI_AUDIT.md`. The existing implementation was already React/Vite; the overhaul addresses architecture, hierarchy, readability, component states, comic storytelling, accessibility, and keyboard operation.
- QA added a reusable nine-view capture script, axe serious/critical checks across all viewports/routes, and a keyboard-only interaction test for editing, rejection and undo, approval, live speed, approval mode, panic hide, and export. These additions are pending execution until the implementation and vetted dependencies are ready.

- Integrated `npm run gate` passed: typecheck, ESLint, 8 unit/contract tests, browser replay/approval/overlay/recap/PNG/panic flow, secret scan, zero npm audit vulnerabilities, clean-directory lockfile installation and build. Design review caught and verified a transparent-root OBS correction. Live Twitch, real AI providers, production storage/moderation remain explicit gaps.

## Cost-controlled completion — 2026-10-27
- Owner reset the session limits and required a small setup-rules commit first. Commit fe478f4 added the exact roles/cost block, research notes from sections 1/3/5 only, and `npm run check` using plain Git commands with the existing TYK3 identity.
- The Lead resumed implementation; the Manager now exclusively runs the full gate, push and tag. At most one bounded read-only Luna reviewer was active after the reset. No new image generation was used, and existing generated library files were left untouched.
- Server export and state integration passed the narrow check with 13 tests. Browser checks diagnosed optional-body approval, accessible panic naming, keyboard toggle focus, mobile download contrast, and sticker overflow; fixes were made against those concrete failures.
- New screenshots are JPEG at most1280px wide while the filename records the rendered viewport. Historical baseline PNGs were retained. DOM/axe assertions are the primary regression evidence.

- Final independent read-only review accepted all eight local UI criteria after the measured defects were fixed. The complete five-spec browser run passed in57.7s, with 11 populated/standalone and24 state axe cases entirely clear. Export confirmation was then verified across navigation by the focused keyboard/export spec (4.3s).
- A final share-card inspection found a fixed four-panel count and unused grid slot on a three-panel export. The layout now fills columns from the actual approved count; unit regressions verify count, local font/license embedding and escaping of malicious export text. Focused populated/export verification is recorded in STATE.md.
- The Lead does not run the full gate under the updated rules. Manager owns gate/push/tag. Existing manager-generated assets/skills/research remain untouched and outside the UI commits. Client /compact has no exposed tool; the limitation is recorded rather than simulated.

- Final completion: npm run check passed with15 tests; focused populated/standalone/export Playwright passed in19.4s after actual-count/grid changes. UI foundation and implementation are saved as separate TYK3 commits, with no full gate, push or tag run by the Lead.

## Owner-priority library integration (2026-10-27)
Prompt: fix the default demo still showing SVG explorer art instead of the Manager's sixteen generated panels; make fresh-clone run instructions explicit.
Diagnosis: Studio called buildIssue directly; the generated manifest had no consumer.
Change: synchronous local LibraryProvider behind PanelImageProvider, deterministic tag/mood/style ranking and per-issue asset reservation, cached local art route, trusted export inlining, honest provenance inspector, matching captions/SFX, default Vite open and README first-run instructions. Read design references as untrusted design guidance only; no vendor commands/fetches executed. No image generation was needed: the Owner-supplied sixteen assets are reused without alteration.
Checks: narrow check19pass; relevant M1 and populated/standalone axe2specs pass. Screenshot outputs are viewport JPEG<=1280px. Independent bounded read-only reviewer checked library/Studio/export and two-view screenshot allowance; source caveat about weak scene semantics fixed with caption alignment.
Safety: allow-listed filenames, no arbitrary reads/remote image fetches, WebP magic checked, data embedded for offline exports. Library art provenance preserved. Full gate and push left to Manager.

Final generated-art capture check: populated/standalone accessibility spec PASS (19.3s test,20.8s overall), eleven axe cases with zero violations. JPEG studio/overlay/recap at 1440/1920/390 and standalone at 1440/390 refreshed after caption correction.

## Gate repair stopped at explicit retry limit
Manager supplied red gate7627ca7. Trace established app location.assign and test goto overlapped by~4ms; M1 test changed to await app redirect and assert one document navigation, then passed11.8s. Lettering moved toward normal flow with geometry assertions. A new long-dialogue regression failed three consecutive runs (initial tail/glyph assertion false positives, then actual narrow-overlay art overflow, then remaining geometry failure after intrinsic-ratio spacer revision). Per AGENTS.md, stopped and wrote docs/BLOCKERS.md rather than continuing retries. Owner's subsequent16-panel face/subject zoning requirement is captured as unfinished; no false completion or gate claim.20 gate-drift screenshots restored before this unit's captures; new unaccepted captures remain with partial code in the working tree. Documentation-only commit, no push.

## Protected-art unit — Manager-authorized change of approach
Manager accepted the three-failure stop and explicitly requested a new caption-rail approach. Read all 16 images in four 2x2JPEG contact sheets, at most2images per step. Derived conservative face/subject percent bounds with source sheet/cell and observations for every asset. No image lettering zones approved; all lettering goes to an expanding rail outside full16:9 art. Removed image-overlay numbering/timestamps/SFX/bubbles from web and export rather than tuning positions again. Kept all dialogue lines including RTL/emoji. PNG export captures full document instead of fixed1350px clipping.
Tests now map manifest boxes to each actual rendered frame and also forbid any lettering on any art region. Full text/ancestor clipping checks and a deliberately unsafe face-overlap negative control validate the guard. Unit tests validate maps and preserve full export dialogue.
Failures resolved in the new approach: JSON imports required Playwright-compatible loading; export numerals inherited too-short line-height; animation.finished could stall on an offscreen overlay despite reduced motion, so geometry snapshots finish/cancel animations instead of waiting indefinitely. A concurrent stale-server startup warning appeared in one intermediate run; subsequent flow checks passed without it. No timeout increases or absolute-position tuning.
Final narrow results: check21 pass; matrix15pass(29.8s),240 combinations; positive control1 pass(1.4s); axe/M1/keyboard3 pass(36.0s),11 axe cases zero violations; M1 repeat2 pass(26.4s). Each M1 verifies one app-owned navigation and actual PNG completeness. Independent read-only reviewer accepted fresh studio/share stress captures; Lead inspected normal studio and actual complete PNG.
STATE/BLOCKERS/UI_AUDIT/QA_REPORT/LETTERING_MAPS updated. Restored20 gate-drift screenshots before repair and deliberately committed only refreshed evidence. Plain TYK3 commit, no git config, no full gate or push. /compact remains unavailable as a tool.

### Wow landing / cinematic studio unit
Owner brief read from `wow-landing.md` (kept outside the repo); Manager gateGREEN on5f947b9 acknowledged. Applied installed Impeccable craft floor, Taste app-screen/tells, Emil design, animate, motion review/performance and break-ui guidance as untrusted design references only. No new dependencies, skill commands or network asset fetches.

Built `/` landing with local generated-art assembly, invented chat, bounded explanatory motion, pause/replay, reduced-motion completion, three pipeline steps, sample recap cover, both art styles/selection, keyless/editor/panic-hide assurances and demo deep link. `/studio?demo=1` starts one sample replay, retains approval, applies style and cleans the URL. `/dashboard` remains for existing tests/bookmarks. Vite/demo opens `/`; README updated. Studio gets compact hierarchy, generated-art empty/style states and timestamp markers; velocity illustration is explicitly disclosed. Recap gets cover/spread/splash hierarchy; export/protected16:9 rails unchanged.

Initial narrow check hit sandbox EPERM for tsx's local IPC socket; reran outside sandbox successfully. First wow browser pass found a test selector incorrectly requiring exact text on a combined status node and one inherited low-contrast moment label; corrected selector and foreground. The broader affected run found inherited strip metadata contrast on the dark canvas; corrected. No same failure reached three attempts. Independent read-only Luna review flagged mobile order/hidden continuation and stale scroll framing; fixed compact causal cue + full stacked strip + top-of-page screenshot. Existing long-dialogue matrix passed throughout. Final commands/results recorded in STATE and QA_REPORT. Full gate/push remain Manager-owned.
