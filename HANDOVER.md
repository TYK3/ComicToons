# ComicToons: handover brief

This brief lets a fresh coding session pick up ComicToons from the GitHub repo, with no earlier conversation. It was rewritten on 1 Nov 2026 at about 15:00 London time (GMT) against `main` at commit `8cb54bb9283b4a48272d9a75dd420b440a125f5f`, and lands in a docs-only commit on top of it. Every fact about the code was checked against that tree. Wherever it says GAP, the point could not be verified or is still open. Paths are given instead of transcripts, so read the file a line points to. Commit hashes below are the pushed (rewritten) hashes; older notes kept outside the repo, and some files in the repo, still quote pre-rewrite hashes that do not exist in the pushed history (see section 8).

## 1. What ComicToons is

- ComicToons, previously called PanelCast, is a Twitch tool. It turns the best moments of a stream into manga-style comic panels while the stream is still live.
  - The streamer approves, edits or rejects each panel in the **Studio**.
  - Approved panels appear live in a transparent **OBS overlay** (`ui.html#/overlay`).
  - At the end of the stream the approved panels become a **Recap Issue**: manga pages, page PNGs, a PNG share card and a standalone HTML export.
  - **Make a comic from a link:** a Twitch clip, VOD or channel link can be turned into panels (`POST /api/import`, `docs/make-from-link.md`).
- It was built for the Codex x TwitchCon hackathon. The deadline is **2 Nov 2026, 14:00 PT** (`AGENTS.md`).
- It works with no keys at all. Three invented sample streams (`fixtures/tabletop-night.json`, `fixtures/speedrun-fail.json`, `fixtures/irl-cooking.json`) replay through the same pipeline as a live stream, and the art comes from a bundled library.
- **Where the code lives:** https://github.com/TYK3/ComicToons, a **private** repo. Default branch `main`; when this was written it was `8cb54bb` with 245 commits, plus this docs commit. Every commit is authored and committed as `TYK3 <atyt1u21@soton.ac.uk>`. There is no licence file. Only `main` was pushed; no side branches and no tags. The older repo `TYK3/panelcast` was left untouched and is not the source of truth.
- Product and design sources: `README.md`, `PRODUCT.md`, `DESIGN.md`, `docs/SPEC.md`, and the delivery history in `STATE.md`.

## 2. Architecture and key-file map

The repo is an npm workspaces monorepo: `apps/server` (Fastify API), `apps/web` (Vite and React) and `packages/core` (shared model). 531 tracked files.

| Area | Key files |
|---|---|
| Server entry and routes | `apps/server/src/index.ts`, `app.ts` (createApp, SSE `/api/events` with a 10 s heartbeat and a backpressure-aware writer, guards), `studio.ts` (the Studio state machine: replay or live, approval queue, clock, stream-end handling, art upgrade), `env.ts` |
| Live ingest | `apps/server/src/ingest/irc.ts` (read-only IRC, including WSS), `ingest/source.ts` (chat source, EventSub/IRC hand-over, privacy, rate and dedup gate), `ingest/clips.ts` (clip lookup and allow-listed clip and thumbnail URLs) |
| Twitch auth and APIs | `apps/server/src/twitch/` (`oauth.ts`, `token-store.ts`, `config.ts`, `routes.ts`), `eventsub/` (WebSocket bridge and subscriptions), `twitch-api/` (`helix.ts`, `switching.ts`, `errors.ts`) |
| Make from a link | `apps/server/src/import/` (`routes.ts`, `caps.ts`, `helix.ts`, `urls.ts`, `panels.ts`, `chatlog.ts`, `results.ts`, `errors.ts`) and the channel series store `apps/server/src/series/` (`store.ts`, `routes.ts`). Web card: `apps/web/src/ui/screens/studio/MakeFromLink.tsx` |
| Participation | `apps/server/src/participation/`: `commands.ts` (`!ink`, `!noink`, `!optout`), `ink-chat.ts` (the `!ink` fallback), `rewards.ts`, `polls.ts`, `predictions.ts`, `director.ts`, `routes.ts` |
| Story and art pipeline | `apps/server/src/pipeline/moments.ts` (moment detection), `writer.ts` (scene and caption), `imagegen.ts` (`ArtPipeline` and `buildPanelArtPrompt`), `frames.ts` (clip-frame inking), `library.ts` (bundled art fallback) |
| Recaps and export | `apps/server/src/recaps.ts`, `export.ts`, `comics/routes.ts` |
| Access control | `apps/server/src/director-access.ts`, plus the director-key contract in `docs/twitch-setup.md` |
| Shared core | `packages/core/src/`: `theme.ts` (4 colour themes), `manga.ts`, `lettering.ts` (face-safe lettering zones), `story.ts`, `art.ts`, `ingest.ts`, `twitch.ts`, `env.mjs` (env names and the legacy `PANELCAST_*` prefix) |
| Web app | `apps/web/src/` (React and Vite): landing page, Studio, Overlay (`ui.html#/overlay`), Recap and manga reader, Output, Connect (`ui.html#/connect`). Sample sets are in `apps/web/public/samples/` |
| Tests | `tests/` (node:test units and Playwright specs), `tests/obs/` (OBS suite), `tests/import-wire/` (import e2e against a fake Twitch), `scripts/twitch-mock/` (fake Twitch harness), `scripts/run-tests.mjs` |
| Scripts | `scripts/demo.mjs` with `demo-spawn.mjs` and `demo-ports.mjs`, `secret-scan.mjs`, `fresh-clone.mjs`, `preflight-live.ts`, `trial-run/`, `build-samples.ts` |
| Docs | `docs/twitch-setup.md`, `docs/live-ingest.md`, `docs/make-from-link.md`, `docs/LIVE_TEST.md`, `docs/OBS_SETUP.md`, `docs/LETTERING_MAPS.md`, `docs/manga-colour-themes.md`, `docs/DEPENDENCIES.md`, `docs/ingest-chaos.md` |

## 3. How to run it

You need Node 20 or later and npm. Install exactly the locked versions with `npm ci`.

```sh
git clone https://github.com/TYK3/ComicToons && cd ComicToons
npm ci
npm run demo
```

| Command | What it does |
|---|---|
| `npm run demo` | Installs Playwright Chromium (network needed on first run), starts the server and web app, and opens `http://localhost:4173/`. No keys needed. It always opens a browser. |
| `npm run dev` | Starts the API on 127.0.0.1:3001 and Vite on 127.0.0.1:4173. Change them with `COMICTOONS_API_PORT` and `COMICTOONS_WEB_PORT`, set in the shell, not in `.env`. |
| `npm run check` | Typecheck, lint and unit tests. |
| `npm run e2e` | Playwright browser tests (`tests/playwright.config.ts`). Ports: `COMICTOONS_E2E_WEB_PORT`, `COMICTOONS_E2E_API_PORT`. |
| `npm run test:twitch -- --gate` | Fake Twitch harness on loopback, ports 3120 (app) and 4120 (fake) by default. Leave every Twitch client variable unset; the harness refuses inherited ones. |
| `npm run test:obs` | OBS browser-source suite. |
| `npm run e2e:import-wire` | Make-from-a-link e2e against a fake Twitch (`tests/import-wire/playwright.config.ts`). |
| `npm run gate` | The full gate, in this order: typecheck, lint, unit, fake Twitch (`--gate`), build, e2e, OBS, import-wire e2e, secret scan, `npm audit --audit-level=high`, fresh-clone build. |

- Other scripts: `npm run secrets`, `npm run fresh-clone`, `npm run smoke:twitch`, `npm run trial-run`, `npm run build:samples`, `npm run test:chaos`.
- Run gates keyless, with `COMICTOONS_ART_NETWORK` unset or `0`.
- Install the Playwright browser once with `npx playwright install chromium` if e2e or the gate reports it missing.
- On Node 20, npm prints `EBADENGINE` warnings for `@axe-core/playwright` and `cookie` (they declare Node 22). They are expected.
- On a shared or slow machine, run only one full e2e gate at a time.
- **Last full gate:** on the final pre-rewrite tree it exited 0: unit 768/768, fake Twitch 39 pass, 0 fail, 13 skipped, e2e 130 passed, OBS 11 passed, import-wire 8 passed, secrets ok, audit 0 high, fresh clone ok. QA then ran its own full gate on the exact tree `8cb54bb`, offline: exit 0 with the same counts; only the audit step was skipped because it was offline. The rewrite changed only 2 test lines (test-login names) against the gated tree.
- **Windows:** the Windows demo fix has landed (`fb54486`). `scripts/demo-spawn.mjs` starts npm through the shell on win32 only, with a plain-argument check, and the README has PowerShell run lines. Set env vars in PowerShell with `$env:NAME='value'`; they last for that window only. The scripts must work on Windows PowerShell 5.1 (no `pwsh`). A real run of `npm run demo` or the gate on Windows has never been done: GAP.

## 4. Environment variables (names only; values live in an untracked `.env`)

Copy `.env.example` to `.env` (git-ignored). Only the API server reads `.env`, at start-up. The web dev server and `npm run demo` read the shell environment only.

- **Ports and UI:** `COMICTOONS_API_PORT`, `COMICTOONS_WEB_PORT`, `COMICTOONS_OPEN`, `COMICTOONS_WEB_EXPOSE`.
- **Access:** `COMICTOONS_DIRECTOR_KEY` (sent by remote clients in the `x-comictoons-director-key` header; unset means only the local machine can write).
- **Twitch:**
  - `COMICTOONS_TWITCH_CLIENT_ID`, `COMICTOONS_TWITCH_CLIENT_SECRET` and `COMICTOONS_TWITCH_REDIRECT_URI`, which fall back to `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and `TWITCH_REDIRECT_URI`;
  - `TWITCH_CHANNEL`, `COMICTOONS_TWITCH_ANON`, `COMICTOONS_OAUTH_SCOPES_READONLY` (read-only scope set for the signed-in trial run);
  - loopback test overrides: `COMICTOONS_TWITCH_AUTH_BASE_URL`, `COMICTOONS_TWITCH_HELIX_BASE_URL`, `COMICTOONS_TWITCH_EVENTSUB_WS_URL`, `COMICTOONS_TWITCH_IRC_URL`, `COMICTOONS_TWITCH_ALLOW_REMOTE_OVERRIDES`.
- **Feature flags:** `COMICTOONS_FLAG_POLLS`, `_TWITCH_POLLS`, `_INK_ME`, `_CATCHUP`, `_HYPE`, `_DIRECTOR`, `_NOINK`, `_BOT_REPLIES`. All are off by default except `_NOINK`. True values: `1`, `true`, `on`, `yes`. `COMICTOONS_PARTICIPATION_MOCK` turns on the in-memory participation mock.
- **Art:**
  - `COMICTOONS_ART_NETWORK`: `1` only for a short, named proof run;
  - `COMICTOONS_PANEL_BUDGET_PER_HOUR` and `IMAGE_BUDGET_PER_HOUR` (default 12 per rolling hour);
  - `COMICTOONS_ART_CACHE_DIR` (art cache folder; defaults to `fixtures/art/generated`);
  - provider keys, up to three slots each: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN_2`, `CLOUDFLARE_ACCOUNT_ID_2`, `CLOUDFLARE_API_TOKEN_3`, `CLOUDFLARE_ACCOUNT_ID_3`, `POLLINATIONS_API_KEY`, `POLLINATIONS_API_KEY_2`, `POLLINATIONS_API_KEY_3`.
- **Tests:** `COMICTOONS_E2E_WEB_PORT`, `COMICTOONS_E2E_API_PORT`, `COMICTOONS_TWITCH_TEST_APP_PORT`, `COMICTOONS_TWITCH_TEST_FAKE_PORT`, `COMICTOONS_TWITCH_TEST_WEB_PORT`, `COMICTOONS_OBS_API_PORT`, `COMICTOONS_OBS_WEB_PORT`, `COMICTOONS_NET_GUARD`, `COMICTOONS_NET_GUARD_LOG`.
- Every `COMICTOONS_*` name also accepts the legacy `PANELCAST_*` prefix (`packages/core/src/env.mjs`).

## 5. Twitch setup (generic)

- **Sign-in:** the OAuth authorisation-code flow. Register the redirect `http://localhost:3001/auth/twitch/callback` exactly, then sign in on the same machine at `/auth/twitch/login`, or from the Connect screen (`/ui.html#/connect`).
  - Tokens are held in server memory only, so after a restart you sign in again. The app then shows "Server restarted, reconnect Twitch."
  - Live sign-in is Young's step only.
- **Scopes (7 base, `apps/server/src/twitch/config.ts`):** `user:read:chat`, `chat:read`, `channel:manage:redemptions`, `channel:manage:polls`, `channel:manage:predictions`, `bits:read`, `channel:read:hype_train`. `user:write:chat` is added only when `COMICTOONS_FLAG_BOT_REPLIES` is on. With `COMICTOONS_OAUTH_SCOPES_READONLY=1` a read-only set is used instead, and never `user:write:chat`. Reasons and token lifecycle: `docs/twitch-setup.md`.
- **Chat transport:** EventSub chat is primary. Read-only IRC is a hot standby and the fallback, and both go through one privacy, rate and dedup gate. `COMICTOONS_TWITCH_ANON=1` allows signed-out, anonymous, read-only IRC, which never sends anything. A quiet live channel stays Live; when EventSub reports the stream offline, the Studio leaves Live and late chat no longer counts.
- **`!ink` fallback:**
  - On a channel that is not Affiliate or Partner, Twitch refuses the "Ink me" channel-point reward. The Studio then shows "Ink me needs an Affiliate or Partner channel".
  - Viewers type `!ink` in chat instead. The streamer or a mod answers `!ink yes` or `!ink no`, in the Director desk or the Studio.
  - The reward's limits still apply: 1 per viewer per stream, a 5-minute global cooldown, and the hourly panel budget. `!noink` (or `!optout`) is final and wins over `!ink`.
  - Code: `participation/ink-chat.ts`, `commands.ts`.
- **Make from a link:** read-only Helix calls (app token, GET only). Caps: a VOD reads only its first 10 minutes and gives at most 6 panels; a single clip gives at most 4 (`import/caps.ts`).
- **Test bots (outside the repo):**
  - Rehearsal bots are kept outside the repo, in a separate `ct-bots/` folder. `live-bots.mjs` sends one rehearsed seed-42 plan (`live-plan.mjs` for 20 bots, `live-plan-12.mjs` for 12) into one fixed test channel hard-coded in the script. Test accounts follow the pattern `comictoons_test<N>`.
  - The default is a dry run. `--live --mock-irc ws://127.0.0.1:PORT` posts only to a loopback mock.
  - A real `--live` run posts to Twitch. That is **Young's step only, with his approval each time.**
  - Never open the bot token directory or the device-code notes.
  - The BOTS-HARDEN-1 patch (token-file guard, early Ctrl-C/STOP, lazy plan load) passed QA but has **not** been applied to the bots kept outside the repo.

## 6. Image pipeline and Young's art rules

- **Chain** (`pipeline/imagegen.ts`, `ArtPipeline`):
  1. Cloudflare Workers AI;
  2. Pollinations;
  3. a manga-inked clip frame (`frames.ts`);
  4. the bundled art library (`library.ts`), applied by the caller when the chain returns nothing.
- The chain has an hourly budget, a disk cache keyed by prompt hash, and one generation in flight. Each provider has up to 3 key slots; a key that hits a quota or rate limit is marked spent until the next UTC day and the next slot is tried. The network steps run only with `COMICTOONS_ART_NETWORK=1`.
- **Sample sets** use only each story's own art (no shared-pool fallback), in `apps/web/public/samples/` and `fixtures/art/`.
- **Young's art rules:**
  1. **No text in the art:** no letters, words, numbers, speech bubbles, captions, signs or logos. All lettering is real HTML text laid over the art, and it is rasterised only on export.
  2. **No caption, text box or bubble may ever cover a face.** Compose with space for lettering; overflow goes onto more pages rather than over faces. See `docs/LETTERING_MAPS.md` and `packages/core/src/lettering.ts`.
  3. **Festival colour is the default.**
  4. **Four themes:** Festival colour, Sunset glow, Lagoon, Blossom (`packages/core/src/theme.ts`, `docs/manga-colour-themes.md`). The legacy `ink`, `noir` and `pop` values resolve to Festival.
  5. No viewer names in art prompts. Chat is untrusted: it is paraphrased, never pasted.
  6. Generated and imported images stay private (not committed, not shared).
- **Current state of the prompts (landed in `15255a2`):**
  - Live Studio panels: `buildArtPrompt` calls the shared `buildPanelArtPrompt({scene, theme, names})`, and `studio.ts` passes the active theme. The prompt uses the theme's colour words, asks for clear space along the top so a caption never covers a face, says "no text of any kind", rewrites bubble, sign and caption words in the scene, and strips handle-shaped names.
  - Make from a link: `import/routes.ts` has its own `importArtPrompt(title, theme)` with the same rules (theme colours, faces in the lower two thirds, no text, no handles). The art chain runs there only with the art network on and a key set; otherwise the clip thumbnail is inked locally or used as is.
  - Whether the hosted models actually obey the no-text and top-space instructions in real images has not been proven: GAP. Imported frames come from a real stream, so they may contain on-screen text: GAP.

## 7. What's done (in `main` at the time of writing)

- The core loop: sample replay, moments, panels, approval queue, overlay, Recap Issue, and PNG and HTML export.
- Studio and overlay UI: Festival UI, landing page with sample sets and look swatches, mobile layout, 720p overlay, banners, hype splash and raid banner, accessibility fixes.
- The Twitch OAuth, EventSub and IRC stack with anonymous read-only fallback, the director key, participation features behind flags, the `!ink` fallback, live-bug fixes, the SSE heartbeat with client watchdog, the clip URL allow-list and IRC test-env isolation.
- Landed during the freeze (pushed hashes, up to `8cb54bb`; this list cannot name the docs commit that adds this file, so check `git log` for anything later):

| Item | Commit |
|---|---|
| IMPORT-1 and IMPORT-1-mount (make a comic from a link, series store, Studio card) | `e2b9dbb`, `87e1435` |
| DOCS-4 (`docs/make-from-link.md`) | `2c61e09` |
| CLIP-URL-2, CLIP-URL-3 (stricter clip links, `/clip/` link shape) | `b089c5d`, `e41037d` |
| CLOCK-1 r1 (live clock keeps running through quiet spells) | `beda0c9` |
| HARNESS-PORT-1 (Twitch test harness uses its own port) | `4cbf42d` |
| LANDING-4 (landing captions visible at 721 to 1279 px) | `56c6b0b` |
| README-RUN-1, WIN-RUN-1 (run steps, Windows-safe demo) | `335b18c`, `fb54486` |
| TH-FLAKE-1, LOAD-FLAKE-1 (e2e flake fixes) | `e59a03d`, `2b15dd6` |
| ART-PROMPT-1 (theme-aware, no-text art prompt) | `15255a2` |
| HANDOVER-1 r1 (in-repo `HANDOVER.md`) | `39f539c` |
| MEM-1a r3 (bounded server memory, slow SSE clients dropped) | `59a05e6` |
| IMPORT-1-wire, IMPORT-LIVE-1 r1, IMPORT-UI-1 r1 (import flow end to end, read-only live Helix import, 320 to 390 px layout with face-safe bubbles) | `ee332ed`, `499479a`, `7dc64f3` |
| NO-TRACE-FIX-1, README-STD-1 r2 (docs scrub, README rewrite with screenshots) | `5ceb703`, `8516117` |
| `e2e:import-wire` added to the gate | `644db1d` |
| SAMPLE-ART-1, SAMPLE-ART-2 (each sample uses its own art) | `133144a`, `8690548` |
| ROLE-SCRUB-1 r1, ROLE-SCRUB-2 (neutral wording in comments and tests) | `60ccef7`, `8cb54bb` |
| STREAM-END-1 r1 (stream offline leaves Live) | `266550a` |

- **Push-readiness:** the history was rewritten locally so every commit is TYK3 with the soton address, then scanned. The final no-trace check passed on the pushed tree (the verdict and evidence are kept outside the repo). `main` was pushed on 1 Nov, after Young approved it at 14:46 London, to the new private repo, with a description and 8 topics. Remote `main` = `8cb54bb` was verified.
- For the full list, see `git log --oneline` (each "Integrate X.patch" commit) and `STATE.md`.

## 8. Known gaps and open bugs (as of 1 Nov 2026, 15:00 London)

**Stop:** Young stopped all work at 14:46 London on 1 Nov: all bots, builds and tests. Nothing is running. The scope freeze (its notes are kept outside the repo) still applies: bug fixes only, no new features, until Young says otherwise.

**Cancelled by the freeze (not done):** MEM-1b, the remaining ART-LIVE-1 and IMPORT-LIVE-1 image runs, the VOD test (section 9), and chat from other channels.

**Stale notes fixed by the docs commit that adds this file:**
- `HANDOVER.md` was the older 04:48 version, with many items marked "not landed" and pre-rewrite hashes. This file replaces it.
- `README.md` → Measured results named a pre-rewrite commit that is not in the pushed history. The hash is gone; the numbers are kept as they were measured, and the final gate on `8cb54bb` is added.
- `README.md` → Testing now lists all 11 gate steps from `package.json`, including `e2e:import-wire`.
- The comment above `importArtPrompt` in `apps/server/src/import/routes.ts` now matches the shared prompt (theme colours, no text of any kind, clear space along the top).
- `BACKLOG.md`: E10 and E13 are marked done. E11 stays `todo`, because `!recap` and `!moment` are not implemented.
- `.env.example`: the unused `MODE` line is removed.

**Still stale (not fixed):**
- `BACKLOG.md` still marks most later items (E12 and E14 to E29) as `todo`; many are partly or fully delivered, but they have not been checked one by one: GAP.
- `docs/SPEC.md` and `docs/LIVE_TEST.md` still mention `MODE`, which the code does not read.

**Other known gaps:**
- Demo video: still `TODO` in `README.md` → Submission.
- Real-image proof that the models obey the no-text and top-space instructions: GAP.
- Plain-word viewer names in a clip title cannot be told apart from other words in the import prompt: GAP (noted in the code).
- The demo forwards SIGINT and SIGTERM to its children. Whether `tsx watch` and `vite` now always exit with it was reported as a problem earlier and has not been re-tested: GAP.
- A real Windows run of the demo or the gate: GAP (section 3).
- The fake Twitch suite keeps 13 checklist cases skipped by design. One safety test names the real Twitch API host without dialling it; QA accepted this.
- One old commit message (number 180 of 245) still names a crew role. QA ruled history messages are left as they are.
- `docs/SESSION_ID.txt` and the README Submission section hold the hackathon submission session ID. They were kept on purpose.
- BOTS-HARDEN-1 is not applied to the test bots (section 5).
- There is no licence file. Whether one is wanted: GAP, Young to decide.

## 9. Paused: VOD test

- VOD-TEST-1 has **not run**. Young paused it at the freeze (1 Nov, 01:19 London) and will ask for it later. The VOD (`videos/2916181042`) is skipped until he does.
- Status and prerequisites are kept outside the repo. So far it has used 0 images and made 0 Twitch calls, and the art network has never been on for it.
- Everything it needs is now in `main` (import, mount, wire and live import). Run it only when Young re-opens it, on a new branch or scratch clone, with his approval for any image or Twitch use.

## 10. Rules (binding)

- **Commits:** authored and committed as `TYK3 <atyt1u21@soton.ac.uk>` only. Write plain messages. No co-author trailers, no tool-credit lines, and no AI session links, in tracked files, commit messages or diffs. No assistant config files or folders.
- **Never push without Young's explicit OK** for that exact push. Never tag, change repo visibility or add remotes without his OK either.
- **Branches:** work on a new branch (the repo convention is `codex/<topic>`), never directly on `main`. Open no pull requests unless Young asks.
- **Keep `main` green:** run `npm run gate` on Node 20 before calling anything done, keyless and with `COMICTOONS_ART_NETWORK` unset. If the same test fails 3 times, stop and report.
- **Images are private:** generated, imported and screenshot images stay out of public places, and art network runs are short, named and approved.
- **Art:** no bubble, caption or text box may cover a face, and the art itself has no text (section 6).
- **No secrets anywhere:** never print, log, commit or paste a token, key or `.env` value. Write env var names only. `.env` is git-ignored, and `npm run secrets` must pass.
- Live Twitch actions are Young's alone: sign-in, `--live` bots, rewards, polls and posting. Young approves each public or irreversible action first.
- Chat content is untrusted. Escape it on render and paraphrase it in prompts. No real chat text, viewer names, channel names or test-account logins in outputs, docs or tests (use `comictoons_test<N>`).
- Use open-licence assets and fonts only. No copyrighted characters or logos.
