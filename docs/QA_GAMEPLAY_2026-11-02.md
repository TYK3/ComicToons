# Real Twitch gameplay QA — 2 November 2026

**Full end-to-end QA has not passed.** Real Twitch broadcast, capture, chat, role separation and review holds work. No usable manga page passed source/face/lettering review. Publishing and collection tests that require such a page remain blocked.

## What actually ran

1. Used the owner's `tyk_twitch` account and existing authorized Twitch connection. No other channel received messages, follows or clips. No bot accounts were created.
2. Ran the verified official SuperTuxKart 1.5 build as an automated Lighthouse race. OBS captured only that game window, fitted to the canvas, with no audio sources. The QA broadcast had an automatic 15:30 limit.
3. Verified Twitch LIVE, then clicked Studio's real ten-minute capture. It completed **600 seconds with 59 unique source frames**. Matching owner QA messages were verified in real Twitch chat. Commands were not used as comic dialogue.
4. The app analysed four chronological source frames and one matching chat quote, returned a four-panel observed recap, and correctly marked it **not a highlight**. No evidenced turning point or chat burst justified a must-clip claim.
5. Pollinations Klein returned an actual comic image. Automatic review held it for invented human figures, garbled lettering and poor fidelity to the virtual-kart scene. It never entered the release queue. A command-context bug later withdrew its quote; this bug was fixed and retested.
6. Switched to Viewer, rejected a non-Twitch URL and pasted `https://www.twitch.tv/tyk_twitch`. The real Viewer run captured seven frames and one chat quote over 83.301 seconds. Streamer controls were absent. A second Klein image failed review, including face/lettering protection.
7. Retested moderator `!ink no` after the fix. The Viewer quote remained present and later chat was not silently denied. Genuine `!noink` withdrawal remains covered by the focused regression.
8. OBS's time limit ended the broadcast. Viewer reported that the channel was offline and stopped capture; it did not substitute archived or Sample footage.
9. Made explicit in-app Gemini attempts against these saved real frames. The old analysis model returned 404. A minimal diagnostic found that `gemini-3.1-flash-lite` generated successfully while `gemini-2.5-flash` failed generation despite appearing in the catalog. Updated analysis/review to the verified model. The final full attempt passed analysis, then image drawing failed **HTTP 429** and automatic generation paused. No account/provider fallback or further paid retries followed.
10. Removed the temporary session key. Returned to Streamer, fixed recovery from a stale Viewer access-denied response, reconnected the existing Twitch authorization and verified 15/15 EventSub subscriptions.
11. Tested a real own-channel `!ink` request. The old code had claimed library art was a generated likeness. It now clearly labels that art as a placeholder and blocks release/automatic approval/fulfilment. The server rejected a desk Release attempt; both Release buttons, quick approval and Accept all were then verified disabled. Rejected the QA request and left zero waiting/accepted panels.

## Actual image flow

Playing Twitch video → timestamped frame captures → four chronological references (Klein limit) and nearby non-command chat → evidence-validated storyboard with source IDs → the chosen provider's image API → source/face/action/lettering review → Studio review queue **only when review passes** → manual release → viewer output and collections.

This run reached drawing and visual review. It did not reach a publishable page. Speech transcription is absent; chat is attributed separately. A newly supplied appearance photo alone is not a substitute for an image from the actual scene. No Codex image generator or manually substituted comic was used.

## Function-by-function result

| Function | Live result / limit |
|---|---|
| Own Twitch authorization and EventSub | PASS: owner connected, 15/15 subscriptions |
| Game-only broadcast and ten-minute capture | PASS: 600 seconds, 59 unique frames |
| Real chat intake | PASS: actual owner messages verified and used as source evidence |
| Viewer paste-link and invalid-link handling | PASS: valid live URL starts capture; external URL rejected |
| Viewer excludes streamer functions | PASS in real UI; broadcaster API denial also covered by focused server tests |
| Viewer → Streamer return | FIXED; real UI recovery and controlled browser regression PASS |
| Capture after stream ends | PASS: explicit offline stop, no Sample fallback |
| Scene analysis / highlight decision | PASS for an observed quiet recap; genuine highlight/burst detection not established by this run |
| In-picture comic image generation | FAIL quality: two real Klein outputs held; Gemini drawing blocked by HTTP 429 |
| Colour palette changes | Controls available; colours select future generation jobs. Existing baked art is not repainted; no accepted live colour-variant QA |
| Face/action/lettering protection | Holds PASS: bad images were withheld. No accepted image passed human visual QA |
| Moderator `!ink no` versus opt-out | FIXED; real Viewer quote retained; focused true-opt-out test PASS |
| Ink Me request and rejection | PASS in real own-channel chat, including final rejection after fixes |
| Actual personalized cameo drawing | NOT IMPLEMENTED in the legacy request path; library placeholder is now explicit and unreleasable |
| Placeholder individual / bulk / automatic release | PASS: server guard; real desk rejection; UI disabled controls; focused regression |
| Real page approve / undo / Accept all / auto-release | BLOCKED: no usable generated page. Controlled server/browser regressions remain distinct from live image QA |
| Chat vote and winning in-picture revision | BLOCKED: no eligible page; multiple distinct authorized chatters unavailable |
| Native Twitch polls / predictions / channel-point rewards | BLOCKED: owner is not Affiliate/Partner; UI eligibility notices verified. No native live creation/payout claimed |
| On-air reveal, vote/Ink/prediction animation with real art | BLOCKED: no usable accepted page or applicable native feature |
| Latecomer live updates and catch-up with real art | BLOCKED: zero accepted real pages |
| Real book/chapter collection and downloaded exports | BLOCKED on this run; controlled completed-page/export regressions PASS |
| Multiple users, duplicate votes, raids, cheers, hype, refunds | Live coverage incomplete; no fabricated accounts/events substituted |
| Session keys / secret exclusion | Temporary key forgotten; latest scan has zero configured-secret matches in source/build |

## Changes made from these findings

- `apps/server/src/scenes/sessions.ts`: pass sender metadata to opt-out parsing, preserving moderator rejection semantics.
- `apps/server/src/scenes/providers.ts`: lock generated subjects to the actual source, and use the verified working Gemini analysis/review model.
- `apps/server/src/participation/ink-chat.ts` and `rewards.ts`: truthful placeholder descriptions, no claimed generated likeness, explicit release block and no placeholder fulfilment.
- `apps/server/src/studio.ts`: enforce the block for individual, bulk and automatic release. Rejection/undo cannot clear it.
- Shared/web panel types carry the release-block reason. Studio, Director and participation UI show the reason, disable unsafe release controls and label requests Waiting for image.
- `apps/web/src/ui/App.tsx`: refresh the broadcaster adapter when returning from Viewer to Streamer, clearing stale access-denied errors.
- Focused regression coverage added for command context, placeholder release and the Gemini model; browser regression added for role return.

## Evidence and checks

Local artifacts are ignored QA evidence, not bundled public samples:

- `artifacts/qa/own-stream/gameplay-ten-minute-report.json`: real ten-minute capture and source/provenance events. Retained chat is zero after the original erroneous command withdrawal; the event history records the selected quote and quality hold. It must not be described as zero real chat received.
- `artifacts/qa/own-stream/gameplay-source-first.jpg` and `gameplay-source-current.jpg`: actual captured game frames.
- `artifacts/qa/own-stream/gameplay-generated-1.jpg`: actual rejected first output; **not publishable**.
- `artifacts/qa/own-stream/viewer-progress.json`, `viewer-source-*.jpg`, `viewer-generated-1.jpg`: real Viewer capture, retained quote and provider outcomes.
- `artifacts/qa/own-stream/gemini-analysis-check.json`: sanitized working/failed model diagnostic, no key values.
- `artifacts/qa/own-stream/placeholder-ui-assertions.json`: actual browser checks of both release buttons, quick approval and Accept all, plus the server rejection.
- `artifacts/qa/own-stream/placeholder-guard.jpg`: real phone header/disabled quick approval during the guard test; the full desk is outside that narrow viewport.
- `artifacts/qa/revisions/placeholder-controls.jpg`: controlled desktop release-guard screenshot; not live media evidence.
- `artifacts/qa/watch/role-return.jpg`: controlled role-transition regression screenshot, not live media evidence.

55 focused Node tests PASS; two focused browser tests PASS for role return and reviewed edits/desktop-phone placeholder controls. The screenshots were visually reviewed. Latest typecheck/lint/build PASS; secret scan checked 784 files against 13 configured secret values with zero matches. Full gate remains maintainer-owned. No commit, push or deployment.

## Cleanup and incident

Twitch is offline. The game is stopped. Original Twitch title **Daily routine Honkai 1hr** and category **Honkai: Star Rail** were restored. OBS is stopped on the original **Untitled** collection. Automatic timing is disabled and its original zero-minute/thirty-second value is restored.

During timer cleanup, a click intended to disarm it instead restarted OBS output for approximately 46 seconds. The QA scene was black with no audio because the game was already closed. It was manually stopped; the original desktop-capture collection was restored only after stopped output was verified. This incident is not part of the successful capture result.

Next required inputs are working image-generation quota/quality and authorized distinct test chatters. Do not mark the app ready for release or all functions passed based on this run.
