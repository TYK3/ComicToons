# ComicToons live Twitch test (runbook)

Read-only anonymous live runs (justinfan, no credentials, nothing sent to Twitch except NICK/CAP/JOIN/PONG) are covered by Young's standing permission. Anything that writes to Twitch or signs in as Young (chat posts, polls, predictions, rewards, OAuth sign-in on tyk_twitch) still needs Young's explicit yes first.

This is the runbook for checking ComicToons against a real Twitch channel, step by step.
It assumes the Twitch slices have landed: sign-in and the token store (P0-1 to P0-3) and
EventSub with the real Helix client (P0-4 to P0-8). Before then, most steps will show
Sample Data or mock results. That is expected and is not a failure of this runbook.

### Accounts

- **Broadcaster:** your own channel. It signs in to ComicToons in step 1.
- **Test viewers:** `comictoons_test<1>`, `comictoons_test<2>` and `comictoons_test<3>`. These are the
  chatters for this runbook.
  - All three are plain viewers. None has Affiliate status.
  - Their logins are in Young's vault. Never paste their emails or passwords into chat,
    an issue, a log or a screenshot.

The moment detector needs **at least 3 different chatters**. Chat spikes and emote bursts both
ignore one person spamming. So use all three test viewers for steps 2a and 2b. Steps 4, 5, 7
and 11 also use them.

If the test viewers are unavailable, two alternatives remain:

- **A. Use the broadcaster account itself.** Type in your own chat, run the poll, and delete
  your own messages. On its own, this proves chat is connected, but it cannot open a spike or
  burst moment (that needs 3 chatters).
- **B. Use the Twitch CLI (`twitch event trigger`).** This is a **dry run against a local
  mock**, not real Twitch. See "Dry run with the Twitch CLI" below.

Nothing in this runbook needs a secret pasted into a chat, an issue or a screenshot.
Keep `.env` on your own machine only. It is git-ignored.

## 0. Before you start

1. **Register the app.** Go to <https://dev.twitch.tv/console/apps>. Two-factor authentication must be on.
   Add the OAuth Redirect URL `http://localhost:3001/auth/twitch/callback` and choose a
   **Confidential** client type. See <https://dev.twitch.tv/docs/authentication/register-app/>.
2. **Create `.env`** in the repo root by copying `.env.example`. Fill in the values yourself and
   never share them. These are the names that matter:
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - `TWITCH_REDIRECT_URI` (the callback URL above)
   - `TWITCH_CHANNEL` (your channel login, lower case)
   - `MODE` set to `live`
   - `COMICTOONS_PARTICIPATION_MOCK`: leave this **unset**, so the real Helix client is used
   - `COMICTOONS_FLAG_POLLS`, `COMICTOONS_FLAG_TWITCH_POLLS`, `COMICTOONS_FLAG_INK_ME`,
     `COMICTOONS_FLAG_CATCHUP`, `COMICTOONS_FLAG_HYPE`, `COMICTOONS_FLAG_NOINK`, `COMICTOONS_FLAG_BOT_REPLIES`: set each to `1`
   - `COMICTOONS_ART_NETWORK`: leave unset or `0` for this test. Network art is a separate check.
3. **Check your channel status.** Go to Creator Dashboard → Settings → Affiliate or Partner.
   If you are neither, that is fine: step 4 then checks the fallback message instead.
4. **Start ComicToons:** `npm run dev`. The studio opens at <http://localhost:4173/studio>.
5. **Sign in the test viewers.** Open three more browser profiles (or private windows in
   different browsers). Sign each in to twitch.tv as `comictoons_test<1>`, `comictoons_test<2>` and
   `comictoons_test<3>`, using the logins from Young's vault, and open your channel's chat in each.
   - New accounts may need to verify an email or phone before they can chat in some channels.
     Check your channel's chat settings (Creator Dashboard → Settings → Moderation) if a message
     is refused.

### OBS Browser Source

1. In OBS, go to Sources, click **+**, choose **Browser**, and name it `ComicToons overlay`.
2. Set URL to `http://localhost:4173/ui.html#/overlay`, Width to `1920` and Height to `1080`.
3. Leave **Custom CSS** at its default. The overlay background is transparent.
4. Tick **Shutdown source when not visible** and **Refresh browser source when scene becomes active**.
5. Put the source above your game or camera in the scene.
6. **Expected:** with Sample Data running, approved panels ink in over your scene and the
   background stays see-through. **Hide overlay immediately** in the studio clears it in under
   a second (one update tick, about 500 ms).

## The steps

There are ten checklist steps plus step 11 (`!optout`). Tick each one. If a step does not match
the expected result, note what you saw (no tokens, no secrets) and carry on.

The P0 ids after each step's title match the automated tests in
`tests/twitch/live-checklist.test.ts`. Step 11 has no automated live test yet.

### 1. Connect (P0-1, P0-2)

- **Young approves:** obtain approval immediately before this live action.
- **Do:** open <http://localhost:4173/connect> and click Connect. Approve on the Twitch page.
- **Expected:**
  - The Twitch page lists the permissions ComicToons asks for.
  - You come back to ComicToons with no error page.
  - <http://localhost:3001/api/twitch/status> shows `connected: true` and your channel.
  - No token appears in the address bar after the callback, on the page, or in the terminal log.

### 2. Chat opens a moment (P0-3, P0-8)

Wait **at least 30 seconds** after the studio shows Live chat before starting. The detector
ignores spikes during its warm-up.

#### 2a. Chat spike (3 test viewers)

- **Young approves:** obtain approval immediately before this live action.
- **Do:** `comictoons_test<1>`, `comictoons_test<2>` and `comictoons_test<3>` together send at least
  6 different lines within 10 seconds (2 or 3 each), all about the same thing. For example:
  "the dragon stole the loot!", "no way, the loot!", "GET THE LOOT BACK".
- **Expected:**
  - The studio source card says **Live chat**, not Sample Data.
  - The received count goes up by one per line.
  - A draft panel appears with origin Twitch, labelled "Live chat · Original illustration". It quotes the test viewers' lines.
  - Approve it and it shows on the overlay.

#### 2b. Emote burst (3 test viewers)

- **Young approves:** obtain approval immediately before this live action.
- **Do:** wait about 30 seconds after 2a (the moment cooldown). Then all three test viewers
  send the same emote within 8 seconds, for example `Kappa`, or the same keyword such as `LOOT`.
- **Expected:** a new draft panel opens for the burst, built around that emote or keyword.

Alternatives:

- **A. Broadcaster only:** send about 10 different lines. Expect the received count to go up,
  which proves chat is live, but **no moment**, because only one chatter is present.
- **B. No CLI equivalent here.** Use the automated rehearsal's `burst` command instead (see the end of this runbook).

### 3. Raid (P0-4, P0-5)

- **Young approves:** obtain approval immediately before this live action.
- **Do:** you cannot raid your own channel. The test viewers would have to go live to raid, so pick one of these:
  - **Optional:** a friend's channel raids yours (`/raid <your channel>`).
  - **B.** Run the CLI dry run: `twitch event trigger channel.raid --transport=websocket`. See below.
- **Expected:**
  - A "Previously on…" catch-up appears on the overlay (with `COMICTOONS_FLAG_CATCHUP=1`).
  - It shows the raider's name and viewer count.

### 4. Ink me: Affiliate or Partner only; otherwise check that the fallback message shows (P0-5, P0-6, P0-7)

- **Young approves:** obtain approval immediately before this live action.
- **Do:** in the studio, connect the Ink me reward.
- What matters here is **your broadcaster channel's** status. The test viewers do not need Affiliate status to redeem.
- **If your channel is Affiliate or Partner:**
  - **Expected:** a reward called "Ink me" appears on your channel. It costs 500 points, allows 1 per viewer per stream, and has a 300 second cooldown.
  - **Redeem:** `comictoons_test<1>` redeems it. A new account may not have 500 channel points yet. If so, lower the cost temporarily on the Twitch dashboard, or use B.
    - **Expected:** a named cameo draft appears in the studio.
    - **Fulfil** marks it FULFILLED on Twitch. Try **Cancel** on a second redemption by `comictoons_test<2>`: it is marked CANCELED and the points are refunded.
    - A second redeem by `comictoons_test<1>` in the same stream is blocked by Twitch.
- **If your channel is not Affiliate or Partner (fallback):**
  - **Expected:** no reward is created. The studio shows a clear message that channel-point rewards need Affiliate or Partner, and everything else keeps working.
  - **Check:** `comictoons_test<1>` opens the channel-points menu in your chat and sees no "Ink me" reward.
  - **Check:** `comictoons_test<2>` and `comictoons_test<3>` keep chatting, and the studio still counts their lines.
  - **Not expected:** a crash, a retry loop, or a fake "connected" state.
- **B. CLI dry run:** `twitch event trigger channel.channel_points_custom_reward_redemption.add --transport=websocket` checks only the event shape. Its reward id will not match a reward ComicToons created.

### 5. Poll (P0-5, P0-6, P0-8)

- **Young approves:** obtain approval immediately before this live action.
- **Do:** with a draft or approved panel on screen, start a caption vote from the studio.
- **Expected:**
  - A native Twitch poll appears in your chat. The question is at most 60 characters, with 2 to 5 choices of at most 25 characters each.
  - `comictoons_test<1>` and `comictoons_test<2>` vote for choice 1, and `comictoons_test<3>` votes for choice 2.
    - **A.** Alternatively, vote from the broadcaster account alone.
  - The counts update live in the studio.
  - When the poll ends, the winning line is lettered into the panel. With zero votes, the studio still shows that the poll ended.
- **Also check:** with `COMICTOONS_FLAG_TWITCH_POLLS` unset, typing `!1` or `!2` in chat counts as a vote.

### 6. Prediction (P0-5, P0-6)

- **Young approves:** obtain approval immediately before this live action.
- **Do:** a hype train starts a prediction ("Will they make it?").
  - **A.** A hype train cannot be started on demand. Use the CLI dry run instead (B, below).
    - **Optional:** you can still lock and resolve any live prediction yourself from the Twitch dashboard.
- **Expected:**
  - The prediction appears in chat.
  - Locking it in the dashboard shows LOCKED in the studio.
  - Resolving it makes the winning outcome the next panel's punchline.

### 7. CLEARMSG: a deleted chat line disappears (P0-3)

- **Young approves:** obtain approval immediately before this live action.
- **Do:**
  1. `comictoons_test<1>` sends a distinctive line, for example "purple walrus test", as part of a spike (step 2a), and you wait until it is quoted in a panel.
  2. From the broadcaster account, delete that message in chat (hover, then Delete).
  3. Time out `comictoons_test<3>` (`/timeout comictoons_test<3> 60`) after one of their lines is quoted.
  4. Then run `/clear`.
  - **A.** Alternatively, send and delete your own line from the broadcaster account.
- **Expected:**
  - The deleted line is removed from drafts, approved panels and the overlay within a few seconds, and Undo cannot bring it back.
  - `/clear` removes everything drawn from the cleared chat.
  - The timeout removes that viewer's lines.

### 8. Token expiry and refresh (P0-2)

- **Young approves:** obtain approval immediately before this live action.
- **Do:** leave ComicToons connected for over an hour.
  - Then disconnect ComicToons at <https://www.twitch.tv/settings/connections> to revoke it.
- **Expected:**
  - Over the hour, nothing visible happens. The terminal shows a routine validation, but no token.
  - After the revoke, the studio asks you to reconnect Twitch within a minute or so, and keeps running on Sample Data.
  - The terminal log does not show a stream of retries.
  - Connect again (step 1) and live chat returns.

### 9. EventSub reconnect (P0-4)

- Real Twitch decides when to send a reconnect request (for example during its own maintenance), so you cannot force one on a live channel.
- **Do (B):** run the dry run below and use `twitch event websocket reconnect`.
- **Expected:**
  - ComicToons moves to the new connection without losing any events.
  - The studio stays on Live chat throughout.
  - **Live check:** you will see this only if Twitch happens to send a reconnect while you are live. If it does, nothing should change on screen.

### 10. Disconnect and recover (P0-3, P0-4)

- **Young approves:** obtain approval immediately before this live action.
- **Do:** with Live chat showing, turn off your network for about 30 seconds, then turn it back on.
- **Expected:**
  - Within about 10 to 20 seconds of losing the network, the studio shows Sample Data or a "reconnecting" message. It does not crash.
  - Within about 10 seconds of getting the network back, it shows Live chat again.
  - New chat lines (step 2) and a new poll (step 5) work again.
  - Lines sent while you were offline are not replayed. Twitch does not replay them, so this is expected.

### 11. !optout (viewer opt-out)

- **Young approves:** obtain approval immediately before this live action.
- **Do:**
  1. Run a spike (step 2a) so that `comictoons_test<2>` is quoted in a draft or approved panel.
     - If your channel has Ink me, `comictoons_test<2>` redeems it first.
  2. `comictoons_test<2>` types `!optout` (`!noink` does the same).
  3. Later, `comictoons_test<2>` types `!ink` and joins another spike.
- **Expected:**
  - `comictoons_test<2>`'s lines disappear from drafts, approved panels, the overlay and the recap archive within a few seconds.
  - A short acknowledgement may appear in chat. It is posted only once bot replies use the real Helix client (see `COMICTOONS_FLAG_BOT_REPLIES`).
  - Any unsettled Ink me redemption by `comictoons_test<2>` is cancelled and refunded.
  - The later `!ink` does **not** bring them back: the opt-out lasts for the whole stream.
  - `comictoons_test<1>` and `comictoons_test<3>` are unaffected and still appear in new panels.
- **A.** Alternatively, type `!optout` from the broadcaster account. Expect your own lines to be removed in the same way.

## Dry run with the Twitch CLI (optional, local only)

`twitch event trigger --transport=websocket` sends events **only to the Twitch CLI's own mock
EventSub server on your machine**. It does **not** send anything to real Twitch, and real Twitch
never sees these events. Treat it as a rehearsal of the event shapes, not as a live test.

1. Install the Twitch CLI: <https://dev.twitch.tv/docs/cli/>. Its local mock server is described at
   <https://dev.twitch.tv/docs/cli/websocket-event-command/>.
2. In one terminal, run `twitch event websocket start-server`. It listens on `ws://127.0.0.1:8080/ws`.
3. Point ComicToons at it by setting `COMICTOONS_TWITCH_EVENTSUB_WS_URL` to that address.
   - This setting is **proposed**. It works only once the EventSub slice reads it. Until then, use the automated rehearsal below instead.
   - The CLI server also has a mock subscriptions endpoint at `http://127.0.0.1:8080/eventsub/subscriptions`. You need it for forwarded events only if you start the server with `-S`.
4. In a second terminal, trigger events:
   - `twitch event trigger channel.raid --transport=websocket`
   - `twitch event trigger channel.channel_points_custom_reward_redemption.add --transport=websocket`
   - `twitch event trigger channel.poll.begin --transport=websocket`, then the same with `channel.poll.progress` and `channel.poll.end`
   - `twitch event trigger channel.prediction.begin --transport=websocket`, then the same with `channel.prediction.progress`, `channel.prediction.lock` and `channel.prediction.end`
   - `twitch event websocket reconnect`, which sends a reconnect request (step 9)
5. **Expected:** each event reaches ComicToons. Without `-S` on `start-server`, the CLI sends
   triggered events to every connected client. Its ids are random, so polls, predictions and
   redemptions will not match ones ComicToons created. Raids and the reconnect are the useful
   checks here.

## Automated rehearsal (no Twitch account needed)

`npm run test:twitch` runs a local fake Twitch on `127.0.0.1:4120`. It covers sign-in, tokens,
Helix, EventSub over WebSocket, and chat over IRC including CLEARMSG, CLEARCHAT and raids.
The run makes no real Twitch calls.

- The ten steps above are in `tests/twitch/live-checklist.test.ts`, and are marked fixme until their P0 items land.
- `COMICTOONS_TWITCH_E2E=all npm run test:twitch` runs them anyway.
- To drive the fake by hand, run `node --import tsx scripts/twitch-mock/start.ts` (add `--not-affiliate` to rehearse step 4's fallback). Type `help` for its commands: `chat`, `burst`, `raid`, `redeem`, `vote`, `reconnect`, `drop`, `expire` and others.
- If the Twitch CLI is installed, set `TWITCH_CLI_BIN` to its path to also check the fake's event shapes against the CLI's.


## Approval checkpoints and offline safety

Read-only anonymous live runs (justinfan, no credentials, nothing sent to Twitch except NICK/CAP/JOIN/PONG) are covered by Young's standing permission. Anything that writes to Twitch or signs in as Young (chat posts, polls, predictions, rewards, OAuth sign-in on tyk_twitch) still needs Young's explicit yes first. Approval for one write or sign-in does not approve later writes or sign-ins. Local fake actions do not contact Twitch.

The mock suite uses COMICTOONS_TWITCH_TEST_APP_PORT and COMICTOONS_TWITCH_TEST_FAKE_PORT (1024–65535, defaults 3120/4120). It runs in the gate after unit tests; unfinished checklist cases and unavailable CLI checks remain explicitly skipped. Failures exit non-zero.

The app kit refuses inherited client credentials and supplies fake values. Its child-process egress guard terminates the app on any non-loopback socket or fetch attempt, so a missing endpoint override fails instead of contacting Twitch. Endpoint-override implementation remains a separate step: wire every OAuth, Helix, IRC and EventSub endpoint to the fake before enabling the corresponding unfinished checklist cases. The fake call log must remain free of credentials, codes and tokens.


## Confirmed live-channel check

Young confirmed the local redirect as http://localhost:3001/auth/twitch/callback. Live sign-in is Young's step only. The test channel is tyk_twitch, broadcaster ID 796822059, with broadcaster_type '' (not Affiliate or Partner). For this channel, Ink me must show exactly "Ink me needs an Affiliate or Partner channel"; do not expect live reward creation to succeed. Young approves each public or irreversible live-channel action before it is performed. These account facts are user-supplied; no live lookup was made during implementation.
