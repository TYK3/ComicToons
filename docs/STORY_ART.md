# Sample story artwork — 1 November 2026

Updated 2 November: the three invented samples each have 20 unique narrative scenes shared by episode and collected-book views. The reader can arrange four, five or six panels per page. This replaces the earlier separate highlights-book model. Story captions and dialogue live in `apps/web/src/ui/data/sampleStories.ts`; these are authored Sample fiction, not reconstructed claims about real streamers.

## Assets and generation mode

Generated with the built-in image generation tool in this Codex session, then copied without modifying the originals. No external stock imagery, copyrighted characters or API credentials were used.

Project assets: `apps/web/public/samples/stories/{tabletop,speedrun,cooking}-{festival,sunset,lagoon,blossom}.png` (12 sheets, 20 scenes per sheet).

Each sheet is four columns and five rows. Actual row boundaries were measured after generation; the shared `panelArtRect` crops to the scene with a small seam inset in HTML and PNG exports. Images are selected by palette, with no grayscale, blend-mode colouring or gradient overlay. Original generated files remain in the local Codex generated_images directory.

## Prompt set

Base generation brief: production-ready original full-colour manga sprite sheet, exactly four columns by five rows, 20 ordered story scenes, no gutters, captions, letters, speech bubbles, logos or watermarks. Keep character identity consistent across every scene. Use vivid environmental colours, natural skin and hair, and distinct local colours on clothes, animals and props. Keep faces and important actions safely inside each scene. Leave quiet composition space near the top and bottom; never paint lettering into the artwork.

The 20-scene narrative supplied for each story follows the ordered `beats` in sampleStories.ts:

- Critical Mess: explorer and orange fox discover a dark citadel, retrieve a key, disturb a golden die, fall through the floor, find a garden and guardian, restore the beacon and return to camp.
- Frame Perfect: runner and small yellow robot train for a sky-city race, discover a shortcut, miss a jump, save one another, learn from the mistake and finish together.
- Batter Days: cook and orange cat prepare breakfast, cause a flour cloud, fail the first pancake flip, patiently try again and share breakfast with friends.

Palette edit brief: use the Festival sheet as the image reference; preserve every scene, character, action, framing and four-by-five arrangement. Repaint individual environment surfaces and lighting with the requested palette. Keep natural skin, hair, clothing and animal colours. No global tint, monochrome treatment, colour wash, gradient overlay, added text, speech balloons or captions.

- Festival: varied, lively blue skies, green foliage, warm stone and colourful details.
- Sunset: mainly orange, amber, terracotta and gold scenery with warm sunset light.
- Lagoon: mainly blue, cyan and turquoise scenery, cool water and sky.
- Blossom: mainly rose, lavender and pink scenery, with mint accents.

## Lettering and export

Generation baseline (2 November 2026): obtain a timestamped frame from the actual scene and use its matching chat or reviewed transcription. A photo taken in another moment establishes appearance only. Any chat-only or unmatched QA interpretation must be labelled as such.

Protect every character's face in both artwork and layout. Speech balloons, captions, SFX, avatars, overlaid images and panel crops must never obscure or cut off faces, eyes or mouths. Preserve hands and key action too. Compose around protected regions, visually inspect the final result, and recompose or paginate if it fails.

Reviewed background pockets place speech balloons inside the sample art. HTML and PNG use the same source-coordinate placement metadata. Library stills use their mapped face bounds to choose a small clear corner, then split longer dialogue into additional illustrated frames. The Studio offers frame navigation; the readers and PNG export paginate every continuation. Art without either a pocket or a face map requires a reviewed lettering layout and cannot export dialogue until one exists. No external dialogue rails are used. The live art prompt also explicitly bans generated lettering and preserves natural object colours.

Atlas cells render at their actual image proportions, contained inside the available frame. Palette previews show four complete painted variants of the same sample scene when a live still has no variants. They do not imply that a legacy live still has already been repainted.

The separate manual Jynxzi test is documented in [JYNXZI_QA.md](JYNXZI_QA.md) and served locally at `/qa/jynxzi/index.html`. Its one-off generated PNG contains baked lettering; production panel lettering stays editable.

## Verification

13 focused Node tests and four Playwright tests pass. Typecheck, ESLint and production web build pass. Desktop 1242px and phone 390px checks cover Studio, Director, recap and manga reader with no horizontal overflow or page errors. Page and cover PNG exports were generated and visually inspected. Evidence is under ignored `artifacts/tmp/local-demo/`.
