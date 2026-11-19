# Protected art and lettering maps

All sixteen original1280x720 WebP assets were visually inspected in four 2x2 contact sheets (JPEG1280px wide). Each manifest entry records its exact sheet/cell, observation and method. Boxes use percentages of the original uncropped image, x from the left and y from the top. Bounds are conservative visual estimates rounded outward, not claimed automated face detection. `faceBox` marks the dominant visible head/face (including a silhouette where relevant); `faceBoxes` also includes Pixel where visible; `subjectBox` includes the main figures and important scene props.

## Placement policy

None of these densely composed images has an approved in-image lettering region. `bubbleZones` and `sfxZones` are deliberately empty. `captionZone = {x:0,y:100,width:100,height:"auto"}` means an expanding rail immediately below the image, not a fixed-height rectangle inside it. Every dialogue line, SFX, panel number, caption and timestamp uses that rail. Unknown or procedural art also fails closed to a rail; the renderer never claims an unmeasured in-image text fit. A future in-image placement requires a newly reviewed safe zone and verified complete text fit before enabling it.

The image frame stays16:9, so CSS `object-fit:cover` shows the full16:9 source without cropping. The rail wraps full English/RTL/emoji text, grows with its content, and contains no ellipsis or dialogue shortening. The queue thumbnail label and recap sticker also live outside the art. Both standalone HTML and share HTML use the same protection. PNG export captures the full document; longer issues may exceed the preferred1350px height instead of cutting off text.

## Per-asset derivation

Box notation: x,y,width,height as percentages. Every row has no approved bubble/SFX image zones and uses the expanding caption rail.

| Asset | Face box | Subject box | Sheet/cell | Visual observation |
|---|---|---|---|---|
| panel-01-stream-start.webp | 43, 24, 21, 31 | 13, 7, 85, 89 | 1/1 | Nova leans toward the desk; Pixel sits lower left; emote faces fill both margins. |
| panel-02-clutch-comeback.webp | 44, 23, 17, 28 | 25, 0, 65, 100 | 1/2 | Raised arms reach the top edge; Pixel and the trophy fill the lower right and centre. |
| panel-03-boss-fight.webp | 26, 25, 23, 36 | 0, 4, 100, 96 | 1/3 | Nova and Pixel occupy the left half; the boss and monitor are the main subject on the right. |
| panel-04-funny-fail.webp | 36, 17, 18, 29 | 4, 1, 91, 97 | 1/4 | The falling body, thrown headset and controller spread across the frame; Pixel is lower left. |
| panel-05-raid-arrives.webp | 29, 29, 12, 18 | 0, 14, 100, 86 | 2/1 | The back of Nova’s head and Pixel lead a crowd across the bridge; crowd faces and the destination are story content. |
| panel-06-hype-train.webp | 29, 23, 13, 24 | 0, 8, 100, 92 | 2/2 | Pixel drives the engine at left; Nova watches at far right; the train spans the entire frame. |
| panel-07-donation-sparkle.webp | 29, 16, 18, 30 | 17, 0, 68, 100 | 2/3 | Nova, Pixel, coins and the opening gift occupy the centre; animated crowd faces fill the edges. |
| panel-08-rainy-chill.webp | 41, 9, 16, 35 | 27, 0, 73, 100 | 2/4 | Nova’s profile is upper centre and sleeping Pixel lower right; rain and window establish the quiet scene. |
| panel-09-emote-storm.webp | 39, 27, 17, 28 | 0, 0, 100, 100 | 3/1 | Nova and Pixel sit centrally; a foreground/background emote vortex makes every image region narrative content. |
| panel-10-jump-scare.webp | 23, 21, 12, 22 | 3, 0, 97, 100 | 3/2 | Nova recoils on the left and Pixel is below; the large ghost and reaction pose fill the remaining image. |
| panel-11-speedrun-record.webp | 44, 21, 18, 28 | 19, 5, 61, 95 | 3/3 | Nova runs through the finish ribbon centrally and Pixel runs at lower left; speed lines carry the action. |
| panel-12-cooking-chaos.webp | 30, 15, 19, 32 | 4, 2, 96, 96 | 3/4 | Nova cooks centrally; Pixel peeks from the left pot; flames, flying food and camera fill the right. |
| panel-13-jam-session.webp | 44, 9, 13, 18 | 15, 0, 73, 100 | 4/1 | Nova’s face is above the guitar; Pixel sits by the drums; instruments and audience silhouettes are protected. |
| panel-14-neon-city-walk.webp | 43, 6, 11, 18 | 27, 0, 42, 100 | 4/2 | Nova walks centrally with a camera pole to the right; Pixel walks lower left; city reflections remain visible. |
| panel-15-sunset-goodbye.webp | 31, 16, 14, 24 | 23, 8, 49, 84 | 4/3 | Nova waves over one shoulder on the left; Pixel sits to the right; sunset and crowd form the farewell. |
| panel-16-to-be-continued.webp | 30, 2, 9, 13 | 0, 0, 100, 100 | 4/4 | The head is a small upper-left-centre silhouette; the full silhouette, moon, ledge and landscape are the main subject. |

## Verification contract

Unit tests validate every map, coordinate bounds, derivation notes and provider propagation. Playwright projects manifest percent boxes into each rendered image frame, checks all lettering against every face/subject box, and applies the stronger rule that no lettering intersects any part of the art. It checks original image dimensions, frame ratio, full dialogue equality, text-line and ancestor clipping, rail collisions and horizontal reflow. All 16 assets are exercised in studio/overlay/recap/standalone/share at 390/1440/1920:240 asset/view/width combinations. English and an additional RTL/emoji dialogue line are preserved in every combination.

M1 additionally compares the actual API-produced PNG dimensions with the rendered full share document. Bounded viewport JPEGs are visual evidence; they are not represented as full-document images. Per-case results are written to artifacts/ui-after/lettering/*-results.json. Final executed results and design-review verdict are recorded in STATE.md and docs/UI_AUDIT.md.

## Design notes: overlay catch-up and split frames (F2)

- **390px overlay catch-up stacks its panels (accepted deviation).** At widths of 600px and below the "Previously on…" catch-up shows its three panels in one column above the footer, not as a three-panel strip across the bottom third with the centre left clear. Three side-by-side panels at 390px are too small to read, so the stacked layout is the accepted mobile treatment. It differs from the wide-screen strip and from the 390px reference shot; the 1440px layout is unchanged. Each stacked panel keeps its "Generated caption" label and its "Generated art · SAMPLE" source label; only the decorative sound effect is hidden at this width.
- **Panels with no dialogue still appear.** A story panel with no dialogue gets one frame per beat: the opening beat is narrated by the panel caption, later silent beats are art only. No approved moment is dropped from a manga page.
- **Split frames vary their framing.** When a panel has more than two dialogue lines it is split into frames of at most two balloons. The first frame shows the whole illustration; each continuation pushes in on a different focal point (zoom 1.3 or more, cycling upper-right, lower-left and centre), so no two frames of a split panel show an identical image. The crop rules live in the shared manga styles and key on the frame id, so React, standalone HTML and PNG output match.
