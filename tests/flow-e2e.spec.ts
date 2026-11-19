// FLOW-E2E: the whole streamer flow on fixtures, in the shipped ui.html, with the OBS overlay watched
// beside it at 1920x1080 the way an OBS Browser Source loads it (a separate, cookie-less browser context).
// - Twitch is the in-repo fake (scripts/twitch-mock/fake-twitch.ts): OAuth, Helix, EventSub and IRC on
//   one loopback listener. The channel is a plain (non-Affiliate) one, so votes run as chat votes and
//   Ink me runs as the chat !ink fallback. No real Twitch: the app only knows the fake's URLs.
// - The real API (createApp) and the real Vite web server (apps/web/vite.config.ts with the /api, /auth,
//   /exports and /art proxy that `npm run dev` uses) run in this test, on free loopback ports, next to
//   the suite's own servers. Art stays offline (COMICTOONS_ART_NETWORK=0); the browser blocks and counts
//   every off-host request.
// - Moment detection uses the app's existing momentConfig seam with short windows, so three panels
//   arrive in seconds rather than minutes. Everything else is the shipped default.
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import net, {connect as connectPlain, createServer as createNetServer, type AddressInfo} from 'node:net';
import {resolve} from 'node:path';
import {expect, test, type Browser, type Page} from '@playwright/test';
import {createServer as createViteServer, type ViteDevServer} from 'vite';
import {createApp} from '../apps/server/src/app.ts';
import {bindIrcSocket, type IrcTransportFactory} from '../apps/server/src/ingest/irc.ts';
import {readProductEnv} from '../packages/core/src/env.mjs';
import {FakeTwitch} from '../scripts/twitch-mock/fake-twitch.ts';

const repo = resolve(import.meta.dirname, '..');
const OBS = {width: 1920, height: 1080};
const EDITED = 'Flow check: the goblin takes the wrong door';

type Panel = {id: string; caption: string; cameo?: string};
type State = {status: string; overlayHidden?: boolean; approvalMode: boolean; panels: Panel[]; pendingPanels: Panel[]; source?: {active?: string; connection?: string}; recapUrl?: string};
type Participation = {poll: null | {total: number; choices: {key: string; votes: number}[]}; lastPoll?: {voters: number}; inkChat?: {active?: boolean; requests?: {status: string; name: string}[]}; reward: {status: string; offReason?: string}};

/** In-process egress guard for this test only (the app and Vite run in this worker): a connect or fetch to
 * anything but loopback throws and is recorded. Restored when the test ends. */
function guardEgress(attempts: string[]) {
  const local = (host?: string) => !host || host === 'localhost' || host === '::1' || host === '[::1]' || (/^127\./.test(host) && net.isIP(host) === 4);
  const connect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = (Array.isArray(args[0]) ? args[0] : args) as unknown[];
    const options = first[0] as {host?: string; path?: string} | number | string;
    const host = typeof options === 'object' ? options?.host : typeof first[1] === 'string' ? first[1] : undefined;
    if (!(typeof options === 'object' && options?.path) && !local(host)) { attempts.push(`connect ${host}`); throw new Error(`FLOW-E2E refused non-loopback connect to ${host}`); }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!local(url.hostname)) { attempts.push(`fetch ${url.host}`); return Promise.reject(new Error(`FLOW-E2E refused fetch to ${url.host}`)); }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => { net.Socket.prototype.connect = connect; globalThis.fetch = originalFetch; };
}

async function freePort() {
  const server = createNetServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const {port} = server.address() as AddressInfo;
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

class FlowStack {
  fake!: FakeTwitch;
  app?: ReturnType<typeof createApp>;
  vite?: ViteDevServer;
  apiPort = 0;
  webPort = 0;
  recaps = '';
  get api() { return `http://127.0.0.1:${this.apiPort}`; }
  get web() { return `http://127.0.0.1:${this.webPort}`; }

  async start() {
    if (readProductEnv('COMICTOONS_ART_NETWORK') === '1') throw new Error('Unset COMICTOONS_ART_NETWORK before running the flow test.');
    await mkdir(resolve(repo, 'artifacts/tmp'), {recursive: true});
    this.recaps = await mkdtemp(resolve(repo, 'artifacts/tmp/flow-recaps-'));
    this.apiPort = await freePort();
    this.webPort = await freePort();
    const callback = `${this.web}/auth/twitch/callback`;
    this.fake = await new FakeTwitch({port: 0, redirectUris: [callback], broadcaster: {broadcasterType: ''}, keepaliveSeconds: 30}).start();
    const fakeEnv = this.fake.appEnv();
    // The app's IRC leg goes to the fake's plain IRC listener through the existing ircTransport seam.
    // (COMICTOONS_TWITCH_IRC_URL is read from process.env, not from createApp's env, and with a transport
    // given there is no WSS fallback.)
    const fakeIrcPort = this.fake.urls.ircPort;
    const ircTransport: IrcTransportFactory = handlers => bindIrcSocket(connectPlain({host: '127.0.0.1', port: fakeIrcPort}, handlers.open), handlers);
    this.app = createApp({
      ircTransport,
      logger: false, recapDirectory: this.recaps,
      env: {
        ...fakeEnv, TWITCH_REDIRECT_URI: callback, NODE_ENV: 'test',
        COMICTOONS_API_PORT: String(this.apiPort), COMICTOONS_WEB_PORT: String(this.webPort),
        COMICTOONS_ART_NETWORK: '0', PANELCAST_ART_NETWORK: '0', COMICTOONS_PARTICIPATION_MOCK: '0',
        COMICTOONS_FLAG_POLLS: '1', COMICTOONS_FLAG_INK_ME: '1', COMICTOONS_FLAG_DIRECTOR: '1', COMICTOONS_FLAG_NOINK: '1', COMICTOONS_FLAG_CATCHUP: '1',
        COMICTOONS_FLAG_TWITCH_POLLS: '0', COMICTOONS_FLAG_HYPE: '0', COMICTOONS_FLAG_BOT_REPLIES: '0',
      },
      momentConfig: {spikeWarmupSeconds: 3600, burstWindowSeconds: 8, burstMinUsers: 3, cooldownSeconds: 2, idleCloseSeconds: 4},
    });
    await this.app.listen({host: '127.0.0.1', port: this.apiPort});
    const target = this.api;
    this.vite = await createViteServer({
      root: resolve(repo, 'apps/web'), configFile: resolve(repo, 'apps/web/vite.config.ts'), logLevel: 'silent', clearScreen: false,
      server: {host: '127.0.0.1', port: this.webPort, strictPort: true, open: false, hmr: false,
        proxy: {'/auth': {target, xfwd: true}, '/api': {target, xfwd: true}, '/exports': {target, xfwd: true}, '/art': {target, xfwd: true}}},
    });
    await this.vite.listen();
  }
  async stop() {
    await this.vite?.close().catch(() => undefined);
    await this.app?.close().catch(() => undefined);
    await this.fake?.stop().catch(() => undefined);
    if (this.recaps) await rm(this.recaps, {recursive: true, force: true});
  }
  async get<T>(path: string): Promise<T> { return (await fetch(this.api + path)).json() as Promise<T>; }
  state() { return this.get<State>('/api/state'); }
  participation() { return this.get<Participation>('/api/participation/status'); }
}

/** Only loopback may be reached from either browser context; anything else is aborted and counted. */
async function offline(page: Page, blocked: string[]) {
  await page.context().route(url => !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname) && /^(https?|wss?):$/.test(url.protocol), route => {
    blocked.push(route.request().url());
    return route.abort();
  });
}

async function obsOverlay(browser: Browser, url: string, blocked: string[]) {
  const context = await browser.newContext({viewport: OBS, deviceScaleFactor: 1});
  const page = await context.newPage();
  await offline(page, blocked);
  // OBS's default Browser Source custom CSS (https://obsproject.com/kb/browser-source).
  await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }';
    document.head.append(style);
  }));
  await page.goto(url);
  return page;
}

const viewer = (n: number) => `flow_viewer_${n}`;

test('FLOW-E2E: connect, panels, A/R/E, !ink, vote, panic and un-panic, end and export, with the OBS overlay at 1920x1080', async ({page, browser}) => {
  test.setTimeout(240_000);
  const stack = new FlowStack();
  const blocked: string[] = [];
  const pageErrors: string[] = [];
  const egress: string[] = [];
  const unguard = guardEgress(egress);
  let overlay: Page | undefined;
  try {
    await stack.start();
    await offline(page, blocked);
    page.on('pageerror', error => pageErrors.push(`studio: ${error.message}`));

    await test.step('connect: sign in with the fixture Twitch and switch to live chat', async () => {
      await page.goto(`${stack.web}/ui.html#/connect`);
      await page.getByRole('button', {name: 'Connect with Twitch'}).first().click();
      // The fake approves at once and the app's callback returns to ui.html#/connect?twitch=connected.
      await expect(page).toHaveURL(/#\/connect\?twitch=connected/, {timeout: 20_000});
      await expect(page.getByRole('heading', {name: /You’re in, @fakebroadcaster/})).toBeVisible({timeout: 20_000});
      await page.goto(`${stack.web}/ui.html#/studio`);
      await page.getByRole('radio', {name: 'Live chat'}).click();
      // The source switches from Sample to Twitch once the fixture chat speaks.
      await expect.poll(async () => { stack.fake.chat(viewer(1), 'hello from the fixture chat'); const source = (await stack.state()).source; return `${source?.active}/${source?.connection}`; }, {timeout: 20_000, intervals: [500]}).toBe('twitch/live');
      await expect(page.getByRole('radio', {name: 'Live chat'})).toHaveAttribute('aria-checked', 'true', {timeout: 10_000});
    });

    overlay = await obsOverlay(browser, `${stack.web}/ui.html#/overlay`, blocked);
    overlay.on('pageerror', error => pageErrors.push(`overlay: ${error.message}`));
    await test.step('OBS overlay at 1920x1080 starts empty and transparent', async () => {
      expect(overlay!.viewportSize()).toEqual(OBS);
      await expect(overlay!.getByRole('region', {name: 'Stream overlay'})).toBeAttached();
      await expect(overlay!.locator('.ct-ov-lead')).toHaveCount(0);
      expect(await overlay!.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    });

    await test.step('panels arrive from chat into the approval queue', async () => {
      const lines = ['the goblin opens the wrong door again', 'who left the trap there', 'that door was a mimic all along', 'roll for initiative chat'];
      lines.forEach((text, index) => stack.fake.chat(viewer(10 + index), text));
      for (const [round, word] of ['KEKW', 'Pog'].entries()) {
        // Let the previous moment close (idleCloseSeconds 4, cooldownSeconds 2) so each burst becomes its own panel.
        if (round > 0) await page.waitForTimeout(6_000);
        for (let n = 0; n < 4; n++) stack.fake.chat(viewer(20 + round * 10 + n), `${word} ${['what a play', 'no way', 'clip that', 'unreal'][n]}`);
        await expect.poll(async () => (await stack.state()).pendingPanels.length, {timeout: 20_000}).toBeGreaterThanOrEqual(round + 2);
      }
      await expect(page.locator('[data-next-up]')).toBeVisible({timeout: 10_000});
      expect((await stack.state()).approvalMode, 'approval mode is the default').toBe(true);
    });

    await test.step('E edits the next-up caption', async () => {
      await page.locator('body').click({position: {x: 5, y: 5}});
      const next = await page.locator('[data-next-up]').getAttribute('data-next-up');
      await page.keyboard.press('e');
      const dialog = page.getByRole('dialog', {name: 'Edit caption'});
      await expect(dialog).toBeVisible();
      await dialog.getByRole('textbox', {name: 'Caption'}).fill(EDITED);
      await dialog.getByRole('button', {name: 'Save caption'}).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await stack.state()).pendingPanels.find(panel => panel.id === next)?.caption).toBe(EDITED);
    });

    await test.step('A approves it and the overlay shows it', async () => {
      await page.locator('body').click({position: {x: 5, y: 5}});
      await expect(page.locator('#ct-desk-title')).toHaveText(EDITED);
      await page.keyboard.press('a');
      await expect(page.getByRole('status').filter({hasText: 'Panel is on air.'})).toBeVisible();
      await expect.poll(async () => (await stack.state()).panels.map(panel => panel.caption)).toContain(EDITED);
      await expect(overlay!.locator('.ct-ov-lead')).toBeVisible({timeout: 10_000});
      await expect(overlay!.locator('.ct-ov-lead')).toContainText(EDITED);
    });

    await test.step('R rejects the next one and it never reaches the overlay', async () => {
      await page.locator('body').click({position: {x: 5, y: 5}});
      const rejected = await page.locator('[data-next-up]').getAttribute('data-next-up');
      const before = await stack.state();
      await page.keyboard.press('r');
      await expect(page.getByRole('status').filter({hasText: 'Panel rejected.'})).toBeVisible();
      await expect.poll(async () => (await stack.state()).pendingPanels.some(panel => panel.id === rejected)).toBe(false);
      const after = await stack.state();
      expect(after.panels.map(panel => panel.id)).not.toContain(rejected);
      expect(after.panels.length).toBe(before.panels.length);
      await expect(overlay!.locator('.ct-ov-lead')).toContainText(EDITED);
    });

    await test.step('a chat vote picks the bubble, on the Studio and the overlay', async () => {
      const card = page.locator('section', {has: page.locator('#ct-vote-title')});
      await card.getByRole('button', {name: 'Start a 45-second vote'}).click();
      await expect(card.getByText(/Chat vote: type !1, !2 or !3/)).toBeVisible({timeout: 10_000});
      // r1: the overlay (its own page) also learns about polls only from the 5 s participation poll; allow four polls.
      await expect(overlay!.locator('.ct-ov-poll')).toBeVisible({timeout: 20_000});
      await expect(overlay!.locator('.ct-ov-poll__hint')).toHaveText('Type !1, !2 or !3 in chat');
      for (const [n, vote] of ['!1', '!1', '!1', '!2'].entries()) stack.fake.chat(viewer(40 + n), vote);
      await expect.poll(async () => (await stack.participation()).poll?.total, {timeout: 10_000}).toBe(4);
      // r1: chat votes reach the card only through the same 5 s participation poll; allow four polls.
      await expect(card.getByText(/· 4 votes ·/)).toBeVisible({timeout: 20_000});
      await expect(overlay!.locator('.ct-ov-poll__pct').first()).toHaveText('75%', {timeout: 20_000});
      await card.getByRole('button', {name: 'End vote now'}).click();
      await expect.poll(async () => (await stack.participation()).poll, {timeout: 10_000}).toBeNull();
      await expect(card.getByText(/Last vote:/)).toBeVisible({timeout: 10_000});
      await expect(overlay!.locator('.ct-ov-poll')).toHaveCount(0, {timeout: 20_000});
    });

    await test.step('!ink: a viewer asks, the cameo waits for review, a mod answers !ink yes', async () => {
      await expect.poll(async () => (await stack.participation()).reward.offReason, {timeout: 15_000}).toBe('not-affiliate');
      stack.fake.chat('flow_inker', 'I want in! hello');
      stack.fake.chat('flow_inker', '!ink');
      await expect.poll(async () => (await stack.state()).pendingPanels.find(panel => panel.cameo === 'flow_inker')?.id, {timeout: 15_000}).toBeTruthy();
      // r1: the Ink me card reads /api/participation/status, which the web adapter polls only every 5 s
      // (apps/web/src/ui/data/server.ts:174). Wait for the server to list the request first, then allow
      // four polls for the card.
      await expect.poll(async () => (await stack.participation()).inkChat?.requests?.some(request => /flow_inker/i.test(request.name)), {timeout: 15_000}).toBe(true);
      const ink = page.locator('section', {has: page.locator('#ct-ink-title')});
      await expect(ink.getByText(/flow_inker/i).first()).toBeVisible({timeout: 20_000});
      expect((await stack.state()).panels.some(panel => panel.cameo === 'flow_inker'), 'nothing on air before the answer').toBe(false);
      stack.fake.chat('flow_mod', '!ink yes', {mod: true});
      await expect.poll(async () => (await stack.state()).panels.some(panel => panel.cameo === 'flow_inker'), {timeout: 15_000}).toBe(true);
      await expect(overlay!.locator('.ct-ov-lead')).toContainText(/flow_inker|Cameo/i, {timeout: 10_000});
    });

    await test.step('Panic hides the overlay at once; un-Panic brings it back', async () => {
      const onAir = (await stack.state()).panels.length;
      await page.getByRole('button', {name: 'Panic hide'}).first().click();
      await expect.poll(async () => (await stack.state()).overlayHidden).toBe(true);
      await expect(page.getByText('Overlay hidden.')).toBeVisible();
      await expect(overlay!.locator('.ct-ov-strip')).toHaveCount(0, {timeout: 5_000});
      await expect(overlay!.locator('.ct-stage .ct-panel, .ct-stage img')).toHaveCount(0);
      // Chat keeps arriving while hidden; nothing shows on stream.
      stack.fake.chat(viewer(60), 'still chatting while it is hidden');
      await page.waitForTimeout(1500);
      await expect(overlay!.locator('.ct-ov-strip')).toHaveCount(0);
      await page.getByRole('button', {name: 'Show overlay'}).first().click();
      await expect.poll(async () => (await stack.state()).overlayHidden).toBe(false);
      await expect(overlay!.locator('.ct-ov-strip')).toBeVisible({timeout: 10_000});
      await expect(overlay!.locator('.ct-ov-lead')).toBeVisible();
      expect((await stack.state()).panels.length).toBe(onAir);
    });

    await test.step('recap: end the stream and export the issue', async () => {
      const approved = (await stack.state()).panels.length;
      expect(approved).toBeGreaterThanOrEqual(2);
      await page.getByRole('button', {name: /End stream/}).first().click();
      const dialog = page.getByRole('dialog', {name: 'End the stream?'});
      await expect(dialog).toBeVisible();
      await dialog.getByRole('textbox', {name: 'Issue title'}).fill('Flow check issue');
      const ended = page.waitForResponse(response => new URL(response.url()).pathname === '/api/end' && response.request().method() === 'POST', {timeout: 90_000});
      await dialog.getByRole('button', {name: 'End stream and bind'}).click();
      const end = await ended;
      expect(end.status()).toBe(200);
      const body = await end.json() as {recapUrl?: string; pageUrls?: string[]; shareUrl?: string};
      expect(body.recapUrl).toBeTruthy();
      await expect(page).toHaveURL(/#\/output/, {timeout: 30_000});
      await expect.poll(async () => (await stack.state()).status, {timeout: 30_000}).toBe('ended');
      const files = [...(body.pageUrls ?? []), ...(body.shareUrl ? [body.shareUrl] : [])];
      expect(files.length, 'the export wrote page or share images').toBeGreaterThan(0);
      for (const file of files) {
        const response = await fetch(new URL(file, stack.api));
        expect(response.status, file).toBe(200);
        expect(response.headers.get('content-type'), file).toMatch(/image\/png/);
      }
      const recapId = /([a-z0-9-]+)\/?$/.exec(body.recapUrl!)?.[1];
      const recap = await fetch(`${stack.api}/api/recaps/${recapId}`);
      expect(recap.status).toBe(200);
      expect(((await recap.json()) as {panels: Panel[]}).panels.length).toBe(approved);
    });

    expect(blocked, 'no off-host request from the Studio or the overlay').toEqual([]);
    expect(egress, 'no off-host connect or fetch from the app or Vite').toEqual([]);
    expect(pageErrors).toEqual([]);
    const secrets = stack.fake.secretValues();
    expect(secrets.length).toBeGreaterThan(0);
    for (const text of [await page.content(), await overlay.content()]) for (const secret of secrets) expect(text.includes(secret), 'no Twitch secret in the page').toBe(false);
  } finally {
    await overlay?.context().close().catch(() => undefined);
    await stack.stop();
    unguard();
  }
});
