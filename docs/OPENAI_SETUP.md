# OpenAI images: local download setup

ComicToons calls the OpenAI API from its Node server. You need API access and available credits; the image allowance inside ChatGPT is not an API credential. Eligible ChatGPT subscriptions may offer a separate API-credit benefit: check [OpenAI's current credit instructions](https://developers.openai.com/api/docs/guides/chatgpt-api-credits). This guide does not create a subscription, purchase credits or guarantee model access for you.

## 1. Download and start the app

1. Open the [submission branch](https://github.com/TYK3/ComicToons/tree/codex/windows-demo-setup), choose **Code → Download ZIP**, and extract the ZIP. Alternatively:

   ```powershell
   git clone --branch codex/windows-demo-setup https://github.com/TYK3/ComicToons.git
   cd ComicToons
   ```

2. Install Node.js 24 with npm, matching the validated local setup. In the project root, run:

   ```powershell
   npm ci
   npx playwright install chromium
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

   The conditional copy preserves an existing `.env`. Keep your private configuration. See [installation](../README.md#️-installation) for Linux dependencies and PowerShell command troubleshooting. Local uncommitted changes are not part of a GitHub download.

3. Follow the [README Twitch setup](../README.md#-configure-twitch-once) for your own Twitch client ID, client secret and callback. Run `npm run dev` and open [Studio](http://localhost:4173/ui.html#/studio). The owner's existing machine uses [port 4122](http://localhost:4122/ui.html#/studio) instead; do not mix callback/port configurations.

## 2. Get an API key

1. Sign in to [OpenAI API Platform](https://platform.openai.com/). Select the organization and project you intend to pay from. A separate project for ComicToons testing makes its usage easier to identify.
2. Open [API billing](https://platform.openai.com/settings/organization/billing/overview). Check for available credits or an eligible subscription credit benefit. Add credits yourself if required; ChatGPT's normal image allowance does not automatically authenticate this app.
3. Open [API keys](https://platform.openai.com/api-keys) for the intended project and choose **Create new secret key**. Give it a recognizable name such as `ComicToons-local`.
4. Store the secret in your password manager or paste it directly into your local app's password field below. Do not paste it into a chat, README, issue, screenshot or Git commit. If you restrict permissions, this app needs model access plus chat completions for source analysis/review and image generation/editing for drawing. A read-only key cannot draw.
5. Review the project's usage and spend controls in the API dashboard. Confirm any hard limit is actually configured; an alert or ComicToons' page-attempt counter is not a guaranteed dollar cap. See [OpenAI production guidance](https://developers.openai.com/api/docs/guides/production-best-practices).

OpenAI may require organization verification or additional model access before image requests work. A connection check confirms access, not available credits or image quality. [Official image API guide](https://developers.openai.com/api/docs/guides/image-generation)

## 3. Use your key for one session

1. In Live Studio, expand **Live setup → Create pages from my live video → Page creation settings**. In Viewer setup, expand **Page creation settings**.
2. Select **OpenAI** and an available model from the app’s dropdown. The current environment example selects `gpt-image-2`; model/account access still needs checking.
3. Paste your key in **API key**. Set **Maximum pages this session** to **1** for your first test.
4. Click **Use my key for this session**, then **Check connection**.
5. Start a two-minute capture of your own playing Twitch stream. The app needs at least four distinct frames. Send short ordinary chat lines during the scene; commands are not dialogue. If necessary, use **Generate a paid preview** after four frames exist.
6. Inspect the actual image and its evidence. A page marked **held** or **failed** has not passed review and must not be treated as successful. Streamer pages wait for **Release** before they reach the audience; Viewer pages do not grant broadcaster controls.

Analysis, drawing and visual review all use your API account. Failed attempts may still incur charges. The one-page limit is an attempt limit, not a promise of one successful page. Do not repeatedly retry an account/quota error.

Session credentials are held on the ComicToons server for up to one hour and forgotten on restart; they are not saved in browser storage. **Use app default / forget my key** removes the session credential. If the server has a configured app key, that action switches to it rather than disabling generation. Stop capture and the server when finished, and revoke a temporary API key in the OpenAI dashboard when you no longer need it.

## 4. Set your own private server default

This is optional. Use it on a machine or server you control so you do not need to enter a session key each time. In the repo root, create/edit the ignored `.env.images` file using a text editor:

```dotenv
OPENAI_API_KEY=replace_with_your_new_private_key
OPENAI_IMAGE_MODEL=gpt-image-2
COMICTOONS_IMAGE_PROVIDER=openai
```

The text above is a placeholder, not a usable key. Replace it only in your private local file. Do not prefix the variable with `VITE_`.

Check that `.env` and your shell/launcher do not already set a different `COMICTOONS_IMAGE_PROVIDER`: process variables and `.env` take priority over `.env.images`. Remove/change the conflicting setting on your own machine. Restart the app and choose **Use app default / forget my key**; the displayed default should say OpenAI and the selected model. Restarting also requires reconnecting Twitch.

When using Git, `git check-ignore .env.images` should print `.env.images`. Before sharing code, run `npm run secrets:public` and `npm run secrets`. A manual ZIP of your whole working folder can include ignored files: prefer GitHub's Download ZIP of the reviewed branch. Check a manually prepared archive yourself.

## 5. Share the local app without sharing a key

People downloading the app enter their own API key using the session steps above, or choose **Use source-frame comic · no image API** to try capture and composition without an image provider. Sample Studio needs neither Twitch sign-in nor a paid image key. Live chat uses each user's Twitch sign-in.

Keep keys in your own private environment or session. Sharing a download containing your key gives someone a reusable credential. Before distributing a source archive, exclude local environment files, captures and chat logs.

## 6. If a key was exposed

Revoke it in [API keys](https://platform.openai.com/api-keys), review recent [usage](https://platform.openai.com/usage), and create a replacement. Deleting a chat message or removing a committed string is not revocation. Update only your private configuration and restart. [OpenAI authentication guidance](https://developers.openai.com/api/reference/overview#authentication)

Only placeholders belong in this tutorial and `.env.example`; real credentials stay in your private configuration.
