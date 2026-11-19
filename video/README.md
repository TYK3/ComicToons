# ComicToons demo video

A [Remotion](https://www.remotion.dev) project that renders the four-minute demo video (1920×1080, 30 fps). It combines animated titles, captions and callouts with screen recordings of the Sample demo.

```text
video/
├─ capture/record.mjs       Playwright: records the Sample demo as separate 1920×1080 clips
├─ capture/screenshots.mjs  Playwright: the README screenshots in docs/media
├─ capture/make_music.py    Synthesises the original ambient music bed
├─ src/                     Remotion scenes (Root.tsx lists every scene, caption and callout)
└─ public/                  Fonts, art, music bed. Recorded clips go in public/clips (git-ignored)
```

## Rebuild it

Run from the repository root unless noted.

```sh
npm ci
npm run build:demo
(cd apps/web/dist-demo && python3 -m http.server 5190) &    # serve the static Sample demo

npm --prefix video ci
node video/capture/record.mjs                                # records, converts to 30 fps H.264, writes hero.png

python3 video/capture/make_music.py 250 video/public/audio/bed.mp3   # optional, already committed

cd video
npx remotion studio                                          # interactive preview
npx remotion render ComicToonsDemo out/ComicToons-demo.mp4 --codec=h264 --crf=24
```

`DEMO_BASE` points the recorder at another host, for example the live demo at `https://comictoons-demo.vercel.app/demo.html`.
