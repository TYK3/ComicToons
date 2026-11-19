import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventBus, type ComicPanel, type ComicToonsBusEvents } from '../packages/core/src/index.ts';
import type { ParticipationEvent, StudioLike } from '../apps/server/src/participation/commands.ts';
import { Participation, createMockHelix, type ParticipationFlags } from '../apps/server/src/participation/routes.ts';
import {startEventSubBridge} from '../apps/server/src/eventsub/bridge.ts';
import {FakeClock,socketFactory,fakeAuth,recordingCreator,welcome,notification} from './eventsub-fakes.ts';
import { INK_ME_CHAT_FALLBACK } from '../apps/server/src/participation/rewards.ts';
import { createHelixClient, createSignedInHelix, INK_ME_AFFILIATE_MESSAGE, type FetchLike, type TwitchAuthProvider } from '../apps/server/src/twitch-api/index.ts';

// Real Helix client over a scripted fetch, behind the signed-in switch. No network, placeholder tokens only.
const ALL_ON: ParticipationFlags = { polls: true, twitchPolls: true, inkMe: true, catchup: true, hype: true, director: true, noink: true, botReplies: false };
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
type Call = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };

function panel(id: string, at = 0, dialogue: string[] = []): ComicPanel {
  return { id, caption: `Panel ${id}`, dialogue, scene: 'scene', characters: [], mood: 'calm', altText: 'alt', imageUrl: '/art/x.png', at };
}
function fakeStudio(): StudioLike {
  const studio: StudioLike = {
    state: { panels: [] as ComicPanel[], pendingPanels: [] as ComicPanel[], elapsed: 0, approvalMode: true },
    moderate(kind: 'approve' | 'reject', panelId?: string) {
      const chosen = studio.state.pendingPanels.find(entry => entry.id === panelId);
      if (!chosen) throw new Error('no such panel');
      studio.state.pendingPanels = studio.state.pendingPanels.filter(entry => entry !== chosen);
      if (kind === 'approve') studio.state.panels.push(chosen);
    },
    caption(panelId: string, caption: string) { const target = studio.state.pendingPanels.find(entry => entry.id === panelId); if (target) target.caption = caption; },
  };
  return studio;
}
/** Answers like Helix for each endpoint; `respond` can override one call (e.g. a 403). */
function helixServer(respond?: (call: Call) => Response | undefined, broadcasterType = 'affiliate') {
  const calls: Call[] = []; let rewardSeq = 0; const rewards: { id: string; title: string }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const override = respond?.(call); if (override) return override;
    const route = `${call.method} ${call.path}`;
    if (route === 'GET /helix/users') return json({ data: [{ id: url.searchParams.get('id') ?? '1234', login: 'inkstreamer', display_name: 'InkStreamer', type: '', broadcaster_type: broadcasterType }] });
    if (route === 'GET /helix/channel_points/custom_rewards') return json({ data: rewards });
    if (route === 'POST /helix/channel_points/custom_rewards') { const reward = { id: `live-reward-${++rewardSeq}`, title: String(call.body!.title) }; rewards.push(reward); return json({ data: [reward] }); }
    if (route === 'PATCH /helix/channel_points/custom_rewards') return json({ data: [{ id: url.searchParams.get('id'), is_paused: call.body!.is_paused }] });
    if (route === 'DELETE /helix/channel_points/custom_rewards') { const at = rewards.findIndex(entry => entry.id === url.searchParams.get('id')); if (at >= 0) rewards.splice(at, 1); return new Response(null, { status: 204 }); }
    if (route === 'PATCH /helix/channel_points/custom_rewards/redemptions') return json({ data: url.searchParams.getAll('id').map(id => ({ id, status: call.body!.status })) });
    if (route === 'POST /helix/polls') return json({ data: [{ id: 'live-poll-1' }] });
    if (route === 'PATCH /helix/polls') return json({ data: [{ id: call.body!.id, status: call.body!.status }] });
    if (route === 'POST /helix/predictions') return json({ data: [{ id: 'live-pred-1', outcomes: [{ id: 'yes-id', title: 'Yes' }, { id: 'no-id', title: 'No' }] }] });
    if (route === 'PATCH /helix/predictions') return json({ data: [{ id: call.body!.id, status: call.body!.status }] });
    return json({ message: 'not found' }, 404);
  };
  return { calls, fetchImpl, rewards };
}
function setup(options: { log?:(message:string)=>void; signedIn?: boolean; respond?: (call: Call) => Response | undefined; broadcasterType?: string } = {}) {
  let signedIn = options.signedIn ?? true;
  const auth: TwitchAuthProvider = {
    async getAuth() { return signedIn ? { clientId: 'client-abc', accessToken: 'placeholder-token', broadcasterId: '1234', login: 'inkstreamer' } : undefined; },
    async refresh() {},
  };
  const server = helixServer(options.respond, options.broadcasterType);
  const fake = createMockHelix();
  const helix = createSignedInHelix({ auth, real: createHelixClient({ auth, fetch: server.fetchImpl, sleep: async () => {} }), fallback: fake });
  const studio = fakeStudio(); const bus = createEventBus<ComicToonsBusEvents>();
  let clock = 1_000_000;
  const engine = new Participation({ log:options.log, studio, bus, flags: ALL_ON, helix, now: () => clock, budgetPerHour: 12 });
  const chat = (user: string, text: string) => bus.emit('stream-event', { t: 0, type: 'chat', id: `${user}-${text}-${clock}`, user, name: user, text } as ParticipationEvent);
  return { engine, studio, bus, fake, server, chat, signOut: () => { signedIn = false; }, advance: (ms: number) => { clock += ms; } };
}
const redeem = (bus: ReturnType<typeof setup>['bus'], id: string, rewardId: string, user: string) => bus.emit('stream-event', { t: 0, type: 'redemption', user, name: user, redemption: { id, rewardId, userLogin: user } } as ParticipationEvent);

test('Ink me live: turning it on creates the reward on Twitch; a second enable reuses the id', async () => {
  const { engine, server } = setup();
  await engine.rewards.enable();
  assert.equal(engine.rewards.status, 'ready');
  assert.equal(engine.rewards.rewardId, 'live-reward-1');
  const posts = () => server.calls.filter(call => call.method === 'POST' && call.path === '/helix/channel_points/custom_rewards');
  assert.equal(posts().length, 1);
  assert.equal(posts()[0]!.body!.title, 'Ink me');
  assert.equal(posts()[0]!.body!.cost, 500);
  const before = server.calls.length;
  await engine.rewards.enable();
  await engine.rewards.connect();
  assert.equal(engine.rewards.rewardId, 'live-reward-1');
  assert.equal(server.calls.length, before, 'no second Helix call when the reward is already live');
});

test('Ink me live: an existing manageable reward (after a restart) is reused, not duplicated', async () => {
  const { engine, server } = setup();
  server.rewards.push({ id: 'kept-from-last-run', title: 'Ink me' });
  await engine.rewards.enable();
  assert.equal(engine.rewards.rewardId, 'kept-from-last-run');
  assert.equal(server.calls.filter(call => call.method === 'POST').length, 0);
});

test('Ink me live: turning it off deletes the reward; on again creates a fresh one', async () => {
  const { engine, server } = setup();
  await engine.rewards.enable();
  await engine.rewards.disable();
  const deleted = server.calls.find(call => call.method === 'DELETE')!;
  assert.equal(deleted.path, '/helix/channel_points/custom_rewards');
  assert.equal(deleted.query.get('id'), 'live-reward-1');
  assert.equal(deleted.query.get('broadcaster_id'), '1234');
  assert.equal(engine.rewards.status, 'idle');
  assert.equal(engine.rewards.rewardId, undefined);
  await engine.rewards.disable();
  assert.equal(server.calls.filter(call => call.method === 'DELETE').length, 1, 'off twice deletes once');
  await engine.rewards.enable();
  assert.equal(engine.rewards.rewardId, 'live-reward-2');
});

const createCalls = (server: ReturnType<typeof helixServer>) => server.calls.filter(call => call.method === 'POST' && call.path === '/helix/channel_points/custom_rewards');

test('Ink me eligibility: affiliate channel gets the reward created after a Get Users check', async () => {
  const { engine, server } = setup({ broadcasterType: 'affiliate' });
  await engine.rewards.enable();
  const users = server.calls.find(call => call.path === '/helix/users')!;
  assert.equal(users.method, 'GET');
  assert.equal(users.query.get('id'), '1234');
  assert.ok(server.calls.indexOf(users) < server.calls.indexOf(createCalls(server)[0]!), 'Get Users runs before Create Custom Rewards');
  assert.equal(engine.rewards.status, 'ready');
  assert.equal(createCalls(server).length, 1);
});

test('Ink me eligibility: partner channel gets the reward created', async () => {
  const { engine, server } = setup({ broadcasterType: 'partner' });
  await engine.rewards.enable();
  assert.equal(engine.rewards.status, 'ready');
  assert.equal(createCalls(server).length, 1);
});

test('Ink me eligibility: a normal channel (broadcaster_type "") never calls Create Custom Rewards, stays off and flags the chat fallback', async () => {
  const { engine, server } = setup({ broadcasterType: '' });
  await engine.rewards.enable();
  assert.equal(createCalls(server).length, 0);
  assert.equal(server.calls.filter(call => call.path === '/helix/channel_points/custom_rewards').length, 0);
  assert.equal(engine.rewards.status, 'unavailable');
  assert.equal(engine.rewards.rewardId, undefined);
  const view = engine.rewards.view();
  assert.equal(view.error, 'Ink me needs an Affiliate or Partner channel');
  assert.equal(view.offReason, 'not-affiliate');
  assert.equal(view.chatFallback, INK_ME_CHAT_FALLBACK);
  assert.match(view.chatFallback!, /!ink yes/);
});

test('Ink me eligibility: a Get Users failure degrades to Ink me off with a message, never a throw', async () => {
  const down = () => new Response(JSON.stringify({ message: 'Service Unavailable' }), { status: 503 });
  const { engine, server, bus } = setup({ respond: call => call.path === '/helix/users' ? down() : undefined });
  await assert.doesNotReject(engine.rewards.enable());
  assert.equal(engine.rewards.status, 'unavailable');
  assert.equal(engine.rewards.offReason, 'check-failed');
  assert.match(engine.rewards.error!, /Ink me is off/);
  assert.ok(engine.rewards.view().chatFallback);
  assert.equal(createCalls(server).length, 0);
  // The bus hook used at sign-in must not reject either.
  bus.emit('twitch-connected', {}); await flush();
  assert.equal(engine.rewards.status, 'unavailable');
});

test('Ink me eligibility: Get Users 401 after refresh and 429 after retry also degrade gracefully', async () => {
  const unauthorised = setup({ respond: call => call.path === '/helix/users' ? new Response(JSON.stringify({ message: 'Invalid OAuth token' }), { status: 401 }) : undefined });
  await unauthorised.engine.rewards.enable();
  assert.equal(unauthorised.engine.rewards.offReason, 'check-failed');
  assert.equal(unauthorised.server.calls.filter(call => call.path === '/helix/users').length, 2);
  const limited = setup({ respond: call => call.path === '/helix/users' ? new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429, headers: { 'Ratelimit-Reset': '0' } }) : undefined });
  await limited.engine.rewards.enable();
  assert.equal(limited.engine.rewards.offReason, 'check-failed');
  assert.equal(limited.server.calls.filter(call => call.path === '/helix/users').length, 2);
});

test('Ink me eligibility: a 403 from Create Custom Rewards gives the same off state and message', async () => {
  const forbidden = () => new Response(JSON.stringify({ error: 'Forbidden', status: 403, message: 'The broadcaster is not a partner or affiliate.' }), { status: 403 });
  const { engine } = setup({ respond: call => call.method === 'POST' && call.path === '/helix/channel_points/custom_rewards' ? forbidden() : undefined });
  await engine.rewards.enable();
  assert.equal(engine.rewards.status, 'unavailable');
  assert.equal(engine.rewards.offReason, 'not-affiliate');
  assert.equal(engine.rewards.error, INK_ME_AFFILIATE_MESSAGE);
  assert.equal(engine.rewards.view().chatFallback, INK_ME_CHAT_FALLBACK);
});

test('Ink me live: approving the cameo marks the redemption FULFILLED; rejecting marks it CANCELED', async () => {
  const { engine, studio, bus, server, advance } = setup();
  await engine.rewards.enable();
  const rewardId = engine.rewards.rewardId!;
  redeem(bus, 'r1', rewardId, 'u1'); await flush();
  assert.ok(studio.state.pendingPanels.some(entry => entry.id === 'cameo-r1'));
  studio.moderate('approve', 'cameo-r1');
  engine.tick(); await flush();
  const patches = () => server.calls.filter(call => call.path === '/helix/channel_points/custom_rewards/redemptions');
  assert.equal(patches().length, 1);
  assert.deepEqual(patches()[0]!.body, { status: 'FULFILLED' });
  assert.deepEqual(patches()[0]!.query.getAll('id'), ['r1']);
  assert.equal(patches()[0]!.query.get('reward_id'), rewardId);
  assert.equal(engine.rewards.redemptions.find(entry => entry.id === 'r1')!.status, 'fulfilled');
  advance(301_000);
  redeem(bus, 'r2', rewardId, 'u2'); await flush();
  studio.moderate('reject', 'cameo-r2');
  engine.tick(); await flush();
  assert.equal(patches().length, 2);
  assert.deepEqual(patches()[1]!.body, { status: 'CANCELED' });
  assert.equal(engine.rewards.redemptions.find(entry => entry.id === 'r2')!.status, 'canceled');
  engine.tick(); await flush();
  assert.equal(patches().length, 2, 'a settled redemption is never updated twice');
});

test('Ink me live: the streamer fulfil and cancel buttons reach Twitch', async () => {
  const { engine, studio, bus, server, advance } = setup();
  await engine.rewards.enable();
  redeem(bus, 'r1', engine.rewards.rewardId!, 'u1'); await flush();
  // A drafted cameo is a library placeholder and cannot go on air, so it cannot be fulfilled until source-grounded art
  // exists. Nothing reaches Twitch for the refused attempt. Once the art is generated the release gate is lifted.
  await assert.rejects(engine.rewards.resolve('r1', 'fulfil'), /source-grounded cameo image/i);
  assert.equal(server.calls.filter(call => call.path === '/helix/channel_points/custom_rewards/redemptions').length, 0);
  for (const panel of studio.state.pendingPanels) delete panel.releaseBlocked;
  await engine.rewards.resolve('r1', 'fulfil');
  advance(301_000);
  redeem(bus, 'r2', engine.rewards.rewardId!, 'u2'); await flush();
  await engine.rewards.resolve('r2', 'cancel');
  const statuses = server.calls.filter(call => call.path === '/helix/channel_points/custom_rewards/redemptions').map(call => call.body!.status);
  assert.deepEqual(statuses, ['FULFILLED', 'CANCELED']);
});

test('polls live: signed in, the Twitch poll is created and an early finish ends it on Twitch', async () => {
  const { engine, studio, chat, server, fake } = setup();
  studio.state.pendingPanels.push(panel('p1'));
  chat('a', 'first line here'); chat('b', 'second line here'); await flush();
  const poll = await engine.polls.start({ panelId: 'p1', duration: 30 });
  assert.equal(poll.mode, 'twitch');
  assert.equal(poll.id, 'live-poll-1');
  assert.equal(server.calls.find(call => call.method === 'POST' && call.path === '/helix/polls')!.body!.broadcaster_id, '1234');
  engine.polls.finish(); await flush();
  const end = server.calls.find(call => call.method === 'PATCH' && call.path === '/helix/polls')!;
  assert.deepEqual(end.body, { broadcaster_id: '1234', id: 'live-poll-1', status: 'TERMINATED' });
  assert.equal(fake.calls.length, 0, 'the fake is not used while signed in');
});

test('polls live: a poll Twitch already ended is not ended again', async () => {
  const { engine, studio, chat, bus, server } = setup();
  studio.state.pendingPanels.push(panel('p1'));
  chat('a', 'first line here'); chat('b', 'second line here'); await flush();
  await engine.polls.start({ panelId: 'p1', duration: 30 });
  bus.emit('stream-event', { t: 0, type: 'poll', poll: { id: 'live-poll-1', status: 'COMPLETED', choices: [{ votes: 3 }, { votes: 1 }] } } as ParticipationEvent); await flush();
  assert.equal(server.calls.filter(call => call.method === 'PATCH' && call.path === '/helix/polls').length, 0);
});

test('predictions live: hype opens a Twitch prediction; resolve and cancel end it on Twitch', async () => {
  const { engine, bus, server } = setup();
  bus.emit('stream-event', { t: 0, type: 'hype_train_begin', level: 2 } as ParticipationEvent); await flush();
  assert.equal(engine.hype.prediction!.id, 'live-pred-1');
  assert.equal(server.calls.find(call => call.method === 'POST' && call.path === '/helix/predictions')!.body!.prediction_window, 120);
  await engine.hype.resolvePrediction('yes-id');
  assert.equal(engine.hype.prediction!.status, 'RESOLVED');
  assert.match(engine.hype.punchline!.text, /THEY MADE IT/);
  const ends = () => server.calls.filter(call => call.method === 'PATCH' && call.path === '/helix/predictions');
  assert.deepEqual(ends()[0]!.body, { broadcaster_id: '1234', id: 'live-pred-1', status: 'RESOLVED', winning_outcome_id: 'yes-id' });
  bus.emit('stream-event', { t: 0, type: 'hype_train_end' } as ParticipationEvent);
  bus.emit('stream-event', { t: 0, type: 'hype_train_begin', level: 1 } as ParticipationEvent); await flush();
  await engine.hype.cancelPrediction();
  assert.equal(engine.hype.prediction!.status, 'CANCELED');
  assert.deepEqual(ends()[1]!.body, { broadcaster_id: '1234', id: 'live-pred-1', status: 'CANCELED' });
});

test('signed out: polls, predictions and Ink me fall back to the in-memory fake with no Helix request', async () => {
  const { engine, studio, chat, bus, server, fake, signOut } = setup({ signedIn: true });
  signOut();
  await engine.rewards.enable();
  assert.equal(engine.rewards.rewardId, 'mock-reward-1');
  studio.state.pendingPanels.push(panel('p1'));
  chat('a', 'first line here'); chat('b', 'second line here'); await flush();
  const poll = await engine.polls.start({ panelId: 'p1', duration: 30 });
  assert.match(poll.id, /^mock-poll-/);
  bus.emit('stream-event', { t: 0, type: 'hype_train_begin', level: 1 } as ParticipationEvent); await flush();
  assert.match(engine.hype.prediction!.id, /^mock-prediction-/);
  assert.deepEqual(fake.calls.map(call => call.method), ['createCustomReward', 'createPoll', 'createPrediction']);
  assert.equal(server.calls.length, 0);
});

// t3b-fix: UNFULFILLED Ink me redemptions are refunded (CANCELED) at stream end and when Ink me is turned off.
const redemptionPatches = (server: ReturnType<typeof helixServer>) => server.calls.filter(call => call.method === 'PATCH' && call.path === '/helix/channel_points/custom_rewards/redemptions');

test('Ink me refunds: turning it off cancels pending redemptions before deleting the reward and leaves settled ones alone', async () => {
  const { engine, studio, bus, server, advance } = setup();
  await engine.rewards.enable();
  redeem(bus, 'r-approved', 'live-reward-1', 'ana'); await flush();
  studio.moderate('approve', 'cameo-r-approved'); engine.tick(); await flush();
  assert.equal(engine.rewards.redemptions.find(entry => entry.id === 'r-approved')!.status, 'fulfilled');
  redeem(bus, 'r-too-soon', 'live-reward-1', 'bo'); await flush(); // cooldown: refunded at once, already settled
  advance(301_000); redeem(bus, 'r-pending-1', 'live-reward-1', 'cy'); await flush();
  advance(301_000); redeem(bus, 'r-pending-2', 'live-reward-1', 'di'); await flush();
  const before = redemptionPatches(server).length;
  await engine.rewards.disable();
  const patches = redemptionPatches(server).slice(before);
  assert.equal(patches.length, 1, 'one batched call');
  assert.deepEqual(patches[0]!.query.getAll('id').sort(), ['r-pending-1', 'r-pending-2']);
  assert.equal(patches[0]!.query.get('reward_id'), 'live-reward-1');
  assert.equal(patches[0]!.body!.status, 'CANCELED');
  const del = server.calls.findIndex(call => call.method === 'DELETE');
  assert.ok(server.calls.indexOf(patches[0]!) < del, 'refunds go out before the reward is deleted');
  const status = (id: string) => engine.rewards.redemptions.find(entry => entry.id === id)!.status;
  assert.equal(status('r-approved'), 'fulfilled');
  assert.equal(status('r-too-soon'), 'canceled');
  assert.equal(status('r-pending-1'), 'canceled');
  assert.equal(status('r-pending-2'), 'canceled');
  assert.equal(studio.state.pendingPanels.length, 0, 'refunded cameos leave the review queue');
  assert.equal(engine.rewards.status, 'idle');
  assert.equal(engine.rewards.rewardId, undefined);
  assert.deepEqual(engine.rewards.pendingIds(), []);
});

test('Ink me refunds: fake EventSub stream.offline cancels exactly the pending redemptions', async () => {
  const { engine, studio, bus, server } = setup();
  await engine.rewards.enable();
  redeem(bus, 'r-live', 'live-reward-1', 'ana'); await flush();
  assert.deepEqual(engine.rewards.pendingIds(), ['r-live']);
  const {sockets,factory}=socketFactory();const clock=new FakeClock();
  const bridge=startEventSubBridge({auth:fakeAuth(),bus,socketFactory:factory,timers:clock,now:()=>clock.now,creator:recordingCreator()});
  try{
    await flush();sockets[0]!.send(welcome('offline-session'));await flush();
    sockets[0]!.send(notification('stream.offline',{broadcaster_user_id:'1234'}));await flush();
  }finally{bridge.stop();}
  const patches = redemptionPatches(server);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0]!.query.getAll('id'), ['r-live']);
  assert.equal(patches[0]!.body!.status, 'CANCELED');
  assert.equal(engine.rewards.redemptions[0]!.status, 'canceled');
  assert.match(engine.rewards.redemptions[0]!.note, /stream ended|refunded/i);
  assert.equal(studio.state.pendingPanels.length, 0);
  assert.equal(engine.rewards.status, 'ready', 'stream end refunds but keeps the reward');
  assert.equal(server.calls.filter(call => call.method === 'DELETE').length, 0);
});

test('Ink me refunds: more than 50 pending are cancelled in batches of at most 50 ids', async () => {
  const { engine, bus, server, advance } = setup();
  await engine.rewards.enable();
  for (let i = 0; i < 51; i += 1) { advance(301_000); redeem(bus, `r-${i}`, 'live-reward-1', `viewer${i}`); await flush(); }
  assert.equal(engine.rewards.pendingIds().length, 51);
  const result = await engine.rewards.cancelPending();
  assert.deepEqual(result, { canceled: 51, failed: 0 });
  assert.deepEqual(redemptionPatches(server).map(call => call.query.getAll('id').length), [50, 1]);
  assert.deepEqual(engine.rewards.pendingIds(), []);
});

test('Ink me refunds: no extra Helix calls when nothing is pending', async () => {
  const { engine, studio, bus, server } = setup();
  await engine.rewards.enable();
  const start = server.calls.length;
  assert.deepEqual(await engine.rewards.cancelPending(), { canceled: 0, failed: 0 });
  assert.equal(server.calls.length, start, 'cancelPending with nothing pending makes no call');
  redeem(bus, 'r-done', 'live-reward-1', 'ana'); await flush();
  studio.moderate('reject', 'cameo-r-done'); engine.tick(); await flush();
  const settled = server.calls.length;
  await engine.rewards.disable();
  assert.deepEqual(server.calls.slice(settled).map(call => call.method), ['DELETE'], 'off with nothing pending only deletes');
});

// t3b-fix2: a failed refund must never be followed by Delete Custom Reward (Twitch would mark the
// redemption FULFILLED and the viewer would lose the points).
const failingRefunds = (failures: { left: number }) => (call: Call) => call.method === 'PATCH' && call.path.endsWith('/redemptions') && failures.left-- > 0
  ? new Response(JSON.stringify({ message: 'internal' }), { status: 500 }) : undefined;
const deletes = (server: ReturnType<typeof helixServer>) => server.calls.filter(call => call.method === 'DELETE');

test('Ink me refunds: a refund failure keeps the reward (paused, no delete), retries once, logs without the token and says why', async () => {
  const failures = { left: Infinity };
  const logged: string[] = [];
  const { engine, bus, server } = setup({ respond: failingRefunds(failures),log:message=>logged.push(message) });
  await engine.rewards.enable();
  redeem(bus, 'r-stuck', 'live-reward-1', 'ana'); await flush();
  await assert.doesNotReject(engine.rewards.disable());
  assert.equal(redemptionPatches(server).length, 2, 'one refund attempt plus exactly one retry');
  assert.equal(deletes(server).length, 0, 'never deleted while a refund is outstanding');
  const pause = server.calls.find(call => call.method === 'PATCH' && call.path === '/helix/channel_points/custom_rewards')!;
  assert.equal(pause.query.get('id'), 'live-reward-1');
  assert.equal(pause.body!.is_paused, true, 'paused so no new redemptions arrive while it is kept');
  assert.equal(engine.rewards.rewardId, 'live-reward-1', 'the reward id is kept for a later retry');
  assert.deepEqual(engine.rewards.pendingIds(), ['r-stuck'], 'the failed id stays pending');
  assert.equal(engine.rewards.status, 'unavailable');
  assert.equal(engine.rewards.view().offReason, 'refund-failed');
  assert.match(engine.rewards.error ?? '', /could not be refunded/i);
  assert.match(engine.rewards.error ?? '', /kept/i);
  assert.equal(engine.rewards.redemptions[0]!.status, 'drafted');
  assert.match(engine.rewards.redemptions[0]!.note, /refund failed/i);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /refund/i);
  assert.doesNotMatch(logged.join('\n'), /placeholder-token|client-abc/, 'no token or client id in the log');
  redeem(bus, 'r-late', 'live-reward-1', 'bo'); await flush();
  assert.equal(engine.rewards.redemptions.some(entry => entry.id === 'r-late'), false, 'a kept reward drafts nothing new');
});

test('Ink me refunds: when the one retry succeeds the reward is then deleted', async () => {
  const failures = { left: 1 };
  const { engine, bus, server } = setup({ respond: failingRefunds(failures) });
  await engine.rewards.enable();
  redeem(bus, 'r-flaky', 'live-reward-1', 'ana'); await flush();
  await engine.rewards.disable();
  const patches = redemptionPatches(server);
  assert.equal(patches.length, 2);
  assert.ok(server.calls.indexOf(patches[1]!) < server.calls.indexOf(deletes(server)[0]!), 'delete only after the refund succeeded');
  assert.equal(deletes(server).length, 1);
  assert.equal(engine.rewards.status, 'idle');
  assert.equal(engine.rewards.rewardId, undefined);
  assert.equal(engine.rewards.error, undefined);
  assert.deepEqual(engine.rewards.pendingIds(), []);
  assert.equal(engine.rewards.redemptions[0]!.status, 'canceled');
});

test('Ink me refunds: after a kept reward, a later disable() or cancelPending() finishes the job cleanly', async () => {
  for (const finish of ['disable', 'cancelPending'] as const) {
    const failures = { left: 2 };
    const { engine, bus, server } = setup({ respond: failingRefunds(failures) });
    await engine.rewards.enable();
    redeem(bus, 'r-later', 'live-reward-1', 'ana'); await flush();
    await engine.rewards.disable();
    assert.equal(deletes(server).length, 0, `${finish}: kept after the first off`);
    if (finish === 'disable') await engine.rewards.disable(); else assert.deepEqual(await engine.rewards.cancelPending(), { canceled: 1, failed: 0 });
    assert.equal(redemptionPatches(server).length, 3, `${finish}: one more refund call`);
    assert.equal(deletes(server).length, 1, `${finish}: the reward is deleted once the refund went through`);
    assert.equal(engine.rewards.status, 'idle', finish);
    assert.equal(engine.rewards.rewardId, undefined, finish);
    assert.equal(engine.rewards.error, undefined, finish);
    assert.equal(engine.rewards.view().offReason, undefined, finish);
    assert.deepEqual(engine.rewards.pendingIds(), [], finish);
    assert.equal(engine.rewards.redemptions[0]!.status, 'canceled', finish);
  }
});

test('Ink me refunds: turning Ink me back on after a kept reward reuses and unpauses it', async () => {
  const failures = { left: 2 };
  const { engine, bus, server } = setup({ respond: failingRefunds(failures) });
  await engine.rewards.enable();
  redeem(bus, 'r-kept', 'live-reward-1', 'ana'); await flush();
  await engine.rewards.disable();
  await engine.rewards.enable();
  assert.equal(engine.rewards.status, 'ready');
  assert.equal(engine.rewards.rewardId, 'live-reward-1');
  assert.equal(createCalls(server).length, 1, 'no second reward');
  const pauses = server.calls.filter(call => call.method === 'PATCH' && call.path === '/helix/channel_points/custom_rewards').map(call => call.body!.is_paused);
  assert.deepEqual(pauses, [true, false]);
  await engine.rewards.cancelPending();
  assert.equal(deletes(server).length, 0, 'back on: a later refund does not delete the reward');
});

test('changing Helix mode keeps a failed refund reward id until refund and deletion succeed',async()=>{
  const failures={left:Infinity};
  const {engine,bus,server}=setup({respond:failingRefunds(failures)});
  await engine.rewards.enable();
  redeem(bus,'kept-id','live-reward-1','ana');await flush();
  await engine.rewards.disable();
  const rewardId=engine.rewards.rewardId;
  assert.equal(engine.rewards.offReason,'refund-failed');
  engine.useHelix(null,'missing');
  assert.equal(engine.rewards.rewardId,rewardId);
  assert.deepEqual(engine.rewards.pendingIds(),['kept-id']);
  const auth:TwitchAuthProvider={getAuth:async()=>({clientId:'fake-client',accessToken:'fake-access',broadcasterId:'1234',login:'streamer'}),refresh:async()=>{}};
  engine.useHelix(createHelixClient({auth,fetch:server.fetchImpl}),'twitch');
  assert.equal(engine.rewards.rewardId,rewardId);
  failures.left=0;
  await engine.rewards.disable();
  assert.deepEqual(redemptionPatches(server).at(-1)!.query.getAll('id'),['kept-id']);
  assert.equal(deletes(server).at(-1)!.query.get('id'),rewardId);
  assert.equal(engine.rewards.rewardId,undefined);
  engine.close();
});
