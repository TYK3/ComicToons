# Manga story redesign: implementation and evidence

Young's selected references are image.png and image-4/5/6.png in Young's reference images (not in the repo). image-2/3.png show the rejected large white outboard caption cards. This revision replaces the Step 3 peak-first summary direction.

## Story and artwork
- Three original six-shot sequences: Juniper/Pixel in the crystal vault; Orbit/Pip in a clockwork speedrun; Clover/Miso's pancake mishap and recovery.
- Original art made with the built-in image-generation tool. No existing manga characters/pages copied into app assets. References inform ink, screentone, pacing, balloons and panel composition.
- Each source atlas was mechanically separated into six image assets without repainting. Prompt/source records remain under the image generator's original directory. Served assets: fixtures/art/generated/panel-story-{tabletop,speedrun,cooking}-{0..5}.png.
- Sample fixture chat now includes six distinct narrative phases. Each approved parent moment owns its establishing/action shots; withholding/rejecting that moment withholds all its shots. Sample dialogue and chat remain clearly labelled as invented.
- Panels read chronologically. The climax retains emphasis without being moved ahead of the setup.

## Lettering and pagination
- Speech, selected chat and SFX are composed inside illustrated panels. Main sample pages have no lettering rails, metadata cards or per-panel provenance boxes.
- Editable caption changes become the source moment's first in-art speech line. HTML text remains editable/escaped and becomes pixels in PNG exports.
- Grapheme-aware text splitting preserves RTL and emoji. Long text creates continuation frames and additional page sections; dense frames receive more width. Page budgets prevent six dense text frames from being squeezed onto one page.
- Standalone HTML and full-issue share PNG remain available. The API also renders individual page-N.png files, exposed through pageUrls and recap download links.
- Existing library-only legacy recap data retains its protected full-art fallback. This build does not fabricate video evidence or claim live Twitch/video reconstruction: the runnable demo is an original fictional interpretation of sample events. Runtime video/image generation and live ingest remain separate scheduled work.

## Research
- https://www.clipstudio.net/en/comics-manga/comic-creation/ - panel/shot variety, planned balloon placement, splitting dialogue across panels.
- https://www.clipstudio.net/how-to-draw/archives/160963 - scene progression, page flow and emphasis.
- https://www.clipstudio.net/en/comics-manga/design-tips/ - pacing, typography, balanced balloons and page transitions.

## Validation checkpoint
Scoped Node20.20.2: check2 PASS (typecheck, lint, 28/28 unit tests). Focused3 PASS 4/4 (all three stories desktop/mobile/standalone plus Unicode long-comment continuation). Full gate and final visual review in progress.

Earlier evidence retained: first focused run failed on overly tight SFX line boxes; second passed continuation but found three mobile SFX/balloon overlaps. Corrected SFX line height, mobile placement/size and concise sample speech. Neither assertion nor timeout relaxed. The third focused run passed all four cases. The first unit check had one obsolete WebP-only assertion; updated it to validate locally embedded PNG or WebP artwork.

Final visual corrections: moved the tabletop tension-shot chat away from Pixel's face; added minimum 235px story grid rows and 14px narrow-frame speech. This fixed the intermediate-width Studio failure while preserving full text and strict non-overlap assertions. Pop/Noir receive warm sepia/neutral ink treatments consistently in React and standalone exports.

The first full gate passed 28 unit tests and 39/41 browser tests. Its two failures were the obsolete library-only provider expectation and the real narrow Studio lettering collision. The affected focused5 rerun passes 7/7 after the test metadata correction and layout fix. Final gate2 PASS: Node20.20.2, unit28/28 and E2E41/41, zero failures/skips, all stages green. Scope/hash/identity verification precedes the local commit.
