# SPEC — ComicToons (Stream Recap Comic)
Codex x TwitchCon Hackathon. Built Oct 23 – Nov 2, 2026. Deadline Nov 2, 2026 2:00 PM PT (feature freeze Oct 31 18:00 London).

## 1. Product
ComicToons turns the last few minutes of a Twitch stream into comic panels shown live in an OBS browser-source overlay, so raided and late-arriving viewers instantly get context, and at stream end it generates a shareable Recap Issue.

Judging (equal weight): Innovation · Impact · Technological implementation (incl. Codex use) · Design (easy and fun to watch).

### Core flows
1. Streamer setup (≤2 min): dashboard → Connect Twitch → pick art style → add OBS Browser Source URL → go live.
2. Live: events stream in → every N min (default 4; demo 30s) pick best moments → 3–4 panel mini-strip → generate art → overlay inks in the strip, then tucks it into a corner ticker. Approval mode (default first run) or auto mode.
3. Raid / late joiner: raid or `!recap` shows "PREVIOUSLY ON THIS STREAM…" with last few panels, naming the raiding channel.
4. Chat participation: `!ink` opts in to be drawn as a character; `!noink` opts out (always wins). Default anonymous cast.
5. After stream: one click → Recap Issue (cover, best moments, Moment of the Stream splash, share cards 1080×1350 and 1080×1920, standalone web page, OG image).

### Wow list (all by Tier 3)
Ink-in halftone/ink-stroke animation with "inking…" placeholder · PREVIOUSLY ON strip · `!ink` cast with consistent looks · live chat pulse meter that triggers a panel on spike · Style Bible (art style, avatar description/reference, palette) · Recap Issue with cover + splash + share cards · Demo Director (fake raid / hype train / chat burst / sub gifts) · accessibility (alt text, transcript, reduced-motion).

### Non-goals
Twitch Extension, audio/video analysis, accounts/billing, mobile app.

### Priority tiers
T1 end-to-end on sample data, zero keys → T2 real Twitch + real images → T3 wow polish → T4 hardening, docs, video, submission. Never skip ahead while a higher tier is red.

## 2. Hackathon constraints
- Must connect to Twitch (chat, overlay, API, EventSub). Overlay = OBS Browser Source + EventSub.
- Newly built in the window; standard libs/templates OK.
- Submission: repo URL, description incl. Codex use, YouTube video <3 min showing it working on Twitch and how Codex built it.
- Repo must run from a fresh clone; never commit keys; document env vars.

## 3. Architecture
Stack: TypeScript monorepo (Node 20+). `apps/server` (Fastify + `ws`, SQLite via better-sqlite3, in-process persisted job queue), `apps/web` (Vite + React; routes `/dashboard`, `/overlay` (OBS uses ui.html#/overlay), `/r/:streamId`, `/demo`), `packages/core` (types, windowing, scoring, prompt builders, provider interfaces + mocks), `fixtures/` (sample streams + pre-generated art), `exports/` (static recap bundles).

Twitch ingestion: EventSub WebSocket `wss://eventsub.wss.twitch.tv/ws` following the Example Chatbot guide. Subscribe: `channel.chat.message` (scope `user:read:chat`), `channel.raid` (`to_broadcaster_user_id`), `channel.chat.notification`, `channel.cheer`, `channel.hype_train.begin/end`, `stream.online/offline`. Handle `session_welcome`, `session_keepalive`, `session_reconnect`, `revocation`, token refresh, duplicate message IDs.

Pipeline (each stage a pure function with provider interface + mock):
1. Collector → normalized events into SQLite.
2. Windower + Moment Scorer (deterministic): chat velocity z-score, emote bursts, unique chatters, raid/sub/gift/cheer/hype-train events, `!moment` mod marks → top-K moments.
3. Writer (LLM, structured JSON): `{issueTitle, panels:[{caption, dialogue[], scene, characters[], mood, altText}], safetyFlags}`. Dialogue is paraphrased chat, never verbatim slurs/personal data.
4. Safety pass: rules + LLM. Drop/redact PII, harassment, slurs, real-person likeness, sexual/violent content. Honor `!noink`.
5. Art Director: image prompts with STYLE LOCK + character sheets. Images contain no text; bubbles/captions are HTML.
6. Image queue: parallel, retries/backoff, timeout, fallback to caption-only/placeholder, cost cap per hour and stream, content-hash cache.
7. Assembler: panels → strip layout (HTML/CSS) → overlay via WebSocket; overlay rehydrates from `/api/state`.
8. Recap builder: at `stream.offline` or button → Recap Issue static bundle + share cards (satori/resvg or Playwright screenshot) + OG image.

Image models: fast model for live strips, quality model for recap cover/splash (check the image provider's docs for current IDs; keep in env vars). Generation takes seconds → asynchronous with "inking…" placeholders.

Mock mode (required): every provider has a mock. `npm run demo` works with zero keys using fixtures and pre-generated art.

Fixtures: ≥3 sample streams as JSON event logs: `tabletop-night`, `speedrun-fail`, `irl-cooking`; 20–45 min each; replay at 1×/10×/60×. Event format:
```json
{"id":"tabletop-night","streamTitle":"...","streamer":{"displayName":"...","avatarDescription":"..."},
 "events":[{"t":12,"type":"chat","user":"u1","name":"Chatter1","text":"..."},
           {"t":301,"type":"raid","from":"SomeChannel","viewers":42},
           {"t":640,"type":"hype_train_begin","level":1}]}
```
Safe, original, invented chat text only.

Env vars: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL`, `IMAGE_BUDGET_PER_HOUR`, `MODE=live|mock`.

## 4. Safety, privacy, moderation
- Chat is untrusted input: escape on render, strip HTML, delimit in prompts with an instruction that it is data; test prompt-injection.
- Anonymous cast by default; names only for `!ink` opt-ins; `!noink` always wins.
- No real-person likeness, no minors-related imagery issues, no sexual/graphic violence, no hate; fall back to neutral panels.
- Approval mode default on first run; auto is opt-in.
- Panic: dashboard kill switch + `!panelstop` (mods) hides overlay instantly.
- Hard caps on image count/spend per hour and per stream; show remaining budget.
- Store minimal data; recap bundles contain only approved/safety-passed content.

## 5. Quality gate (`npm run gate`)
Typecheck, lint, unit tests, contract tests on recorded Twitch payloads, Playwright e2e (plays tabletop-night at 60×, overlay panels appear, recap renders, share PNG non-empty, screenshots to artifacts/), secret scan, `npm audit` (no high/critical without waiver), fresh-clone smoke test.

## 6. M1 acceptance (Wed Oct 28 23:59 London)
Fresh clone → `npm ci && npm run demo` → browser opens dashboard → play `tabletop-night` at 60× → overlay shows panels → "End stream" → Recap page + PNG share card exist. No keys.
