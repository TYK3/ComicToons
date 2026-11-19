# Live-ingest chaos suite

Run `npm run test:chaos` on Node 20. The suite uses injected sockets, a virtual
clock and invented chat. It never opens a Twitch connection. Browser evidence
will retain the Sample Data label. Passing simulations do not verify live access.

## Group 1: reconnect and dedup

- INGEST-01: at most three retries per outage, after 1, 2 and 4 seconds. A server
  001 welcome followed by at least 60 continuous seconds establishes recovery,
  so four stable, independently recovered drops all reconnect. An outage with no successful welcome exhausts its three retries.
  Authentication rejection is terminal. Stop/source switching cancels the timer
  and fences callbacks from previous sockets. The production socket binding has
  no idle timeout: two minutes of silent chat leave it connected, and server PING
  still receives PONG. Chat silence never closes that socket or leaves Live.
- INGEST-02: drain complete IRC frames already buffered alongside RECONNECT
  before replacing the socket. Keep the draft and the connection's original
  relative timeline; discard incomplete old-socket bytes. Restore cached Sample
  Data during backoff, then restore the live draft on the next eligible message.
- INGEST-03: check message IDs and `(user, text)` payloads independently. IDs
  remain suppressed while present in the bounded ledger; identical payloads from
  the same user are suppressed for less than 500ms even with different IDs.
  Different users remain independent. Both keys share a maximum of 1,024 entries.

The adapter has no send-chat method. Outgoing protocol frames remain limited to
authentication, capabilities, channel join and PONG controls. Credentials are
supplied by a future owner callback; absent credentials do not open a socket.

Protocol reference: [Twitch IRC concepts](https://dev.twitch.tv/docs/chat/irc/),
especially the RECONNECT command. Tests send server commands only to a local
simulated transport.

## Step 6 group status

Group 2 covers INGEST-04 to INGEST-10 below. INGEST-11 to 16 are defined and
passing (see the Group 3 section), and INGEST-17, 18 and 18b are defined and
passing (see the Group 4 section), and INGEST-19 (the operator throttle notice)
is defined and passing (see the last section). The watchdog checks retain the
additional INGEST-01a ID specified by Spec.


## INGEST-01 F3: stable recovery instead of welcome-only reset

A welcome immediately followed by a drop does not reset the retry count. The
first 001 on the current socket starts a 60-second stability window; a later
duplicate 001 neither shortens nor restarts that window. Drops before it ends
spend the existing budget at 1, 2 and 4 seconds, then stop. A drop at or after
60 continuous seconds begins a new outage with the base delay. Stop, source
switching and stale socket callbacks remain fenced.

The flapping regression welcomes each attempt, drops at 59,999ms and checks
that exactly three retries are spent. A separate boundary test verifies 59,999
versus 60,000ms, duplicate welcomes and cancellation. Spec confirmed this 60-second stability window. Six executable checks cover
INGEST-01 through 03; the remaining named cases are not completed by this fix.


## INGEST-01 refill cap: ten refills per rolling hour

A spent retry budget can refill after sixty continuous seconds following the
first 001 on its socket. Any parsed inbound frame, including PING, can confirm
that recovery; a later drop can also confirm it. The initial unused budget and
later frames on an already recovered socket do not consume extra refills.

At most ten actual refills are retained in a rolling hour. Once that allowance
is reached, the next outage stops automatic reconnection, closes the transport
and cancels its timers. The source switches to labelled Sample Data and the
Studio shows exactly **Live ingest paused**. A healthy connection can keep
receiving frames at the cap; the cap limits reconnecting. No timer restarts the
connection after the hour passes. Stopping/restarting the same adapter cannot
erase its refill history; a refill expires exactly one hour after it occurred.

Two additional INGEST-01 checks drive ten reconnections with connections living
just over sixty seconds, verify the paused fallback and mobile/desktop status,
and check one millisecond before versus exactly at the oldest refill's expiry.
Ordinary PING traffic keeps the healthy socket alive without consuming further
refills. Screenshots are artifacts/ingest-chaos/refill-paused-{1280,390}.jpg.
Visual review confirms that the Sample Data label and paused status are readable
beside each other at both widths, the controls wrap on mobile, and no content
overflows horizontally. Both sizes have no serious/critical axe findings.

## INGEST-01a F4: watchdog from measured server PING intervals

The initial watchdog is ten minutes, as specified by the scope cut, while two
server PINGs have not yet established a cadence. After two valid PINGs, the gap
is exactly twice their measured positive interval. Each later positive PING
interval retunes the gap; a zero-time duplicate cannot reduce it to zero. The
001 welcome and ordinary frames do not count as PING samples. A healthy server
sending PING every five minutes therefore receives PONG and keeps its socket,
with a measured ten-minute gap. The former fixed five-minute policy is superseded.

Every complete, parseable server frame renews the current deadline without
changing the PING measurement. Partial bytes and malformed lines do not renew
it. Expiry reconnects under the normal three-retry budget, and a silent expired
link cannot refill its budget merely by waiting. Retry, stop and stale socket
or canceled timer callbacks remain fenced. At most one watchdog is retained.

Four INGEST-01a checks verify healthy five-minute PINGs over five intervals,
exact measured expiry, changing server cadence, ordinary frames not becoming
PING samples, the ten-minute bootstrap for unwelcomed links, three-retry
exhaustion, malformed bytes and canceled callbacks. Together with the existing
checks, the reconnect/watchdog group has ten executable tests covering
INGEST-01, 01a, 02 and 03.
All use virtual time and injected local transports; no real Twitch cadence or
channel access was measured or claimed. Group2 coverage follows below.

## Group 2: empty, text, burst and privacy boundaries

- INGEST-04 advances virtual time through 60 seconds with no messages, checks
  the labelled Sample Data queue in the real studio UI, and receives a later
  message on the same simulated socket.
- INGEST-05 cuts a UTF-8 IRC frame at every byte boundary. ZWJ families,
  skin-tone astronaut emoji, accented Latin and Japanese text arrive intact in
  the drafting queue.
- INGEST-06 measures short Arabic/Hebrew balloons at desktop and mobile widths,
  including automatic RTL direction, panel bounds and text overflow. JPEGs live
  in artifacts/ingest-chaos/rtl-1280.jpg and rtl-390.jpg. This is bounded layout
  coverage; the previously recorded mixed-language continuation-typesetting
  limitation F2 is still open and is not resolved by these screenshots.
- INGEST-07 processes 1,000 messages per virtual minute for forty minutes, then a
  synchronous overload. A rolling one-second admission window permits at most
  60 ordinary events. Excess content is dropped, not queued for later delivery.
  Privacy controls bypass the content limit. At most 60 admission timestamps,
  1,024 dedup keys and 4,096 denied users are retained; studio panel/draft bounds
  also remain in force. The benchmark records collection sizes, serialized queue
  bytes, runtime and heap readings. Bounded retained state is verified; raw heap
  deltas include garbage and do not prove a zero-leak live process.
- INGEST-08 discards malformed lines, fences incomplete old-socket frames across
  reconnect and falls back cleanly for an oversized unterminated input buffer.
- INGEST-09 makes self !optout and authenticated Twitch CLEARCHAT with a target
  user id remove prior inclusion and invalidate undo. Only the self !optout is
  permanent and beats a later !ink. Following Young's ruling, a ban or timeout
  is never an opt-out: that user's later lines are included again. Other
  viewers continue normally. The IRC path only receives moderation commands.
  Group 3 (INGEST-12 and 13) extends CLEARCHAT to whole-room clears and to
  per-line removal for the targeted user.
- INGEST-10 withdraws a line while its live draft is archived under idle
  fallback, then resumes chat and confirms it cannot reappear.

The source is injectable and simulated for every case. No real Twitch account,
channel permission or live performance is verified. No outgoing PRIVMSG or
WHISPER interface is introduced. INGEST-11 to 16 are covered by Group 3 below.

### Group2 visual and benchmark review

The desktop and mobile RTL JPEGs were opened for visual review. Both short lines
are complete within their balloons, faces remain clear and Sample Data remains
visible. The geometry assertion measures actual DOM text fragments: scrollHeight
also includes the intentionally protruding CSS speech tail, so it cannot identify
text overflow on its own. No production typography or layout assertion was relaxed.

The rolling-rate check crosses a clock-second boundary while the previous60
admissions are only500ms old; the next burst is rejected until the full second
expires. The benchmark sends40,000 regular load messages, then1,300 overload and
boundary probes, followed by2withdrawal commands and1excluded follow-up line.
The last8minute checkpoints have equal serialized queue size after reaching the
24-panel cap. This verifies bounded retained state rather than claiming a live
process has zero heap growth. Protocol format was checked against the official
[Twitch IRC concepts](https://dev.twitch.tv/docs/chat/irc/) CLEARCHAT example.

## Group 3: notices, moderation clears, raids, RECONNECT and ceilings

All six cases are implemented in apps/server/src/ingest/irc.ts and pass in
tests/ingest-chaos.spec.ts (run with `npm run test:chaos`). Adapter-level
companions are in tests/irc-hardening.test.ts: IRC-NOTICE, IRC-NOTICE-AUTH,
IRC-CLEARCHAT-ROOM, IRC-CLEARCHAT-USER, IRC-RAID, IRC-RAID-AUTH,
IRC-CLEARCHAT-MOMENT, IRC-CLEARCHAT-MOMENT-USER, IRC-CLEARCHAT-OPTIN,
IRC-CLEARCHAT-SCOPE and IRC-CLEARCHAT-SURVIVOR-BAN. Every case uses the
injected local transport and the virtual clock; no Twitch connection is opened.

- INGEST-11 NOTICE: an ordinary NOTICE (for example `msg_channel_suspended`,
  `slow_on` or `delete_message_success`) keeps the socket open and logs exactly
  one line, `[irc] NOTICE msg-id=<id>; staying connected`. Only the symbolic
  msg-id is logged, and only if it matches `^[a-z0-9_]{1,64}$` (otherwise
  `none`); notice text, user names and credentials are never logged. Only a
  login failure is terminal: status becomes unauthenticated, the socket closes
  and no retry is scheduled. A login failure is either of the documented texts
  `Login authentication failed` or `Improperly formatted auth`, or, as a safety
  net, a NOTICE addressed to `*` before the 001 welcome whose text mentions
  auth or login.
- INGEST-12 Whole-room CLEARCHAT: a CLEARCHAT on the joined channel with no
  target-user-id tag and no user parameter drops every earlier line, including
  lines from earlier sockets in the same session, from drafts, pending panels
  and moments. Following Young's ruling, cleared lines are removed rather than
  hidden or marked: no unpublished panel keeps their text or cites their IDs
  in its sources, and undo is invalidated. An approved (published) panel is
  left exactly as it was. A whole-room clear is not an opt-out; viewers who
  chat afterwards are included normally. INGEST-17 pins the published-panel
  rule.
- INGEST-13 Targeted CLEARCHAT: a ban or timeout identified by the
  target-user-id tag removes only that user's lines; other viewers' lines in
  the same panel or moment remain. The adapter also falls back to the trailing
  user parameter when the tag is absent; that fallback is implemented but not
  yet covered by a test. A ban or timeout is never
  an opt-out (Young's ruling): the user's later lines are included again
  (INGEST-13 and IRC-CLEARCHAT-OPTIN). CLEARCHAT for another channel is
  ignored. CLEARMSG is unchanged: it removes the single line named
  by target-msg-id.
- INGEST-14 Raid USERNOTICE: USERNOTICE with `msg-id=raid` on the joined
  channel after the welcome becomes a raid StreamEvent in the shape produced by
  the EventSub `channel.raid` normaliser (`normalizeTwitchEvent` in
  packages/core): `{id, t, type: 'raid', from, viewers}`. `from` is
  msg-param-displayName, then msg-param-login, then display-name, then
  `Anonymous crew`, sanitised; `viewers` is msg-param-viewerCount. INGEST-14
  also checks that other USERNOTICE kinds (such as resub) are ignored. Two
  further rules are tested at adapter level rather than in INGEST-14: a count
  that is not 1 to 9 digits drops the event (IRC-RAID), and a raid before the
  welcome is ignored (IRC-RAID-AUTH).
- INGEST-15 RECONNECT: buffered frames are drained, the old socket closes, and
  after 1 second a new socket re-sends PASS, NICK and CAP, then JOIN after its
  welcome. Frames from the old socket are fenced. A second RECONNECT within
  the 60-second stability window backs off 2 seconds; after 60 stable seconds
  the delay returns to 1 second.
- INGEST-16 Fifteen-minute ceiling: the measured watchdog gap (twice the server
  PING interval) and the retry delay are both clamped to 15 minutes
  (900,000 ms). With PINGs nine minutes apart the watchdog closes the silent
  socket at exactly 900,000 ms rather than 18 minutes. The retry-delay clamp
  cannot be reached under the current three-retry budget (the largest delay is
  4 seconds), so it is not separately observable.

### Group 3 limits and open items

- A whole-room clear can only remove lines the adapter recorded: the 1,024 most
  recent lines that carried an `id` tag. Older lines, or a line without an
  `id`, cannot be withdrawn by a whole-room clear. With the tags capability
  every PRIVMSG carries `id`, and Studio's bounds (24 pending panels, 120 draft
  records) are well within 1,024 lines.
- apps/server/src/ingest/source.ts forwards non-chat events, so an IRC raid
  reaches Studio.
- A CLEARMSG or a targeted clear removes the line from every panel, published
  or not, even one that an earlier whole-room clear spared (INGEST-17,
  IRC-CLEARCHAT-SURVIVOR-BAN). A whole-room clear removes it from drafts,
  pending panels and moments only, preserving approved panels.
  The detector forgets withdrawn lines (T11): withdrawals use the existing
  `forget(ids)` path, and opt-outs from both chat paths call `forgetUser(user)` alongside B2's
  shared `forget(predicate)`. The user-specific call also clears the full
  120-second baseline after the shorter chat windows have expired. These lines
  stop counting towards the spike, baseline and burst windows and are pruned
  from detector records, so a burst made only of withdrawn lines opens no
  moment (MOMENTS-14 to 16, IRC-MOMENT-FORGET, IRC-MOMENT-FORGET-BUS;
  QA-T11-1). B2 also prunes unpublished moment snapshots.


## Group 4: room-wide clears and published panels, emptied and queued deletions

These cases are in tests/ingest-chaos.spec.ts and use the injected local
transport and virtual clock; no Twitch connection is opened.

- INGEST-17 Room-wide CLEARCHAT and published panels (Young's ruling, 31 Oct
  2026, 02:14): a whole-room clear removes the cleared lines from pending
  drafts and moments, and a moment opened afterwards never cites them, even
  though the detector saw them. A panel that was already approved is left
  exactly as it was, deep-equal to its state before the clear. The clear is not
  an opt-out: the same viewer's later chat is drafted. A later CLEARMSG, or a
  later targeted clear (ban or timeout), of a line in the published panel
  still removes it, even though the earlier room-wide clear spared that panel
  (IRC-CLEARCHAT-SURVIVOR-BAN): the adapter keeps a room-cleared line
  findable by id so a later targeted clear can still reach it.
- INGEST-18 CLEARMSG emptied panel: deleting every line of an approved panel
  removes the panel rather than leaving a blank one, and invalidates undo.
  Deleting every line of a pending burst moment removes that moment panel.
  When nothing live is left the source shows Sample Data; on the next chat
  line the live archive is restored without any emptied panel.
- INGEST-18b CLEARMSG queued message: while EventSub chat is active, IRC lines
  wait in the standby queue. Deleting a queued line removes it from the queue,
  so it is not drafted when IRC takes over again. A deletion that arrives before
  its line also blocks that line when it arrives.

Room-wide withdrawals carry `scope: 'room'` on the StreamEvent
(IRC-CLEARCHAT-SCOPE), so Studio can tell them from a single deletion or a ban
or timeout. The source deduplicates the two separately, so a CLEARMSG after a
room-wide clear still reaches Studio.

Protocol reference: [Twitch IRC concepts](https://dev.twitch.tv/docs/chat/irc/),
which on 31 Oct 2026 carries the IRC command and tag reference used here
(NOTICE and its login-failure texts, CLEARCHAT, CLEARMSG, USERNOTICE raid tags,
RECONNECT and PING). https://dev.twitch.tv/docs/chat/irc-commands/ is not needed.
On 31 Oct 2026 it returns 403 from Twitch's documentation host (Amazon S3 behind
CloudFront; S3 answers 403 for a missing page), not from ComicToons. ComicToons never
fetches documentation at run time, so live chat does not depend on it.

## Operator throttle notice (INGEST-19)

The 60-per-second admission limit from INGEST-07 no longer drops chat silently.
Each ordinary line it skips is counted on the source state as `throttled`, and
while live chat is the active source Studio's chat-source card shows a notice
with `role="status"`: "Chat is busier than ComicToons reads: N chat lines
skipped on this connection (limit 60 per second). Opt-outs and deletions are
never skipped." The count starts at zero on each new connection and is cleared
by switching to Sample Data, and the notice is never shown on Sample Data.

- INGEST-19 floods 100 lines in one virtual millisecond: 60 are admitted and 40
  are counted. The notice shows the count at 1440 and 390 px with no horizontal
  overflow and no serious or critical axe findings. A further skipped line
  raises the count, and an opt-out sent into the saturated window still takes
  effect and is not counted. After switching to Sample Data the notice is gone.
- Screenshots are written to artifacts/tmp/ingest-chaos/throttle-notice-{1440,390}.png
  (not versioned).
- Limit: the count covers ComicToons' own admission limit only. Twitch does not
  tell a read-only IRC client when it drops messages, so losses on Twitch's
  side cannot be shown (GAP).


## Current transport and permission boundary

The default IRC transport tries verified TLS 6697, then WSS 443 if TLS fails before welcome or times out waiting for it. A local IRC URL override replaces both legs. A transport name is published only after welcome; the classic card shows it only for real live chat. Masked WebSocket server frames fail closed. The reconnect episode has a fifteen-minute total ceiling in addition to bounded individual waits (tests/irc-wss.test.ts, tests/irc-ceiling.test.ts and tests/transport-label.test.ts).

Read-only anonymous live runs using justinfan with no credentials and only NICK/CAP/JOIN/PONG have Young's standing permission. Writes to Twitch and sign-in as Young still require an explicit yes; the full split is in [LIVE_TEST.md](LIVE_TEST.md). No live chat content, viewer names or run evidence is included here. Ink-me chat fallback remains behind the off-by-default Ink-me and Director flags; opted-out viewers are blocked and ink commands are never quoted.
