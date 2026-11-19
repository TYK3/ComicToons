# M1 Design Director review

This records the original M1 review. The owner subsequently requested a broader UI overhaul; its baseline and final acceptance evidence live in [UI_AUDIT.md](UI_AUDIT.md). Do not treat this earlier M1 verdict as approval of the overhaul.

Reviewed 2026-10-27 against the keyless local application, using Playwright captures and direct inspection of the saved PNG files. Scope: desktop dashboard, 1920 × 1080 OBS overlay, recap, 1080 × 1350 share card, and 390px mobile reflow. Product Design audit guidance informed the evidence review; no canvas or external publication was requested.

**Verdict: suitable for the M1 mock-data demonstration after the transparency correction.** This is not a production accessibility sign-off or a claim that mock illustrations depict each event accurately.

## Flow and evidence

1. **Start replay and approve — healthy.** The dashboard separates comic preview, approval queue, replay controls, and emergency hide. Yellow primary actions, restrained lavender accents, and clear card boundaries make the next action visible. Evidence: [desktop studio](../artifacts/README.md), [mobile studio](../artifacts/README.md).
2. **Watch in OBS — corrected and healthy.** The first capture exposed an opaque document background. The frontend now clears the root background on the overlay route, and the browser regression checks it. Three readable panels sit in the lower-right corner, preserving most of the stream canvas. Evidence: [overlay at 1920 × 1080](../artifacts/README.md).
3. **End stream and read recap — healthy.** The cream page, large editorial title, numbered panels, HTML bubbles, and prominent download link make the result feel like a collected issue. Mobile stacks all panels without clipping. Evidence: [desktop issue](../artifacts/README.md), [mobile issue](../artifacts/README.md).
4. **Download share card — healthy for M1.** The exported 1080 × 1350 PNG has a prominent title, intact caption text, and consistent ink borders. Evidence: [share card](../artifacts/README.md). The browser test also verifies PNG signature and nontrivial byte size.
5. **Emergency hide — healthy.** The browser acceptance test verifies that the hide action removes all overlay panels. The saved overlay image intentionally shows the populated state.

## Findings to carry forward

- **Mock art limits storytelling.** Current panels reuse an original explorer scene with palette changes. Replace these with event-specific scene art before the final live demo; captions currently carry the narrative.
- **Small supporting text.** Desktop labels and microcopy are visibly small. Increase secondary text sizes and measure actual contrast before the accessibility milestone. The main comic captions and primary actions remain legible in these captures.
- **Mobile preview hides two panels.** The mobile studio deliberately shows the first panel while its status reports three on air. Add a carousel or explicit “showing 1 of 3” cue; the mobile recap already shows all panels.
- **Share layout can improve.** A three-panel issue leaves an unused lower-right slot. A featured panel spanning the row would give the export more deliberate composition.
- **Motion evidence required care.** Initial screenshots captured panels during their ink animation and were rejected as static evidence. Final captures fast-forward animations; normal UI motion remains enabled and reduced-motion CSS is present.

## Evidence limits

Screenshots establish layout and visible hierarchy. They do not establish full keyboard access, screen-reader reading order, measured contrast, real OBS compositing over gameplay, or long-running performance. Browser tests establish the local replay/approval/export/hide flow. Live Twitch ingestion and real AI generation were outside this review.
