// Self-tests for the mock-Twitch harness (scripts/twitch-mock). These run for real
// and must pass: they prove the fake behaves like the documented Twitch endpoints
// before any ComicToons code is tested against it. Configurable fake port (one fake at a time), no network.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {twitchConfig} from '../../apps/server/src/twitch/config.ts';
import {FakeTwitch} from '../../scripts/twitch-mock/fake-twitch.ts';
import {EventSubTestClient, APP_PORT, FAKE_PORT, form, helix, IrcTestClient, shape, sleep, waitUntil} from './helpers.ts';

const ALL_SCOPES = twitchConfig({COMICTOONS_FLAG_BOT_REPLIES:'1'}).scopes;

async function withFake(options: ConstructorParameters<typeof FakeTwitch>[0], run: (fake: FakeTwitch) => Promise<void>) {
  const fake = await new FakeTwitch({port: FAKE_PORT, ...options}).start();
  try { await run(fake); } finally { await fake.stop(); }
}

describe('OAuth (authorisation code flow, validate, refresh, revoke)', () => {
  let fake: FakeTwitch;
  const redirect = `http://127.0.0.1:${APP_PORT}/auth/twitch/callback`;
  before(async () => { fake = await new FakeTwitch({port: FAKE_PORT,redirectUris:[redirect]}).start(); });
  after(() => fake.stop());
  const authorizeUrl = (extra: Record<string, string> = {}) => `${fake.urls.authBase}/authorize?${new URLSearchParams({
    response_type: 'code', client_id: fake.clientId, redirect_uri: redirect, scope: ALL_SCOPES.join(' '), state: 'st4te', ...extra})}`;

  test('approve redirects with code, scope and the same state; code is single use', async () => {
    const response = await fetch(authorizeUrl(), {redirect: 'manual'});
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location')!);
    assert.equal(`${location.origin}${location.pathname}`, redirect);
    assert.equal(location.searchParams.get('state'), 'st4te');
    assert.equal(location.searchParams.get('scope'), ALL_SCOPES.join(' '));
    const code = location.searchParams.get('code')!;
    const exchange = () => fetch(`${fake.urls.authBase}/token`, form({client_id: fake.clientId, client_secret: fake.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirect}));
    const first = await exchange();
    assert.equal(first.status, 200);
    const tokens = await first.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(tokens).sort(), ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type']);
    assert.equal(tokens.token_type, 'bearer');
    assert.deepEqual(tokens.scope, ALL_SCOPES);
    const again = await exchange();
    assert.equal(again.status, 400);
    assert.deepEqual(await again.json(), {status: 400, message: 'Invalid authorization code'});
  });

  test('deny redirects with error=access_denied and state; bad redirect_uri and client are rejected', async () => {
    fake.authorizeMode = 'deny';
    try {
      const response = await fetch(authorizeUrl(), {redirect: 'manual'});
      const location = new URL(response.headers.get('location')!);
      assert.equal(location.searchParams.get('error'), 'access_denied');
      assert.equal(location.searchParams.get('state'), 'st4te');
      assert.equal(location.searchParams.get('code'), null);
    } finally { fake.authorizeMode = 'approve'; }
    assert.equal((await fetch(authorizeUrl({redirect_uri: 'http://127.0.0.1:9/elsewhere'}), {redirect: 'manual'})).status, 400);
    assert.equal((await fetch(authorizeUrl({client_id: 'nope'}), {redirect: 'manual'})).status, 400);
  });

  test('token endpoint refuses a wrong client secret', async () => {
    const response = await fetch(`${fake.urls.authBase}/token`, form({client_id: fake.clientId, client_secret: 'wrong', grant_type: 'refresh_token', refresh_token: 'x'}));
    assert.equal(response.status, 403);
  });

  test('validate returns the documented fields; expired tokens get 401', async () => {
    const tokens = fake.issueUserToken(['chat:read']);
    const ok = await fetch(`${fake.urls.authBase}/validate`, {headers: {Authorization: `OAuth ${tokens.access_token}`}});
    assert.equal(ok.status, 200);
    const body = await ok.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['client_id', 'expires_in', 'login', 'scopes', 'user_id']);
    assert.equal(body.login, fake.broadcaster.login);
    fake.expireAccessTokens();
    const expired = await fetch(`${fake.urls.authBase}/validate`, {headers: {Authorization: `OAuth ${tokens.access_token}`}});
    assert.equal(expired.status, 401);
    assert.deepEqual(await expired.json(), {status: 401, message: 'invalid access token'});
  });

  test('client_credentials grant returns only the documented app-token fields', async () => {
    const response = await fetch(`${fake.urls.authBase}/token`, form({client_id: fake.clientId, client_secret: fake.clientSecret, grant_type: 'client_credentials'}));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['access_token', 'expires_in', 'token_type']);
    assert.equal(body.token_type, 'bearer');
  });

  test('validate on an app token returns only client_id, expires_in and scopes (no login or user_id)', async () => {
    const token = await fetch(`${fake.urls.authBase}/token`, form({client_id: fake.clientId, client_secret: fake.clientSecret, grant_type: 'client_credentials'}));
    const {access_token} = await token.json() as {access_token: string};
    const ok = await fetch(`${fake.urls.authBase}/validate`, {headers: {Authorization: `OAuth ${access_token}`}});
    assert.equal(ok.status, 200);
    const body = await ok.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['client_id', 'expires_in', 'scopes']);
    assert.deepEqual(body.scopes, []);
  });

  test('refresh rotates: new pair works, the old refresh token is refused with 400', async () => {
    const tokens = fake.issueUserToken(['chat:read']);
    fake.expireAccessTokens();
    const refresh = (token: string) => fetch(`${fake.urls.authBase}/token`, form({client_id: fake.clientId, client_secret: fake.clientSecret, grant_type: 'refresh_token', refresh_token: token}));
    const first = await refresh(tokens.refresh_token!);
    assert.equal(first.status, 200);
    const fresh = await first.json() as {access_token: string; refresh_token: string};
    assert.notEqual(fresh.access_token, tokens.access_token);
    assert.equal((await fetch(`${fake.urls.authBase}/validate`, {headers: {Authorization: `OAuth ${fresh.access_token}`}})).status, 200);
    const reused = await refresh(tokens.refresh_token!);
    assert.equal(reused.status, 400);
    assert.deepEqual(await reused.json(), {error: 'Bad Request', status: 400, message: 'Invalid refresh token'});
  });

  test('revoke kills the token', async () => {
    const tokens = fake.issueUserToken(['chat:read']);
    assert.equal((await fetch(`${fake.urls.authBase}/revoke`, form({client_id: fake.clientId, token: tokens.access_token}))).status, 200);
    assert.equal((await fetch(`${fake.urls.authBase}/validate`, {headers: {Authorization: `OAuth ${tokens.access_token}`}})).status, 401);
    assert.equal((await fetch(`${fake.urls.authBase}/revoke`, form({client_id: fake.clientId, token: tokens.access_token}))).status, 400);
  });

  test('the call log never holds token, code or secret values', () => {
    const logged = JSON.stringify(fake.log);
    assert.ok(!logged.includes(fake.clientSecret));
    assert.ok(!/[0-9a-f]{30}/.test(logged), 'no 30-hex token values in the log');
  });
});

describe('Helix', () => {
  test('Get Users, rate-limit headers, scope and client-id checks', () => withFake({}, async fake => {
    const t = fake.issueUserToken(ALL_SCOPES);
    const auth = {clientId: fake.clientId, token: t.access_token};
    const users = await helix(fake.urls.helixBase, 'GET', '/users', auth);
    assert.equal(users.status, 200);
    const [me] = users.body.data as Record<string, unknown>[];
    assert.equal(me!.id, fake.broadcaster.id);
    assert.equal(me!.broadcaster_type, 'affiliate');
    assert.ok(users.headers.get('ratelimit-limit'));
    assert.ok(users.headers.get('ratelimit-remaining'));
    assert.ok(users.headers.get('ratelimit-reset'));
    assert.equal((await helix(fake.urls.helixBase, 'GET', '/users', {clientId: 'other', token: t.access_token})).status, 401);
    assert.equal((await helix(fake.urls.helixBase, 'GET', '/users', {...auth, token: 'not-a-token'})).status, 401);
    const noScope = fake.issueUserToken(['chat:read']);
    const poll = await helix(fake.urls.helixBase, 'POST', '/polls', {clientId: fake.clientId, token: noScope.access_token},
      {broadcaster_id: fake.broadcaster.id, title: 'Q', choices: [{title: 'a'}, {title: 'b'}], duration: 60});
    assert.equal(poll.status, 401);
  }));

  test('Get Users returns exactly the documented fields, plus email only for the token\'s own user with user:read:email', () => withFake({}, async fake => {
    // https://dev.twitch.tv/docs/api/reference/#get-users
    const DOC_FIELDS = ['id', 'login', 'display_name', 'type', 'broadcaster_type', 'description', 'profile_image_url', 'offline_image_url', 'view_count', 'created_at'];
    const plain = fake.issueUserToken(ALL_SCOPES);
    const self = await helix(fake.urls.helixBase, 'GET', '/users', {clientId: fake.clientId, token: plain.access_token});
    const [me] = self.body.data as Record<string, unknown>[];
    assert.deepEqual(Object.keys(me!).sort(), [...DOC_FIELDS].sort());

    const withEmail = fake.issueUserToken([...ALL_SCOPES, 'user:read:email']);
    const emailAuth = {clientId: fake.clientId, token: withEmail.access_token};
    const other = fake.user('otherviewer');
    const mixed = await helix(fake.urls.helixBase, 'GET', `/users?id=${fake.broadcaster.id}&id=${other.id}`, emailAuth);
    const [broadcasterRow, otherRow] = mixed.body.data as Record<string, unknown>[];
    assert.deepEqual(Object.keys(broadcasterRow!).sort(), [...DOC_FIELDS, 'email'].sort());
    assert.deepEqual(Object.keys(otherRow!).sort(), [...DOC_FIELDS].sort(), 'email is only present for the token\'s own user');
  }));

  test('fault injection: 429 with Ratelimit-Remaining 0, then 401, 500, then normal', () => withFake({}, async fake => {
    const auth = {clientId: fake.clientId, token: fake.issueUserToken(ALL_SCOPES).access_token};
    fake.injectFault({path: '/helix/users', status: 429, retryAfterSeconds: 2});
    fake.injectFault({path: '/helix/users', status: 401});
    fake.injectFault({path: '/helix/users', status: 500});
    const limited = await helix(fake.urls.helixBase, 'GET', '/users', auth);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(limited.headers.get('ratelimit-reset')) >= Math.floor(Date.now() / 1000) + 1);
    assert.equal((await helix(fake.urls.helixBase, 'GET', '/users', auth)).status, 401);
    assert.equal((await helix(fake.urls.helixBase, 'GET', '/users', auth)).status, 500);
    assert.equal((await helix(fake.urls.helixBase, 'GET', '/users', auth)).status, 200);
  }));

  test('custom reward: created by this app, redemption fulfilled; duplicate and wrong-app updates refused', () => withFake({}, async fake => {
    const auth = {clientId: fake.clientId, token: fake.issueUserToken(ALL_SCOPES).access_token};
    const q = `?broadcaster_id=${fake.broadcaster.id}`;
    const created = await helix(fake.urls.helixBase, 'POST', `/channel_points/custom_rewards${q}`, auth, {title: 'Ink me', cost: 500, prompt: 'Put me in the comic', is_user_input_required: true});
    assert.equal(created.status, 200);
    const reward = (created.body.data as Record<string, unknown>[])[0]!;
    for (const key of ['id', 'title', 'cost', 'prompt', 'is_user_input_required', 'is_enabled', 'is_paused', 'should_redemptions_skip_request_queue', 'max_per_stream_setting', 'global_cooldown_setting']) assert.ok(key in reward, key);
    assert.equal((await helix(fake.urls.helixBase, 'POST', `/channel_points/custom_rewards${q}`, auth, {title: 'ink me', cost: 5})).status, 400);
    const {redemption} = fake.redeem('Ink me', 'viewer1', 'a pirate cat');
    const patch = (who: typeof auth, id = redemption.id) => helix(fake.urls.helixBase, 'PATCH', `/channel_points/custom_rewards/redemptions${q}&reward_id=${reward.id}&id=${id}`, who, {status: 'FULFILLED'});
    const otherApp = fake.issueUserToken(ALL_SCOPES, fake.broadcaster.login, 'someotherclient');
    assert.equal((await patch({clientId: 'someotherclient', token: otherApp.access_token})).status, 403);
    const done = await patch(auth);
    assert.equal(done.status, 200);
    assert.equal((done.body.data as {status: string}[])[0]!.status, 'FULFILLED');
    assert.equal((await patch(auth)).status, 404, 'already fulfilled');
  }));

  test('custom reward refused with 403 when the broadcaster is not Affiliate or Partner', () => withFake({broadcaster: {broadcasterType: ''}}, async fake => {
    const auth = {clientId: fake.clientId, token: fake.issueUserToken(ALL_SCOPES).access_token};
    const response = await helix(fake.urls.helixBase, 'POST', `/channel_points/custom_rewards?broadcaster_id=${fake.broadcaster.id}`, auth, {title: 'Ink me', cost: 500});
    assert.equal(response.status, 403);
    assert.match(String(response.body.message), /partner or affiliate/);
  }));

  test('Get Streams returns exactly the documented fields and filters by user_login/user_id', () => withFake({}, async fake => {
    // https://dev.twitch.tv/docs/api/reference/#get-streams
    const DOC_FIELDS = ['id', 'user_id', 'user_login', 'user_name', 'game_id', 'game_name', 'type', 'title', 'viewer_count',
      'started_at', 'language', 'thumbnail_url', 'tag_ids', 'tags', 'is_mature'];
    const auth = {clientId: fake.clientId, token: fake.issueUserToken(ALL_SCOPES).access_token};
    const other = fake.user('otherstreamer');
    fake.goLive(fake.broadcaster.login, {title: 'fixture stream', viewerCount: 42, gameId: '509658', gameName: 'Just Chatting', tags: ['english']});
    fake.goLive(other.login, {title: 'other stream'});

    const byLogin = await helix(fake.urls.helixBase, 'GET', `/streams?user_login=${fake.broadcaster.login}`, auth);
    assert.equal(byLogin.status, 200);
    const [stream] = byLogin.body.data as Record<string, unknown>[];
    assert.deepEqual(Object.keys(stream!).sort(), [...DOC_FIELDS].sort());
    assert.equal(stream!.user_id, fake.broadcaster.id);
    assert.equal(stream!.user_login, fake.broadcaster.login);
    assert.equal(stream!.viewer_count, 42);
    assert.equal(stream!.game_name, 'Just Chatting');
    assert.deepEqual(stream!.tags, ['english']);

    const byId = await helix(fake.urls.helixBase, 'GET', `/streams?user_id=${other.id}`, auth);
    assert.equal((byId.body.data as Record<string, unknown>[]).length, 1);
    assert.equal((byId.body.data as Record<string, unknown>[])[0]!.user_login, other.login);

    fake.goOffline(fake.broadcaster.login);
    const afterOffline = await helix(fake.urls.helixBase, 'GET', `/streams?user_login=${fake.broadcaster.login}`, auth);
    assert.deepEqual(afterOffline.body.data, []);

    const unfiltered = await helix(fake.urls.helixBase, 'GET', '/streams', auth);
    assert.equal((unfiltered.body.data as unknown[]).length, 1, 'only the still-live stream (other) remains');
  }));

  test('Get Clips returns exactly the documented fields and filters by broadcaster_id', () => withFake({}, async fake => {
    // https://dev.twitch.tv/docs/api/reference/#get-clips
    const DOC_FIELDS = ['id', 'url', 'embed_url', 'broadcaster_id', 'broadcaster_name', 'creator_id', 'creator_name',
      'video_id', 'game_id', 'language', 'title', 'view_count', 'created_at', 'thumbnail_url', 'duration', 'vod_offset', 'is_featured'];
    const auth = {clientId: fake.clientId, token: fake.issueUserToken(ALL_SCOPES).access_token};
    const other = fake.user('otherstreamer');
    fake.addClip(fake.broadcaster.login, {title: 'fixture clip', viewCount: 7, duration: 12.5, isFeatured: true});
    fake.addClip(other.login, {title: 'other clip'});

    const mine = await helix(fake.urls.helixBase, 'GET', `/clips?broadcaster_id=${fake.broadcaster.id}`, auth);
    assert.equal(mine.status, 200);
    const [clip] = mine.body.data as Record<string, unknown>[];
    assert.deepEqual(Object.keys(clip!).sort(), [...DOC_FIELDS].sort());
    assert.equal(clip!.broadcaster_id, fake.broadcaster.id);
    assert.equal(clip!.view_count, 7);
    assert.equal(clip!.duration, 12.5);
    assert.equal(clip!.is_featured, true);

    const theirs = await helix(fake.urls.helixBase, 'GET', `/clips?broadcaster_id=${other.id}`, auth);
    assert.equal((theirs.body.data as Record<string, unknown>[]).length, 1);
    assert.equal((theirs.body.data as Record<string, unknown>[])[0]!.broadcaster_id, other.id);

    const missing = await helix(fake.urls.helixBase, 'GET', '/clips', auth);
    assert.equal(missing.status, 400, 'broadcaster_id is required');
  }));
});

describe('EventSub WebSocket', () => {
  const sub = async (fake: FakeTwitch, token: string, sessionId: string, type: string, condition?: Record<string, string>) =>
    helix(fake.urls.helixBase, 'POST', '/eventsub/subscriptions', {clientId: fake.clientId, token}, {
      type, version: type.startsWith('channel.hype_train') ? '2' : '1',
      condition: condition ?? (type === 'channel.raid' ? {to_broadcaster_user_id: fake.broadcaster.id} : type.startsWith('channel.chat.') ? {broadcaster_user_id: fake.broadcaster.id, user_id: fake.broadcaster.id} : {broadcaster_user_id: fake.broadcaster.id}),
      transport: {method: 'websocket', session_id: sessionId}});

  test('welcome, subscribe (202), keepalive and a notification with the documented envelope', () => withFake({keepaliveSendMs: 150}, async fake => {
    const token = fake.issueUserToken(ALL_SCOPES).access_token;
    const client = new EventSubTestClient(fake.urls.eventSubWs);
    const session = await client.welcome();
    assert.equal(session.status, 'connected');
    assert.equal(session.keepalive_timeout_seconds, 10);
    assert.equal(session.reconnect_url, null);
    const created = await sub(fake, token, session.id, 'channel.raid');
    assert.equal(created.status, 202);
    assert.deepEqual(Object.keys(created.body).sort(), ['data', 'max_total_cost', 'total', 'total_cost']);
    const s = (created.body.data as Record<string, unknown>[])[0]!;
    assert.equal(s.status, 'enabled');
    assert.equal((s.transport as {session_id: string}).session_id, session.id);
    assert.equal((await sub(fake, token, session.id, 'channel.raid')).status, 409);
    assert.equal((await sub(fake, token, 'no_such_session', 'channel.poll.begin')).status, 400);
    assert.equal((await sub(fake, fake.issueUserToken(['chat:read']).access_token, session.id, 'channel.poll.begin')).status, 403);
    await client.next('session_keepalive', 3000);
    assert.equal(fake.raid('raidfriend', 42).eventsub, 1);
    const note = (await client.next('notification')) as unknown as {metadata: Record<string, string>; payload: {subscription: {type: string}; event: Record<string, unknown>}};
    assert.equal(note.metadata.subscription_type, 'channel.raid');
    assert.equal(note.metadata.subscription_version, '1');
    assert.equal(note.payload.subscription.type, 'channel.raid');
    assert.equal(note.payload.event.viewers, 42);
    await client.close();
  }));

  test('client inbound traffic is closed with 4001; no subscription in the window is closed with 4003', () => withFake({subscribeWindowMs: 300}, async fake => {
    const chatty = new EventSubTestClient(fake.urls.eventSubWs);
    await chatty.welcome();
    chatty.send('hello');
    assert.equal(await chatty.closed, 4001);
    const idle = new EventSubTestClient(fake.urls.eventSubWs);
    await idle.welcome();
    assert.equal(await idle.closed, 4003);
  }));

  test('session_reconnect: new socket gets a welcome and the subscriptions; old one closed by the client', () => withFake({}, async fake => {
    const token = fake.issueUserToken(ALL_SCOPES).access_token;
    const first = new EventSubTestClient(fake.urls.eventSubWs);
    const s1 = await first.welcome();
    await sub(fake, token, s1.id, 'channel.raid');
    fake.sendReconnect();
    const notice = await first.next('session_reconnect');
    const payload = (notice.payload.session as {status: string; reconnect_url: string; keepalive_timeout_seconds: null});
    assert.equal(payload.status, 'reconnecting');
    assert.equal(payload.keepalive_timeout_seconds, null);
    assert.match(payload.reconnect_url, /^ws:\/\/127\.0\.0\.1:\d+\/ws\?reconnect_id=/);
    const second = new EventSubTestClient(payload.reconnect_url);
    const s2 = await second.welcome();
    await first.close();
    assert.equal(fake.raid('raidfriend', 7).eventsub, 1);
    await second.next('notification');
    assert.equal(first.notifications().length, 0);
    assert.equal([...fake.subscriptions.values()][0]!.transport.session_id, s2.id);
    await second.close();
  }));

  test('reconnect ignored: the old socket is closed with 4004 after the grace period', () => withFake({reconnectGraceMs: 200}, async fake => {
    const token = fake.issueUserToken(ALL_SCOPES).access_token;
    const client = new EventSubTestClient(fake.urls.eventSubWs);
    const session = await client.welcome();
    await sub(fake, token, session.id, 'channel.raid');
    fake.sendReconnect();
    assert.equal(await client.closed, 4004);
  }));

  test('drop and revocation: subscriptions turn websocket_disconnected / authorization_revoked', () => withFake({}, async fake => {
    const token = fake.issueUserToken(ALL_SCOPES).access_token;
    const a = new EventSubTestClient(fake.urls.eventSubWs);
    const sa = await a.welcome();
    await sub(fake, token, sa.id, 'channel.poll.begin');
    fake.revokeAuthorisation();
    const revoked = await a.next('revocation');
    assert.equal((revoked.payload.subscription as {status: string}).status, 'authorization_revoked');
    const t2 = fake.issueUserToken(ALL_SCOPES).access_token;
    const b = new EventSubTestClient(fake.urls.eventSubWs);
    const sb = await b.welcome();
    await sub(fake, t2, sb.id, 'channel.raid');
    fake.closeSessions('drop');
    await b.closed;
    assert.notEqual(b.closeCode, 1000);
    const raid = [...fake.subscriptions.values()].find(s => s.type === 'channel.raid')!;
    assert.equal(raid.status, 'websocket_disconnected');
    assert.ok(raid.transport.disconnected_at);
    fake.acceptingWebsockets = false;
    const refused = new EventSubTestClient(fake.urls.eventSubWs);
    await assert.rejects(refused.opened);
    fake.acceptingWebsockets = true;
    const back = new EventSubTestClient(fake.urls.eventSubWs);
    await back.welcome();
    await back.close();
  }));

  test('polls and predictions over Helix emit begin/progress/lock/end with documented statuses', () => withFake({}, async fake => {
    const token = fake.issueUserToken(ALL_SCOPES).access_token;
    const auth = {clientId: fake.clientId, token};
    const client = new EventSubTestClient(fake.urls.eventSubWs);
    const session = await client.welcome();
    for (const type of ['channel.poll.begin', 'channel.poll.progress', 'channel.poll.end', 'channel.prediction.begin', 'channel.prediction.progress', 'channel.prediction.lock', 'channel.prediction.end']) {
      assert.equal((await sub(fake, token, session.id, type)).status, 202, type);
    }
    const created = await helix(fake.urls.helixBase, 'POST', '/polls', auth, {broadcaster_id: fake.broadcaster.id, title: 'What happens next?', choices: [{title: 'Dragon'}, {title: 'Heist'}], duration: 60});
    assert.equal(created.status, 200);
    assert.equal((created.body.data as {status: string}[])[0]!.status, 'ACTIVE');
    assert.equal((await helix(fake.urls.helixBase, 'POST', '/polls', auth, {broadcaster_id: fake.broadcaster.id, title: 'Another', choices: [{title: 'a'}, {title: 'b'}], duration: 60})).status, 400);
    fake.votePoll([3, 5]);
    fake.finishPoll();
    await waitUntil(() => client.notifications('channel.poll.end').length === 1);
    const end = client.notifications('channel.poll.end')[0]!.payload.event as {status: string; choices: {votes: number}[]};
    assert.equal(end.status, 'completed');
    assert.deepEqual(end.choices.map(c => c.votes), [3, 5]);
    assert.equal(client.notifications('channel.poll.begin').length, 1);
    assert.equal(client.notifications('channel.poll.progress').length, 1);

    const prediction = await helix(fake.urls.helixBase, 'POST', '/predictions', auth, {broadcaster_id: fake.broadcaster.id, title: 'Will the hero win?', outcomes: [{title: 'Yes'}, {title: 'No'}], prediction_window: 60});
    assert.equal(prediction.status, 200);
    const p = (prediction.body.data as {id: string; outcomes: {id: string}[]}[])[0]!;
    fake.predict(1, 4, 400);
    assert.equal((await helix(fake.urls.helixBase, 'PATCH', '/predictions', auth, {broadcaster_id: fake.broadcaster.id, id: p.id, status: 'LOCKED'})).status, 200);
    assert.equal((await helix(fake.urls.helixBase, 'PATCH', '/predictions', auth, {broadcaster_id: fake.broadcaster.id, id: p.id, status: 'RESOLVED', winning_outcome_id: p.outcomes[1]!.id})).status, 200);
    await waitUntil(() => client.notifications('channel.prediction.end').length === 1);
    const pend = client.notifications('channel.prediction.end')[0]!.payload.event as {status: string; winning_outcome_id: string};
    assert.equal(pend.status, 'resolved');
    assert.equal(pend.winning_outcome_id, p.outcomes[1]!.id);
    assert.equal(client.notifications('channel.prediction.lock').length, 1);
    await client.close();
  }));

  test('event bodies keep the key sets of the dev.twitch.tv examples', () => withFake({}, async fake => {
    // Keys copied from the "event" objects on https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/
    const docs: Record<string, string[]> = {
      'channel.raid': ['from_broadcaster_user_id', 'from_broadcaster_user_login', 'from_broadcaster_user_name', 'to_broadcaster_user_id', 'to_broadcaster_user_login', 'to_broadcaster_user_name', 'viewers'],
      'channel.chat.message': ['badges', 'broadcaster_user_id', 'broadcaster_user_login', 'broadcaster_user_name', 'channel_points_custom_reward_id', 'chatter_user_id', 'chatter_user_login', 'chatter_user_name', 'cheer', 'color', 'is_source_only', 'message', 'message_id', 'message_type', 'reply', 'source_badges', 'source_broadcaster_user_id', 'source_broadcaster_user_login', 'source_broadcaster_user_name', 'source_message_id'],
      'channel.chat.message_delete': ['broadcaster_user_id', 'broadcaster_user_login', 'broadcaster_user_name', 'message_id', 'target_user_id', 'target_user_login', 'target_user_name'],
      'channel.chat.clear_user_messages': ['broadcaster_user_id', 'broadcaster_user_login', 'broadcaster_user_name', 'target_user_id', 'target_user_login', 'target_user_name'],
      'channel.channel_points_custom_reward_redemption.add': ['broadcaster_user_id', 'broadcaster_user_login', 'broadcaster_user_name', 'id', 'redeemed_at', 'reward', 'status', 'user_id', 'user_input', 'user_login', 'user_name'],
      'channel.hype_train.begin': ['all_time_high_level', 'all_time_high_total', 'broadcaster_user_id', 'broadcaster_user_login', 'broadcaster_user_name', 'expires_at', 'goal', 'id', 'is_shared_train', 'level', 'progress', 'shared_train_participants', 'started_at', 'top_contributions', 'total', 'type'],
    };
    const token = fake.issueUserToken(ALL_SCOPES).access_token;
    const client = new EventSubTestClient(fake.urls.eventSubWs);
    const session = await client.welcome();
    for (const type of Object.keys(docs)) assert.equal((await sub(fake, token, session.id, type)).status, 202, type);
    const auth = {clientId: fake.clientId, token};
    await helix(fake.urls.helixBase, 'POST', `/channel_points/custom_rewards?broadcaster_id=${fake.broadcaster.id}`, auth, {title: 'Ink me', cost: 100});
    fake.raid('raider', 3);
    const {id} = fake.chat('viewer1', 'hello');
    fake.deleteMessage('viewer1', id, 'hello');
    fake.clearChat('viewer2', 600);
    fake.redeem('Ink me', 'viewer3', 'me as a knight');
    fake.hypeTrain(2);
    await waitUntil(() => client.notifications().length === Object.keys(docs).length, 3000, 'all notifications');
    for (const [type, keys] of Object.entries(docs)) {
      const event = client.notifications(type)[0]!.payload.event as Record<string, unknown>;
      assert.deepEqual(Object.keys(event).sort(), [...keys].sort(), type);
    }
    const message = client.notifications('channel.chat.message')[0]!.payload.event as {message: unknown};
    assert.deepEqual(shape(message.message), ['.fragments', '.fragments[]', '.fragments[].cheermote', '.fragments[].emote', '.fragments[].mention', '.fragments[].text', '.fragments[].type', '.text']);
    await client.close();
  }));
});

describe('Chat IRC', () => {
  test('bad token gets "Login authentication failed"; a token without chat:read too', () => withFake({}, async fake => {
    const bad = new IrcTestClient(fake.urls.ircPort);
    await bad.login('not-a-real-token', fake.broadcaster.login);
    await bad.waitFor(/NOTICE \* :Login authentication failed/);
    await waitUntil(() => bad.closed);
    const noScope = new IrcTestClient(fake.urls.ircPort);
    await noScope.login(fake.issueUserToken(['user:read:chat']).access_token, fake.broadcaster.login);
    await noScope.waitFor(/Login authentication failed/);
  }));

  test('welcome, JOIN, PRIVMSG, CLEARMSG, CLEARCHAT, raid USERNOTICE, PING and RECONNECT', () => withFake({}, async fake => {
    const irc = new IrcTestClient(fake.urls.ircPort);
    await irc.login(fake.issueUserToken(['chat:read']).access_token, fake.broadcaster.login);
    await irc.waitFor(/^:tmi\.twitch\.tv 001 fakebroadcaster :Welcome, GLHF!$/);
    await irc.waitFor(/:tmi\.twitch\.tv GLOBALUSERSTATE$/);
    irc.send(`JOIN #${fake.broadcaster.login}`);
    await irc.waitFor(/JOIN #fakebroadcaster$/);
    await irc.waitFor(/ROOMSTATE #fakebroadcaster$/);
    const {id, irc: delivered} = fake.chat('viewer_one', 'hello; world');
    assert.equal(delivered, 1);
    const line = await irc.waitFor(/PRIVMSG #fakebroadcaster :hello; world$/);
    assert.match(line, new RegExp(`;id=${id};`));
    assert.match(line, /^@badge-info=.*;user-id=\d+;user-type= :viewer_one!viewer_one@viewer_one\.tmi\.twitch\.tv PRIVMSG/);
    fake.deleteMessage('viewer_one', id, 'hello; world');
    assert.match(await irc.waitFor(/CLEARMSG/), new RegExp(`^@login=viewer_one;room-id=;target-msg-id=${id};tmi-sent-ts=\\d+ :tmi\\.twitch\\.tv CLEARMSG #fakebroadcaster :hello; world$`));
    fake.clearChat('viewer_two', 600);
    assert.match(await irc.waitFor(/CLEARCHAT #fakebroadcaster :viewer_two$/), /^@ban-duration=600;room-id=\d+;target-user-id=\d+;tmi-sent-ts=\d+ /);
    fake.clearChat();
    await irc.waitFor(/^@room-id=\d+;tmi-sent-ts=\d+ :tmi\.twitch\.tv CLEARCHAT #fakebroadcaster$/);
    fake.raid('raidfriend', 15);
    const raid = await irc.waitFor(/USERNOTICE #fakebroadcaster$/);
    assert.match(raid, /msg-id=raid;msg-param-displayName=raidfriend;msg-param-login=raidfriend;msg-param-viewerCount=15;/);
    assert.match(raid, /system-msg=15\\sraiders\\sfrom\\sraidfriend\\shave\\sjoined!/);
    fake.irc.ping();
    await irc.waitFor(/^PING :tmi\.twitch\.tv$/);
    irc.send('PING :tmi.twitch.tv');
    await irc.waitFor(/PONG/);
    fake.irc.reconnect(50);
    await irc.waitFor(/^:tmi\.twitch\.tv RECONNECT$/);
    await waitUntil(() => irc.closed, 2000, 'server close after RECONNECT');
  }));

  test('IRC and HTTP share one port; dropAll cuts chat without touching HTTP', () => withFake({}, async fake => {
    const irc = new IrcTestClient(fake.urls.ircPort);
    await irc.login(fake.issueUserToken(['chat:read']).access_token, fake.broadcaster.login);
    await irc.waitFor(/ 001 /);
    assert.equal((await fetch(`${fake.urls.base}/health`)).status, 200);
    fake.irc.dropAll();
    await waitUntil(() => irc.closed);
    await sleep(10);
    assert.equal((await fetch(`${fake.urls.base}/health`)).status, 200);
  }));
});
