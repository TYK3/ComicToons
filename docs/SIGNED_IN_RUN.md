# Signed-in trial run (runbook for Young)

This is the runbook for `trial-run --signed-in`: a scripted sign-in on `tyk_twitch` that reads
EventSub for a few minutes and reports what arrived, with no chat posts, polls, predictions,
reward changes or redemption updates possible.

**Where this runs.** The repo lives on the box, so the whole run — the command, the ComicToons
server it starts, and `localhost:3001` — happens on the box. Young does not run this from his own
machine. The lead hands him the screen so he can sign in through the box's own browser; that browser
is the only place `http://localhost:3001` resolves to the ComicToons server this run started.

**A real run needs your explicit yes, every time.** The tool refuses to even try unless you have
said go and set the exact environment variable below. Approving one run does not approve a later
one. There is a separate, no-account dry run (`--fake`) you never need to approve — it only talks
to a local, fake Twitch on this machine and is covered any time.

## Dry run first (no account, no browser, no keys)

Before ever running this for real, run the dry run and read its report:

```
npm run trial-run -- --signed-in --fake
```

This starts ComicToons, signs in through a local stand-in for Twitch (`scripts/twitch-mock`), lets
it subscribe to the same read-only events a real run would, plays a few fake chat/raid/hype-train
events, and writes a report to a new folder under your system temp directory (the exact path is
printed at the end, e.g. `wrote <temp dir>/comictoons-signed-in-.../signed-in-report.md`). Nothing here
ever reaches the real `id.twitch.tv`, `api.twitch.tv` or `eventsub.wss.twitch.tv`.

## The real run

### 1. Say yes

In the terminal you will run this from:

```
export COMICTOONS_SIGNED_IN_REAL_RUN=young-approved
```

This has to be the exact value above. Anything else (including `1`, `yes`, `true`) is treated as
not approved and the tool refuses before it starts a server or sends a single request. Unset this
variable again when you are done; it does not expire on its own.

### 2. The exact command

```
npm run trial-run -- --signed-in
```

A real run listens on port 3001, because the app's registered redirect URI is
`http://localhost:3001/auth/twitch/callback`; make sure nothing else is using 3001 first. It waits
up to 180 s for you to finish clicking through; add `--timeout <seconds>` (up to 600) for longer.
If the wait runs out, it still reports whatever happened so far.

The real run needs the app's own Twitch client ID and secret in your environment or `.env`, as in
`docs/twitch-setup.md`. The dry run needs neither.

### 3. What you click

The command prints `http://localhost:3001/auth/twitch/login` for the box browser. Open it in the
box browser (the lead hands you the screen there), signed in as `tyk_twitch` — that is the only
browser where `localhost:3001` reaches the ComicToons server this run started. Twitch shows its
normal consent page listing the six scopes below — click **Authorize**. You are sent back to
a plain local page the run serves on its web port (`http://localhost:4118/ui.html`, or whatever
`--web-port` says) that reads "Connected as <channel>, you can close this tab", and the terminal
reports it saw you connect. The run keeps that page up for up to 15 s after it sees the sign-in so
the browser can land on it, then closes it with the rest of the run. The script never opens a browser or drives
Twitch's page itself, and it never sees your password. The sign-in code and token go to the
ComicToons server, as with any ComicToons sign-in, and never into the report.

### 4. Scopes and what gets read

A `--signed-in` run always sets `COMICTOONS_OAUTH_SCOPES_READONLY=1` in the server's environment
(`apps/server/src/twitch/config.ts`), which narrows the sign-in to exactly these six read-only
scopes — never the broader set ComicToons asks for on an ordinary sign-in (see
`docs/twitch-setup.md`), and never `user:write:chat` even if bot replies are otherwise turned on:

`user:read:chat`, `bits:read`, `channel:read:redemptions`, `channel:read:polls`,
`channel:read:predictions`, `channel:read:hype_train`

Once connected, the run only **reads** these already-public, already-happened event types — it
asks Twitch to subscribe it to read-only event types; it never performs any action a manage scope
would otherwise allow. Checked against
<https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/> on 31 Oct 2026:

| EventSub type | Scope needed |
|---|---|
| `channel.chat.message` | `user:read:chat` |
| `channel.chat.message_delete` | `user:read:chat` |
| `channel.cheer` | `bits:read` |
| `channel.channel_points_custom_reward_redemption.add` | `channel:read:redemptions` |
| `channel.poll.begin` | `channel:read:polls` |
| `channel.poll.progress` | `channel:read:polls` |
| `channel.poll.end` | `channel:read:polls` |
| `channel.prediction.begin` | `channel:read:predictions` |
| `channel.prediction.progress` | `channel:read:predictions` |
| `channel.prediction.lock` | `channel:read:predictions` |
| `channel.prediction.end` | `channel:read:predictions` |
| `channel.hype_train.begin` (v2) | `channel:read:hype_train` |
| `channel.hype_train.end` (v2) | `channel:read:hype_train` |
| `channel.raid` | none |
| `stream.online` | none |
| `stream.offline` | none |

In plain terms, that is:

- Chat messages and message deletions you can already read (`channel.chat.message`, `channel.chat.message_delete`)
- Raids into the channel (`channel.raid`)
- Cheers (`channel.cheer`)
- Existing channel-point redemptions (`channel.channel_points_custom_reward_redemption.add`)
- An existing poll's begin/progress/end (`channel.poll.*`)
- An existing prediction's begin/progress/lock/end (`channel.prediction.*`)
- Hype train begin/end (`channel.hype_train.*`)
- Stream online/offline (`stream.online`, `stream.offline`)

The terminal report shows counts of each type received, plus whether sign-in and subscribing
succeeded — never any chat text, viewer name, or the content of a redemption/poll/prediction.

### 5. What it never writes

Every HTTP request the ComicToons server sends through `fetch` during the run is checked against a hard allowlist
(`scripts/trial-run/signed-in-allowlist.ts`) *before* it is sent — a disallowed request throws
instead of reaching Twitch. Each entry also fixes the host: `id.twitch.tv` for sign-in, `api.twitch.tv`
for Helix (or a loopback address for the dry run's fake). The allowlist has exactly five entries: the consent page, the token
exchange, token validation, reading your own channel's Affiliate/Partner status, and creating an
EventSub subscription for one of the read-only types above. Nothing else — no chat message, no
poll, no prediction, no reward creation or change, no redemption update, no subscription to any
other event type — can be sent; the code throws first. The tool's own write-triggering features
(Ink me, Twitch-native polls, hype actions, bot replies) are also force-disabled for this run, on
top of the allowlist.

### 6. How to stop

Ctrl+C the terminal at any time. It stops the ComicToons server it started and exits; nothing it
did needs to be undone on Twitch's side. If you want to fully revoke ComicToons' access afterward,
do that yourself at <https://www.twitch.tv/settings/connections> — stopping this tool does not
revoke the token, the same as any other ComicToons sign-in (see `docs/twitch-setup.md`).

## If something looks wrong

If the report's "Write attempts blocked by the allowlist" count is ever above zero, something
tried to send a request the allowlist does not recognize and it was stopped before it reached
Twitch — stop the run and tell the team before trying again.
