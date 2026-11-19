# B1b studio write access

Implemented independently of F3; no F3 patch was applied. The shared module exports directorAccess, directorGuard, readDirectorKey and the current environment/header constants. F3 can import them when accepted.

The app captures the trimmed director key once from its injected environment. A configured key is checked using SHA-256 digests and timingSafeEqual. Without a key, the socket and every forwarded hop must be loopback. Authentication runs onRequest before parsing and schema validation. Failure bodies contain fixed guidance only.

Guarded POST routes: /api/ingest, /api/replay, /api/settings, /api/approve, /api/reject, /api/undo, /api/caption, /api/stop, /api/recaps, /api/end, /api/catchup, /api/comics/:id/title. Read routes and existing stream shutdown behavior are unchanged. Development proxies forward client addresses for /api, /exports and /art.

Participation writes remain unchanged for F3: /api/participation/polls, /polls/end, /rewards/connect, /redemptions/:id, /catchup, /director/:action (approve or reject), /mock-event and /mock-connect, all under /api/participation. The last two exist only with the mock flag enabled.

S6/S7 client follow-up: provide a director-key field and send its value in x-comictoons-director-key on studio writes. Keep it out of URLs, logs and server responses. No protected client files were edited.

Validation: Node 20 typecheck and repository lint pass. Direct assertion totals: director guard 17/17, art route 1/1, participation 19/19. Both SSE assertions are blocked by localhost-binding EPERM in the sandbox. The requested four-file test invocation reports three passing files and one blocked file. Injected requests verify every guarded route, pre-parsing denial, unchanged state after denial, current/legacy environment precedence and no key echo. All three proxy settings were inspected by importing the configuration; captured logs contain no test key. No real network/image calls, browser tests or full gate were run. Protected client files and the session identifier are unchanged.
