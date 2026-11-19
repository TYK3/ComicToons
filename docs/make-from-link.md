# Make a comic from a Twitch link

In Live Studio, open **Live setup → Create pages from a VOD or clip**, then paste a Twitch link into **Make a comic from a link**. This import uses clip titles and thumbnails; it is separate from timed live-video capture and reference-frame illustration. You can add the result to that channel's manga series as a new chapter. The code is in `apps/server/src/import/` and `apps/server/src/series/`, and the card is `apps/web/src/ui/screens/studio/MakeFromLink.tsx`.

## What you need

- **Twitch app credentials** (`COMICTOONS_TWITCH_CLIENT_ID` and `COMICTOONS_TWITCH_CLIENT_SECRET`, see [Configuration](../README.md#configuration)). Clip and VOD details come from Twitch's read-only Helix API, using an app token. If no credentials are set, the request is refused with 409 ("Twitch app access is not set up on this machine…") and nothing is sent to Twitch.
- **Live Studio:** the server adapter implements `importLink` and `addSeriesChapter`; the routes are registered in `apps/server/src/app.ts`. Use the Live workspace for Twitch imports.

## Accepted links

The box takes one link, or up to 6 clip links (one per line). Only `http` and `https` links are accepted, with no user name or password in them.

| Link | Example form | What happens |
|---|---|---|
| Clip | `clips.twitch.tv/<slug>`, or `twitch.tv/<channel>/clip/<slug>` (also `www.` and `m.`) | 1 to 4 panels from the clip |
| VOD | `twitch.tv/videos/<id>`, with or without `?t=` | Up to 6 panels from the VOD's clips |
| Channel | `twitch.tv/<channel>` | Switches the Studio to live chat on that channel |

Anything else is refused with 400 and a plain message (for example "… is not a Twitch link."). Twitch's own page paths, such as `/directory`, are not treated as channels.

## VODs: the first 10 minutes

- ComicToons only reads the first 10 minutes (600 s) of a VOD, counted from its start. A longer VOD is not refused, just clamped. The card says so, for example "from the first 10 min of a 42 min VOD".
- The clips made inside that window are ranked by views, and the top 6 are kept. If two clips have the same views, the earlier one wins. The kept clips are then put back in time order.
- Each clip becomes one panel, placed at its time in the VOD.
- A missing, private or deleted VOD gives 404. So does a window with no clips ("No clips … in the first N min").

## Clips: 1 to 4 panels each

- **One clip** makes 1 to 4 panels from its title and thumbnail.
- **Chat log (optional):** you can add a `.txt` or `.json` chat log. It is split into even, back-to-back chunks, one per panel; for example, 9 lines become 3, 2, 2 and 2. No line is dropped or reordered.
- **Several clips** (up to 6, one per line) make one panel each, in the order you pasted them. Clips that can't be found are listed as missing.

## Art

- With `COMICTOONS_ART_NETWORK` unset (the default), the clip thumbnail is used as the panel frame and nothing extra is fetched.
- With `COMICTOONS_ART_NETWORK=1`, the thumbnail is inked locally and served from `/api/import/frame/<id>.png`. If that fails, the plain thumbnail is used.

## Series chapters

- After a comic is made, the card offers a chapter title field and **Add to #channel's manga series**.
- **Which channel:** the channel comes from the VOD's owner, or else from the clip link, or else from the clip's broadcaster.
- **Panels:** a chapter is built from the server's own copy of the import, not from anything the browser sends.
- **Endpoints:**
  - `GET /api/channel-series/:channel` returns the channel's chapters, numbered in order.
  - `POST /api/channel-series/:channel/chapters` with `{importId, title?}` adds a chapter (201). If you give no title, a default is used.
- **Storage:** each channel's series is one JSON file under `artifacts/series/`, which git ignores. It is written atomically, and additions to the same channel happen one at a time.
- **Short memory:** the server keeps only the last 20 imports, in memory. After a restart, or for an unknown import, adding a chapter gives 404 ("Import it again").
- **Bad channel name:** gives 400.

## Access and errors

- **Who can write:** `POST /api/import` and the chapter POST are studio-changing requests, so the director-key rule applies. Without a key, only the local machine can use them; with a key, the header is required. Reading a series is open, like the other reads.
- **Twitch errors** are never reported as a server error (5xx), because the Studio would read that as "server unreachable". Instead you get:
  - 409 when the app credentials aren't set up;
  - 424 when Twitch's API returns an error.

## Not covered yet

- Not checked against real Twitch: all tests used a local fake of the Helix API (GAP).
- The card is wired into Live Studio. The repository includes isolated import-wire browser checks (`npm run e2e:import-wire`); these are not proof of a successful real-Twitch import in the current working tree.
- Live streams are not added as chapters yet.
