// CHAT-BANNER-1: once real chat has arrived, a quiet spell must not bring back the Studio's
// "no chat yet" copy. Real server (createApp) on 3120, its IRC leg on the local fake on 4120, one chat
// line, then a quiet spell. BANNER-RAID-1: quiet chat stays Live (RAID-SAMPLE-1, the lead's ruling), so the source must
// stay twitch/live and the banners say "quiet" from their own client-side window (CHAT_QUIET_MS), not from a server
// flip to Sample Data. The banners are rendered from the /api/state source the server returned.
// The app's IRC leg goes through the ircTransport seam to the fake: COMICTOONS_TWITCH_IRC_URL is read from
// process.env, not createApp's env, so without the seam the adapter would dial real Twitch. An in-process
// egress guard refuses and records any non-loopback connect or fetch as a second line of defence.
import assert from 'node:assert/strict';
import {register} from 'node:module';
import net, {connect as connectPlain} from 'node:net';
import {after, before, test} from 'node:test';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createApp} from '../../apps/server/src/app.ts';
import {bindIrcSocket, type IrcTransportFactory} from '../../apps/server/src/ingest/irc.ts';
import type {ChatSourceState} from '../../packages/core/src/index.ts';
import {FakeTwitch} from '../../scripts/twitch-mock/fake-twitch.ts';
import type {Studio} from '../../apps/web/src/hooks/useStudio.ts';
import type {ComicToonsAdapter, UiSnapshot} from '../../apps/web/src/ui/data/adapter.ts';
import {Browser} from './app-kit.ts';
import {APP_PORT, FAKE_PORT, WEB_PORT, sleep} from './helpers.ts';

// Web components import CSS and bundled art, which Node can't load; those become empty modules here.
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, context, next) {'
  + ' if (/\\.css$/.test(url)) return { format: "module", source: "", shortCircuit: true };'
  + ' if (/\\.(webp|png|svg|woff2?)$/.test(url)) return { format: "module", source: "export default " + JSON.stringify(url), shortCircuit: true };'
  + ' return next(url, context); }'));
Object.assign(globalThis, {location: {hash: '#/studio', pathname: '/ui.html', search: '', origin: 'http://127.0.0.1'}});

function guardEgress(attempts: string[]) {
  const local = (host?: string) => !host || host === 'localhost' || host === '::1' || host === '[::1]' || (/^127\./.test(host) && net.isIP(host) === 4);
  const connect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = (Array.isArray(args[0]) ? args[0] : args) as unknown[];
    const options = first[0] as {host?: string; path?: string} | number | string;
    const host = typeof options === 'object' ? options?.host : typeof first[1] === 'string' ? first[1] : undefined;
    if (!(typeof options === 'object' && options?.path) && !local(host)) { attempts.push(`connect ${host}`); throw new Error(`refused non-loopback connect to ${host}`); }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!local(url.hostname)) { attempts.push(`fetch ${url.host}`); return Promise.reject(new Error(`refused fetch to ${url.host}`)); }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => { net.Socket.prototype.connect = connect; globalThis.fetch = originalFetch; };
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** The classic Studio banner (components/ChatSource.tsx) for a server source. */
// `quietAfterMs: 0` renders a page that saw the last line at least the quiet window ago (a static render has no clock).
async function classicBanner(source: ChatSourceState, quietAfterMs?: number) {
  const {ChatSourceControl} = await import('../../apps/web/src/components/ChatSource.tsx');
  const studio = {state: {source}, busy: false, sampleReady: true, mutate: async () => undefined, useSampleData: async () => undefined} as unknown as Studio;
  return text(renderToStaticMarkup(createElement(ChatSourceControl, {studio, quietAfterMs})));
}

/** The shipped ui.html Studio Chat card for a server source, opened after the line arrived (no lines in its list). */
async function uiChatCard(source: ChatSourceState, quietAfterMs?: number) {
  const {MockAdapter} = await import('../../apps/web/src/ui/data/mock.ts');
  const {AdapterProvider} = await import('../../apps/web/src/ui/data/store.tsx');
  const {ChatCard} = await import('../../apps/web/src/ui/screens/studio/Participation.tsx');
  const now = Date.UTC(2026, 9, 31, 20, 0, 0);
  const base = new MockAdapter({freeze: true, now, count: 3, pending: 3});
  const snapshot = {...base.getSnapshot(), chat: []} as UiSnapshot;
  snapshot.studio = {...snapshot.studio, source} as UiSnapshot['studio'];
  const adapter = Object.assign(Object.create(base) as ComicToonsAdapter, {getSnapshot: () => snapshot, subscribe: () => () => undefined, now: () => now});
  return text(renderToStaticMarkup(createElement(AdapterProvider, {adapter, children: createElement(ChatCard, {quietAfterMs}) as ReactNode})));
}

let fake: FakeTwitch;
let app: ReturnType<typeof createApp> | undefined;
const egress: string[] = [];
let unguard = () => {};
before(async () => {
  unguard = guardEgress(egress);
  fake = await new FakeTwitch({port: FAKE_PORT, redirectUris: [`http://127.0.0.1:${APP_PORT}/auth/twitch/callback`]}).start();
  const ircTransport: IrcTransportFactory = handlers => bindIrcSocket(connectPlain({host: '127.0.0.1', port: fake.urls.ircPort}, handlers.open), handlers);
  app = createApp({
    ircTransport, logger: false,
    env: {...fake.appEnv(), TWITCH_REDIRECT_URI: `http://127.0.0.1:${APP_PORT}/auth/twitch/callback`, NODE_ENV: 'test', COMICTOONS_API_PORT: String(APP_PORT), COMICTOONS_WEB_PORT: String(WEB_PORT), COMICTOONS_ART_NETWORK: '0', PANELCAST_ART_NETWORK: '0', COMICTOONS_PARTICIPATION_MOCK: '0'},
  });
  await app.listen({host: '127.0.0.1', port: APP_PORT});
});
after(async () => { await app?.close(); app = undefined; await fake?.stop(); unguard(); });

test('CHAT-BANNER-1: after one real chat line and a quiet spell, the Studio banners say chat is quiet while the source stays Live', async t => {
  const base = `http://127.0.0.1:${APP_PORT}`;
  const source = async () => ((await (await fetch(`${base}/api/state`)).json()) as {source: ChatSourceState}).source;
  // The fake's IRC only welcomes a signed-in token, so sign in through the fake first (a real connect).
  const {response} = await new Browser().follow(`${base}/auth/twitch/login`);
  assert.ok(response.status < 400, `sign-in through the fake finished (${response.status})`);
  const ingest = await fetch(`${base}/api/ingest`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({mode: 'twitch', channel: fake.broadcaster.login})});
  assert.ok(ingest.ok, `ingest accepted (${ingest.status})`);

  // Before any line: the "nothing yet" copy is right and must stay.
  let deadline = Date.now() + 10_000;
  let state = await source();
  while (!(state.requested === 'twitch' && state.connection === 'empty')) {
    if (Date.now() > deadline) assert.fail(`never reached the quiet, connected state: ${JSON.stringify(state)}`);
    await sleep(100); state = await source();
  }
  assert.equal(state.received, 0);
  assert.match(await classicBanner(state), /No chat messages yet/, 'before any line the classic banner still says so');
  assert.match(await uiChatCard(state), /No chat yet/, 'before any line the ui.html card still says so');

  // One real line through the fake IRC server.
  deadline = Date.now() + 10_000;
  while (!(state.active === 'twitch' && (state.received ?? 0) >= 1)) {
    if (Date.now() > deadline) assert.fail(`the chat line never arrived: ${JSON.stringify(state)}`);
    fake.chat('viewer1', 'the goblin opens the wrong door');
    await sleep(300); state = await source();
  }
  const received = state.received;
  assert.equal(received, 1, 'exactly one line read');
  assert.doesNotMatch(await classicBanner(state), /No chat messages yet/);
  // Inside the default 60 s window (this render just saw the line) the banners are not quiet yet.
  assert.match(await classicBanner(state), /Read-only chat is arriving/, 'a fresh line is not "quiet"');
  assert.doesNotMatch(await uiChatCard(state), /Chat is quiet/, 'a fresh line is not "quiet" on the ui.html card');

  // A quiet spell: no more lines. The server must stay on Live chat and keep the count (no idle flip).
  await sleep(3_000);
  state = await source();
  t.diagnostic(`source after a quiet spell, from /api/state: ${JSON.stringify({requested: state.requested, active: state.active, connection: state.connection, reason: state.reason, received: state.received, transport: state.transport})}`);
  assert.equal(state.active, 'twitch', 'quiet chat stays on the Twitch source');
  assert.equal(state.connection, 'live', 'quiet chat stays Live');
  assert.equal(state.reason, undefined, 'no fallback reason while quiet');
  assert.equal(state.received, received, 'the server kept source.received through the quiet spell');

  const classic = await classicBanner(state, 0);
  const card = await uiChatCard(state, 0);
  const {chatStateText, isLiveChatQuiet, CHAT_QUIET_MS} = await import('../../apps/web/src/ui/screens/studio/live.ts');
  const line = chatStateText(state, true);
  t.diagnostic(`classic banner: ${classic.trim()}`);
  t.diagnostic(`ui.html chat card: ${card.trim()}`);
  assert.doesNotMatch(classic, /No chat messages yet/, 'classic Studio banner cleared once a line was received');
  assert.match(classic, /Chat has gone quiet after 1 line\./, 'classic Studio banner says chat has gone quiet');
  assert.match(classic, /Live chat/, 'classic Studio banner still labels the source Live chat');
  assert.doesNotMatch(classic, /Showing Sample Data/, 'classic Studio banner does not claim Sample Data while Live');
  assert.doesNotMatch(line, /waiting for the first chat line|Waiting for Twitch chat/i, 'ui.html status line no longer waits for a first line');
  assert.doesNotMatch(card, /No chat yet/, 'ui.html Chat card no longer says "No chat yet"');
  assert.match(card, /Live chat[^·]*· [^·]*· Chat is quiet · 1 read|Live chat · Chat is quiet · 1 read/, 'ui.html Chat card: Live chat, quiet, 1 read');

  // The window itself, on the live source the server returned.
  assert.equal(CHAT_QUIET_MS, 60_000);
  assert.equal(isLiveChatQuiet(state, 0, CHAT_QUIET_MS - 1), false, 'not quiet one ms before the window');
  assert.equal(isLiveChatQuiet(state, 0, CHAT_QUIET_MS), true, 'quiet once the window has passed');
  assert.equal(isLiveChatQuiet({...state, received: 0}, 0, CHAT_QUIET_MS), false, 'no line read: "waiting", not "quiet"');
  assert.equal(isLiveChatQuiet({...state, simulated: true}, 0, CHAT_QUIET_MS), false, 'simulated chat is never "quiet live"');
  assert.deepEqual(egress, [], 'no off-host connect or fetch');
});
