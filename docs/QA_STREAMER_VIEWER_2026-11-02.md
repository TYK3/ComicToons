# Streamer / Viewer QA — 2 November 2026

## Real ten-minute capture

Stream: https://www.twitch.tv/lacy. Twitch Helix reported it live before capture; Jynxzi and the other initially checked named channels were offline.

Started: 02/11/2026, 13:21:03 Europe/London. Finished: 02/11/2026, 13:31:03 Europe/London. Duration: **600 seconds**. **60 advancing video frames; 860 admitted chat lines.** The screenshots show the actual people and restaurant scene, not a profile photo, thumbnail or library illustration.

| Minute | Actual frames | Retained eligible chat lines |
|---|---:|---:|
| 1 | 6 | 66 |
| 2 | 6 | 118 |
| 3 | 6 | 51 |
| 4 | 6 | 51 |
| 5 | 6 | 49 |
| 6 | 6 | 125 |
| 7 | 6 | 151 |
| 8 | 6 | 58 |
| 9 | 6 | 94 |
| 10 | 6 | 78 |

Raw evidence: artifacts/qa/live10/capture-report.json. Source references: artifacts/qa/live10/references/. Actual Viewer screenshots: artifacts/qa/live10/real-viewer-1242.jpg and real-viewer-390.jpg. API keys are not in these reports.

## Verification matrix

| Function | Result | Evidence type |
|---|---|---|
| Viewer selection; no broadcaster controls | PASS | Browser UI and API tests |
| Viewer denies approve/hide/ingest/polls/end/state APIs | PASS | Real Fastify routes with controlled session |
| Other-channel link switches to Viewer | PASS | Browser integration test; no broadcaster write |
| Own-channel URL validation, sign-in prerequisite, stop | PASS | Browser integration test |
| Streamer owner-only capture and review before release | PASS | Controlled Twitch auth and capture integration |
| Actual public Twitch playback capture | PASS | Real Lacy ten-minute run |
| Actual public Twitch chat admission | PASS | Real run: 860 admitted lines |
| Scene frame and chat references; chronology validation | PASS | Controlled provider tests |
| Generated page face/source/lettering hold | PASS | Controlled successful and rejected review responses |
| OpenAI/Gemini settings, model and page limit | PASS | Browser settings tests; reference request integration |
| Key expiry, no key persistence, no hidden fallback | PASS | Node tests and browser-storage assertions |
| Evidence restored after server restart | PASS | Real 60-frame / 860-line restored session and Node test |
| Complete comic pages stay whole in collection layout | PASS | Reader/book/manga grouping tests |
| Samples: gradual replay, Release, Accept all | PASS | Browser integration |
| Samples: votes, Ink Me, prediction, panic preview | PASS | Browser integration; no Twitch API posts |
| Accepted-panel newcomer live update | PASS | Two-window browser test |
| Palettes, face-clear Jynxzi lettering, phone layouts | PASS | Browser tests and screenshot review |
| Real paid Gemini analysis/image/review | WAITING FOR KEY | No real provider key saved at capture completion |
| Live own-channel poll/reward/prediction / OBS in broadcast | NOT EXERCISED | No connected live owner account during this QA |
| Speech transcription | UNAVAILABLE | Capture uses video frames and matching chat only |

## Analysis and image flow

Capture actual playing video every ten seconds and record local receipt timestamps plus player video time. Retain matching read-only IRC chat, excluding commands and withdrawn/opted-out lines. After four distinct frames, analyse the latest four to six frames and nearby chat. Subsequent scans are spaced two minutes apart and obey the session attempt limit. A candidate highlight requires a visible supported turning point; quiet observed recaps are labelled separately. The model must reference existing frame/chat IDs in chronological order.

The selected image provider receives those frames as references, the supported storyboard and exact selected chat quotes. No audio means no invented streamer speech. Palette rules preserve natural character colours. The generated page is checked against its source frames for face, hands/action, lettering, chronology and appearance. Held/failed pages are not displayed as finished comics. Viewer displays accepted pages automatically; Streamer pages enter review. Provider errors never silently choose library artwork or a different provider.

All generated output is labelled an AI interpretation of captured evidence. Automated review is not a guarantee of factual or visual perfection. Stream delay can affect chat alignment.

## Test runs and scope

20 focused Playwright checks and 27 focused Node checks passed; typecheck, lint and web production build passed. The final Node checks also cover credential-free public session identifiers and complete-page export without duplicate dialogue rails. Full maintainer gate was not run under AGENTS.md's building-agent role. No Git commit or push. The landing layout was not redesigned.

Real image generation is not marked passed until the user's session key is saved and the actual output is inspected. A generated manual/sample image is not substituted for this missing step.

Session keys are held in server memory for at most one hour and forgotten on restart; neither browser storage nor saved evidence contains the key. Public session identifiers differ from the private HTTP-only session cookie. Captured evidence survived the final runtime reload, with 60 frames and 860 admitted lines intact. No unattended paid-generation helper remains running.

Generated dialogue is baked into the complete page image. Changing a Studio caption changes metadata; it does not rewrite that image's embedded dialogue. Audio transcription and a real broadcaster's live participation/OBS run remain outside the verified results above.

## Provider references

OpenAI reference-image edits: https://developers.openai.com/api/reference/resources/images/methods/edit
Gemini reference-image generation: https://ai.google.dev/gemini-api/docs/generate-content/image-generation
Twitch player documentation: https://dev.twitch.tv/docs/embed/video-and-clips/
