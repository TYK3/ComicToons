// OBS-OVERLAY: proves the overlay browser source end to end, the way OBS loads it.
// - OBS-UI-OVERLAY loads stack.overlayUrl, the URL the streamer pastes: ui.html#/overlay.
// - The other tests cover the classic /overlay page (stack.classicOverlayUrl), which is still served.
// - No user interaction: the page is only loaded and watched (no clicks, keys or hovers).
// - Fixed browser-source sizes 1920x1080 and 1280x720 at device scale 1, transparent page.
// - Chat comes from the in-memory Twitch IRC fake (fake-twitch-irc.ts) through the real
//   TwitchIrcAdapter, Studio, /api/events and the Vite proxy that `npm run dev` serves.
// - Off-host requests are blocked and counted, so nothing can reach Twitch or an art API.
// Timings are written to <shots dir>/timings-<size>.json for the report.
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {expect, test, type Page} from '@playwright/test';
import {decodePng, transparentShare} from './png.ts';
import {ObsStack} from './obs-kit.ts';

const repo = resolve(import.meta.dirname, '../..');
import {readProductEnv} from '../../packages/core/src/env.mjs';
const shotsDir = readProductEnv('COMICTOONS_OBS_SHOTS_DIR') || resolve(repo, 'artifacts/tmp/obs-shots');
// OBS's own default for the Browser Source "Custom CSS" box (https://obsproject.com/kb/browser-source).
const OBS_DEFAULT_CSS = 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }';
const SIZES = [{width: 1920, height: 1080}, {width: 1280, height: 720}] as const;
const viewer = (n: number) => ({login: `obs_viewer_${n}`, userId: String(70_000 + n), displayName: `ObsViewer${n}`});
const STEADY = new Set(['load', 'steady', 'after-api-restart', 'after-full-restart']);

interface ObsWindow {__obsSeen: Record<string, number>}
interface LogLine {phase: string; at: number; text: string}

/** In-page probe: the epoch time each studio panel (a manga cell's data-source-id) first enters the
 * overlay DOM, as Date.now() on the same machine clock the test uses. */
function installPanelProbe() {
  const seen: Record<string, number> = {};
  (window as unknown as ObsWindow).__obsSeen = seen;
  const scan = () => {
    for (const element of document.querySelectorAll('main.overlay .manga-cell[data-source-id]')) {
      const id = element.getAttribute('data-source-id');
      if (id && !(id in seen)) seen[id] = Date.now();
    }
  };
  new MutationObserver(scan).observe(document, {childList: true, subtree: true});
}

class Watch {
  phase = 'load';
  consoleErrors: LogLine[] = [];
  pageErrors: LogLine[] = [];
  failedRequests: LogLine[] = [];
  blockedOffHost: string[] = [];
  eventStreamOpens: number[] = [];
  stateRequests: number[] = [];
  navigations: number[] = [];
  constructor(page: Page, origin: string) {
    const line = (text: string) => ({phase: this.phase, at: Date.now(), text});
    page.on('console', message => { if (message.type() === 'error') this.consoleErrors.push(line(message.text())); });
    page.on('pageerror', error => this.pageErrors.push(line(error.message)));
    page.on('requestfailed', request => this.failedRequests.push(line(`${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ''}`)));
    page.on('request', request => {
      const path = request.url().startsWith(origin) ? new URL(request.url()).pathname : '';
      if (path === '/api/events') this.eventStreamOpens.push(Date.now());
      if (path === '/api/state') this.stateRequests.push(Date.now());
    });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) this.navigations.push(Date.now()); });
  }
  steadyErrors() { return [...this.consoleErrors, ...this.pageErrors].filter(entry => STEADY.has(entry.phase)); }
}

async function seenAt(page: Page, id: string) {
  return page.evaluate(panelId => (window as unknown as ObsWindow).__obsSeen?.[panelId], id);
}

async function panelIds(page: Page) {
  // The Vite dev client may reload the page after a dev-server restart; a poll that lands mid-reload sees no panels.
  const ids = await page.locator('main.overlay .manga-cell[data-source-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-source-id') ?? ''))
    .catch((error: Error) => { if (/context was destroyed|navigat/i.test(error.message)) return [] as string[]; throw error; });
  return [...new Set(ids)];
}

/** Waits for a panel id that was not on screen before, and returns it with its on-screen time. */
async function nextPanel(page: Page, before: string[], timeout = 15_000) {
  let id = '';
  await expect.poll(async () => { id = (await panelIds(page)).find(candidate => !before.includes(candidate)) ?? ''; return id; }, {timeout, intervals: [25]}).not.toBe('');
  await expect(page.locator(`main.overlay .manga-cell[data-source-id="${id}"]`).first()).toBeVisible();
  const at = await seenAt(page, id);
  expect(at, 'probe saw the panel enter the DOM').toBeGreaterThan(0);
  return {id, at: at!};
}

interface StudioSnapshot {source?: {active?: string}; panels: {id: string; caption: string; sfx?: string}[]; pendingPanels: {id: string; caption: string}[]}

/** First live chat line: the studio swaps its sample fallback for the live issue. Returns when that has happened. */
async function firstLiveLine(stack: ObsStack, n: number, text: string) {
  const sent = Date.now();
  stack.fake.say(viewer(n), text);
  await expect.poll(async () => { const state = await stack.api<StudioSnapshot>('/api/state'); return state.source?.active === 'twitch' && state.panels.length + state.pendingPanels.length > 0; }, {timeout: 10_000, intervals: [25]}).toBe(true);
  return sent;
}

async function sendBurst(stack: ObsStack, first: number, keyword: string) {
  for (let n = first; n < first + 3; n++) stack.fake.say(viewer(n), keyword);
  return Date.now();
}

/** Lettering checks on every visible lettering element (manga balloons, sound effects, and caption
 * rails when a panel uses one): visible, at least 14 px, WCAG AA contrast against its own backing,
 * the text box stays inside its balloon and its panel, and the panel stays inside the frame. */
async function letteringReport(page: Page) {
  return page.evaluate(() => {
    const parse = (value: string) => { const match = value.match(/rgba?\(([^)]+)\)/); if (!match) return undefined; const [r = 0, g = 0, b = 0, a = 1] = match[1]!.split(/[ ,/]+/).filter(Boolean).map(Number); return {r, g, b, a}; };
    const luminance = ({r, g, b}: {r: number; g: number; b: number}) => { const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
    const backing = (element: Element) => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const colour = parse(getComputedStyle(node).backgroundColor);
        if (colour && colour.a >= 0.95) return colour;
      }
      return undefined;
    };
    const round = (value: number) => Math.round(value * 10) / 10;
    return [...document.querySelectorAll('main.overlay [data-lettering-kind="caption"], main.overlay [data-lettering-kind="dialogue"], main.overlay [data-lettering-kind="sfx"]')].flatMap(element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect(), html = element as HTMLElement;
      if (box.width <= 1 || box.height <= 1) return []; // screen-reader-only text
      const range = document.createRange(); range.selectNodeContents(element); const text = range.getBoundingClientRect();
      const panel = element.closest('.comic-panel')?.getBoundingClientRect();
      const kind = element.getAttribute('data-lettering-kind');
      // Sound effects are stroked display lettering drawn over the art; balloons and captions sit on their own backing.
      const fg = parse(style.color), bg = kind === 'sfx' ? parse(style.webkitTextStrokeColor) : backing(element);
      const contrast = fg && bg ? (Math.max(luminance(fg), luminance(bg)) + 0.05) / (Math.min(luminance(fg), luminance(bg)) + 0.05) : 0;
      const spill = kind === 'sfx' ? 0 : Math.max(0, box.left - text.left, box.top - text.top, text.right - box.right, text.bottom - box.bottom);
      return [{kind, text: html.innerText.trim(), fontPx: round(parseFloat(style.fontSize)), contrast: Math.round(contrast * 100) / 100,
        visible: style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.9,
        textSpillPx: round(spill), insidePanel: !panel || (box.left >= panel.left - 1 && box.top >= panel.top - 1 && box.right <= panel.right + 1 && box.bottom <= panel.bottom + 1),
        inFrame: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, markup: element.children.length}];
    });
  });
}

function expectReadable(lettering: Awaited<ReturnType<typeof letteringReport>>) {
  for (const item of lettering) {
    const name = `${item.kind} "${item.text}"`;
    expect(item.text, `${item.kind} has text`).not.toBe('');
    expect(item.visible, `${name} visible`).toBe(true);
    expect(item.fontPx, `${name} font size`).toBeGreaterThanOrEqual(14);
    expect(item.contrast, `${name} contrast`).toBeGreaterThanOrEqual(4.5);
    expect(item.textSpillPx, `${name} text stays inside its balloon`).toBeLessThanOrEqual(1);
    expect(item.insidePanel, `${name} inside its panel`).toBe(true);
    expect(item.inFrame, `${name} inside the frame`).toBe(true);
    expect(item.markup, 'chat text is never rendered as markup').toBe(0);
  }
}

async function frameReport(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const scrollers = [...document.querySelectorAll('body *')].filter(element => { const style = getComputedStyle(element); return /(auto|scroll)/.test(style.overflowX + style.overflowY) && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1); }).map(element => element.className.toString());
    const strip = document.querySelector('main.overlay .overlay-strip, main.overlay .overlay-waiting')?.getBoundingClientRect();
    const chain: string[] = [];
    for (let node: Element | null = document.querySelector('main.overlay'); node; node = node.parentElement) chain.push(`${node.tagName.toLowerCase()}=${getComputedStyle(node).backgroundColor}`);
    return {innerWidth, innerHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, scrollers,
      content: strip ? {left: Math.round(strip.left), top: Math.round(strip.top), right: Math.round(strip.right), bottom: Math.round(strip.bottom)} : undefined, backgrounds: chain};
  });
}

function expectFrame(frame: Awaited<ReturnType<typeof frameReport>>) {
  expect(frame.scrollWidth, 'no horizontal overflow').toBeLessThanOrEqual(frame.innerWidth);
  expect(frame.scrollHeight, 'no vertical overflow').toBeLessThanOrEqual(frame.innerHeight);
  expect(frame.clientWidth, 'no vertical scrollbar gutter').toBe(frame.innerWidth);
  expect(frame.clientHeight, 'no horizontal scrollbar gutter').toBe(frame.innerHeight);
  expect(frame.scrollers, 'no inner scroll areas').toEqual([]);
  for (const background of frame.backgrounds) expect(background, 'page layers stay transparent').toMatch(/=rgba\(0, 0, 0, 0\)$/);
  if (frame.content) {
    expect(frame.content.left).toBeGreaterThanOrEqual(0); expect(frame.content.top).toBeGreaterThanOrEqual(0);
    expect(frame.content.right).toBeLessThanOrEqual(frame.innerWidth); expect(frame.content.bottom).toBeLessThanOrEqual(frame.innerHeight);
  }
}

/** Transparent-background screenshot (as OBS composites it) plus the alpha measurements. */
async function transparentShot(page: Page, name: string) {
  const png = await page.screenshot({omitBackground: true, path: join(shotsDir, `${name}.png`)});
  const image = decodePng(png), size = 12;
  const corners = [{x: 0, y: 0}, {x: image.width - size, y: 0}, {x: 0, y: image.height - size}, {x: image.width - size, y: image.height - size}]
    .map(corner => transparentShare(image, {...corner, width: size, height: size}));
  return {width: image.width, height: image.height, transparentShare: Math.round(transparentShare(image) * 1000) / 1000, corners};
}

for (const size of SIZES) {
  const label = `${size.width}x${size.height}`;
  test.describe(`OBS browser source ${label}`, () => {
    test.use({viewport: size, deviceScaleFactor: 1, hasTouch: false, isMobile: false});
    test(`OBS-OVERLAY ${label}: a fake Twitch moment reaches the transparent overlay, stays readable and survives restarts`, async ({page}) => {
      test.setTimeout(150_000);
      mkdirSync(shotsDir, {recursive: true});
      const stack = new ObsStack();
      const timings: Record<string, unknown> = {size: label};
      try {
        await stack.start();
        const watch = new Watch(page, stack.webOrigin);
        await page.route(url => url.hostname !== '127.0.0.1' || url.port !== String(stack.webPort), route => { watch.blockedOffHost.push(route.request().url()); return route.abort('blockedbyclient'); });
        await page.addInitScript(installPanelProbe);
        // Young's default: approval on. Until live chat arrives the studio holds sample panels as
        // pending, so the overlay shows its waiting card.
        await stack.goLive();

        // 1. Load exactly the browser-source URL; nothing is clicked.
        const loadStart = Date.now();
        await page.goto(stack.classicOverlayUrl);
        await expect(page.getByText('Waiting for approved moments')).toBeVisible();
        timings.loadToWaitingMs = Date.now() - loadStart;
        await expect.poll(() => watch.eventStreamOpens.length).toBeGreaterThan(0);
        await page.waitForTimeout(1_000);
        expectFrame(await frameReport(page));
        const idle = await transparentShot(page, `overlay-${label}-waiting`);
        expect(idle.corners).toEqual([1, 1, 1, 1]);
        expect(idle.transparentShare).toBeGreaterThan(0.9);
        timings.waitingTransparentShare = idle.transparentShare;

        // 2. First chat line opens the live issue (its chat panel waits for approval), then the
        // studio switches approval off so moments go straight on air. Then a 3-viewer "gg" burst.
        watch.phase = 'steady';
        await firstLiveLine(stack, 1, 'hello from chat');
        await expect(page.getByText('Waiting for approved moments')).toBeVisible();
        const autoOn = Date.now();
        await stack.api('/api/settings', {approvalMode: false});
        const chatPanel = await nextPanel(page, []);
        timings.approvalOffToChatPanelMs = chatPanel.at - autoOn;
        const burstSent = await sendBurst(stack, 2, 'gg');
        const moment = await nextPanel(page, [chatPanel.id]);
        timings.momentToPanelMs = moment.at - burstSent;
        const onAir = await stack.api<{panels: {id: string; caption: string; dialogue: string[]; sfx?: string}[]}>('/api/state');
        const momentPanel = onAir.panels.find(panel => panel.id === moment.id);
        expect(momentPanel, 'the new overlay panel is the moment panel on air').toBeTruthy();
        timings.momentPanel = {caption: momentPanel?.caption, sfx: momentPanel?.sfx};
        await expect(page.getByRole('status')).toHaveText(/\d+ comic frames? on screen\./);
        await page.waitForTimeout(600); // entrance animation (200 ms) settles
        timings.liveRegionText = await page.getByRole('status').innerText();
        timings.cellsOnScreen = await page.locator('main.overlay .manga-cell').count();

        // 3. Captions readable; no scrollbars; transparent background.
        const lettering = await letteringReport(page);
        timings.lettering = lettering;
        expect(lettering.filter(item => item.kind === 'dialogue').length, 'visible balloons').toBeGreaterThan(0);
        expectReadable(lettering);
        const frame = await frameReport(page);
        timings.frame = frame;
        expectFrame(frame);
        const live = await transparentShot(page, `overlay-${label}-moment`);
        timings.momentTransparentShare = live.transparentShare;
        expect(live.corners).toEqual([1, 1, 1, 1]);
        expect(live.transparentShare).toBeGreaterThan(0.2);

        // 4. API restart (the dev server's own process restarts; Vite keeps serving the page).
        watch.phase = 'outage-api';
        const apiDown = Date.now();
        await stack.stopApi();
        await expect(page.locator('main.overlay [role="alert"]')).toBeVisible({timeout: 15_000});
        timings.apiDownToAlertMs = Date.now() - apiDown;
        timings.apiOutageAlert = await page.locator('main.overlay [role="alert"]').innerText();
        // Recorded, not asserted here: see OBS-OVERLAY-OUTAGE below for the known gap.
        timings.panelsOnAirDuringApiOutage = (await panelIds(page)).length;
        await page.waitForTimeout(2_000);
        watch.phase = 'recovery-api';
        const apiUpOpens = watch.eventStreamOpens.length;
        await stack.startApi();
        const apiUp = Date.now();
        await expect(page.locator('main.overlay [role="alert"]')).toHaveCount(0, {timeout: 15_000});
        timings.apiUpToRecoveredMs = Date.now() - apiUp;
        await stack.goLive();
        // A fresh studio starts with approval on, as Young's does: the panel waits for the studio's Approve.
        await expect(page.getByText('Waiting for approved moments')).toBeVisible();
        const preRestart = await panelIds(page);
        await firstLiveLine(stack, 9, 'we are back');
        const chatPendingIds = (await stack.api<StudioSnapshot>('/api/state')).pendingPanels.map(panel => panel.id);
        const pogSent = await sendBurst(stack, 10, 'pog');
        let pendingId = '';
        await expect.poll(async () => { pendingId = (await stack.api<StudioSnapshot>('/api/state')).pendingPanels.find(panel => !chatPendingIds.includes(panel.id))?.id ?? ''; return pendingId; }, {timeout: 10_000, intervals: [25]}).not.toBe('');
        timings.momentToPendingAfterApiRestartMs = Date.now() - pogSent;
        const approved = Date.now();
        await stack.api('/api/approve', {panelId: pendingId});
        const afterApi = await nextPanel(page, preRestart.filter(id => id !== pendingId));
        expect(afterApi.id).toBe(pendingId);
        timings.approveToPanelAfterApiRestartMs = afterApi.at - approved;
        timings.eventStreamReopenedAfterApiRestart = watch.eventStreamOpens.length > apiUpOpens;
        watch.phase = 'after-api-restart';
        const pollStart = watch.stateRequests.length;
        await page.waitForTimeout(3_000);
        timings.statePollsPer3sAfterApiRestart = watch.stateRequests.length - pollStart;
        expectFrame(await frameReport(page));

        // 5. Full restart: API and Vite both stop and start again on the same URL (as `npm run dev` would).
        watch.phase = 'outage-full';
        const fullDown = Date.now();
        await stack.stopWeb();
        await stack.stopApi();
        await expect(page.locator('main.overlay [role="alert"]')).toBeVisible({timeout: 15_000});
        timings.fullDownToAlertMs = Date.now() - fullDown;
        await page.waitForTimeout(2_000);
        watch.phase = 'recovery-full';
        const navigationsBefore = watch.navigations.length;
        // When its dev server comes back, the Vite client in the page reloads it (it polls about once a second).
        const reload = page.waitForEvent('framenavigated', {timeout: 8_000}).catch(() => undefined);
        await stack.startApi();
        await stack.startWeb();
        const fullUp = Date.now();
        await reload;
        await page.waitForLoadState('load');
        timings.fullUpToPageReloadMs = watch.navigations.length > navigationsBefore ? watch.navigations.at(-1)! - fullUp : null;
        await stack.goLive();
        await expect(page.getByText('Waiting for approved moments')).toBeVisible({timeout: 30_000});
        await expect(page.locator('main.overlay [role="alert"]')).toHaveCount(0, {timeout: 30_000});
        timings.fullUpToRecoveredMs = Date.now() - fullUp;
        timings.pageReloadedByDevServer = watch.navigations.length > navigationsBefore;
        watch.phase = 'after-full-restart';
        await firstLiveLine(stack, 20, 'back again');
        await stack.api('/api/settings', {approvalMode: false});
        const chatAfterFull = await nextPanel(page, []);
        const thirdSent = await sendBurst(stack, 21, 'lul');
        const third = await nextPanel(page, [chatAfterFull.id]);
        timings.momentToPanelAfterFullRestartMs = third.at - thirdSent;
        await page.waitForTimeout(600);
        expectFrame(await frameReport(page));
        expectReadable(await letteringReport(page));

        // 6. Same page with OBS's default Custom CSS applied: still transparent, nothing cut off.
        await page.addStyleTag({content: OBS_DEFAULT_CSS});
        expectFrame(await frameReport(page));
        const obs = await transparentShot(page, `overlay-${label}-obs-default-css`);
        expect(obs.corners).toEqual([1, 1, 1, 1]);
        // Preview only (not a check): the same frame over a flat game-like backdrop.
        await page.addStyleTag({content: 'html { background: #2d3440 !important; }'});
        await page.screenshot({path: join(shotsDir, `overlay-${label}-preview-on-backdrop.png`)});

        timings.consoleErrorsByPhase = Object.fromEntries([...new Set([...watch.consoleErrors, ...watch.pageErrors].map(entry => entry.phase))].map(phase => [phase, [...watch.consoleErrors, ...watch.pageErrors].filter(entry => entry.phase === phase).map(entry => entry.text)]));
        timings.failedRequests = watch.failedRequests.map(entry => `${entry.phase}: ${entry.text}`);
        timings.blockedOffHost = watch.blockedOffHost;
        timings.fakeLog = stack.fake.log.map(entry => entry.kind).filter(kind => kind !== 'irc.privmsg');
        writeFileSync(join(shotsDir, `timings-${label}.json`), `${JSON.stringify(timings, null, 2)}\n`);

        // 7. No console errors while the stack is up; nothing left the machine.
        expect(watch.steadyErrors(), 'console errors while the studio is up').toEqual([]);
        expect(watch.blockedOffHost, 'requests to anything but the local overlay origin').toEqual([]);
      } finally {
        writeFileSync(join(shotsDir, `timings-${label}.json`), `${JSON.stringify(timings, null, 2)}\n`);
        await stack.stop();
      }
    });
  });
}

// OBS-UI-OVERLAY (DOCS-2): stack.overlayUrl is the URL the docs and the Studio give the streamer,
// ui.html#/overlay. Loaded the same way (nothing clicked, transparent, off-host requests blocked),
// a fake Twitch moment must reach it and it must come back after an API restart. On this page the
// empty, loading and error states draw nothing, and panels on air stay through an outage.
async function uiPanelIds(page: Page) {
  const ids = await page.locator('.ct-ov-strip .ct-panel[data-panel-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-panel-id') ?? ''))
    .catch((error: Error) => { if (/context was destroyed|navigat/i.test(error.message)) return [] as string[]; throw error; });
  return [...new Set(ids)];
}

async function nextUiPanel(page: Page, before: string[], timeout = 15_000) {
  let id = '';
  await expect.poll(async () => { id = (await uiPanelIds(page)).find(candidate => !before.includes(candidate)) ?? ''; return id; }, {timeout, intervals: [25]}).not.toBe('');
  return id;
}

async function uiFrame(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const strip = document.querySelector('.ct-ov-strip')?.getBoundingClientRect();
    return {innerWidth, innerHeight, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight,
      strip: strip ? {left: Math.round(strip.left), top: Math.round(strip.top), right: Math.round(strip.right), bottom: Math.round(strip.bottom)} : undefined,
      visibleText: [...document.querySelectorAll('.ct-stage *')].filter(element => element.children.length === 0 && (element as HTMLElement).innerText?.trim()).map(element => (element as HTMLElement).innerText.trim())};
  });
}

for (const size of SIZES) {
  const label = `${size.width}x${size.height}`;
  test.describe(`OBS browser source ${label} streamer URL`, () => {
    test.use({viewport: size, deviceScaleFactor: 1, hasTouch: false, isMobile: false});
    test(`OBS-UI-OVERLAY ${label}: a fake Twitch moment reaches ui.html#/overlay, the URL the streamer pastes, and it survives an API restart`, async ({page}) => {
      test.setTimeout(120_000);
      mkdirSync(shotsDir, {recursive: true});
      const stack = new ObsStack();
      try {
        await stack.start();
        const watch = new Watch(page, stack.webOrigin);
        await page.route(url => url.hostname !== '127.0.0.1' || url.port !== String(stack.webPort), route => { watch.blockedOffHost.push(route.request().url()); return route.abort('blockedbyclient'); });
        await stack.goLive();
        expect(new URL(stack.overlayUrl).pathname + new URL(stack.overlayUrl).hash, 'the streamer URL').toBe('/ui.html#/overlay');

        // 1. Exactly the browser-source URL; nothing on stream until a panel is approved.
        await page.goto(stack.overlayUrl);
        await expect(page.locator('.ct-overlay-root .ct-stage')).toBeAttached();
        await expect.poll(() => watch.eventStreamOpens.length).toBeGreaterThan(0);
        await page.waitForTimeout(1_000);
        const idle = await transparentShot(page, `ui-overlay-${label}-empty`);
        expect(idle.corners).toEqual([1, 1, 1, 1]);
        expect(idle.transparentShare, 'empty overlay draws nothing').toBeGreaterThan(0.99);

        // 2. Live chat, approval off, then a "gg" burst: both panels reach the strip.
        watch.phase = 'steady';
        await firstLiveLine(stack, 1, 'hello from chat');
        await stack.api('/api/settings', {approvalMode: false});
        const chatPanel = await nextUiPanel(page, []);
        await sendBurst(stack, 2, 'gg');
        const moment = await nextUiPanel(page, [chatPanel]);
        const onAir = await stack.api<StudioSnapshot>('/api/state');
        expect(onAir.panels.some(panel => panel.id === moment), 'the new strip panel is the moment panel on air').toBe(true);
        await expect(page.locator(`.ct-ov-lead .ct-panel[data-panel-id="${moment}"]`)).toBeVisible();
        await page.waitForTimeout(800);
        await page.addStyleTag({content: OBS_DEFAULT_CSS});
        const frame = await uiFrame(page);
        expect(frame.scrollWidth, 'no horizontal overflow').toBeLessThanOrEqual(size.width);
        expect(frame.scrollHeight, 'no vertical overflow').toBeLessThanOrEqual(size.height);
        expect(frame.strip, 'strip drawn').toBeDefined();
        expect(frame.strip!.left).toBeGreaterThanOrEqual(0); expect(frame.strip!.top).toBeGreaterThanOrEqual(0);
        expect(frame.strip!.right).toBeLessThanOrEqual(size.width); expect(frame.strip!.bottom).toBeLessThanOrEqual(size.height);
        const live = await transparentShot(page, `ui-overlay-${label}-moment`);
        expect(live.corners).toEqual([1, 1, 1, 1]);
        expect(live.transparentShare).toBeGreaterThan(0.5);

        // 3. API restart: no warning is drawn on stream and the panels on air stay.
        watch.phase = 'outage-api';
        await stack.stopApi();
        await page.waitForTimeout(3_000);
        expect(await uiPanelIds(page), 'panels on air stay through the outage').toContain(moment);
        expect((await uiFrame(page)).visibleText.join(' '), 'no outage warning drawn on stream').not.toMatch(/connect|offline|lost|error/i);
        watch.phase = 'recovery-api';
        await stack.startApi();
        await stack.goLive();
        const preRestart = await uiPanelIds(page);
        await firstLiveLine(stack, 9, 'we are back');
        await stack.api('/api/settings', {approvalMode: false});
        const afterApi = await nextUiPanel(page, preRestart, 20_000);
        expect((await stack.api<StudioSnapshot>('/api/state')).panels.some(panel => panel.id === afterApi), 'panel from the restarted studio').toBe(true);
        watch.phase = 'after-api-restart';
        await page.waitForTimeout(1_000);

        expect(watch.steadyErrors(), 'console errors while the studio is up').toEqual([]);
        expect(watch.blockedOffHost, 'requests to anything but the local overlay origin').toEqual([]);
      } finally { await stack.stop(); }
    });
  });
}

/** Shared opening for the two focused tests below: overlay loaded at 1920x1080, one live chat
 * panel on air with approval off. */
async function onAirPanel(page: Page, stack: ObsStack) {
  await stack.start();
  await page.route(url => url.hostname !== '127.0.0.1' || url.port !== String(stack.webPort), route => route.abort('blockedbyclient'));
  await page.addInitScript(installPanelProbe);
  await stack.goLive();
  await page.goto(stack.classicOverlayUrl);
  await expect(page.getByText('Waiting for approved moments')).toBeVisible();
  await firstLiveLine(stack, 1, 'on air before the outage');
  await stack.api('/api/settings', {approvalMode: false});
  return nextPanel(page, []);
}

test.describe('OBS browser source 1920x1080 known gaps', () => {
  test.use({viewport: {width: 1920, height: 1080}, deviceScaleFactor: 1});

  test('OBS-OVERLAY-OUTAGE: approved panels stay on screen while the API restarts', async ({page}) => {
    const stack = new ObsStack();
    try {
      const panel = await onAirPanel(page, stack);
      await stack.stopApi();
      await expect(page.locator('main.overlay [role="alert"]')).toBeVisible({timeout: 15_000});
      await page.waitForTimeout(1_500);
      await expect(page.locator(`main.overlay .manga-cell[data-source-id="${panel.id}"]`).first()).toBeVisible({timeout: 1_000});
      await expect(page.locator('main.overlay [role="alert"]')).toHaveText(/last approved moments/, {timeout: 1_000});
      await stack.startApi();
      await expect(page.locator(`main.overlay .manga-cell[data-source-id="${panel.id}"]`)).toHaveCount(0,{timeout:15_000});

    } finally { await stack.stop(); }
  });

  test('OBS-OVERLAY-SAMPLE: waiting for live chat preserves labelled Sample Data panels',async({page})=>{
    const stack=new ObsStack();
    try{
      await stack.start();
      await stack.api('/api/ingest',{mode:'sample'});
      await stack.api('/api/settings',{approvalMode:false});
      await stack.goLive();
      await page.goto(stack.classicOverlayUrl);
      await expect(page.locator('main.overlay')).toBeVisible();
      await expect(page.locator('main.overlay .manga-sample').first()).toBeVisible();
    }finally{await stack.stop();}
  });

  // Observation only (behaviour recorded, not evaluated): what the overlay shows after a quiet spell.
  // Since RAID-SAMPLE-1 quiet chat no longer leaves Live, so the on-air panel is expected to stay.
  test('OBS-OVERLAY-QUIET: what the overlay shows once chat goes quiet', async ({page}) => {
    const stack = new ObsStack();
    try {
      const panel = await onAirPanel(page, stack);
      const quietFrom = Date.now();
      let gone = 0;
      await expect.poll(async () => { if (!(await panelIds(page)).includes(panel.id)) gone = gone || Date.now(); return gone > 0; }, {timeout: 10_000, intervals: [100]}).toBe(true).catch(() => undefined);
      const after = {livePanelLeftOverlayAfterMs: gone ? gone - quietFrom : null, overlayText: (await page.locator('main.overlay').innerText()).replace(/\s+/g, ' ').slice(0, 160),
        sourceLabel: await page.locator('main.overlay .manga-sample').first().textContent({timeout: 1_000}).catch(() => null)};
      mkdirSync(shotsDir, {recursive: true});
      writeFileSync(join(shotsDir, 'quiet-chat-1920x1080.json'), `${JSON.stringify(after, null, 2)}\n`);
      await page.screenshot({omitBackground: true, path: join(shotsDir, 'overlay-1920x1080-after-quiet-chat.png')});
      expectFrame(await frameReport(page));
    } finally { await stack.stop(); }
  });
});

// OBS-OVERLAY-FIT (T8b): the T8b real-chat run showed that once the newest manga page holds three
// rows (five or six frames: three busy chat minutes are enough), the strip is about 870 px tall and
// runs off the bottom of a 1280x720 browser source, where OBS's default CSS clips it silently.
// The studio's own replay fixture fills a page the same way, with no network and no timing luck.
async function fullPageOnAir(page: Page, stack: ObsStack) {
  await stack.start();
  await page.goto(stack.classicOverlayUrl);
  await stack.api('/api/settings', {approvalMode: false});
  await stack.api('/api/replay', {fixtureId: 'tabletop-night', speed: 60});
  await expect.poll(async () => page.locator('main.overlay .overlay-strip .manga-cell').count(), {timeout: 30_000, intervals: [100]}).toBeGreaterThanOrEqual(5);
  await page.waitForTimeout(500);
}

for (const size of SIZES) {
  const label = `${size.width}x${size.height}`;
  test.describe(`OBS browser source ${label} full page`, () => {
    test.use({viewport: size, deviceScaleFactor: 1, hasTouch: false, isMobile: false});
    test(`OBS-OVERLAY-FIT ${label}: a full three-row page of on-air panels stays inside the frame`, async ({page}) => {
      // OVERLAY-720: on landscape sources shorter than about 905 px the strip is zoomed down, so a
      // full three-row page fits a 720p browser source as well as a 1080p one (was a declared
      // test.fail at 720p).
      const stack = new ObsStack();
      try {
        await fullPageOnAir(page, stack);
        mkdirSync(shotsDir, {recursive: true});
        await page.screenshot({omitBackground: true, path: join(shotsDir, `overlay-${label}-full-page.png`)});
        await page.addStyleTag({content: OBS_DEFAULT_CSS});
        const strip = await page.locator('main.overlay .overlay-strip').boundingBox();
        expect(strip, 'strip rendered').not.toBeNull();
        expect(strip!.y + strip!.height, 'strip bottom inside the frame').toBeLessThanOrEqual(size.height);
        // A 1080p source has room for the full strip, so it keeps its design width there (not scaled down).
        if (size.height >= 1080) expect(Math.round(strip!.width), 'full-size strip at 1080p').toBe(Number.parseFloat(await page.locator('main.overlay .overlay-strip').evaluate(element => (element as HTMLElement).style.maxWidth)));
        expectFrame(await frameReport(page));
      } finally { await stack.stop(); }
    });
  });
}

// OBS-UI-OVERLAY-FIT (OVERLAY-720 addendum): the overlay a streamer pastes into OBS is
// ui.html#/overlay (the classic /overlay page above does not show chat votes). This proves that page
// fits a 1920x1080 and a 1280x720 browser source: the 1920x1080 stage is scaled to the frame, and
// the on-air strip and the "Previously on…" catch-up stay inside it, with nothing to scroll and
// OBS's default CSS applied. The page is only loaded and measured; off-host requests are blocked.
const UI_PARTS = ['.ct-stage', '.ct-ov-strip', '.ct-ov-strip .ct-panel', '.ct-ov-credit', '.ct-ov-poll', '.ct-ov-catchup', '.ct-ov-catchup .ct-panel'];

async function measureUiOverlay(page: Page) {
  return page.evaluate(parts => {
    const root = document.documentElement;
    const boxes = parts.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
      const box = element.getBoundingClientRect();
      return {selector, left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom)};
    }));
    return {innerWidth, innerHeight, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, boxes};
  }, UI_PARTS);
}

function expectUiOverlayInFrame(frame: Awaited<ReturnType<typeof measureUiOverlay>>, size: {width: number; height: number}) {
  expect(frame.innerWidth).toBe(size.width);
  expect(frame.innerHeight).toBe(size.height);
  expect(frame.scrollWidth, 'no horizontal overflow').toBeLessThanOrEqual(size.width);
  expect(frame.scrollHeight, 'no vertical overflow').toBeLessThanOrEqual(size.height);
  const stage = frame.boxes.find(box => box.selector === '.ct-stage');
  // A 16:9 source has no letterbox: the 1920x1080 stage is scaled to exactly the frame.
  expect(stage, '1920x1080 stage scaled to the frame').toEqual({selector: '.ct-stage', left: 0, top: 0, right: size.width, bottom: size.height});
  for (const box of frame.boxes) {
    expect(box.left, `${box.selector} left edge inside the frame`).toBeGreaterThanOrEqual(0);
    expect(box.top, `${box.selector} top edge inside the frame`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${box.selector} right edge inside the frame`).toBeLessThanOrEqual(size.width);
    expect(box.bottom, `${box.selector} bottom edge inside the frame`).toBeLessThanOrEqual(size.height);
  }
}

for (const size of SIZES) {
  const label = `${size.width}x${size.height}`;
  test.describe(`OBS browser source ${label} ui.html#/overlay`, () => {
    test.use({viewport: size, deviceScaleFactor: 1, hasTouch: false, isMobile: false});
    test(`OBS-UI-OVERLAY-FIT ${label}: ui.html#/overlay keeps the on-air strip and the catch-up inside the frame`, async ({page}) => {
      const stack = new ObsStack();
      try {
        await stack.start();
        await page.route('**/*', route => /^(https?:\/\/127\.0\.0\.1[:/]|data:|blob:)/.test(route.request().url()) ? route.continue() : route.abort());
        await page.goto(`${stack.webOrigin}/ui.html#/overlay`);
        await stack.api('/api/settings', {approvalMode: false});
        await stack.api('/api/replay', {fixtureId: 'tabletop-night', speed: 60});
        // Full strip: the newest panel plus the two earlier ones.
        await expect.poll(async () => page.locator('.ct-ov-strip .ct-ov-earlier .ct-panel').count(), {timeout: 30_000, intervals: [100]}).toBe(2);
        await page.waitForTimeout(800);
        mkdirSync(shotsDir, {recursive: true});
        await page.screenshot({omitBackground: true, path: join(shotsDir, `ui-overlay-${label}.png`)});
        await page.addStyleTag({content: OBS_DEFAULT_CSS});
        expectUiOverlayInFrame(await measureUiOverlay(page), size);

        // ?catchup=1&freeze=1 is the page's own preview switch for the raid catch-up; a hash change
        // alone keeps the mounted overlay, so the page is reloaded.
        await page.goto(`${stack.webOrigin}/ui.html#/overlay?catchup=1&freeze=1`);
        await page.reload();
        await expect.poll(async () => page.locator('.ct-ov-catchup .ct-panel').count(), {timeout: 15_000, intervals: [100]}).toBe(3);
        await page.waitForTimeout(1500);
        await page.screenshot({omitBackground: true, path: join(shotsDir, `ui-overlay-${label}-catchup.png`)});
        await page.addStyleTag({content: OBS_DEFAULT_CSS});
        expectUiOverlayInFrame(await measureUiOverlay(page), size);
      } finally { await stack.stop(); }
    });
  });
}
