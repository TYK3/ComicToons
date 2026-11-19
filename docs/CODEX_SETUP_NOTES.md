# Codex setup notes

Source: a local research note (`codex-setup-research.md`, not in this repo), sections **1, 3 and 5 only**, read 2026-10-27. This is a workflow summary, not a claim that proposed configuration changes have been installed.

## Ranked recommendations (section 1)

The largest reported cost is subagent usage. Prioritize fewer, cheaper, narrowly scoped agents with fresh context; separate implementation from the Manager's full gate; reduce screenshot/context volume; choose effort per task; and compact after each completed unit. The Owner's current rules are stricter than the research's two-agent ceiling: **at most one active subagent**, for bounded read-heavy work. Permission loosening was flagged as a security tradeoff, not a blanket recommendation. Consider disabling unused design skills/plugins after the overhaul. The suggested alternative test runner remains unverified.

## Workflow (section 3)

Specify goal, context, constraints and observable completion checks. The Lead runs the narrow checks needed for the changed unit; the Manager runs the full gate. `npm run check` combines typecheck, lint and unit tests. Run relevant Playwright specs for UI work. Capture long output once to a file and show its last 40 lines; avoid repeated polling and large rereads. Keep changes bounded, and stop after the same failure occurs three times.

Use JPEG screenshots no wider than 1280px, inspect at most two images per step, and prefer DOM, axe, bounding-box and computed-style assertions. Use contact sheets for visual judgment rather than repeatedly viewing unchanged images. Update STATE.md, then use the client's `/compact` after each finished unit.

## Image-generation budget (section 5)

The research recommends treating the existing 16-panel library as the final demo art budget, with HTML captions and CSS crop/color variation. It reports that image generation can consume included limits faster than comparable text work; avoid gratuitous regeneration. If additional generation becomes necessary, batch four panels in a 2×2 sheet, keep resolution around 1024px, prohibit image text, and limit per-image iteration to two attempts. Inspect consistency before relying on sliced sheets. Keep image work in a short isolated session; do not assume an API key exists. Previously researched open-source/free-API providers remain a separate potential live-generation path.

No new image generation, permission change, model change, plugin removal or API-key creation is authorized or performed by this notes commit.
