import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sampleSource, type ChatSourceState } from '@comictoons/core';
import { TWITCH_STILL_SIGNED_OUT, type ComicToonsAdapter, type EventSubStatus, type TwitchAuth, type UiSnapshot } from '../apps/web/src/ui/data/adapter.ts';
import { AdapterProvider } from '../apps/web/src/ui/data/store.tsx';
import { TwitchErrorBanner } from '../apps/web/src/ui/components/TwitchConnect.tsx';
import { EventSubBanner } from '../apps/web/src/ui/screens/studio/EventSub.tsx';

// BANNERS (report-token-expiry.md REQUESTS 3 and 4). The Studio's two Twitch banners, rendered with a
// stub adapter. The heading has to name the cause the server reported, and the EventSub banner has to
// show when every subscription failed while Live chat is on (case C2), not only when Twitch revoked one.

const live: ChatSourceState = { requested: 'twitch', active: 'twitch', connection: 'live', channel: 'tyk_twitch', simulated: false, received: 12 };
const ircLive: ChatSourceState = { ...live, transport: 'tls' };
const eventsub = (patch: Partial<EventSubStatus> = {}): EventSubStatus => ({ state: 'subscribed', signedIn: true, subscribed: [], failed: [], revoked: [], reconnects: 0, notifications: 0, ...patch });
function render(node: Parameters<typeof createElement>[0], ui: { twitch?: TwitchAuth; eventsub?: EventSubStatus; source?: ChatSourceState }) {
  const snapshot = { busy: '', twitch: ui.twitch ?? { state: 'connected', login: 'tyk_twitch' }, eventsub: ui.eventsub ?? eventsub({ subscribed: ['channel.chat.message'] }), studio: { source: ui.source ?? sampleSource() } } as unknown as UiSnapshot;
  const adapter = { kind: 'server', subscribe: () => () => undefined, getSnapshot: () => snapshot } as unknown as ComicToonsAdapter;
  return renderToStaticMarkup(createElement(AdapterProvider, { adapter, children: createElement(node) })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
const twitchBanner = (error?: string) => render(TwitchErrorBanner, { twitch: { state: 'error', error } });

test('a session the server ended says the sign-in ended, with the server’s reason, not that sign-in didn’t finish', () => {
  for (const reason of ['Twitch authorization expired. Reconnect Twitch.', 'Twitch refresh unavailable. Reconnect Twitch.']) {
    const text = twitchBanner(reason);
    assert.match(text, /^Your Twitch sign-in ended\. /);
    assert.ok(text.includes(reason), text);
    assert.ok(!text.includes('didn’t finish'), text);
    // Mid-stream the source may be live, so the banner must not claim a Sample replay is running.
    assert.ok(!text.includes('sample replay'), text);
    assert.ok(text.includes('Connect with Twitch above signs you in again.'), text);
  }
});

test('a validation the server could not run says so, without claiming a sign-out', () => {
  const text = twitchBanner('Twitch validation unavailable.');
  assert.match(text, /^Twitch couldn’t check your sign-in\. Twitch validation unavailable\./);
  assert.ok(!text.includes('ended') && !text.includes('didn’t finish'), text);
});

test('a sign-in that never completed keeps “Twitch sign-in didn’t finish.”', () => {
  assert.match(twitchBanner(TWITCH_STILL_SIGNED_OUT), new RegExp(`^Twitch sign-in didn’t finish\\. ${TWITCH_STILL_SIGNED_OUT}`));
  assert.match(twitchBanner(undefined), /^Twitch sign-in didn’t finish\. You may have cancelled it, or Twitch didn’t answer\. Your sample replay is still running\./);
});

test('a machine without Twitch set up says it is not set up', () => {
  const text = twitchBanner('Twitch sign-in is not set up on this machine yet.');
  // On head the UI-HEAD #4 keyless banner owns this case.
  assert.match(text, /^Twitch sign-in isn’t set up on this computer\./);
  assert.ok(!text.includes('didn’t finish'), text);
});

test('a reason the Studio does not know is shown as it came, under a heading that claims no cause', () => {
  const text = twitchBanner('Twitch said something new.');
  assert.match(text, /^Twitch isn’t signed in\. Twitch said something new\./);
  assert.ok(!text.includes('didn’t finish') && !text.includes('ended'), text);
});

test('no banner unless the sign-in is in error', () => {
  assert.equal(render(TwitchErrorBanner, { twitch: { state: 'signed-out' } }), '');
  assert.equal(render(TwitchErrorBanner, { twitch: { state: 'connected', login: 'tyk_twitch' } }), '');
});

const failedAll = eventsub({ failed: [{ type: 'channel.chat.message', error: 'Twitch sign-in expired; sign in again.' }, { type: 'channel.raid', error: 'Twitch sign-in expired; sign in again.' }], lastError: 'Twitch sign-in expired; sign in again.' });

test('C2: every EventSub subscription failed while Live chat is on shows a banner with the server’s reason', () => {
  const text = render(EventSubBanner, { eventsub: failedAll, source: live });
  assert.match(text, /^! Twitch isn’t sending live events\. Twitch sign-in expired; sign in again\. /);
  // EventSub carries chat here (no IRC transport), so chat is named as missing.
  assert.ok(text.includes('Twitch sign-in expired; sign in again. Chat, raids, cheers, votes and Ink me don’t reach the comic.'), text);
  assert.ok(text.includes('Approved panels and the overlay are safe.'), text);
  for (const action of ['Sign in to Twitch again', 'Check again', 'Use Sample data']) assert.ok(text.includes(action), action);
});

test('C2 over IRC chat: chat still has its own connection, so the banner does not say chat is missing', () => {
  const text = render(EventSubBanner, { eventsub: failedAll, source: ircLive });
  assert.ok(text.includes('Twitch sign-in expired; sign in again. Raids, cheers, votes and Ink me don’t reach the comic.'), text);
  assert.ok(!/\bchat\b/i.test(text.replace('Live chat', '')), text);
});

test('a failed EventSub without a reason from the server uses the plain fallback, not an invented cause', () => {
  const text = render(EventSubBanner, { eventsub: eventsub({ state: 'stopped', failed: [{ type: 'channel.raid', error: '' }] }), source: live });
  assert.match(text, /^! Twitch isn’t sending live events\. Twitch didn’t accept the event subscriptions\. Chat, raids, cheers, votes and Ink me don’t reach the comic\./);
});

test('no failed banner on Sample data, while signing in, or when only some subscriptions failed', () => {
  assert.equal(render(EventSubBanner, { eventsub: failedAll, source: sampleSource() }), '');
  assert.equal(render(EventSubBanner, { eventsub: failedAll, source: live, twitch: { state: 'connecting' } }), '');
  assert.equal(render(EventSubBanner, { eventsub: eventsub({ subscribed: ['channel.chat.message'], failed: [{ type: 'channel.raid', error: 'x' }] }), source: live }), '');
  assert.equal(render(EventSubBanner, { eventsub: eventsub({ subscribed: ['channel.chat.message'] }), source: live }), '');
});

test('the revoked banner is unchanged and still shows on any source', () => {
  const text = render(EventSubBanner, { eventsub: eventsub({ revoked: [{ type: 'channel.raid', version: '1', status: 'authorization_revoked', at: 1 }] }), source: sampleSource() });
  assert.match(text, /^! Twitch stopped sending live events\. Twitch access was withdrawn, so raids no longer reach the comic\./);
});
