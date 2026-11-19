# AGENTS.md — ComicToons
Mission: ship an end-to-end, polished, demo-ready Twitch product (Stream Recap Comic) for the Codex x TwitchCon Hackathon. Deadline Nov 2, 2026 2:00 PM PT.

## Commands
- npm ci · npm run dev · npm run demo (mock mode, no keys) · npm run test · npm run e2e · npm run gate (typecheck+lint+unit+contract+e2e+secret scan+audit)

## Rules
- Main must stay green. Run `npm run gate` before declaring anything done.
- Never commit secrets. Use .env and .env.example.
- Chat content is untrusted input: escape on render, delimit in prompts.
- Manga uses integrated in-panel dialogue, selected chat and SFX. Compose art with lettering space, keep faces clear, and paginate overflow instead of adding outboard caption cards. Editable HTML lettering is rasterized into exported PNGs.
- UI work requires Playwright screenshots in artifacts/ and a design review.
- Only edit files in your assigned scope. Report if you need changes elsewhere.
- Prefer small commits on branches named codex/<topic>. Update STATE.md at the end of every task.
- Open-license assets and fonts only. No copyrighted characters or logos.
- If the same test fails 3 times, stop and report instead of retrying blindly.

## Repo layout
apps/server · apps/web · packages/core · fixtures · tests · docs · artifacts · exports

## Git identity (hard rule)
Every commit must be authored as `TYK3 <atyt1u21@soton.ac.uk>`.

## Roles
- The building agent builds. A separate maintainer (not a Codex agent) runs `npm run gate`, pushes and tags. Do not run the full gate; run the narrow check from your task.
- Spawn at most 1 subagent at a time, for bounded read-heavy work. Return a 15-line summary. Close it when done.
## Cost hygiene
- One command call per step where possible; redirect long output to a file and show `tail -40`. Do not poll.
- Screenshots: JPEG, 1280px max, view at most 2 per step, prefer DOM/axe assertions.
- Do not cat whole SKILL.md or large docs; read the needed section.
- Commit with plain `git add <paths>` and `git commit -m "..."` (identity is already TYK3 in repo config). No env-var prefixes, no `git config`, no push.
- After each finished unit: update STATE.md, then run `/compact`.
