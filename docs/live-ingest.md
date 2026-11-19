# Read-only live ingest and immediate sample fallback (Step 4)

The IRC adapter is tested with injected transports and local fakes. A signed-in session supplies private IRC credentials; with COMICTOONS_TWITCH_ANON=1, a signed-out session can use read-only justinfan chat. Otherwise missing authentication returns labelled Sample Data. No live run was performed for this documentation update.

## Source behavior
- GET /api/ingest/sample prepares a read-only curated snapshot for UI preloading. It does not start playback, approve panels or modify the current issue.
- POST /api/ingest accepts only mode (sample/twitch) and a public channel name. Unknown fields are rejected before Fastify's default stripping. No HTTP credential input exists.
- The source controller starts on Sample Data while IRC is connecting or has no eligible messages. Authentication/network/drop errors restore the cached sample synchronously; no reconnection timer or artwork generation is awaited. Network drops and RECONNECT retry at 1, 2 and 4 seconds, at most three retries per outage. A 001 welcome followed by 60 continuous seconds establishes recovery; a welcome-then-drop flap keeps spending the same budget. A passive inbound-frame watchdog starts with the scope’s ten-minute bootstrap, then uses twice the positive interval measured between server PINGs to detect half-open links under the normal retry budget. Complete server frames renew it and PING receives PONG; chat silence below that gap does not close the socket. Both the measured watchdog gap and the retry delay are capped at 15 minutes, and one reconnect episode has a 15-minute total budget. RECONNECT closes the old socket and reconnects under the same backoff, re-authenticating and rejoining. See [the chaos suite](ingest-chaos.md) for exact boundaries and simulation coverage.
- The manual Use Sample Data now control paints its preloaded snapshot in the click handler, before its source POST finishes. A held-request browser test proves this ordering. Backend synchronization still requires its normal HTTP round trip. Automatic status updates reach the UI through the existing 800ms state poll; this is not a claim of zero physical network latency.
- A previously active chat stays Live through quiet spells of any length; it does not return to Sample Data on silence. A connection that has never received chat already shows Sample Data from the start.
- Sample approvals/edits and the live draft are separate, bounded in-memory snapshots. Returning to the same channel restores the live draft; panic hide clears it and fences stale callbacks. Starting a new sample replay is an explicit fresh issue.

## Adapter and source boundary
apps/server/src/ingest/irc.ts provides TwitchIrcAdapter and injectable transports. Production tries verified TLS on irc.chat.twitch.tv:6697 first, then verified WSS on irc-ws.chat.twitch.tv:443 if TLS fails before welcome or does not welcome within 15 seconds. A local COMICTOONS_TWITCH_IRC_URL override replaces both legs. Authentication is a private callback; absent/invalid identity does not dial unless anonymous mode is enabled. The adapter has no chat-post method. Outbound IRC controls are PASS (signed in only), NICK, CAP REQ, JOIN and PONG. Split/batched CRLF frames use StringDecoder; recognised tags are normalised, and mismatched channels/malformed frames are ignored.

Future approved bootstrap example (illustrative only):

```ts
createApp({
  adapterFactory: channel => {
    if (channel !== approvedTestChannel) throw new Error('Unapproved channel');
    return new TwitchIrcAdapter({channel, authenticate: ownerCredentialProvider});
  },
});
```

The owner supplies that callback privately after channel/access confirmation. No token belongs in the browser, HTTP source body, source state, screenshots or logs. No credential callback is configured by this implementation.

## Honest output and bounded data
Live chat text is sanitized and selected into approval-gated, one-minute draft groups (up to four distinct comments each). Existing original artwork illustrates the chat; it is not represented as captured video or newly generated scene evidence. Real-source panels carry origin=twitch and output labels say Live chat / Original illustration. Simulated IRC and all curated fallbacks say Sample Data, including manga headers, recap and exported documents.

The source dedup ledger holds up to1024 entries. Draft inclusion is bounded to24 pending panels and120 live draft records. The opt-out ledger holds4096 users; reaching capacity pauses inclusion rather than evicting an earlier denial. Opt-out purges affected pending/approved live panels and their archive entries, invalidates undo, and wins over a later opt-in. The separate Step6 sixteen-case chaos suite is not claimed by these Step4 tests.

## Verification and UI review
- tests/ingest.test.ts: IRC-PARSE, IRC-READONLY, IRC-AUTH, INGEST-INSTANT, INGEST-CACHE, INGEST-EMPTY, INGEST-BOUNDS, INGEST-PRIVACY, INGEST-API and INGEST-LABELS. All use local simulated transport; no live service assertion.
- tests/live-ingest.spec.ts: IN-FALLBACK-UI, IN-CACHED-SWITCH, IN-PROVENANCE. Prove initial missing-auth fallback, approval gating, 390/1280 layouts/axe, pre-response cached rendering, and labels through actual saved HTML/PNG export.
- Source-card screenshots: artifacts/live-ingest/fallback-{1280,390}.jpg, both opened and visually reviewed. Controls match the existing dark studio, labels/body remain readable, keyboard focus is standard native/button behavior and neither width overflows. Serious/critical axe findings: zero at both widths.
- Exact native final results and protected hashes are stored under artifacts/tmp/live-ingest/; final counts are recorded in STATE.md and the handoff report.

## Notices, moderation clears and raids (Step 6 Groups 3 and 4)
- NOTICE: an ordinary NOTICE keeps the connection open and logs one line containing only its symbolic msg-id, never the notice text. Only a login failure ends the session without retry: the documented texts "Login authentication failed" or "Improperly formatted auth", or, as a safety net, a NOTICE to `*` before the welcome that mentions auth or login.
- CLEARCHAT, following Young's ruling: neither kind is ever an opt-out, and the user's later chat stays eligible. A whole-room clear drops every earlier recorded line from drafts, pending panels and moments (removed, not hidden or marked) but never changes a panel that is already approved. A targeted clear (ban or timeout) removes only that user's earlier lines, including from a panel an earlier whole-room clear spared: the adapter keeps a room-cleared line findable by id so a later targeted clear can still reach it (IRC-CLEARCHAT-SURVIVOR-BAN). A whole-room clear reaches only the 1,024 most recent lines that carried an `id` tag; older lines and lines without an `id` cannot be withdrawn by it.
- CLEARMSG removes the single named line everywhere, including from approved panels. A panel left with no lines is removed, and a deleted line still waiting in the standby queue is never drafted.
- Raid: USERNOTICE with msg-id=raid becomes a raid StreamEvent in the EventSub `channel.raid` normaliser's shape and is forwarded to Studio.
- Simulation coverage is INGEST-11 to INGEST-18b in [the chaos suite](ingest-chaos.md), with adapter checks in tests/irc-hardening.test.ts.

## Primary protocol references
- https://dev.twitch.tv/docs/chat/irc/ : TLS endpoint, CRLF framing, capabilities, authentication order, PRIVMSG, PING/PONG and disconnect notices; on 31 Oct 2026 it also carries the command and tag reference for NOTICE, CLEARCHAT, CLEARMSG, USERNOTICE and RECONNECT.
- https://dev.twitch.tv/docs/chat/irc-commands/ is not needed. On 31 Oct 2026 it returns 403 from Twitch's documentation host (Amazon S3 behind CloudFront; S3 answers 403 for a missing page), not from ComicToons. ComicToons never fetches documentation at run time, so live chat does not depend on it. The command and tag reference the adapter uses is on the IRC concepts page above, which returns 200.
- https://dev.twitch.tv/docs/authentication/scopes/ : chat:read is the IRC read permission; this adapter implements no chat-send operation.

No dependency, lockfile, Git-config or provider/account changes. No push or deploy.

## Group2 load and withdrawal boundaries

Ordinary unique chat is admitted at no more than60events per rolling second;
overflow is dropped rather than retained in a deferred queue. Dropped lines are
counted (`throttled` on the source state), and while live chat is active Studio
shows the operator a notice with the count on the chat-source card (INGEST-19).
Privacy commands run before dedup and throttling, so overload cannot delay an opt-out. Incoming
Twitch CLEARCHAT with a target-user-id (ban or timeout) withdraws that user's
earlier lines, removing selected text and invalidating undo through the existing
scrub path. Following Young's ruling it is never an opt-out: the user's later
chat is still eligible. Only a self opt-out enters the ledger and blocks a later
opt-in. A whole-room CLEARCHAT drops recorded lines from unpublished drafts and moments but preserves approved panels. All validation uses simulated transports.
See the chaos suite for40virtual-minute load bounds, UTF-8 byte splits, short
Arabic/Hebrew geometry and drafting/archive-purge checks.

## Anonymous read-only chat (opt-in, Step T6)

For trial runs before the Twitch app keys exist, the IRC adapter can read a public channel's chat without signing in. This is off by default.

- **Flag:** `COMICTOONS_TWITCH_ANON`. Only the exact value `1` enables it; unset, empty, `0`, `true`, `yes` and padded values all leave it off (`anonymousChatEnabled` in apps/server/src/ingest/irc.ts). The adapter does not read the environment itself; the server wiring passes the parsed flag in.
- **Login:** `withAnonymousFallback(authenticate, enabled)` wraps the existing credential callback. A signed-in token always wins and is re-checked on every connect and retry. Only when there is no token and the flag is on does it return the anonymous identity: `NICK justinfan<5 digits>` with no `PASS`, then the usual `CAP REQ` and, after the 001 welcome, `JOIN`. The adapter accepts this identity only when it was minted by that helper; a hand-made `justinfan` identity is rejected as unauthenticated.
- **Read-only:** every outbound frame passes an allow-list (`PASS oauth:…`, `NICK`, `CAP REQ`, `JOIN`, `PONG`); an anonymous session never sends `PASS`. The adapter has no method that posts chat, so `PRIVMSG` and `WHISPER` are never sent in any mode. Reconnect, watchdog, NOTICE, CLEARCHAT, CLEARMSG and raid handling are the same as for a signed-in session.
- **Evidence:** Twitch's [IRC concepts](https://dev.twitch.tv/docs/chat/irc/) page documents only OAuth login and does not mention anonymous access (GAP: the convention is undocumented and could be limited by Twitch without notice). On 31 Oct 2026 a 40-second anonymous connection to a public live channel over `wss://irc-ws.chat.twitch.tv:443` was accepted with `NICK` and no `PASS`, and received chat lines while sending only `NICK`, `CAP` and `JOIN`. The box's network could not complete TLS to `irc.chat.twitch.tv:6697`, so the production TLS endpoint was not exercised live.
- **Endpoint fallback (T19):** chat dials `irc.chat.twitch.tv:6697` over TLS first and falls back to `wss://irc-ws.chat.twitch.tv:443` when 6697 fails before a welcome; `COMICTOONS_TWITCH_IRC_URL`, when set, overrides both legs.
- **Local fake endpoint:** `COMICTOONS_TWITCH_IRC_URL` can point the production transport at a local Twitch fake, for example `irc://127.0.0.1:6667` (plain) or `ircs://localhost:6697` (verified TLS). Unset or empty uses the TLS-first/WSS-fallback chain above. Only `localhost`, `127.0.0.1` and `::1` with an explicit port and no user, path or query are honoured. Any other value, including another Twitch address, is refused: one warning line is logged, no socket is dialled, and the adapter ends as unreachable after its normal retries. It never falls back to Twitch (`ircEndpoint` in irc.ts).
- **Moderation:** handled exactly as for a signed-in session; see the moderation section above. No CLEARCHAT is an opt-out (Young's ruling, 31 Oct 2026).
- **Tests:** tests/irc-anonymous.test.ts: IRC-ANON-FLAG, IRC-ANON-OFF, IRC-ANON-ON, IRC-ANON-TOKEN, IRC-ANON-READONLY and IRC-ANON-EXPLICIT; tests/irc-endpoint.test.ts: IRC-URL-DEFAULT, IRC-URL-LOCAL and IRC-URL-REFUSED; tests/irc-hardening.test.ts: IRC-CLEARCHAT-OPTIN. All use simulated local transports.


## Current operator controls

- The classic source card names the welcomed IRC leg as TLS 6697 or WSS 443 only for real live chat; it has no transport label before welcome, on Sample Data or on EventSub chat. See tests/transport-label.test.ts and tests/transport-label.spec.ts.
- With COMICTOONS_FLAG_INK_ME enabled, unavailable channel-point rewards can use the chat Ink-me fallback: eligible viewers ask with !ink and, with COMICTOONS_FLAG_DIRECTOR enabled, a moderator or broadcaster decides with !ink yes / !ink no. Both flags default off. Opted-out viewers are blocked first, and Studio never quotes these commands.
- Read-only anonymous live runs (justinfan, no credentials, nothing sent to Twitch except NICK/CAP/JOIN/PONG) are covered by Young's standing permission. Anything that writes to Twitch or signs in as Young (chat posts, polls, predictions, rewards, OAuth sign-in on tyk_twitch) still needs Young's explicit yes first. See [LIVE_TEST.md](LIVE_TEST.md).
