# Twitch sign-in setup

Register ComicToons in the Twitch developer console and add this exact OAuth redirect URL, with no trailing slash:

```
http://localhost:3001/auth/twitch/callback
```

Put COMICTOONS_TWITCH_CLIENT_ID, COMICTOONS_TWITCH_CLIENT_SECRET and COMICTOONS_TWITCH_REDIRECT_URI in the untracked .env file, then restart the API. The redirect defaults to the URL above. Optional TWITCH_CHANNEL selects a public chat channel; otherwise live ingest uses the signed-in login. An explicit channel in the source request takes precedence. No credentials are required for Sample Data.

Start sign-in on the same machine at /auth/twitch/login (API port 3001, or through the web proxy). The callback redirects to http://localhost:4173/connect?twitch=connected, using COMICTOONS_WEB_PORT when configured. Denied consent redirects with twitch=denied. State is random, single-use and expires after ten minutes. Authentication routes suppress request logs and never return authorization codes or tokens. Provider requests use an injectable fetch and identity-service base URL; tests use mocked responses only.

The API stays bound to 127.0.0.1. Some systems resolve localhost to IPv6 ::1 first, which can miss this IPv4-only listener. Check local name resolution if the callback cannot connect. If registering an IPv4 callback instead, update both the developer console and TWITCH_REDIRECT_URI identically; do not silently substitute one host for the other. See [application registration](https://dev.twitch.tv/docs/authentication/register-app/) and [authorization-code flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/).

The web dev server binds 127.0.0.1 by default. COMICTOONS_WEB_EXPOSE=1 explicitly enables a LAN listener. Configure COMICTOONS_DIRECTOR_KEY before exposing it; remote writes require that value in x-comictoons-director-key. All API, export, art and auth proxies forward client addresses so a proxied remote client cannot impersonate loopback. Twitch sign-in initiation remains local-only even when a director key is configured. The callback uses state authentication and remains reachable.

## Requested scopes

These seven base scopes match the IRC and participation plan, using the official scope/endpoint evidence recorded in the supplied readiness audit. No live documentation or provider requests were made during implementation.

| Scope | Purpose | Documentation |
|---|---|---|
| user:read:chat | Receive EventSub chat and deletions | [Scopes](https://dev.twitch.tv/docs/authentication/scopes/#userreadchat) |
| chat:read | Receive chat over the existing read-only IRC adapter | [IRC authentication](https://dev.twitch.tv/docs/chat/irc/) |
| channel:manage:redemptions | Create rewards, update redemptions and receive redemption events | [Scopes](https://dev.twitch.tv/docs/authentication/scopes/#channelmanageredemptions) |
| channel:manage:polls | Create/end polls and receive updates | [Scopes](https://dev.twitch.tv/docs/authentication/scopes/#channelmanagepolls) |
| channel:manage:predictions | Create/end predictions and receive updates | [Scopes](https://dev.twitch.tv/docs/authentication/scopes/#channelmanagepredictions) |
| bits:read | Receive cheers | [Scopes](https://dev.twitch.tv/docs/authentication/scopes/#bitsread) |
| channel:read:hype_train | Receive hype-train events | [Scopes](https://dev.twitch.tv/docs/authentication/scopes/#channelreadhype_train) |

The management scope covers redemption reads and subscriptions; the additional redemption-read scope is unnecessary. Followers are outside this authorization plan; outgoing bot replies request their optional user-token scope only when enabled.

## Token lifecycle and integration

Tokens exist only in the server's in-memory TwitchTokenStore; restarting requires sign-in again. Validation runs on connect and hourly on an unref'd interval. A validation 401 refreshes once. Refresh is single-flight, preserves rotated refresh tokens and clears the session on refresh failure. withTwitchAuth retries a Helix call once after refresh on 401. See [refresh tokens](https://dev.twitch.tv/docs/authentication/refresh-tokens/) and [validation](https://dev.twitch.tv/docs/authentication/validate-tokens/).

TwitchTokenStore implements TwitchAuthProvider from eventsub/types.ts. getAuth and ircSnapshot are private server integration methods; only status is returned over HTTP. Disconnect clears credentials and selects the existing IRC standby as fallback. New IRC authentication snapshots are unavailable until sign-in; a fresh connection still fails closed without credentials. The IRC constructor receives the existing authenticate callback unchanged, including the oauth: token prefix and signed-in login; IRC resilience remains owned by its existing implementation.

T3 integration remains separate: the app now announces the provider through the twitch-auth bus hand-over that the accepted bridge can consume once integrated. The shared interface is already present; a real Helix client can be supplied separately by its owner. No EventSub or participation behavior was changed here beyond the app-level access guard. Pending-desk GET and every participation write require the director key or a local socket with entirely local forwarded hops. This includes the optional mock endpoints.

## Connect screen mount request

The minimal TwitchConnect component is intentionally unmounted and has no new styles. S6/S7 should update apps/web/src/components/Connect.tsx, which already serves /connect and /auth:

```tsx
import {TwitchConnect} from './TwitchConnect';
```

Place `<TwitchConnect/>` inside the existing main element after the page heading. It includes a password field and Save/Forget controls for the tab's director key; it never reloads the stored value into the field. Do not pass OAuth tokens. The component polls public status, links to sign-in and submits the guarded disconnect. Final styling, screenshots and mounting remain with the front-end owner. Preserve the single installDirectorKeyTransport import and call in main.tsx if that entry point is rebuilt.


## Director key contract

Set COMICTOONS_DIRECTOR_KEY on the server. The legacy PANELCAST_DIRECTOR_KEY name remains a fallback for one release; the current name wins when both are present. A blank or whitespace-only current value disables the configured key. COMICTOONS_WEB_EXPOSE=1 explicitly enables LAN access to the development web server; configure a director key before exposing it. This does not expose the IPv4-loopback-only API directly.

Clients send the key in `x-comictoons-director-key`. The browser transport stores it only in sessionStorage under `comictoons.directorKey`, with an in-memory fallback when sessionStorage throws. It never places the key in persistent storage or a URL, never logs it and never renders the stored value back. Save clears the password field; Forget clears both storage and memory. The transport reads the current key at request time and preserves an explicit caller-supplied header. It only attaches a stored key to same-origin requests.

The exact current guarded routes are:

```text
POST /api/ingest
POST /api/replay
POST /api/settings
POST /api/approve
POST /api/reject
POST /api/undo
POST /api/caption
POST /api/stop
POST /api/recaps
POST /api/end
POST /api/catchup
POST /api/comics/:id/title
POST /api/twitch/disconnect
POST /api/participation/polls
POST /api/participation/polls/end
POST /api/participation/rewards/connect
POST /api/participation/redemptions/:id
POST /api/participation/catchup
POST /api/participation/director/:action
POST /api/participation/mock-event
POST /api/participation/mock-connect
GET /api/participation/director
```

The app-level boundary also guards any future non-GET/HEAD/OPTIONS request under `/api/participation/`. The current director actions are approve and reject. Mock-event and mock-connect are registered only when the participation mock flag is enabled. HEAD for the pending director desk is protected just like GET. Authentication precedes body parsing and validation, including for disabled features. Other GET/HEAD reads, OPTIONS, SSE, exports and art remain public.

When a director key is configured, even localhost must send the correct header. Missing or incorrect keys return HTTP 401 with exactly:

```json
{"error":"Enter the director key to use this page."}
```

When no director key is configured, writes are allowed only from a loopback socket with exclusively loopback X-Forwarded-For hops (or no forwarded header). A non-loopback socket is never local, regardless of its forwarded header. Non-local writes return HTTP 403 with exactly:

```json
{"error":"Studio writes from another device need a key. Set COMICTOONS_DIRECTOR_KEY and restart ComicToons."}
```

GET `/auth/twitch/login` is always local-only and never accepts a director key as a substitute. A non-local login attempt returns HTTP 403 with exactly:

```json
{"error":"Start Twitch sign-in from this machine."}
```

`/auth/twitch/callback` needs valid single-use OAuth state, not a director key; successful consent also supplies the authorization code for server-side exchange. Other callback validation rules still apply.

On a guarded route's JSON 401 response, the installed client transport dispatches `comictoons:director-key-required` on window. Its CustomEvent detail is exactly `{status: 401, url: "/api/stop"}` for that example route: only the status and URL path, without query, header or key. The response remains readable by its original caller. Owners can listen for this event to show key entry; no automatic write retry occurs. Public or cross-origin requests do not trigger the event. The bootstrap consists of one import and one installation call before render in main.tsx; keep both when rebuilding the entry point.


## Chat source and hand-over

EventSub is the sole admitted chat transport while subscribed; IRC remains a hot standby and becomes the fallback when EventSub loses chat connectivity. ChatSource.setEventSubChat selects the transport; acceptEventSub admits chat only for a requested Twitch session. Subscribe availability can mark that session live without increasing received. IRC raids and generic non-chat signals forward to the source callback, but do not increase received or establish chat liveness; IRC raids are suppressed while EventSub owns chat. Otherwise raw USERNOTICE raids are published by the app before the direct Studio callback, preserving their five-field shape and opening a moment through the existing bus path. IRC/EventSub raid duplicates with different envelope IDs are coalesced for ten seconds by normalized raider and viewer count, using the bounded shared ledger.

Both chat transports share the existing privacy, exclusion and 60 messages/second admission pipeline. The bounded 1024-entry ledger retains message IDs across switches and keeps the existing 500 ms same-payload debounce. If either delivery lacks an ID, identical user/text payloads across transports debounce for five seconds; observed overlap remains remembered when switching back. The heuristic may coalesce identical id-less repeats during that window. Admission ledgers clear on start/sample/close, not on transport selection. Ordinary admitted chat alone increments received.

IRC standby retains at most 200 messages from the last ten seconds. On fallback, retained messages not already admitted are replayed in arrival order through the same rate/privacy limits; expired, overflowed or throttled messages are not replayed. Opt-out and deletion controls from either transport bypass buffering and throttling immediately while Twitch is requested, including during transitions. Controls are idempotent within the bounded deletion/ID retention; opt-outs retain the existing per-channel permanent ledger and fail-closed capacity. Deleted or opted-out standby lines are purged. Signing out selects IRC fallback and flushes the bounded buffer through the same ledger; late EventSub events are rejected before shared-bus publication.

The app emits twitch-auth `{auth}` once per connection transition, including already-connected startup after plugins are ready. The value is the server-side TwitchAuthProvider object, not a token snapshot; no Helix value is supplied and nothing is logged. Bus emission avoids changing the currently installed participation plugin's option type and matches T3's TwitchHandover listener. Refresh/validation do not re-announce a connected session.

The app re-arms eligibility on twitch-connected `{source:'eventsub'}` or eventsub-state `{state:'subscribed'}` but never selects EventSub from these signals alone: T3 announces a batch even if chat subscription failed. The first chat notification after hand-over proves delivery and selects EventSub before shared admission. A bridge-input bus routes real T3 chat through acceptEventSub before publishing admitted events to the shared bus; both transports therefore use the same privacy/rate/dedup gate. App publication gives id-less admitted events a private-run canonical ID so Studio's detector and live callback share one event ID. It falls back on a new twitch-auth hand-over, sign-out, chat revocation, twitch-disconnected or non-subscribed eventsub-state. Because T3 has no disconnect signal, the app also reads its existing status route every 500 ms and before state reads; a missing chat subscription or non-subscribed status flushes standby and selects IRC. Successful status only re-arms proof, never selects chat. All listeners are removed on shutdown.

Owner requests before live integration:

- **EventSub (T3) lane:** emit twitch-disconnected `{source:'eventsub'}` whenever chat delivery is lost/stopped, and twitch-connected `{source:'eventsub'}` after each successful chat resubscription; alternatively emit eventsub-state `{state}` on every transition. Only advertise chat availability when channel.chat.message is subscribed. The inspected T3 bridge emits its connected signal just once and currently has no disconnect signal, so automatic fallback/recovery needs this change. Consume twitch-auth and tear down the bridge when the provider becomes disconnected.
- **Studio lane:** Studio currently registers its raw stream-event listener before the app's admission listener. For real messages with IDs, its seen-event ledger prevents the later live callback ingesting the detector twice. The app now gates the real bridge before shared publication and assigns canonical IDs to id-less admitted events, preventing that bypass for wired transports. Keep any other raw chat publishers behind shared admission, preserving non-chat bus events. The app now publishes admitted IRC raids to the bus before the direct callback, so the existing busEvent detector path opens exactly one moment and participation sees one catch-up. The direct liveEvent path is still text-gated: handle fresh non-chat signals before the `!text` return, feed MomentDetector without requiring dialogue, and respect the existing event-ID ledger so a raid already consumed from the bus is not counted again. Keep this as a Studio-owner change; raw IRC-to-app tests cover the bus path in both cross-transport arrival orders.
- **IRC (T5) lane:** keep the inspected USERNOTICE raid mapping and Twitch message IDs intact when T5 lands. No IRC resilience or transport changes were made here.


## Sign-in configuration and renewal

COMICTOONS_TWITCH_CLIENT_ID, COMICTOONS_TWITCH_CLIENT_SECRET and COMICTOONS_TWITCH_REDIRECT_URI take precedence over TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET and TWITCH_REDIRECT_URI respectively. Explicit empty current settings remain empty. The redirect defaults to exactly http://localhost:3001/auth/twitch/callback; register that same URL. The environment example uses the current names. TWITCH_CHANNEL still selects the channel, falling back to the signed-in login.

The seven base scopes include both chat:read for IRC and user:read:chat for EventSub. Only when COMICTOONS_FLAG_BOT_REPLIES is enabled is user:write:chat added ([scope reference](https://dev.twitch.tv/docs/authentication/scopes/#userwritechat)). Neither user:bot nor channel:bot is requested: this flow uses a user token. Public status includes connected, channel, granted scopes and missingScopes; sign in again when required scopes are missing. No credential fields or values are included. Refresh replaces private auth and stores the rotated refresh credential for the next refresh; rejected refresh clears private auth.


## Loopback endpoint overrides

Optional COMICTOONS_TWITCH_AUTH_BASE_URL accepts an HTTP(S) origin with or without /oauth2; both forms use /oauth2/authorize, /oauth2/token and /oauth2/validate. COMICTOONS_TWITCH_HELIX_BASE_URL supplies the Helix base (normally ending /helix), and COMICTOONS_TWITCH_EVENTSUB_WS_URL supplies the WS(S) endpoint. COMICTOONS_TWITCH_IRC_URL is validated as irc(s) with an explicit port and no path; The T6 transport reads this setting directly. Empty settings preserve production defaults.

Startup rejects malformed endpoints, credentials/query/fragment in endpoints, and hosts other than localhost, 127.0.0.1 or ::1. Errors name only the variable. COMICTOONS_TWITCH_ALLOW_REMOTE_OVERRIDES=1 explicitly permits remote override hosts; protocol/shape validation remains enforced. Tests inject fetch and sockets and never dial these endpoints.


## Confirmed live-channel check

Young confirmed the local redirect as http://localhost:3001/auth/twitch/callback. Live sign-in is Young's step only. The test channel is tyk_twitch, broadcaster ID 796822059, with broadcaster_type '' (not Affiliate or Partner). For this channel, Ink me must show exactly "Ink me needs an Affiliate or Partner channel"; do not expect live reward creation to succeed. Young approves each public or irreversible live-channel action before it is performed. These account facts are user-supplied; no live lookup was made during implementation.


## Anonymous read-only fallback

COMICTOONS_TWITCH_ANON=1 enables signed-out IRC using a helper-minted justinfan login. All other values keep the default fail-closed behavior. The app wraps the private snapshot callback with withAnonymousFallback; signed-in credentials always win. App sign-out does not force Sample Data, so an existing IRC standby remains available and later anonymous reconnects are possible when enabled. No anonymous PASS or PRIVMSG is sent, and the adapter exposes no chat-posting API.

COMICTOONS_TWITCH_IRC_URL selects an explicit irc:// or ircs:// localhost, 127.0.0.1 or ::1 endpoint with a port and no credentials, path, query or fragment. The transport now reads that setting itself; the app validates it at startup. IRC stays loopback-only even when remote overrides are enabled for other endpoint types. With no override, verified TLS to the production IRC endpoint is unchanged. The anonymous convention is undocumented and can be restricted by Twitch; no live connection was made for these tests.
