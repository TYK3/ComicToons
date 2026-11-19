import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import type { EventSubStatus } from '../apps/web/src/ui/data/adapter.ts';

// BANNERS, queue line 23 (report-live-fix-1.md REQUEST 2). After Twitch signs the streamer out, the
// Studio's Twitch line must change on the next sign-out or connection-lost signal, not wait up to 15 s
// for the loadTwitch poll. A stub fetch and EventSource stand in for the server; no real network.

// The adapter pulls in the mock, which imports art files the way Vite does. Map those to their URL
// for this test only (Node has no loader for .webp).
const assetLoader = `export async function load(url, context, next) {
  if (/\\.(webp|png|jpe?g|svg|css)(\\?.*)?$/.test(url)) return { format: 'module', source: 'export default ' + JSON.stringify(url), shortCircuit: true };
  return next(url, context);
}`;
register('data:text/javascript,' + encodeURIComponent(assetLoader));

type Listener = (event: { data: string }) => void;
class FakeEventSource {
  static CLOSED = 2; static last?: FakeEventSource;
  readyState = 1; listeners = new Map<string, Listener>();
  onerror?: () => void; onopen?: () => void;
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, listener); }
  fire(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  close() { this.readyState = 2; }
}

const eventsub = (patch: Partial<EventSubStatus> = {}): EventSubStatus => ({ state: 'subscribed', signedIn: true, subscribed: ['channel.chat.message'], failed: [], revoked: [], reconnects: 0, notifications: 0, ...patch });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

async function setup() {
  const server = { twitch: { configured: true, connected: true, login: 'tyk_twitch', scopes: [] } as Record<string, unknown>, eventsub: eventsub(), statusReads: 0 };
  const g = globalThis as Record<string, unknown>;
  g.EventSource = FakeEventSource;
  g.fetch = async (path: string) => {
    const body = path === '/api/twitch/status' ? (server.statusReads++, server.twitch)
      : path === '/api/participation/eventsub' ? server.eventsub
        : path === '/api/fixtures' ? [] : path === '/api/state' ? { panels: [], pendingPanels: [] } : {};
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  };
  const { ServerAdapter } = await import('../apps/web/src/ui/data/server.ts');
  const adapter = new ServerAdapter();
  await settle();
  assert.equal(adapter.getSnapshot().twitch.state, 'connected');
  const signOut = () => { server.twitch = { configured: true, connected: false, scopes: [] }; };
  return { adapter, server, signOut, source: FakeEventSource.last! };
}

test('the EventSub poll seeing the sign-in drop refreshes the Twitch line at once', async () => {
  const { adapter, server, signOut } = await setup();
  try {
    signOut(); server.eventsub = eventsub({ signedIn: false, state: 'stopped', subscribed: [] });
    await adapter.getEventSub(); await settle();
    assert.equal(adapter.getSnapshot().twitch.state, 'signed-out');
  } finally { adapter.dispose(); }
});

test('an EventSub revocation event refreshes the Twitch line', async () => {
  const { adapter, server, signOut, source } = await setup();
  try {
    signOut(); server.eventsub = eventsub({ revoked: [{ type: 'channel.chat.message', status: 'authorization_revoked', at: 1 }] as unknown as EventSubStatus['revoked'] });
    source.fire('eventsub-revoked', { type: 'channel.chat.message', status: 'authorization_revoked', at: 1 });
    await settle();
    assert.equal(adapter.getSnapshot().twitch.state, 'signed-out');
  } finally { adapter.dispose(); }
});

test('the studio connection coming back refreshes the Twitch line', async () => {
  const { adapter, signOut, source } = await setup();
  try {
    // Follow ui-live-a's lost → retry → resume path.
    source.onerror?.(); signOut(); await new Promise(resolve => setTimeout(resolve, 1500 + 300));
    assert.equal(adapter.getSnapshot().twitch.state, 'signed-out');
  } finally { adapter.dispose(); }
});

test('a healthy EventSub poll does not add Twitch status reads', async () => {
  const { adapter, server } = await setup();
  try {
    const before = server.statusReads;
    await adapter.getEventSub(); await adapter.getEventSub(); await settle();
    assert.equal(server.statusReads, before);
    assert.equal(adapter.getSnapshot().twitch.state, 'connected');
  } finally { adapter.dispose(); }
});
