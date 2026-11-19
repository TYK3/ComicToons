# Studio samples and viewer output

Open http://127.0.0.1:4122/#/studio and choose **Sample chat**. Its queue, participation and chat belong to a local SampleStudioAdapter, separate from the server-backed Live workspace. State is persisted in this browser and shared with same-origin viewer tabs through storage events. No sample action posts to Twitch.

Choose Critical Mess, Frame Perfect, Batter Days or Jynxzi QA. Images decode before being added one at a time; replay speed changes the interval. Pause/resume and restart are available. Reloading restores the queue paused. Jynxzi is a chat-inspired interpretation using a separate public appearance reference, not a reconstruction of a verified video moment.

## Producer and audience flow

- **Incoming review:** each new panel waits in the desk and grid. Release one or use Accept all waiting for the current batch. Later arrivals still wait. Released panels animate in On air and the sample viewer output.
- **Vote:** start a dialogue vote, use Vote !1/!2/!3 or send the command in Sample chat, then end it. Counts appear on air; the winning line replaces the reviewed balloon inside the selected picture. A waiting panel still requires release. A vote with zero votes leaves the dialogue unchanged.
- **Ink Me:** redeem the sample reward, create the fox cameo panel, review it, then release. The cameo reveal appears on air. Refund removes the request without releasing a panel. This is a prepared fictional fox illustration, not automatic image generation for arbitrary requests.
- **Prediction:** start, back an outcome with sample points, and pay out the chosen outcome. On air shows the question, participation and result. Sample points have no real balance or value.
- **Privacy and arrivals:** !noink increments the sample privacy count without quoting the viewer; !previously or Simulate a raid plays the catch-up. The separate newcomer view updates after each release.
- **End/bind:** the sample session reader uses released panels only. The public authored-story readers remain complete five-page fictional examples.

The On air card uses the same ViewerStage component as standalone viewer output, including release, participation and catch-up motion. Reduced-motion settings disable movement. Preview continues showing the sample during panic hide; actual output hides. Announcements occupy their own space rather than covering faces.

Open the explicit **Open viewer output** and **Open newcomer view** links. Their `workspace=sample` query selects the local simulation; default OBS URLs remain server-backed. Sample state is local to this browser, not a hosted/public shared session.

## Live scope and image baseline

Live chat opens clean and requires Twitch sign-in to read a public channel. Explicit link submission starts a fresh queue; automatic reconnects preserve their session. Streamer participation controls remain restricted to the signed-in owner's channel.

Chat reading and highlight analysis do not constitute scene reconstruction. Automatic scene capture, transcription and GPT scene-page generation are still unavailable. Existing live library drafts are illustrative and do not prove a matching scene was analysed. Faithful generation must use a timestamped frame of the actual moment and matching chat or reviewed transcription. Faces, eyes, mouths, hands and key action must remain clear of text, overlays and panel crops; recompose or paginate as needed.

The corrected Jynxzi sample and four painted palettes are bundled under `apps/web/public/qa/jynxzi/`. See JYNXZI_QA.md for source limits and prompts.
