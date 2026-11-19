# Hosting the Sample demo on Vercel

The Sample demo is a static site. It uses the bundled Sample data through `MockAdapter`
(`apps/web/src/ui/demo-main.tsx`), so it needs no API server, no Twitch sign-in and no keys.

- Build: `npm run build:demo` writes `apps/web/dist-demo` (about 75 MB, mostly sample art).
- `vercel.json` sets the install command, build command, output directory and a rewrite of `/` to `/demo.html`.
- Set no environment variables on the Vercel project. Never add `.env` values there for the demo.
- Live Twitch features (Connect with Twitch, Live chat, panel generation) need the API and stay local-only.

Deploying is a manual step: `vercel` from the repo root, or import the repo in the Vercel dashboard.