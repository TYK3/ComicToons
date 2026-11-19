# BACKLOG.md
Each item: id · description · owner role · acceptance criteria · status

## P0 (blocks demo) — Tier 1 / M1: end-to-end on sample data (by Wed Oct 28 23:59 London)
- E1 · Repo scaffold, scripts, lint, tests, CI-style `npm run gate` · Lead · `npm ci && npm run gate` passes on fresh clone · done (M1 mock scope; npm run gate green 2026-10-27)
- E2 · Core types + fixtures (tabletop-night, speedrun-fail, irl-cooking; 20–45 min events each, safe invented chat) + replay engine (1×/10×/60×) · AI Pipeline / QA · replay unit tests · done (M1 mock scope; npm run gate green 2026-10-27)
- E3 · Moment scorer + windower with unit tests · AI Pipeline · scorer tests, golden top-K per fixture · done (M1 mock scope; npm run gate green 2026-10-27)
- E4 · Writer with mock provider + real provider interface (schema-validated JSON) · AI Pipeline · schema + injection tests · done (M1 mock scope; npm run gate green 2026-10-27)
- E5 · Mock image provider with small pre-generated, license-clean art set · Image & Art · mock strip instant · done (M1 mock scope; npm run gate green 2026-10-27)
- E6 · Overlay: shows strips live from replay; basic ink-in animation · Frontend Overlay · Playwright screenshots 1920×1080 · done (M1 mock scope; npm run gate green 2026-10-27)
- E7 · Dashboard: start/stop replay, approval queue, style picker (2 styles) · Frontend Dashboard · e2e · done (M1 mock scope; npm run gate green 2026-10-27)
- E8 · Recap Issue page + share card export from a replay · Frontend Dashboard & Recap · non-empty PNG + page renders · done (M1 mock scope; npm run gate green 2026-10-27)
- E9 · `npm run demo` one-command experience + README quickstart · Docs/Lead · fresh clone → demo works with no keys · done (M1 mock scope; npm run gate green 2026-10-27)
- M1 acceptance: fresh clone → `npm ci && npm run demo` → browser opens dashboard → play tabletop-night at 60× → overlay URL shows panels → "End stream" → Recap page + PNG share card exist. No keys.

## P1 (wow) — Tier 2 (Thu Oct 29)
- E10 · Twitch OAuth + EventSub live ingestion, reconnect, token refresh · done (apps/server/src/twitch/, apps/server/src/eventsub/)
- E11 · Chat commands `!recap` `!ink` `!noink` `!moment` (mods) · todo
- E12 · Real LLM writer (structured outputs, retries, schema validation, cost log) · todo
- E13 · Real image provider: queue, retries, budget cap, cache, fallback art · done (apps/server/src/pipeline/imagegen.ts, library.ts)
- E14 · Safety pass + moderation controls + panic switch (`!panelstop`, dashboard kill switch) · todo
- E15 · Live test script / harness simulating chat · todo

## P1 (wow) — Tier 3 (Fri Oct 30)
- E16 · "PREVIOUSLY ON…" raid/late-joiner strip · todo
- E17 · `!ink` cast system + consistent characters · todo
- E18 · Chat pulse meter + spike-triggered panel · todo
- E19 · Style Bible editor + 4 art styles · todo
- E20 · Recap Issue v2: cover, Moment of the Stream splash, 9:16 and 4:5 share cards, OG image, static export, caption + hashtags · todo
- E21 · Demo Director panel (fake raid, hype train, chat burst, sub gifts) · todo
- E22 · Motion, sound option, reduced-motion, alt text, transcript · todo
- E23 · 60-second OBS setup wizard · todo

## P2 (hardening / submission pack) — Tier 4 (Sat–Mon)
- E24 · Chaos tests (reconnects, 429s, timeouts, 1,000 msg/min, emoji/RTL/non-English, duplicates, empty stream) · todo
- E25 · Accessibility, performance (<5% idle CPU), 2-hour soak at 60× · todo
- E26 · Security review (XSS, prompt injection, secret scan, npm audit) · todo
- E27 · Fresh-clone test in clean container; README, architecture doc, troubleshooting · todo
- E28 · docs/CODEX_LOG.md finalized · todo
- E29 · Devpost description, 3-minute video storyboard, shot list · todo
- Stretch: Create Clip integration; multi-language captions; one-command recap hosting · todo
