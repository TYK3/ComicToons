# Stream → evidence → comic episode

Updated 2 November 2026, Europe/London. This supersedes the earlier separation of manga stories from comic-book highlights.

## Product model

Comic and manga use one sequence of story pages. A verified moment becomes a 4–6-panel page. Pages form an episode, episodes form chapters, and chapters form a collected volume. A highlights catch-up is a separate short preview, not a different definition of comic. The author can revise the storyboard and later assemble the collection. The sample episode and book now share all 20 scenes; the reader offers 4, 5 or 6 panels per page.

## Actual Jynxzi trial

The owner authorised reading https://www.twitch.tv/jynxzi. The app joined public IRC over TLS using the existing Twitch connection. It posted no messages, did not follow the account, and did not create any Twitch clips. Before the required server restart, the local session admitted 1,377 messages and made 14 drafts. Its source snapshot was saved in ignored artifacts/tmp/local-demo/jynxzi-before-restart.json. This is bounded evidence, not a full transcript. The owner’s existing OAuth session was reconnected after restart and Jynxzi reselected.

Observed draft provenance was library artwork. Some selected chat lines were questions, emotes and general audience remarks. The template writer made generic scenes. Those images cannot establish what Jynxzi actually did or said.

The live /#/flow screen and GET /api/story-flow expose current counters, retained evidence, source message IDs, detector signals, draft provenance and missing production stages. Captured quotes are Chat, never attributed to the streamer. No credentials or viewer account names are added by this endpoint.

## Current detection, exactly

- Input admission deduplicates events, respects deletes and opt-outs, and rate-limits accepted events to 60/second. The inspector shows throttling because this affects measured velocity.
- Spike: at least six messages from three distinct users in ten seconds, at least three times the trailing baseline (up to 120 seconds, excluding the current ten-second window), after 30 seconds of warm-up.
- Burst: three distinct users repeat a recognised token within eight seconds. Tokens include KEKW, LUL, PogChamp, Pog, W, GG, F and clip it. A 30-second cooldown prevents repeatedly opening the same burst.
- Clip cluster: three distinct polled clips within 120 seconds; a 120-second cluster cooldown. The current public-channel mode deliberately disables clip polling and the owner’s EventSub events for other channels, so this signal is unavailable for Jynxzi in this mode.
- Routine chat also makes bounded one-minute summary drafts. These are NOT highlight detections. The inspector distinguishes them.
- Existing moment scores are sums of per-event weights, not a model confidence probability. The inspector reports retained evidence counts; moments retain at most 60 events.

This is a candidate detector, not an understanding model. In a large channel a three-user W/GG burst is weak evidence. It should not automatically become a “must clip” call. No automatic clip creation was added.

## Required faithful scene pipeline (not yet implemented)

1. Acquire permitted source footage for the candidate, including lead-in and aftermath. Keep timestamped source frames. A Twitch page URL, clip title or thumbnail is insufficient to reconstruct six actions.
2. Transcribe the streamer’s audio with timestamps and speaker attribution. Distinguish the streamer, teammates, game audio and Chat. Review uncertainty and profanity; never invent direct quotations.
3. Analyse frames and transcript together: actors, setting, visible actions, key objects, scoreboard/outcome, changes in expression and chronology. Align chat with video after accounting for delay. Separate observation from inference.
4. Rank a candidate using the verified scene plus independent reactions (velocity, distinct viewers, explicit clip requests, existing clips). Check novelty, context, ambiguity and spam. Mark strong candidates for author review; avoid fabricated numeric confidence.
5. Build a four-to-six-panel storyboard. Six-panel structure: establishing situation → tension → action → turning point → reaction → resolution. Four panels may combine setup/tension and reaction/resolution. Each panel must point to its source timestamp/frame and verified dialogue. Do not pad short moments with made-up events.
6. Have GPT or another image model illustrate the approved storyboard, using reference frames and a consistent character sheet. The actual art-provider pipeline currently uses Cloudflare/Pollinations/frame/library fallbacks; a production GPT vision/transcription/image integration has not been added by this unit.
7. Place editable balloons in reviewed negative-space pockets inside the artwork. Review faces, hands, important action, reading order, exact dialogue and continuity. Recompose, shorten or split when text does not fit. Export after author approval.
8. Store stable page/episode/chapter/volume identities and editable revisions. The new inspector supports a local storyboard draft and production-brief JSON export; it is not a complete backend collection editor.

## Generation rules implemented now

The shared contract is packages/core/src/story-flow.ts (COMIC_GENERATION_RULES); the inspector displays it and includes it in the production brief. The live/import art prompt now explicitly preserves known actions and reserves irregular background pockets within the scene, protecting faces, hands and key action. It produces artwork without baked text so final in-image lettering remains editable.

Sample balloon pockets have been visually reviewed against their art sheets and are shared with PNG rendering. No outside caption rails appear on those reviewed samples. Legacy/live panels without a reviewed placement map retain the safe fallback; there is no automatic face detector, and this unit does not claim otherwise. Actual sample pages demonstrate the intended comic composition. They are fictional samples, not Jynxzi footage.

## Verification

33 focused Node tests and six Playwright tests pass. Typecheck, lint and web build pass. The reader retains every scene at all three page sizes. Desktop/phone layouts and PNG output were checked. Screenshots: artifacts/tmp/local-demo/in-panel-{tabletop-night,speedrun-fail,irl-cooking}.jpg and story-flow*.jpg. Full gate remains maintainer-owned per AGENTS.md.

## Twitch references

- Chat interfaces: https://dev.twitch.tv/docs/chat/
- Clip retrieval and creation (creation requires its own authorisation and publishes a clip): https://dev.twitch.tv/docs/api/clips/
