# Manga colour themes

There are four themes: Festival colour (the default), Sunset glow, Lagoon and Blossom (`packages/core/src/theme.ts`). A stored legacy `ink`, `noir` or `pop` value, or a missing or unknown one, resolves to Festival colour. Each theme is a local colour treatment of the existing original illustrations. No new artwork, image provider, external service request or dependency is introduced. Existing `/api/settings` carries the choice; no new endpoint is added.

| Role | Festival colour (default) | Sunset glow | Lagoon | Blossom |
| --- | --- | --- | --- | --- |
| Paper | Warm paper `#fff5e8` | `#fff1ea` | `#eef9f7` | `#fbf1fb` |
| Ink / balloon text | Midnight navy `#142b36` | `#3a1029` | `#0d2a3f` | `#2e1446` |
| Picture treatment | Warm base with teal `#1da2b3`, amber `#ffc258`, coral `#ee6471` multiply washes | `#e4407a`, `#ff8a3d`, `#ffd166` multiply washes | `#2f6fdf`, `#2ec4d6`, `#a8e063` multiply washes | `#8e5cf6`, `#ff7ac6`, `#7fe3c4` multiply washes |
| Speech balloon | Cream `#fffdf5` | `#fff8f2` | `#f7fffd` | `#fffaff` |
| Selected chat balloon | Mint `#d9f1e6` | `#ffe3ec` | `#e3edff` | `#efe7ff` |
| Sound effect | Deep coral `#a52b48` with cream edge | `#9b1d5c` with `#fff8f2` edge | `#1d4a9e` with `#f7fffd` edge | `#f7f2ff` with `#2e1446` edge |

These are the manga page rules in `packages/core/src/theme.ts` (`FESTIVAL_CLASSIC` for Festival colour, `classicRules` for the other three).

Multiply compositing retains dark outlines, original screentone and speed lines. The treatment supplies multiple hues rather than a global sepia toggle. It does not infer the real-world colours of depicted objects. Original scene sequence, face clearance, balloons, chat/SFX and continuation pagination stay intact. Sample Data provenance remains visible, in a dark high-contrast label in every theme.

## Selection and persistence

The native select supports Tab, arrows, Home/End and Enter. A successful selection is stored in `comictoons-manga-theme` in localStorage and in the shared studio state. A reload restores the saved choice; a later server reset is reconciled from that preference when the studio opens. Storage denial does not break the shared studio setting. Overlay reads the shared choice, so it needs no separate browser storage. Theme changes also update cached sample/live snapshots, including the optimistic manual fallback view.

Saved recaps capture their selected theme in the persisted issue snapshot; another user's current preference cannot recolour a saved issue. Older snapshots without a theme, or with the legacy `ink` theme, resolve to Festival colour. Replay retains the selected theme, independently of Festival colour / Midnight noir artwork selection for new source issues.

## One shared rendering policy

`packages/core/src/theme.ts` supplies validated IDs, names and CSS. The shared manga stylesheet includes the palette rules. MangaPage sets a `data-manga-theme` attribute on its page collection. Studio, overlay, recap, standalone HTML, full saved PNG, per-page saved PNG and the browser-local Step5 PNG all use that attribute and the same CSS. Theme changes do not mutate approved captions, dialogue or image identities.

## Verification

- MT-STATE: unknown values/default resolution, API validation, no panel mutation, replay and unavailable-Twitch sample fallback retain the palette.
- MT-HTML: a legacy theme renders as Festival colour, and both export documents retain the exact theme attribute, Sample Data, balloons and SFX for all four themes.
- CT-SWITCH: the picker lists all four themes with Festival colour first and default; a legacy `ink` setting resolves to Festival colour; keyboard switching, reload persistence, restoring a saved preference after a server default reset, overlay propagation, visible sample labels and390/1280px overflow/axe checks.
- CT-EXPORT: real Step5 browser PNG download with required filename and size, saved `/recap/:id`, and actual server per-page PNG, in Festival colour. Raster pixel checks confirm multihue colour (warm and cool) and verify dark ink survives. It saves visual evidence and numerical proofs under `artifacts/manga-colour/`.

Exact command logs, native exits and protected source hashes live in `artifacts/tmp/manga-colour/`. Final counts and commit are recorded in STATE.md and the handoff report after the gate completes.

The regular E2E ports were occupied by a separate preview checkout during this work. `tests/playwright.config.ts` now permits `COMICTOONS_E2E_WEB_PORT` and `COMICTOONS_E2E_API_PORT` overrides, retaining its existing4273/4301 defaults. This step uses4373/4401 for both focused runs and the complete unchanged gate command. No preview process was stopped or changed.

No push, configuration/identity change, credential access, image-service call, visibility change or lockfile change. Step6 chaos work is separate.
