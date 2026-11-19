import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import {SERVER_RESTARTED, twitchAuthFromStatus} from '../apps/web/src/ui/data/twitch-status.ts';
import {twitchErrorCopy} from '../apps/web/src/ui/data/twitch-copy.ts';

// LIVE-TEST BUG-1 (the lead, 19:08, the visible-restart fallback). The server keeps the Twitch sign-in in
// memory only, so a restart (a tsx watch reload) comes back configured, not connected and with NO reason.
// The Studio must then say the server restarted instead of a silent "Connect with Twitch". The server
// sends a per-process bootId; the Studio remembers the one it was connected on. No tokens, no network.

const assetLoader = `export async function load(url, context, next) {
  if (/\\.(webp|png|jpe?g|svg|css)(\\?.*)?$/.test(url)) return { format: 'module', source: 'export default ' + JSON.stringify(url), shortCircuit: true };
  return next(url, context);
}`;
register('data:text/javascript,' + encodeURIComponent(assetLoader));

const restarted = {configured: true, connected: false, scopes: [], bootId: 'boot-b'};

test('BUG-1-FALLBACK: connected on one server process, signed out with no reason on a new one -> "Server restarted, reconnect Twitch"', () => {
  assert.equal(SERVER_RESTARTED, 'Server restarted, reconnect Twitch.');
  assert.deepEqual(twitchAuthFromStatus(restarted, undefined, 'boot-a'), {state: 'error', error: 'Server restarted, reconnect Twitch.'});
  const copy = twitchErrorCopy('Server restarted, reconnect Twitch.');
  assert.equal(copy.heading, 'Server restarted, reconnect Twitch.');
  assert.match(copy.detail, /restarted/);
  assert.match(copy.detail, /Connect with Twitch above signs you in again/);
});

test('BUG-1-FALLBACK: never connected, the same process, a deliberate sign-out or a server reason are not called a restart', () => {
  assert.deepEqual(twitchAuthFromStatus(restarted), {state: 'signed-out'});
  assert.deepEqual(twitchAuthFromStatus(restarted, undefined, 'boot-b'), {state: 'signed-out'});
  assert.deepEqual(twitchAuthFromStatus({...restarted, bootId: undefined}, undefined, 'boot-a'), {state: 'signed-out'});
  assert.deepEqual(twitchAuthFromStatus({...restarted, reason: 'Twitch disconnected.'}, undefined, 'boot-a'), {state: 'signed-out'});
  const expired = 'Twitch authorization expired. Reconnect Twitch.';
  assert.deepEqual(twitchAuthFromStatus({...restarted, reason: expired}, undefined, 'boot-a'), {state: 'error', error: expired});
  assert.deepEqual(twitchAuthFromStatus({...restarted, connected: true, login: 'tyk_twitch'}, undefined, 'boot-a'), {state: 'connected', login: 'tyk_twitch', broadcasterType: undefined});
  assert.deepEqual(twitchAuthFromStatus(restarted, 'Server restarted, reconnect Twitch.', 'boot-a'), {state: 'signed-out'});
});

test('BUG-1-FALLBACK: the Studio remembers the bootId across a page reload, shows the restart, and Dismiss clears it', async () => {
  const stored = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)); }, removeItem: (k: string) => { stored.delete(k); }};
  g.EventSource = class { readyState = 1; addEventListener() {} close() {} };
  let twitch: Record<string, unknown> = {configured: true, connected: true, login: 'tyk_twitch', scopes: [], bootId: 'boot-a'};
  g.fetch = async (path: string) => {
    const body = path === '/api/twitch/status' ? twitch : path === '/api/fixtures' ? [] : path === '/api/state' ? {panels: [], pendingPanels: []} : {};
    return {ok: true, status: 200, json: async () => body} as unknown as Response;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  const {ServerAdapter} = await import('../apps/web/src/ui/data/server.ts');
  const first = new ServerAdapter(); await settle();
  assert.equal(first.getSnapshot().twitch.state, 'connected');
  assert.deepEqual([...stored.values()], ['boot-a'], 'only the bootId is stored: no login, no token');
  first.dispose();
  twitch = {configured: true, connected: false, scopes: [], bootId: 'boot-b'};
  const reloaded = new ServerAdapter(); await settle();
  assert.deepEqual(reloaded.getSnapshot().twitch, {state: 'error', error: 'Server restarted, reconnect Twitch.'});
  reloaded.dismissTwitchError();
  assert.equal(stored.size, 0);
  reloaded.dispose();
  const again = new ServerAdapter(); await settle();
  assert.equal(again.getSnapshot().twitch.state, 'signed-out');
  again.dispose();
});

test('BUG-1-FALLBACK: GET /api/twitch/status carries a bootId that is stable within one server process and is not secret-shaped', async () => {
  const {createApp} = await import('../apps/server/src/app.ts');
  const app = createApp({env: {}, logger: false});
  try {
    const one = (await app.inject('/api/twitch/status')).json(), two = (await app.inject('/api/twitch/status')).json();
    assert.match(one.bootId, /^[0-9a-f]{12}$/);
    assert.equal(two.bootId, one.bootId);
  } finally { await app.close(); }
});
