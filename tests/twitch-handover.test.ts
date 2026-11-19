import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer,type Socket} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {eventBus} from '@comictoons/core';
import {createApp} from '../apps/server/src/app.ts';
import {TwitchTokenStore} from '../apps/server/src/twitch/token-store.ts';
import type {SignedInHelix} from '../apps/server/src/twitch-api/index.ts';
import type {TwitchAuthProvider} from '../apps/server/src/eventsub/types.ts';

const env = {TWITCH_CLIENT_ID: 'handover-client', TWITCH_CLIENT_SECRET: 'handover-test-secret'};
const mockFetch = (async (input: URL | string | Request) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://handover.invalid');
  return Response.json(url.pathname === '/oauth2/token'
    ? {access_token: 'handover-test-access', refresh_token: 'handover-test-refresh'}
    : {client_id: env.TWITCH_CLIENT_ID, user_id: '12345', login: 'streamer', scopes: ['chat:read'], expires_in: 7200});
}) as typeof fetch;
/** IRC-ENV-1: a loopback stand-in for EventSub, so the hand-over's live client never dials
 * eventsub.wss.twitch.tv. It only counts connections; the WebSocket upgrade is not needed here. */
async function fakeEventSub(): Promise<{url: string; connections: () => number; close: () => Promise<void>}> {
  let count = 0; const sockets = new Set<Socket>();
  const server = createServer(socket => {count++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));});
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fake EventSub has no port');
  return {url: `ws://127.0.0.1:${address.port}/ws`, connections: () => count,
    close: () => new Promise(done => {for (const socket of sockets) socket.destroy(); server.close(() => done());})};
}
const EVENTSUB_ENV = (fake: {url: string}) => ({COMICTOONS_TWITCH_EVENTSUB_WS_URL: fake.url});
const reached = async (fake: {connections: () => number}) => {for (let attempt = 0; attempt < 80 && fake.connections() === 0; attempt++) await delay(25); return fake.connections();};
const makeStore = () => new TwitchTokenStore({env, fetchImpl: mockFetch, baseUrl: 'https://handover.invalid'});

test('twitch-auth hand-over follows a successful callback exactly once with the provider and live client', async () => {
  const store = makeStore();
  const received: {auth: TwitchAuthProvider;helix:SignedInHelix}[] = [];
  const off = eventBus.on('twitch-auth', payload => received.push(payload as {auth: TwitchAuthProvider;helix:SignedInHelix}));
  const eventSub = await fakeEventSub();
  const app = createApp({env: {COMICTOONS_TWITCH_HELIX_BASE_URL:'http://127.0.0.1:4102/helix', ...EVENTSUB_ENV(eventSub)}, twitchStore: store, logger: false,
    helix:{fetch:async input=>{assert.equal(new URL(String(input)).origin,'http://127.0.0.1:4102');return Response.json({data:[{id:'poll-test'}]});}}});
  try {
    await app.ready(); assert.equal(received.length, 0);
    const state = new URL((await app.inject('/auth/twitch/login')).headers.location!).searchParams.get('state');
    const callback = await app.inject(`/auth/twitch/callback?state=${state}&code=handover-test-code`);
    assert.equal(callback.statusCode, 302);
    assert.equal(received.length, 1);
    assert.deepEqual(Object.keys(received[0]), ['auth', 'helix']);
    assert.equal(received[0].auth, store);
    assert.deepEqual(await received[0].helix.createPoll({title:'Test',choices:[{title:'A'},{title:'B'}],duration:30}),{id:'poll-test'});
    assert.deepEqual(await received[0].auth.getAuth(), {clientId: env.TWITCH_CLIENT_ID, accessToken: 'handover-test-access', broadcasterId: '12345', login: 'streamer'});
    await store.refresh(); await store.validate();
    assert.equal(received.length, 1, 'refresh/validation are not connection transitions');
    assert.equal(callback.body.includes('handover-test-access'), false);
    assert.ok(await reached(eventSub) >= 1, 'the live EventSub client must dial the injected loopback endpoint');
  } finally {off(); await app.close(); await eventSub.close();}
});

test('twitch-auth hand-over is announced after app readiness for an already connected store and again after reconnect', async () => {
  const store = makeStore();
  await store.connect('handover-test-code');
  const received: {auth:TwitchAuthProvider;helix:unknown}[] = [];
  const off = eventBus.on('twitch-auth', payload => received.push(payload as {auth:TwitchAuthProvider;helix:unknown}));
  const eventSub = await fakeEventSub();
  const app = createApp({env: EVENTSUB_ENV(eventSub), twitchStore: store, logger: false});
  try {
    assert.equal(received.length, 0);
    await app.ready(); assert.equal(received.length, 1);
    store.disconnect(); assert.equal(received.length, 1);
    await store.connect('handover-test-code'); assert.equal(received.length, 2);
    assert.equal(received[0].auth,store);assert.equal(received[1].auth,store);
    assert.ok(received[0].helix);assert.equal(received[1].helix,received[0].helix);
    assert.ok(await reached(eventSub) >= 1, 'the live EventSub client must dial the injected loopback endpoint');
  } finally {off(); await app.close(); await eventSub.close();}
});

test('twitch-auth is not emitted for missing configuration, invalid state or denied consent', async () => {
  const received: {auth:TwitchAuthProvider;helix:unknown}[] = [];
  const off = eventBus.on('twitch-auth', payload => received.push(payload as {auth:TwitchAuthProvider;helix:unknown}));
  const eventSub = await fakeEventSub();
  const missing = createApp({env: EVENTSUB_ENV(eventSub), logger: false});
  const denied = createApp({env: EVENTSUB_ENV(eventSub), twitchStore: makeStore(), logger: false});
  try {
    assert.equal((await missing.inject('/auth/twitch/login')).statusCode, 503);
    assert.equal((await denied.inject('/auth/twitch/callback?state=unknown&code=handover-test-code')).statusCode, 400);
    const state = new URL((await denied.inject('/auth/twitch/login')).headers.location!).searchParams.get('state');
    assert.equal((await denied.inject(`/auth/twitch/callback?state=${state}&error=access_denied`)).statusCode, 302);
    assert.deepEqual(received, []);
    assert.equal(eventSub.connections(), 0, 'no hand-over, so no EventSub connection');
  } finally {off(); await Promise.all([missing.close(), denied.close()]); await eventSub.close();}
});
