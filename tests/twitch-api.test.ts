import assert from 'node:assert/strict';
import test from 'node:test';
import { createHelixClient, HELIX_BASE, INK_ME_AFFILIATE_MESSAGE, TwitchApiError, TwitchForbiddenError, TwitchSignedOutError, type FetchLike, type TwitchAuthProvider } from '../apps/server/src/twitch-api/index.ts';

// Every test runs on a scripted fetch: no network, no real tokens. The token strings below are placeholders.
type Call = { method: string; url: URL; headers: Record<string, string>; body?: unknown };
type Scripted = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeFetch(script: Scripted[]) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    calls.push({ method: init?.method ?? 'GET', url: new URL(String(input)), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = script.shift();
    if (!next) throw new Error('fake fetch: no scripted response left');
    return new Response(next.status === 204 ? null : JSON.stringify(next.body ?? {}), { status: next.status, headers: { 'content-type': 'application/json', ...(next.headers ?? {}) } });
  };
  return { calls, fetchImpl };
}
function fakeAuth(options: { signedOut?: boolean } = {}) {
  let token = 'token-one'; let refreshes = 0;
  const auth: TwitchAuthProvider = {
    async getAuth() { return options.signedOut ? undefined : { clientId: 'client-abc', accessToken: token, broadcasterId: '1234', login: 'inkstreamer' }; },
    async refresh() { refreshes += 1; token = 'token-two'; },
  };
  return { auth, refreshes: () => refreshes };
}
function setup(script: Scripted[], options: { signedOut?: boolean; now?: number } = {}) {
  const { calls, fetchImpl } = fakeFetch(script);
  const { auth, refreshes } = fakeAuth(options);
  const sleeps: number[] = [];
  const client = createHelixClient({ auth, fetch: fetchImpl, sleep: async ms => { sleeps.push(ms); }, now: () => options.now ?? 1_700_000_000_000 });
  return { client, calls, refreshes, sleeps };
}
const REWARD = { title: 'Ink me', cost: 500, prompt: 'Become a manga panel.', isMaxPerUserPerStreamEnabled: true, maxPerUserPerStream: 1, isGlobalCooldownEnabled: true, globalCooldownSeconds: 300 };

test('helix 200: create custom reward sends POST, query broadcaster_id, snake_case body, Client-Id and Bearer', async () => {
  const { client, calls } = setup([{ status: 200, body: { data: [{ id: 'reward-1', title: 'Ink me' }] } }]);
  assert.deepEqual(await client.createCustomReward(REWARD), { id: 'reward-1' });
  const [call] = calls;
  assert.equal(call!.method, 'POST');
  assert.equal(`${call!.url.origin}${call!.url.pathname}`, `${HELIX_BASE}/channel_points/custom_rewards`);
  assert.equal(call!.url.searchParams.get('broadcaster_id'), '1234');
  assert.equal(call!.headers['client-id'], 'client-abc');
  assert.equal(call!.headers.authorization, 'Bearer token-one');
  assert.equal(call!.headers['content-type'], 'application/json');
  assert.deepEqual(call!.body, { title: 'Ink me', cost: 500, prompt: 'Become a manga panel.', is_enabled: true, is_max_per_user_per_stream_enabled: true, max_per_user_per_stream: 1, is_global_cooldown_enabled: true, global_cooldown_seconds: 300 });
});

test('helix 200: get users by id and for the token user, and read broadcaster_type', async () => {
  const { client, calls } = setup([
    { status: 200, body: { data: [{ id: '1234', login: 'inkstreamer', display_name: 'InkStreamer', type: '', broadcaster_type: 'partner' }] } },
    { status: 200, body: { data: [{ id: '1234', login: 'inkstreamer', display_name: 'InkStreamer', type: '', broadcaster_type: '' }] } },
    { status: 200, body: { data: [{ id: '1234', login: 'inkstreamer', display_name: 'InkStreamer', type: '', broadcaster_type: 'affiliate' }] } },
  ]);
  assert.deepEqual(await client.getUsers(), [{ id: '1234', login: 'inkstreamer', displayName: 'InkStreamer', broadcasterType: 'partner' }]);
  assert.equal(await client.getBroadcasterType(), '');
  assert.equal(await client.getBroadcasterType(), 'affiliate');
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(`${calls[0]!.url.origin}${calls[0]!.url.pathname}`, `${HELIX_BASE}/users`);
  assert.equal([...calls[0]!.url.searchParams.keys()].length, 0, 'no params: the token user');
  assert.equal(calls[1]!.url.searchParams.get('id'), '1234');
  assert.equal(calls[1]!.headers['client-id'], 'client-abc');
});

test('helix 200: get (find manageable), update and delete custom reward', async () => {
  const { client, calls } = setup([
    { status: 200, body: { data: [{ id: 'other', title: 'Hydrate' }, { id: 'reward-9', title: 'Ink me' }] } },
    { status: 200, body: { data: [] } },
    { status: 200, body: { data: [{ id: 'reward-9', title: 'Ink me', is_enabled: false }] } },
    { status: 204 },
  ]);
  assert.deepEqual(await client.findCustomReward('Ink me'), { id: 'reward-9' });
  assert.equal(await client.findCustomReward('Ink me'), undefined);
  await client.updateCustomReward({ rewardId: 'reward-9', isEnabled: false });
  await client.deleteCustomReward({ rewardId: 'reward-9' });
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.url.pathname, '/helix/channel_points/custom_rewards');
  assert.equal(calls[0]!.url.searchParams.get('only_manageable_rewards'), 'true');
  assert.equal(calls[2]!.method, 'PATCH');
  assert.equal(calls[2]!.url.searchParams.get('id'), 'reward-9');
  assert.deepEqual(calls[2]!.body, { is_enabled: false });
  assert.equal(calls[3]!.method, 'DELETE');
  assert.equal(calls[3]!.url.searchParams.get('broadcaster_id'), '1234');
  assert.equal(calls[3]!.url.searchParams.get('id'), 'reward-9');
  assert.equal(calls[3]!.body, undefined);
});

test('helix 200: update redemption status FULFILLED and CANCELED', async () => {
  const { client, calls } = setup([{ status: 200, body: { data: [{ id: 'r1', status: 'FULFILLED' }] } }, { status: 200, body: { data: [{ id: 'r2', status: 'CANCELED' }] } }]);
  await client.updateRedemptionStatus({ rewardId: 'reward-1', redemptionIds: ['r1'], status: 'FULFILLED' });
  await client.updateRedemptionStatus({ rewardId: 'reward-1', redemptionIds: ['r2', 'r3'], status: 'CANCELED' });
  assert.equal(calls[0]!.method, 'PATCH');
  assert.equal(calls[0]!.url.pathname, '/helix/channel_points/custom_rewards/redemptions');
  assert.equal(calls[0]!.url.searchParams.get('reward_id'), 'reward-1');
  assert.deepEqual(calls[0]!.url.searchParams.getAll('id'), ['r1']);
  assert.deepEqual(calls[0]!.body, { status: 'FULFILLED' });
  assert.deepEqual(calls[1]!.url.searchParams.getAll('id'), ['r2', 'r3']);
  assert.deepEqual(calls[1]!.body, { status: 'CANCELED' });
});

test('helix 200: create and end poll', async () => {
  const { client, calls } = setup([{ status: 200, body: { data: [{ id: 'poll-1' }] } }, { status: 200, body: { data: [{ id: 'poll-1', status: 'TERMINATED' }] } }]);
  assert.deepEqual(await client.createPoll({ title: 'Which line?', choices: [{ title: 'a' }, { title: 'b' }], duration: 45 }), { id: 'poll-1' });
  await client.endPoll({ id: 'poll-1', status: 'TERMINATED' });
  assert.equal(calls[0]!.method, 'POST'); assert.equal(calls[0]!.url.pathname, '/helix/polls');
  assert.deepEqual(calls[0]!.body, { broadcaster_id: '1234', title: 'Which line?', choices: [{ title: 'a' }, { title: 'b' }], duration: 45 });
  assert.equal(calls[1]!.method, 'PATCH'); assert.equal(calls[1]!.url.pathname, '/helix/polls');
  assert.deepEqual(calls[1]!.body, { broadcaster_id: '1234', id: 'poll-1', status: 'TERMINATED' });
});

test('helix 200: create, resolve and cancel prediction', async () => {
  const { client, calls } = setup([
    { status: 200, body: { data: [{ id: 'pred-1', outcomes: [{ id: 'o1', title: 'Yes' }, { id: 'o2', title: 'No' }] }] } },
    { status: 200, body: { data: [{ id: 'pred-1', status: 'RESOLVED' }] } },
    { status: 200, body: { data: [{ id: 'pred-2', status: 'CANCELED' }] } },
  ]);
  assert.deepEqual(await client.createPrediction({ title: 'Will they make it?', outcomes: [{ title: 'Yes' }, { title: 'No' }], predictionWindow: 120 }), { id: 'pred-1', outcomes: [{ id: 'o1', title: 'Yes' }, { id: 'o2', title: 'No' }] });
  await client.endPrediction({ id: 'pred-1', status: 'RESOLVED', winningOutcomeId: 'o1' });
  await client.endPrediction({ id: 'pred-2', status: 'CANCELED' });
  assert.equal(calls[0]!.method, 'POST'); assert.equal(calls[0]!.url.pathname, '/helix/predictions');
  assert.deepEqual(calls[0]!.body, { broadcaster_id: '1234', title: 'Will they make it?', outcomes: [{ title: 'Yes' }, { title: 'No' }], prediction_window: 120 });
  assert.equal(calls[1]!.method, 'PATCH'); assert.equal(calls[1]!.url.pathname, '/helix/predictions');
  assert.deepEqual(calls[1]!.body, { broadcaster_id: '1234', id: 'pred-1', status: 'RESOLVED', winning_outcome_id: 'o1' });
  assert.deepEqual(calls[2]!.body, { broadcaster_id: '1234', id: 'pred-2', status: 'CANCELED' });
  await assert.rejects(client.endPrediction({ id: 'pred-1', status: 'RESOLVED' }), /winning outcome/);
});

test('helix 200: send chat message as the broadcaster', async () => {
  const { client, calls } = setup([{ status: 200, body: { data: [{ message_id: 'm1', is_sent: true }] } }]);
  await client.sendChatMessage({ message: 'Opt-out noted.', replyParentMessageId: 'parent-1' });
  assert.equal(calls[0]!.url.pathname, '/helix/chat/messages');
  assert.deepEqual(calls[0]!.body, { broadcaster_id: '1234', sender_id: '1234', message: 'Opt-out noted.', reply_parent_message_id: 'parent-1' });
});

test('helix 401: refreshes the token once and retries once with the new token', async () => {
  const { client, calls, refreshes } = setup([{ status: 401, body: { message: 'Invalid OAuth token' } }, { status: 200, body: { data: [{ id: 'poll-2' }] } }]);
  assert.deepEqual(await client.createPoll({ title: 'q', choices: [{ title: 'a' }, { title: 'b' }], duration: 15 }), { id: 'poll-2' });
  assert.equal(refreshes(), 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers.authorization, 'Bearer token-one');
  assert.equal(calls[1]!.headers.authorization, 'Bearer token-two');
});

test('helix 401 twice: gives up after one refresh, without leaking the token', async () => {
  const { client, calls, refreshes } = setup([{ status: 401, body: { message: 'Invalid OAuth token' } }, { status: 401, body: { message: 'Invalid OAuth token' } }]);
  const error = await client.createPoll({ title: 'q', choices: [{ title: 'a' }, { title: 'b' }], duration: 15 }).catch(caught => caught);
  assert.ok(error instanceof TwitchApiError);
  assert.equal(error.status, 401);
  assert.doesNotMatch(String(error.message), /token-one|token-two/);
  assert.equal(refreshes(), 1);
  assert.equal(calls.length, 2);
});

test('helix 403: non-Affiliate channel gives the typed Ink me error', async () => {
  const { client } = setup([{ status: 403, body: { error: 'Forbidden', status: 403, message: 'The broadcaster is not a partner or affiliate.' } }]);
  const error = await client.createCustomReward(REWARD).catch(caught => caught);
  assert.ok(error instanceof TwitchForbiddenError);
  assert.equal(error.status, 403);
  assert.equal(error.reason, 'not-affiliate');
  assert.equal(error.message, 'Ink me needs an Affiliate or Partner channel');
  assert.equal(error.userMessage, INK_ME_AFFILIATE_MESSAGE);
  assert.equal(INK_ME_AFFILIATE_MESSAGE, 'Ink me needs an Affiliate or Partner channel');
});

test('helix 403: a reward owned by another app is a different, clear message', async () => {
  const { client } = setup([{ status: 403, body: { message: 'The ID in the Client-Id header must match the client ID used to create the custom reward.' } }]);
  const error = await client.updateRedemptionStatus({ rewardId: 'x', redemptionIds: ['r'], status: 'FULFILLED' }).catch(caught => caught);
  assert.ok(error instanceof TwitchForbiddenError);
  assert.equal(error.reason, 'other-app');
  assert.notEqual(error.message, INK_ME_AFFILIATE_MESSAGE);
});

test('helix 429: waits until Ratelimit-Reset, then retries once', async () => {
  const now = 1_700_000_000_000;
  const { client, calls, sleeps } = setup([
    { status: 429, body: { message: 'Too Many Requests' }, headers: { 'Ratelimit-Limit': '800', 'Ratelimit-Remaining': '0', 'Ratelimit-Reset': String(now / 1000 + 3) } },
    { status: 200, body: { data: [{ id: 'poll-3' }] } },
  ], { now });
  assert.deepEqual(await client.createPoll({ title: 'q', choices: [{ title: 'a' }, { title: 'b' }], duration: 15 }), { id: 'poll-3' });
  assert.deepEqual(sleeps, [3000]);
  assert.equal(calls.length, 2);
});

test('helix 429 twice: retries at most once, then fails with status 429', async () => {
  const now = 1_700_000_000_000;
  const limited = { status: 429, body: { message: 'Too Many Requests' }, headers: { 'Ratelimit-Reset': String(now / 1000 + 1) } };
  const { client, calls, sleeps } = setup([limited, { ...limited }], { now });
  const error = await client.createPoll({ title: 'q', choices: [{ title: 'a' }, { title: 'b' }], duration: 15 }).catch(caught => caught);
  assert.ok(error instanceof TwitchApiError);
  assert.equal(error.status, 429);
  assert.equal(sleeps.length, 1);
  assert.equal(calls.length, 2);
});

test('helix signed out: throws a typed error and makes no request', async () => {
  const { client, calls } = setup([], { signedOut: true });
  await assert.rejects(client.createPoll({ title: 'q', choices: [{ title: 'a' }, { title: 'b' }], duration: 15 }), TwitchSignedOutError);
  assert.equal(calls.length, 0);
});
