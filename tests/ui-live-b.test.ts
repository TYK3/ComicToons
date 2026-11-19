import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComicToonsAdapter, ParticipationStatus, UiSnapshot } from '../apps/web/src/ui/data/adapter.ts';
import { AdapterProvider } from '../apps/web/src/ui/data/store.tsx';
import {
  chatSourceChip, chatStateText, connectionBanner, inkQueueWaiting, isKeyless, nextUpPanel, readConnection, readInkChat, time24,
} from '../apps/web/src/ui/screens/studio/live.ts';

// UI-LIVE-B: the screen side of the live contract, on sample data only. Studio and Director
// import their CSS and the bundled art, which Node can't load, so those imports become empty modules here.
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, context, next) {'
  + ' if (/\\.css$/.test(url)) return { format: "module", source: "", shortCircuit: true };'
  + ' if (/\\.(webp|png|svg|woff2?)$/.test(url)) return { format: "module", source: "export default " + JSON.stringify(url), shortCircuit: true };'
  + ' return next(url, context); }'));
// The router builds hash links from location; a static page address stands in for the browser's.
Object.assign(globalThis, { location: { hash: '#/studio', pathname: '/ui.html', search: '', origin: 'http://127.0.0.1' } });
const { MockAdapter } = await import('../apps/web/src/ui/data/mock.ts');

const NOW = Date.UTC(2026, 10, 2, 20, 0, 0);
type Extra = { connection?: unknown; nextUp?: unknown; inkChat?: unknown };

/** A frozen MockAdapter snapshot (sample data) with the contract fields laid over it. */
function fake(edit: (snapshot: UiSnapshot) => UiSnapshot = snapshot => snapshot, extra: { adapterConnection?: unknown } = {}): ComicToonsAdapter {
  const base = new MockAdapter({ freeze: true, now: NOW, count: 3, pending: 3 });
  const snapshot = edit(base.getSnapshot());
  return Object.assign(Object.create(base) as ComicToonsAdapter, { getSnapshot: () => snapshot, subscribe: () => () => undefined, now: () => NOW, connection: extra.adapterConnection });
}
const render = (adapter: ComicToonsAdapter, node: ReactNode) => renderToStaticMarkup(createElement(AdapterProvider, { adapter, children: node }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const withStudio = (patch: Extra & Record<string, unknown>) => (snapshot: UiSnapshot) => ({ ...snapshot, studio: { ...snapshot.studio, ...patch } }) as UiSnapshot;
const withParticipation = (patch: Extra & Partial<ParticipationStatus>) => (snapshot: UiSnapshot) => ({ ...snapshot, participation: { ...snapshot.participation, ...patch } }) as UiSnapshot;

const at = (hours: number, minutes: number) => new Date(2026, 9, 31, hours, minutes).getTime();
const INK_CHAT = {
  active: true,
  text: 'Not an Affiliate or Partner? Viewers type !ink in chat instead. You or a mod answer with !ink yes or !ink no.',
  cooldownEndsAt: NOW + 4 * 60_000,
  note: 'Cooldown: the last !ink was under 5 minutes ago, so this one was skipped.',
  requests: [
    { id: 'ink-chat-3', name: 'pixelmoth', at: at(20, 5), status: 'queued', note: 'Waiting: panel budget used up. Not lost; drafted when the hour frees up.' },
    { id: 'ink-chat-2', name: 'tinyhaiku', at: at(19, 58), status: 'drafted', note: 'Cameo drafted; waiting for !ink yes or !ink no.', panelId: 'cameo-ink-chat-2' },
    { id: 'ink-chat-1', name: 'quietkettle', at: at(8, 7), status: 'approved', note: 'Approved by mod_sample.' },
    { id: 'ink-chat-0', name: 'Opted-out viewer', at: at(0, 0), status: 'withdrawn', note: 'Withdrawn: this viewer opted out with !noink.' },
  ],
};

// ---- banner states ----------------------------------------------------------------------------
test('UI-LIVE-B banner: connection comes from the snapshot, then the adapter, then offline/error', () => {
  const snapshot = fake().getSnapshot();
  assert.equal(readConnection({ ...snapshot, connection: 'reconnecting' } as UiSnapshot), 'reconnecting');
  assert.equal(readConnection(snapshot, { connection: 'lost' }), 'lost');
  assert.equal(readConnection({ ...snapshot, connection: 'nonsense' } as UiSnapshot, {}), 'ok');
  assert.equal(readConnection({ ...snapshot, offline: true }), 'lost', 'before the field lands, offline still reads as lost');
  assert.equal(connectionBanner('ok'), null);
  assert.equal(connectionBanner('lost')?.title, 'Connection lost.');
  assert.equal(connectionBanner('reconnecting')?.title, 'Reconnecting…');
});

test('UI-LIVE-B banner: lost and reconnecting render in a polite live region; ok renders an empty one', async () => {
  const { ConnectionBanner } = await import('../apps/web/src/ui/components/AppBar.tsx');
  const lost = render(fake(snapshot => ({ ...snapshot, connection: 'lost' }) as UiSnapshot), createElement(ConnectionBanner));
  assert.match(lost, /role="status" aria-live="polite"/);
  assert.match(lost, /data-connection="lost"/);
  assert.match(text(lost), /Connection lost\. .*Reconnect/);
  const back = render(fake(undefined, { adapterConnection: 'reconnecting' }), createElement(ConnectionBanner));
  assert.match(back, /data-connection="reconnecting"/);
  assert.doesNotMatch(text(back), /Reconnect\b(?!ing)/, 'no Reconnect button while it is already reconnecting');
  const ok = render(fake(snapshot => ({ ...snapshot, connection: 'ok' }) as UiSnapshot), createElement(ConnectionBanner));
  assert.equal(ok, '<div class="ct-live-region" role="status" aria-live="polite"></div>');
});

test('UI-LIVE-B banner: the header chip follows connection, then says the same source words as the Channel card', async () => {
  const { AppBar } = await import('../apps/web/src/ui/components/AppBar.tsx');
  const chip = (adapter: ComicToonsAdapter) => /<span class="ct-chip[^"]*"[^>]*>(.*?)<\/span>(?=<)/.exec(render(adapter, createElement(AppBar, { current: 'studio' })))?.[0] ?? '';
  assert.match(text(chip(fake(snapshot => ({ ...snapshot, connection: 'lost' }) as UiSnapshot))), /Connection lost/);
  assert.match(text(chip(fake(snapshot => ({ ...snapshot, connection: 'reconnecting' }) as UiSnapshot))), /Reconnecting…/);
  assert.match(text(chip(fake())), /Sample data/);
  const live = { requested: 'twitch', active: 'twitch', connection: 'live', simulated: false, received: 4, channel: 'sample_channel', transport: 'wss' } as const;
  assert.equal(chatSourceChip(live), 'Live chat');
  assert.equal(chatSourceChip({ ...live, active: 'sample', connection: 'connecting' }), 'Connecting to chat…');
  assert.equal(chatSourceChip({ ...live, simulated: true }), 'Simulated chat');
  // STREAM-END-1: once EventSub stream.offline has reached the server, the chip stops reading Live
  // and loses its glow, even though source.active is still 'twitch' (the issue is kept, not sampled).
  const ended = { ...live, connection: 'ended' as const };
  assert.equal(chatSourceChip(ended), 'Stream ended');
  const endedChip = chip(fake(withStudio({ source: ended })));
  assert.match(text(endedChip), /Stream ended/);
  assert.doesNotMatch(endedChip, /ct-live/, 'the glowing Live chip is gone once the stream has ended');
});

// ---- next up ------------------------------------------------------------------------------------
test('UI-LIVE-B nextUp: the server pick wins; unknown or missing ids fall back to the oldest waiting panel', () => {
  const { studio } = fake().getSnapshot();
  const [oldest, , cameo] = studio.pendingPanels;
  assert.ok(oldest && cameo);
  assert.equal(nextUpPanel({ ...studio, nextUp: cameo.id } as typeof studio)?.id, cameo.id);
  assert.equal(nextUpPanel({ ...studio, nextUp: 'gone' } as typeof studio)?.id, oldest.id);
  assert.equal(nextUpPanel({ ...studio, nextUp: null } as typeof studio)?.id, oldest.id);
  assert.equal(nextUpPanel(studio)?.id, oldest.id);
  assert.equal(nextUpPanel({ ...studio, pendingPanels: [], nextUp: null } as typeof studio), undefined);
});

test('UI-LIVE-B nextUp: Studio puts the server pick on the review desk and marks it in the grid; Director shows it', async () => {
  const { Studio } = await import('../apps/web/src/ui/screens/Studio.tsx');
  const { Director } = await import('../apps/web/src/ui/screens/Director.tsx');
  const snapshot = fake().getSnapshot();
  const pick = snapshot.studio.pendingPanels[2]!;
  const adapter = fake(withStudio({ nextUp: pick.id }));
  const studio = render(adapter, createElement(Studio));
  assert.match(studio, new RegExp(`data-next-up="${pick.id}"`), 'review desk shows the nextUp panel');
  assert.equal(studio.match(/data-next="true"/g)?.length, 1, 'exactly one grid cell is marked next up');
  assert.match(studio, new RegExp(`<h2 id="ct-desk-title" class="ct-desk__cap">${pick.caption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '&#x27;')}</h2>`));
  const director = render(adapter, createElement(Director));
  assert.match(director, new RegExp(`id="ct-dir-next" class="ct-kicker" data-next-up="${pick.id}"`));
  const oldest = render(fake(), createElement(Director));
  assert.match(oldest, new RegExp(`data-next-up="${snapshot.studio.pendingPanels[0]!.id}"`), 'no nextUp: the oldest, as before');
});

// ---- cameo count ---------------------------------------------------------------------------------
test('UI-LIVE-B cameo count: the Ink me queue counts redemptions plus chat cameos still waiting', async () => {
  const { participation } = fake().getSnapshot();
  const redemptions = participation.reward.redemptions.filter(entry => entry.status === 'queued' || entry.status === 'drawing').length;
  assert.equal(inkQueueWaiting(participation), redemptions, 'no inkChat: redemptions only');
  assert.equal(inkQueueWaiting({ ...participation, inkChat: null } as ParticipationStatus), redemptions);
  assert.equal(inkQueueWaiting({ ...participation, inkChat: INK_CHAT } as ParticipationStatus), redemptions + 2, 'queued and drafted count; approved and withdrawn do not');
  const { Director } = await import('../apps/web/src/ui/screens/Director.tsx');
  const html = render(fake(withParticipation({ inkChat: INK_CHAT })), createElement(Director));
  assert.match(html, new RegExp(`data-ink-waiting="true">${redemptions + 2} waiting<`));
});

test('UI-LIVE-B inkChat is read defensively, in either spelling of the contract', () => {
  const participation = fake().getSnapshot().participation;
  const read = readInkChat({ ...participation, inkChat: { active: true, cooldown: 123, notes: 'Sample note', requests: [{ id: 'x', status: 'drafted' }, { status: 'queued' }, 'junk'] } } as unknown as ParticipationStatus);
  assert.deepEqual(read, { active: true, text: '', cooldownEndsAt: 123, note: 'Sample note', requests: [{ id: 'x', name: 'viewer', at: 0, status: 'drafted', note: '', panelId: undefined }] });
  assert.equal(readInkChat(participation), null);
});

test('UI-LIVE-B InkMeCard shows the server !ink copy, the requests and the cooldown in 24-hour time', async () => {
  const { InkMeCard } = await import('../apps/web/src/ui/screens/studio/Participation.tsx');
  const adapter = fake(snapshot => withParticipation({ inkChat: INK_CHAT, reward: { ...snapshot.participation.reward, status: 'unavailable', offReason: 'not-affiliate', error: 'Ink me needs an Affiliate or Partner channel', chatFallback: 'older fallback text' } })(snapshot));
  const html = text(render(adapter, createElement(InkMeCard)));
  assert.ok(html.includes(INK_CHAT.text), 'viewer !ink copy, verbatim');
  assert.ok(!html.includes('older fallback text'), 'the older chatFallback steps aside for the !ink copy');
  assert.match(html, /1 per viewer per stream, one every 5 minutes\. Next !ink from \d\d:\d\d\./);
  assert.match(html, /@pixelmoth Queued Waiting: panel budget used up\. .* 20:05/);
  assert.match(html, /@tinyhaiku Waiting for !ink yes Cameo drafted; waiting for !ink yes or !ink no\. · 19:58/);
  assert.match(html, /@quietkettle Approved Approved by mod_sample\. · 08:07/);
  assert.match(html, /Opted-out viewer Withdrawn/);
  assert.doesNotMatch(html, /@Opted-out/);
  assert.match(html, /2 !ink requests waiting/);
  assert.doesNotMatch(html, /\b(AM|PM|am|pm)\b/);
});

// ---- 24-hour time --------------------------------------------------------------------------------
test('UI-LIVE-B times are UK 24-hour clock times', () => {
  assert.equal(time24(at(20, 5)), '20:05');
  assert.equal(time24(at(8, 7)), '08:07');
  assert.equal(time24(at(0, 0)), '00:00');
  assert.equal(time24(at(12, 30)), '12:30');
  assert.equal(time24(at(23, 59)), '23:59');
});

// ---- chat card and keyless copy ------------------------------------------------------------------
test('UI-LIVE-B ChatCard: transport label only from the server, no raw reason tokens, no "read" beside an empty list', async () => {
  const { ChatCard } = await import('../apps/web/src/ui/screens/studio/Participation.tsx');
  const source = { requested: 'twitch', active: 'twitch', connection: 'live', simulated: false, received: 1, channel: 'sample_channel', transport: 'wss' } as const;
  const card = (patch: Record<string, unknown>, chat = true) => text(render(fake(snapshot => ({ ...snapshot, chat: chat ? snapshot.chat : [], studio: { ...snapshot.studio, source: { ...source, ...patch } } }) as UiSnapshot), createElement(ChatCard)));
  assert.match(card({}), /#sample_channel · Live chat · WSS 443 · 1 read/);
  assert.match(card({ transport: 'tls' }), /Live chat · TLS 6697/);
  assert.doesNotMatch(card({ transport: undefined }), /WSS|TLS/);
  for (const reason of ['empty', 'unreachable', 'disconnected', 'unauthenticated', 'paused', 'connecting'] as const) {
    const line = card({ active: 'sample', connection: reason, transport: undefined });
    assert.doesNotMatch(line, /Fell back|\((empty|unreachable|disconnected|unauthenticated|paused)\)/, reason);
  }
  assert.equal(chatStateText({ ...source, active: 'sample', connection: 'empty', received: 0 }), 'Connected · WSS 443 · waiting for the first chat line');
  const reloaded = card({}, false);
  assert.doesNotMatch(reloaded, /No chat yet/, 'a count of lines read never sits beside "No chat yet"');
  assert.match(reloaded, /Lines read before this page opened/);
});

test('UI-LIVE-B keyless computer: set-up copy, never "sign-in didn’t finish"', async () => {
  const { TwitchErrorBanner } = await import('../apps/web/src/ui/components/TwitchConnect.tsx');
  const { Connect } = await import('../apps/web/src/ui/screens/Connect.tsx');
  const keyless = { state: 'error', error: 'Twitch sign-in is not set up on this machine yet.' } as const;
  assert.ok(isKeyless(keyless));
  assert.ok(isKeyless({ state: 'signed-out', configured: false } as never));
  assert.ok(!isKeyless({ state: 'error', error: 'You cancelled on Twitch.' }));
  const adapter = fake(snapshot => ({ ...snapshot, twitch: keyless }));
  for (const html of [render(adapter, createElement(TwitchErrorBanner)), render(adapter, createElement(Connect))]) {
    assert.match(text(html), /Twitch sign-in isn’t set up on this computer\./);
    assert.doesNotMatch(text(html), /didn’t finish/);
  }
  assert.match(render(adapter, createElement(Connect)), /aria-disabled="true"[^>]*aria-describedby="ct-keyless-note"/);
});

test('UI-HEAD #8: an idle studio with no panels says "No stream yet", not the loaded Sample title', async () => {
  const { Studio } = await import('../apps/web/src/ui/screens/Studio.tsx');
  const idle = fake(withStudio({ status: 'idle', streamTitle: 'The dice had other plans', issueTitle: 'Critical Mess', panels: [], pendingPanels: [] }));
  const html = text(render(idle, createElement(Studio)));
  assert.match(html, /No stream yet .*Ready when you are/);
  assert.doesNotMatch(html, /Issue in progress|Critical Mess/);
});
