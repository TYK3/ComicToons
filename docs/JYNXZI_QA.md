# Jynxzi reference and chat-inspired QA — 2 November 2026

User-approved scope: correct in-picture dialogue, full palette previews and sample picture proportions; restore unrequested landing copy changes. Jynxzi is a separate QA case, not landing content. Existing landing layout and unrelated auth/ingest work are preserved.

## Inputs and selection

### Permission check — 2 November 2026

Consent for ComicToons sample distribution or reference-image AI adaptation is **not established**. No consent record was found in these QA notes. Jynxzi's public About page was inspected at https://www.twitch.tv/jynxzi/about; it displayed the business contact jynxzi@rightclick.gg, with no explicit clipping/reuse/AI-adaptation permission statement found in the inspected content. This absence does not prove refusal, but cannot be recorded as permission.

Twitch's Clip Settings are managed in the broadcaster's private Creator Dashboard. Twitch-native clipping eligibility can depend on enabled clips, category exclusions, follow duration, subscription and user restrictions. Current eligibility for our account was not confirmed by creating a clip; none was created or published. Existing clips or a public recording do not establish permission for this application's separate AI sample use.

Official references: https://help.twitch.tv/s/article/clips-settings and https://help.twitch.tv/s/article/how-to-use-clips. Before describing this as a consented sample, obtain a documented creator authorization covering the intended reference-image processing and sample distribution, or use owned/explicitly licensed material. This check does not remove or publish any existing assets.

- Appearance reference: https://www.twitch.tv/videos/2917030838, opened from https://www.twitch.tv/jynxzi. Browser capture around VOD 00:02:28; black shirt, short light brown hair and teal/dark headphones. The recording was used for appearance only.
- Captured chat: “he said i’m cheating because i killed him once lmao”. Message `f1d9a53d-0e84-472a-9f57-a9c1f7eac299`; capture offset 1020.139 seconds, not a VOD timestamp.
- Moment `irc-c8e95def-8636-43f4-8d48-81cd90e8f02b-23`: ordinary chat, score 4, candidate false, four messages/four users, ends 1022.117 seconds. The author selected this quote for QA; the detector did not identify a verified highlight.
- Original draft paired this quote with sunset library art and three unrelated chat lines. Only the selected quote informs the QA story.

## Generated output

Built-in `image_gen` mode, reference image supplied. Six panels: desk focus → original virtual avatar action → single game elimination → retained CHAT quote → silent amused reaction → next round. Actions, setting, game display and narration are an authored interpretation. There is no verified time alignment or speech transcript for this chat excerpt.

Files served by the app:

- `apps/web/public/qa/jynxzi/index.html`: separate evidence walkthrough at http://127.0.0.1:4122/qa/jynxzi/index.html.
- `six-panel-page.png`: selected final image, copied into the workspace from the built-in output.
- `reference-channel.png`: original browser reference capture.
- `generation-prompt.txt` and `revision-prompt.txt`: exact prompt set. Revision removes logos and the tail toward the streamer so the quote belongs to chat.

Original generated drafts and retained source panel/flow snapshots remain under ignored `artifacts/qa/jynxzi/`. The generated QA image has baked lettering and is a demonstration, not an integrated automatic GPT image provider. The app currently reports automatic video analysis, speech transcription and automatic scene-page generation as unavailable.

## Visual review

Six sequential panels, consistent appearance, full-colour scenery, quote completely inside panel four, CHAT attribution, clear faces and hands. No copied clothing/chat logos in the selected version. The report labels the page as interpretation. The revised PNG omitted the requested footer; the surrounding QA report and download filename carry that label.

The landing hero, featured carousel and issue shelf use sample content while reading another channel. No Jynxzi page or link is inserted into landing content. Original “Comic book” and “Manga series” copy and destinations are restored.
