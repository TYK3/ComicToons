# ComicToons overlay in OBS: 5-minute setup

For Young. This puts the ComicToons comic strip on your stream as a transparent layer over your game or camera. You need OBS Studio and ComicToons running on the same computer.

Setting names in **bold** are copied from OBS's own knowledge base (KB). Sources are listed at the end. Where the KB doesn't name something, it is marked **GAP**: the wording in your OBS version may be slightly different.

## Before you start (1 minute)

1. Start ComicToons from the repo folder with `npm run dev`.
2. In a normal browser, open the studio at <http://localhost:4173/studio> and sign in to Twitch as usual (see `docs/twitch-setup.md`).
3. In the same browser, open <http://localhost:4173/ui.html#/overlay>. With nothing approved yet the page draws nothing at all: no box and no text, so OBS stays clear. To check it, approve a panel in the studio; it appears in the bottom-right corner. Then you can close that tab.

## Add the browser source (2 minutes)

1. In OBS, pick the scene you stream from.
2. Click the **+** button at the bottom of the **Sources** dock and choose **Browser** (the KB calls this the *Browser Source*). Name it `ComicToons overlay`.
3. In the properties window, set:

| OBS setting | Set it to | Why |
| --- | --- | --- |
| **Local file** | Off | The overlay is served by ComicToons, not loaded from a file. |
| **URL** | `http://localhost:4173/ui.html#/overlay` | This is the address `npm run dev` serves, and the only overlay page that shows running chat votes. The older page at `/overlay` does not show them. If you changed the web port, use your port instead. |
| **Width** | `1920` | Match your **Base (Canvas) Resolution** (Settings → Video). OBS's own default is 800, which is too small. |
| **Height** | `1080` | As above. Use `1280` × `720` if your canvas is 720p. The page draws a 1920 × 1080 stage and scales it to the source size, so 720p shows the same layout at two thirds of the size. |
| **Use custom frame rate** | Off | The overlay only animates briefly when a panel arrives, so it doesn't need its own frame rate. |
| **FPS** | Leave at 30 | Only used if **Use custom frame rate** is on. If you turn it on, 30 is plenty; the KB warns that 60 fps can be very taxing. |
| **Custom CSS** | Leave the default | The default makes the page background transparent and hides scroll bars. The overlay is transparent on its own too. |
| **Shutdown source when not visible** | Off (see below) | |
| **Refresh browser source when scene becomes active** | Off | Not needed: the overlay reconnects by itself. |
| **Page permissions** | Leave the default | ComicToons doesn't use them. |

4. Click **OK**.

### Shutdown source when not visible: our advice

- **Keep it Off while you're live.** With it on, OBS unloads the page whenever the source is hidden (eye icon) or its scene isn't active, and loads it again from scratch when it comes back. That means a short gap, with nothing drawn, before the strip reappears.
- Nothing is lost if you do switch it on. Approved panels live in the ComicToons server, not in the page, so the strip comes back as it was.
- **Turn it On only if OBS is short on CPU or memory** and the overlay sits in a scene you rarely use.

## Place it (1 minute)

The strip is drawn in the bottom-right corner: the newest panel, with up to two earlier panels above it and a small "ComicToons" credit. With two approved panels on a 1920 × 1080 source it is about 720 × 666 pixels, 48 pixels in from the right and bottom edges; on 1280 × 720 it is the same at two thirds of the size (about 480 × 444). The rest of the page is fully transparent.

- To move it, click the source in the preview and drag it.
- To size it exactly, use **Edit Transform** (Edit → Transform → Edit Transform…, or Ctrl-E / Cmd-E).
- To show only part of it, hold Alt (Option on a Mac) and drag an edge to crop it.
- In the **Sources** dock, keep it **above** your game or camera source, so it is drawn on top.
- Don't stretch it to a different shape. Change **Width** and **Height** instead, so the text stays sharp.

## Check it is live (1 minute)

1. **Empty state.** With nothing approved, the overlay draws nothing, so the OBS preview shows only your other sources. That is correct. Approve a panel to see it appear; if it doesn't, check that the eye icon next to the source is on and that the source is above your other sources.
2. **First panel.** In the studio, approve a panel (or go live and wait for chat to produce a moment, then approve it). It should appear in OBS almost at once: in the automated test, panels reached the overlay about 0.3 seconds after **Approve** and about 0.45 seconds after a chat moment when approval was off.
3. **Connection.** If the studio stops, the overlay draws no warning on stream; the last panels stay on screen (in a local check with `npm run dev` they were still there after 6 and 30 seconds). Recovery after a restart has not been tested on a live run; if the overlay stays stale once ComicToons is running again, use step 4.
4. **If it is stuck** (old content, or blank after you changed the URL), open the source's properties and click **Refresh cache of current page**.
5. **Seeing the page as OBS sees it.** OBS can open an interactive window for a browser source (right-click the source → **Interact**). **GAP:** this menu item is not in the OBS KB; it is confirmed only by the OBS forum. You don't need it for normal use; never click inside the overlay during a stream.

## Good to know

- **Quiet chat.** A live session stays live when chat goes quiet, for any length of time: approved panels stay on the overlay and the studio does not switch to Sample Data. Only a real end (a dropped connection, a lost sign-in, or switching source) leaves Live.
- **Restarts.** If you restart ComicToons (`npm run dev`), the overlay reloads itself and returns within about a second. ComicToons keeps your Twitch sign-in in memory only, so after a restart sign in again from the studio before you go live. While the studio is down, the last approved live panels stay visible, with no label on stream, until a new event-stream snapshot arrives.
- **Hide it in an emergency.** Click the eye icon next to the source in OBS. ComicToons' own hide control in the studio clears the strip too.
- **Nothing leaves your computer.** The overlay only talks to ComicToons on `localhost`.

## Sources (checked 31 October 2026)

- OBS KB, Browser Source: property names, defaults and the default Custom CSS (**Local file**, **URL**, **Width**, **Height**, **Use custom frame rate**, **FPS**, **Custom CSS**, **Shutdown source when not visible**, **Refresh browser source when scene becomes active**, **Page permissions**, **Refresh cache of current page**): <https://obsproject.com/kb/browser-source>
- OBS KB, Sources Guide (the **+** button in the **Sources** dock, the eye icon, source order, **Edit Transform** and Ctrl-E / Cmd-E, cropping with Alt): <https://obsproject.com/kb/sources-guide>
- OBS KB, OBS Studio Overview (Settings → Video: **Base (Canvas) Resolution**, **Common FPS Value**, the 60 fps warning): <https://obsproject.com/kb/obs-studio-overview>
- **GAP:** **Interact** is not in the KB. It is confirmed only by the OBS forum, for example <https://obsproject.com/forum/threads/use-chrome-browser-for-sources.145995/>.
- **GAP:** the KB describes the source as *Browser Source*; the entry in the **+** list is labelled **Browser** in current OBS builds. This wasn't checked against a running OBS for this guide.
- **GAP:** the automated test uses Playwright's Chromium. OBS uses the Chrome Embedded Framework (per the KB), so behaviour should match, but it wasn't checked inside OBS itself.

## Automated overlay check

Run `npm run test:obs` separately from `npm run e2e`; the gate runs it immediately after e2e finishes. The OBS stack owns its loopback API and web servers on 3102/4102 by default. `COMICTOONS_OBS_API_PORT` and `COMICTOONS_OBS_WEB_PORT` override those ports; when absent, `COMICTOONS_TWITCH_TEST_APP_PORT` and `COMICTOONS_TWITCH_TEST_FAKE_PORT` supply the gate's lane. The fake IRC transport is in memory and opens no additional listener.
