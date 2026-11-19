import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {createServer, type AddressInfo} from 'node:net';
import {once} from 'node:events';
import {authenticatedIrcFactory} from '../apps/server/src/ingest/source.ts';
import type {IrcTransportFactory} from '../apps/server/src/ingest/irc.ts';
import {Writable} from 'node:stream';
import {createApp} from '../apps/server/src/app.ts';
import {DIRECTOR_KEY_HEADER} from '../apps/server/src/director-access.ts';
import {TWITCH_SCOPES, TWITCH_SCOPES_READONLY, twitchConfig} from '../apps/server/src/twitch/config.ts';
import {TwitchOAuth} from '../apps/server/src/twitch/oauth.ts';
import {TwitchTokenStore, withTwitchAuth, type TokenStoreOptions} from '../apps/server/src/twitch/token-store.ts';
import type {TwitchAuthProvider} from '../apps/server/src/eventsub/types.ts';

/** A genuinely closed local port (bound then released), so a signed-in handover's EventSub dial
 * fails fast against loopback instead of reaching the real eventsub.wss.twitch.tv. */
async function closedEventSubUrl() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, 'close');
  return `ws://127.0.0.1:${port}/ws`;
}
let eventSubUrl = '';
before(async () => { eventSubUrl = await closedEventSubUrl(); });

const env = {TWITCH_CLIENT_ID: 'test-client', TWITCH_CLIENT_SECRET: 'test-client-secret',
  TWITCH_REDIRECT_URI: 'http://localhost:3001/auth/twitch/callback'};
const access = 'test-access-token', refresh = 'test-refresh-token', code = 'test-auth-code';
const privateValues = [env.TWITCH_CLIENT_SECRET, access, refresh, code, 'test-rotated-access', 'test-rotated-refresh'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
function noSecrets(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of privateValues) assert.equal(text.includes(secret), false, 'private authentication value escaped');
}
function mockIdentity() {
  const calls: {url: URL; init?: RequestInit}[] = [];
  const control = {invalid: false, refreshStatus: 200, validationStatus: 200, delay: undefined as Promise<void> | undefined};
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://mock-id.invalid');
    calls.push({url, init});
    if (url.pathname === '/oauth2/token') {
      const fields = new URLSearchParams(String(init?.body));
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/x-www-form-urlencoded');
      assert.equal(fields.get('client_id'), env.TWITCH_CLIENT_ID);
      assert.equal(fields.get('client_secret'), env.TWITCH_CLIENT_SECRET);
      if (fields.get('grant_type') === 'authorization_code') {
        assert.equal(fields.get('code'), code);
        assert.equal(fields.get('redirect_uri'), env.TWITCH_REDIRECT_URI);
        return json({access_token: access, refresh_token: refresh});
      }
      await control.delay;
      if (control.refreshStatus !== 200) return json({message: 'mock failure'}, control.refreshStatus);
      control.invalid = false;
      return json({access_token: 'test-rotated-access', refresh_token: 'test-rotated-refresh'});
    }
    assert.equal(url.pathname, '/oauth2/validate');
    const auth = new Headers(init?.headers).get('authorization');
    assert.ok(auth === `OAuth ${access}` || auth === 'OAuth test-rotated-access');
    if (control.invalid) return json({}, 401);
    if (control.validationStatus !== 200) return json({}, control.validationStatus);
    return json({client_id: env.TWITCH_CLIENT_ID, login: 'streamer', user_id: '12345', scopes: [...TWITCH_SCOPES], expires_in: 7200});
  }) as typeof fetch;
  return {calls, control, fetchImpl};
}
function storeHarness(extra: Partial<TokenStoreOptions> = {}) {
  const mock = mockIdentity();
  const store = new TwitchTokenStore({env, baseUrl: 'https://mock-id.invalid', fetchImpl: mock.fetchImpl, ...extra});
  return {...mock, store};
}

test('Twitch config and authorize URL use the exact authorization-code parameters and minimum scopes', () => {
  assert.equal(twitchConfig({}).configured, false);
  assert.equal(twitchConfig(env).configured, true);
  assert.equal(twitchConfig({...env, TWITCH_REDIRECT_URI: ''}).configured, false);
  assert.equal(twitchConfig({}).redirectUri, 'http://localhost:3001/auth/twitch/callback');
  const oauth = new TwitchOAuth(twitchConfig(env));
  const url = new URL(oauth.authorize('random-state'));
  assert.equal(url.origin + url.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), {response_type: 'code', client_id: env.TWITCH_CLIENT_ID,
    redirect_uri: env.TWITCH_REDIRECT_URI, scope: TWITCH_SCOPES.join(' '), state: 'random-state'});
  assert.match(url.search, /scope=user%3Aread%3Achat\+chat%3Aread\+channel%3Amanage%3Aredemptions/);
  assert.deepEqual([...TWITCH_SCOPES], ['user:read:chat', 'chat:read', 'channel:manage:redemptions', 'channel:manage:polls',
    'channel:manage:predictions', 'bits:read', 'channel:read:hype_train']);
  noSecrets(url.href);
});

test('token store validates on connect, exposes only public status, and supplies T3 and IRC credentials privately', async () => {
  const {store, calls} = storeHarness();
  try {
    assert.equal(store.ircSnapshot(), undefined);
    assert.equal(await store.getAuth(), undefined);
    await store.connect(code);
    assert.deepEqual(calls.map(call => call.url.pathname), ['/oauth2/token', '/oauth2/validate']);
    const provider: TwitchAuthProvider = store;
    assert.deepEqual(await provider.getAuth(), {clientId: env.TWITCH_CLIENT_ID, accessToken: access, broadcasterId: '12345', login: 'streamer'});
    assert.deepEqual(store.ircSnapshot(), {username: 'streamer', token: `oauth:${access}`});
    assert.equal(store.status().connected, true);
    assert.equal(store.status().login, 'streamer');
    noSecrets(store.status());
    store.disconnect();
    assert.equal(store.ircSnapshot(), undefined);
    assert.equal(await store.getAuth(), undefined);
    noSecrets(store.status());
  } finally { store.close(); }
});

test('Helix retry refreshes once on 401, keeps rotated refresh tokens, and single-flights concurrent refreshes', async () => {
  const {store, calls} = storeHarness();
  try {
    await store.connect(code);
    const attempts: string[] = [];
    const result = await withTwitchAuth(store, async auth => {
      attempts.push(auth.accessToken);
      return {status: attempts.length === 1 ? 401 : 200};
    });
    assert.equal(result.status, 200);
    assert.deepEqual(attempts, [access, 'test-rotated-access']);
    calls.length = 0;
    await Promise.all([store.refresh(), store.refresh()]);
    const refreshes = calls.filter(call => call.url.pathname === '/oauth2/token');
    assert.equal(refreshes.length, 1);
    assert.equal(new URLSearchParams(String(refreshes[0].init?.body)).get('refresh_token'), 'test-rotated-refresh');
    let count = 0;
    const stillUnauthorized = await withTwitchAuth(store, async () => { count++; return {status: 401}; });
    assert.equal(stillUnauthorized.status, 401);
    assert.equal(count, 2, 'a second 401 does not loop');
  } finally { store.close(); }
});

test('refresh encodes special refresh-token characters as form data', async () => {
  const {calls, fetchImpl} = mockIdentity();
  const oauth = new TwitchOAuth(twitchConfig(env), {baseUrl: 'https://mock-id.invalid', fetchImpl});
  await oauth.refresh('mock+refresh/&= value');
  const body = String(calls[0].init?.body);
  assert.match(body, /refresh_token=mock%2Brefresh%2F%26%3D\+value/);
  assert.equal(new URLSearchParams(body).get('refresh_token'), 'mock+refresh/&= value');
});

for (const status of [400, 401, 500]) test(`failed refresh ${status} disconnects and clears private snapshots`, async () => {
  const {store, control} = storeHarness();
  try {
    await store.connect(code);
    control.refreshStatus = status;
    await store.refresh();
    assert.equal(store.status().connected, false);
    assert.match(store.status().reason ?? '', /Reconnect Twitch/);
    assert.equal(await store.getAuth(), undefined);
    assert.equal(store.ircSnapshot(), undefined);
    noSecrets(store.status());
  } finally { store.close(); }
});

test('hourly unref validation uses injected time; a validation 401 refreshes once', async () => {
  let clock = 1000, tick: (() => void) | undefined, unref = 0, canceled = 0;
  const {store, control, calls} = storeHarness({now: () => clock,
    schedule: (task, ms) => { assert.equal(ms, 3_600_000); tick = task; return {unref: () => {unref++;}}; },
    cancel: () => {canceled++;},
  });
  try {
    await store.connect(code);
    assert.equal(unref, 1);
    assert.equal(store.status().expiresAt, clock + 7_200_000);
    clock += 3_600_000; control.invalid = true; calls.length = 0;
    tick!(); await store.validate();
    assert.deepEqual(calls.map(call => call.url.pathname), ['/oauth2/validate', '/oauth2/token', '/oauth2/validate']);
    assert.equal(store.status().expiresAt, clock + 7_200_000);
    assert.equal((await store.getAuth())?.accessToken, 'test-rotated-access');
    store.disconnect(); assert.equal(canceled, 1);
  } finally { store.close(); }
});

test('disconnect fences an in-flight refresh so it cannot resurrect a session', async () => {
  const {store, control} = storeHarness();
  try {
    await store.connect(code);
    let release!: () => void;
    control.delay = new Promise<void>(resolve => {release = resolve;});
    const pending = store.refresh();
    store.disconnect(); release(); await pending;
    assert.equal(store.status().connected, false);
    assert.equal(await store.getAuth(), undefined);
  } finally { store.close(); }
});


async function loginState(app: ReturnType<typeof createApp>) {
  const login = await app.inject('/auth/twitch/login');
  assert.equal(login.statusCode, 302);
  noSecrets(login.body);
  return new URL(login.headers.location!).searchParams.get('state')!;
}
function routeHarness(extraEnv: Record<string, string> = {}, now: () => number = Date.now) {
  const harness = storeHarness({now});
  let logs = '';
  const stream = new Writable({write(chunk, _encoding, done) {logs += String(chunk); done();}});
  const app = createApp({env: {...env, COMICTOONS_TWITCH_EVENTSUB_WS_URL: eventSubUrl, ...extraEnv}, twitchStore: harness.store, helix:{fetch:async()=>Response.json({data:[{id:'1234',login:'streamer',display_name:'Streamer',broadcaster_type:''}]})},now, logger: {level: 'info', stream}});
  return {...harness, app, logs: () => logs};
}

test('OAuth login is local-only, not-configured guidance is fixed, and forwarded remote clients are denied', async () => {
  const unconfigured = createApp({env: {}});
  try {
    const missing = await unconfigured.inject('/auth/twitch/login');
    assert.equal(missing.statusCode, 503);
    assert.match(missing.body, /TWITCH_CLIENT_ID/);
    assert.equal((await unconfigured.inject({url: '/auth/twitch/login', remoteAddress: '192.168.1.20'})).statusCode, 403);
    assert.equal((await unconfigured.inject({url: '/auth/twitch/login', headers: {'x-forwarded-for': '10.0.0.5'}})).statusCode, 403);
  } finally {await unconfigured.close();}
});

test('OAuth state rejects missing, unknown, expired and reused values before any token request', async () => {
  let clock = 1000;
  const {app, calls, logs} = routeHarness({}, () => clock);
  try {
    for (const query of ['', '?state=unknown', '?state=one&state=two']) {
      const response = await app.inject(`/auth/twitch/callback${query}`);
      assert.equal(response.statusCode, 400); noSecrets(response.body);
    }
    const expired = await loginState(app);
    clock += 600_000;
    assert.equal((await app.inject(`/auth/twitch/callback?state=${expired}&code=${code}`)).statusCode, 400);
    assert.equal(calls.length, 0, 'bad state must never contact the token endpoint');
    const state = await loginState(app);
    const success = await app.inject(`/auth/twitch/callback?state=${state}&code=${code}`);
    assert.equal(success.statusCode, 302);
    const before = calls.length;
    const reused = await app.inject(`/auth/twitch/callback?state=${state}&code=${code}`);
    assert.equal(reused.statusCode, 400);
    assert.equal(calls.length, before);
    noSecrets(logs());
    assert.equal(logs().includes(state), false);
    assert.equal(logs().includes(expired), false);
  } finally {await app.close();}
});

test('OAuth access_denied consumes state and redirects only a fixed denied result', async () => {
  const {app, calls, logs} = routeHarness({COMICTOONS_WEB_PORT: '4179'});
  try {
    const state = await loginState(app);
    const response = await app.inject(`/auth/twitch/callback?state=${state}&error=access_denied`);
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, 'http://localhost:4179/ui.html#/connect?twitch=denied');
    assert.equal(calls.length, 0);
    assert.equal((await app.inject(`/auth/twitch/callback?state=${state}&code=${code}`)).statusCode, 400);
    noSecrets(response.body); noSecrets(logs());
  } finally {await app.close();}
});

test('OAuth success stores credentials privately; no status, response or captured log leaks them', async () => {
  const {app, store, logs} = routeHarness({COMICTOONS_WEB_PORT: '4179'});
  try {
    const state = await loginState(app);
    const response = await app.inject(`/auth/twitch/callback?code=${code}&state=${state}`);
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, 'http://localhost:4179/ui.html#/connect?twitch=connected');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    noSecrets(response.body); noSecrets(response.headers);
    const status = await app.inject('/api/twitch/status');
    assert.equal(status.json().connected, true);
    assert.equal(status.json().login, 'streamer');
    assert.deepEqual(status.json().scopes, [...TWITCH_SCOPES]);
    noSecrets(status.body);
    assert.equal((await store.getAuth())?.broadcasterId, '12345');
    const disconnected = await app.inject({method: 'POST', url: '/api/twitch/disconnect'});
    assert.equal(disconnected.statusCode, 200);
    assert.equal(disconnected.json().connected, false);
    assert.equal(await store.getAuth(), undefined);
    noSecrets(disconnected.body); noSecrets(logs());
    assert.equal(logs().includes(state), false);
  } finally {await app.close();}
});

test('OAuth provider failures return fixed errors and never log provider bodies or codes', async () => {
  const {app, store, control, logs} = routeHarness();
  try {
    control.validationStatus = 500;
    const state = await loginState(app);
    const response = await app.inject(`/auth/twitch/callback?code=${code}&state=${state}`);
    assert.equal(response.statusCode, 502);
    assert.equal(store.status().connected, false);
    noSecrets(response.body); noSecrets(logs());
  } finally {await app.close();}
});

test('Twitch disconnect requires a local request or the configured director header', async () => {
  const local = routeHarness();
  const keyed = routeHarness({COMICTOONS_DIRECTOR_KEY: 'test-director-secret'});
  try {
    assert.equal((await local.app.inject({method: 'POST', url: '/api/twitch/disconnect', remoteAddress: '192.168.1.20'})).statusCode, 403);
    for (const address of ['127.0.0.1', '192.168.1.20']) {
      for (const headers of [{}, {[DIRECTOR_KEY_HEADER]: 'wrong'}]) {
        assert.equal((await keyed.app.inject({method: 'POST', url: '/api/twitch/disconnect', remoteAddress: address, headers})).statusCode, 401);
      }
    }
    const allowed = await keyed.app.inject({method: 'POST', url: '/api/twitch/disconnect', remoteAddress: '192.168.1.20', headers: {[DIRECTOR_KEY_HEADER]: 'test-director-secret'}});
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.includes('test-director-secret'), false);
  } finally {await Promise.all([local.app.close(), keyed.app.close()]);}
});


test('IRC adapter factory fails closed without auth and supplies the private snapshot to the existing adapter', async () => {
  const {store} = storeHarness();
  const frames: string[] = [];
  let opened = 0, handlers: Parameters<IrcTransportFactory>[0] | undefined;
  const factory = authenticatedIrcFactory(() => store.ircSnapshot(), next => {
    opened++; handlers = next;
    return {write(frame) {frames.push(frame);}, close() {}};
  });
  const adapter = factory('streamer');
  try {
    const statuses: string[] = [];
    adapter.start({event() {}, status(value) {statuses.push(value);}});
    assert.equal(opened, 0);
    assert.deepEqual(statuses, ['unauthenticated']);
    await store.connect(code);
    adapter.start({event() {}, status() {}});
    assert.equal(opened, 1);
    handlers!.open();
    assert.deepEqual(frames.slice(0, 2), [`PASS oauth:${access}\r\n`, 'NICK streamer\r\n']);
    adapter.stop(); store.disconnect();
    adapter.start({event() {}, status() {}});
    assert.equal(opened, 1, 'disconnected credentials cannot open a new transport');
  } finally {adapter.stop(); store.close();}
});

test('ingest defaults to configured channel or signed-in login and sign-out retains IRC fallback', async () => {
  for (const channel of ['', 'configured_channel']) {
    const {store} = storeHarness({env: {...env, TWITCH_CHANNEL: channel}});
    await store.connect(code);
    const selected: string[] = [];
    let stopped = 0;
    const app = createApp({env: {COMICTOONS_TWITCH_EVENTSUB_WS_URL: eventSubUrl}, twitchStore: store, adapterFactory: selectedChannel => {
      selected.push(selectedChannel);
      return {start() {}, stop() {stopped++;}};
    }});
    try {
      const response = await app.inject({method: 'POST', url: '/api/ingest', payload: {mode: 'twitch'}});
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(selected[0], channel || 'streamer');
      noSecrets(response.body);
      await app.inject({method: 'POST', url: '/api/twitch/disconnect'});
      assert.equal(stopped, 0, 'an existing IRC connection remains the fallback; new auth snapshots are cleared');
      assert.equal((await app.inject('/api/state')).json().source.requested, 'twitch');
    } finally {await app.close();}
  }
});


test('configured scopes request EventSub chat and only opt in to user-token bot replies',()=>{
  for(const enabled of [undefined,'0','1','on']){
    const config=twitchConfig({...env,COMICTOONS_FLAG_BOT_REPLIES:enabled});
    assert.equal(config.scopes.includes('user:write:chat'),enabled==='1'||enabled==='on');
    assert.ok(config.scopes.includes('user:read:chat'));
    assert.ok(!config.scopes.includes('user:bot')&&!config.scopes.includes('channel:bot'));
    assert.equal(new URL(new TwitchOAuth(config).authorize('test-state')).searchParams.get('scope'),config.scopes.join(' '));
  }
});

const DISALLOWED_SCOPE=/:(manage|write|edit|moderate)|^chat:edit|^user:write|^moderator:/;

test('COMICTOONS_OAUTH_SCOPES_READONLY narrows the login scope to exactly the six read scopes',()=>{
  const config=twitchConfig({...env,COMICTOONS_OAUTH_SCOPES_READONLY:'1'});
  assert.deepEqual(config.scopes,['user:read:chat','bits:read','channel:read:redemptions','channel:read:polls','channel:read:predictions','channel:read:hype_train']);
  assert.deepEqual(config.scopes,[...TWITCH_SCOPES_READONLY]);
  const scopeParam=new URL(new TwitchOAuth(config).authorize('test-state')).searchParams.get('scope')!;
  assert.equal(scopeParam,TWITCH_SCOPES_READONLY.join(' '));
  for(const scope of scopeParam.split(' '))assert.doesNotMatch(scope,DISALLOWED_SCOPE,`${scope} must not be a write/manage/edit/moderate scope`);
});

test('without COMICTOONS_OAUTH_SCOPES_READONLY the login scope is byte-for-byte the current TWITCH_SCOPES',()=>{
  for(const unset of [undefined,'0','false']){
    const config=twitchConfig({...env,COMICTOONS_OAUTH_SCOPES_READONLY:unset});
    assert.deepEqual(config.scopes,[...TWITCH_SCOPES]);
    assert.equal(new URL(new TwitchOAuth(config).authorize('test-state')).searchParams.get('scope'),TWITCH_SCOPES.join(' '));
  }
  // The existing BOT_REPLIES behaviour (above) is otherwise unchanged when the flag is absent.
  const withBotReplies=twitchConfig({...env,COMICTOONS_FLAG_BOT_REPLIES:'1'});
  assert.deepEqual(withBotReplies.scopes,[...TWITCH_SCOPES,'user:write:chat']);
});

test('COMICTOONS_OAUTH_SCOPES_READONLY wins over COMICTOONS_FLAG_BOT_REPLIES: never user:write:chat in read-only mode',()=>{
  const config=twitchConfig({...env,COMICTOONS_OAUTH_SCOPES_READONLY:'1',COMICTOONS_FLAG_BOT_REPLIES:'1'});
  assert.ok(!config.scopes.includes('user:write:chat'));
  assert.deepEqual(config.scopes,[...TWITCH_SCOPES_READONLY]);
});


test('GET /auth/twitch/login: a write or manage scope never appears in the signed-in authorise URL, and the normal URL is unchanged',async()=>{
  const cases:[Record<string,string>,readonly string[]][]=[
    [{COMICTOONS_OAUTH_SCOPES_READONLY:'1'},TWITCH_SCOPES_READONLY],
    [{COMICTOONS_OAUTH_SCOPES_READONLY:'1',COMICTOONS_FLAG_BOT_REPLIES:'1'},TWITCH_SCOPES_READONLY],
    [{},TWITCH_SCOPES],
    [{COMICTOONS_FLAG_BOT_REPLIES:'1'},[...TWITCH_SCOPES,'user:write:chat']],
  ];
  for(const [extra,expected] of cases){
    const store=new TwitchTokenStore({env:{...env,...extra},baseUrl:'https://mock-id.invalid',fetchImpl:mockIdentity().fetchImpl});
    const app=createApp({env:{...env,...extra},twitchStore:store});
    try{
      const login=await app.inject('/auth/twitch/login');
      assert.equal(login.statusCode,302);
      const scopes=new URL(login.headers.location!).searchParams.get('scope')!.split(' ');
      assert.deepEqual(scopes,[...expected],JSON.stringify(extra));
      if(extra.COMICTOONS_OAUTH_SCOPES_READONLY)for(const scope of scopes)assert.doesNotMatch(scope,DISALLOWED_SCOPE,`${scope} must not be in the signed-in authorise URL`);
    }finally{await app.close();store.close();}
  }
});

test('refresh changes private auth, reuses the rotated refresh token, and clears auth on rejection',async()=>{
  const {store,calls,control}=storeHarness();
  try{
    await store.connect(code);const before=await store.getAuth();
    await store.refresh();const after=await store.getAuth();
    assert.equal(before?.accessToken,access);assert.equal(after?.accessToken,'test-rotated-access');
    calls.length=0;await store.refresh();
    assert.equal(new URLSearchParams(String(calls.find(call=>call.url.pathname==='/oauth2/token')!.init?.body)).get('refresh_token'),'test-rotated-refresh');
    control.refreshStatus=400;await store.refresh();assert.equal(await store.getAuth(),undefined);
  }finally{store.close();}
});

test('public status recursively excludes credential keys and values and exposes channel and missing scopes',async()=>{
  const {store}=storeHarness({env:{...env,TWITCH_CHANNEL:'chosen_channel',COMICTOONS_FLAG_BOT_REPLIES:'1'}});
  await store.connect(code);
  const app=createApp({env:{COMICTOONS_TWITCH_EVENTSUB_WS_URL:eventSubUrl},twitchStore:store,helix:{fetch:async()=>Response.json({data:[{id:'1234',login:'streamer',display_name:'Streamer',broadcaster_type:''}]})},logger:false});
  const inspect=(value:unknown):void=>{
    if(!value||typeof value!=='object')return;
    for(const [name,child]of Object.entries(value)){
      assert.doesNotMatch(name,/token|refresh|secret|code|authorization/i);inspect(child);
    }
  };
  try{
    const response=await app.inject('/api/twitch/status');const status=response.json();
    assert.equal(status.connected,true);assert.equal(status.channel,'chosen_channel');
    assert.deepEqual(status.missingScopes,['user:write:chat']);inspect(status);noSecrets(response.body);
    store.disconnect();const disconnected=(await app.inject('/api/twitch/status')).json();
    assert.equal(disconnected.connected,false);inspect(disconnected);noSecrets(disconnected);
  }finally{await app.close();}
});


test('current Twitch credential names win, legacy names work, and the callback default is exact',()=>{
  const current={COMICTOONS_TWITCH_CLIENT_ID:'current-test-id',COMICTOONS_TWITCH_CLIENT_SECRET:'current-test-secret',COMICTOONS_TWITCH_REDIRECT_URI:'http://localhost:3001/auth/twitch/callback'};
  const config=twitchConfig({...env,...current});
  assert.equal(config.clientId,current.COMICTOONS_TWITCH_CLIENT_ID);
  assert.equal(config.clientSecret,current.COMICTOONS_TWITCH_CLIENT_SECRET);
  assert.equal(config.redirectUri,current.COMICTOONS_TWITCH_REDIRECT_URI);
  assert.equal(twitchConfig(env).clientId,env.TWITCH_CLIENT_ID);
  assert.equal(twitchConfig(env).clientSecret,env.TWITCH_CLIENT_SECRET);
  assert.equal(twitchConfig({}).redirectUri,'http://localhost:3001/auth/twitch/callback');
  assert.equal(twitchConfig({...env,...current,COMICTOONS_TWITCH_CLIENT_SECRET:''}).configured,false);
});
