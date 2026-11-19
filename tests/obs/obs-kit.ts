// Starts ComicToons the way a streamer runs it for OBS: the real API app and the real Vite web
// server (the same apps/web/vite.config.ts that `npm run dev` uses, with its /api proxy), but
// with chat coming from the in-memory Twitch IRC fake instead of irc.chat.twitch.tv.
//
// Dedicated loopback ports default to 3102/4102 and can be overridden for parallel runs.
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer as createViteServer, type ViteDevServer} from 'vite';
import {createApp} from '../../apps/server/src/app.ts';
import {authenticatedIrcFactory} from '../../apps/server/src/ingest/source.ts';
import {readProductEnv} from '../../packages/core/src/env.mjs';
import {obsPorts} from './ports.ts';
import {FakeTwitchIrc} from './fake-twitch-irc.ts';

const repo = resolve(import.meta.dirname, '../..');
export const CHANNEL = 'obs_fake_channel';
const BOT = 'obs_fake_bot';
// Not a credential: a fixed local value that only the in-memory fake accepts.
const FAKE_TOKEN = 'fakeobsoverlaytoken0000000000';

/** The app sees no Twitch app config and no provider keys: nothing here can reach Twitch or art APIs. */
const appEnv: Record<string, string | undefined> = {NODE_ENV: 'test', MODE: 'live', COMICTOONS_TWITCH_ANON: '1'};

export function assertOffline() {
  if (readProductEnv('COMICTOONS_ART_NETWORK') === '1') throw new Error('Unset COMICTOONS_ART_NETWORK (or set it to 0) before running the OBS overlay test.');
}


type App = ReturnType<typeof createApp>;

export class ObsStack {
  readonly fake = new FakeTwitchIrc(CHANNEL, FAKE_TOKEN, BOT);
  apiPort = 0;
  webPort = 0;
  private app?: App;
  private vite?: ViteDevServer;
  private recapDirectory = '';

  get webOrigin() { return `http://127.0.0.1:${this.webPort}`; }
  get apiOrigin() { return `http://127.0.0.1:${this.apiPort}`; }
  /** The exact URL a streamer pastes into the OBS Browser Source (docs/OBS_SETUP.md, Studio's Copy overlay URL). */
  get overlayUrl() { return `${this.webOrigin}/ui.html#/overlay`; }
  /** The classic /overlay page: still served, but it does not show chat votes, so it is not the OBS URL. */
  get classicOverlayUrl() { return `${this.webOrigin}/overlay`; }

  async start() {
    assertOffline();
    await mkdir(resolve(repo,'artifacts/tmp'),{recursive:true});
    this.recapDirectory = await mkdtemp(resolve(repo, 'artifacts/tmp/obs-recaps-'));
    const ports=obsPorts();
    this.apiPort = ports.api;
    this.webPort = ports.web;
    await this.startApi();
    await this.startWeb();
  }

  async startApi() {
    const app = createApp({
      env: appEnv, logger: false, recapDirectory: this.recapDirectory,
      adapterFactory: authenticatedIrcFactory(() => ({username: BOT, token: `oauth:${FAKE_TOKEN}`}), this.fake.transport),
    });
    await app.listen({host: '127.0.0.1', port: this.apiPort});
    this.app = app;
  }

  async stopApi() { const app = this.app; this.app = undefined; await app?.close(); }

  async startWeb() {
    const target = this.apiOrigin;
    this.vite = await createViteServer({
      root: resolve(repo, 'apps/web'), configFile: resolve(repo, 'apps/web/vite.config.ts'), logLevel: 'silent', clearScreen: false,
      server: {host: '127.0.0.1', port: this.webPort, strictPort: true, open: false,
        proxy: {'/auth': {target, xfwd: true}, '/api': {target, xfwd: true}, '/exports': {target, xfwd: true}, '/art': {target, xfwd: true}}},
    });
    await this.vite.listen();
  }

  async stopWeb() { const vite = this.vite; this.vite = undefined; await vite?.close(); }

  /** Studio calls, as the studio page makes them (loopback, no director key configured). */
  async api<T = unknown>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiOrigin}${path}`, body === undefined ? undefined : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  /** Switches the studio to live Twitch chat and waits until the fake sees the app join. */
  async goLive(timeoutMs = 10_000) {
    await this.api('/api/ingest', {mode: 'twitch', channel: CHANNEL});
    const deadline = Date.now() + timeoutMs;
    while (this.fake.joined < 1) {
      if (Date.now() > deadline) throw new Error('The app did not join the fake Twitch channel.');
      await new Promise(done => setTimeout(done, 25));
    }
  }

  async stop() {
    this.fake.stop();
    await this.stopWeb().catch(() => undefined);
    await this.stopApi().catch(() => undefined);
    // Only the temporary recap folder this stack created itself.
    if (this.recapDirectory) await rm(this.recapDirectory, {recursive: true, force: true});
  }
}
