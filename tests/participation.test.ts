import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createEventBus, type ComicPanel, type EventBus, type ComicToonsBusEvents } from '../packages/core/src/index.ts';
import { Studio } from '../apps/server/src/studio.ts';
import { OptOutLedger, parseCommand, fitText, type ParticipationEvent, type StudioLike } from '../apps/server/src/participation/commands.ts';
import { POLL_LIMITS, POLL_QUESTION, validatePoll } from '../apps/server/src/participation/polls.ts';
import { INK_ME, PanelBudget, inkMeReward, validateReward } from '../apps/server/src/participation/rewards.ts';
import { HYPE_PREDICTION, punchlineFor, validatePrediction } from '../apps/server/src/participation/predictions.ts';
import { Participation, createMockHelix, participationRoutes, readParticipationFlags, type ParticipationFlags } from '../apps/server/src/participation/routes.ts';

// Every test runs on mocked bus events and the in-memory Helix: no network, no paid API, no secrets.
const ALL_ON: ParticipationFlags = { polls: true, twitchPolls: false, inkMe: true, catchup: true, hype: true, director: true, noink: true, botReplies: true };
const flush = () => new Promise(resolve => setImmediate(resolve));

function panel(id: string, at = 0, dialogue: string[] = []): ComicPanel {
  return { id, caption: `Panel ${id}`, dialogue, scene: 'scene', characters: [], mood: 'calm', altText: 'alt', imageUrl: '/art/x.png', at };
}
function fakeStudio(): StudioLike & { log: string[] } {
  const log: string[] = [];
  const studio = {
    log,
    state: { panels: [] as ComicPanel[], pendingPanels: [] as ComicPanel[], elapsed: 0, approvalMode: true },
    moderate(kind: 'approve' | 'reject', panelId?: string) {
      const chosen = studio.state.pendingPanels.find(entry => entry.id === panelId);
      if (!chosen) throw new Error('no such panel');
      studio.state.pendingPanels = studio.state.pendingPanels.filter(entry => entry !== chosen);
      if (kind === 'approve') studio.state.panels.push(chosen);
      log.push(`${kind}:${panelId}`);
    },
    caption(panelId: string, caption: string) {
      const target = studio.state.pendingPanels.find(entry => entry.id === panelId);
      if (!target) throw new Error('gone');
      target.caption = caption; log.push(`caption:${panelId}:${caption}`);
    },
  };
  return studio;
}
function setup(flags: Partial<ParticipationFlags> = {}, options: { affiliate?: boolean; budget?: number } = {}) {
  let clock = 1_000_000;
  const bus: EventBus<ComicToonsBusEvents> = createEventBus<ComicToonsBusEvents>();
  const studio = fakeStudio();
  const helix = createMockHelix({ affiliate: options.affiliate });
  const engine = new Participation({ studio, bus, flags: { ...ALL_ON, ...flags }, helix, now: () => clock, budgetPerHour: options.budget ?? 12 });
  const seen: { channel: string; payload: unknown }[] = [];
  for (const channel of ['catchup', 'poll-started', 'poll-result', 'cameo', 'hype-splash', 'panel-splash', 'punchline']) bus.on(channel, payload => seen.push({ channel, payload }));
  const chat = (user: string, text: string, extra: Partial<ParticipationEvent> = {}) => bus.emit('stream-event', { id: `m-${user}-${clock}-${text.length}`, t: 0, type: 'chat', user, name: user, text, ...extra } as ParticipationEvent);
  return { bus, studio, helix, engine, seen, chat, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

test('commands: chat commands parse strictly and fitText keeps to Twitch limits', () => {
  assert.deepEqual(parseCommand('!2'), { kind: 'vote', choice: 2 });
  assert.equal(parseCommand('!6'), null);
  assert.equal(parseCommand('!previously')?.kind, 'previously');
  assert.equal(parseCommand('!ink yes')?.kind, 'ink-approve');
  assert.equal(parseCommand('!INK no')?.kind, 'ink-reject');
  assert.equal(parseCommand('!noink')?.kind, 'noink');
  assert.equal(parseCommand('!optout')?.kind, 'noink');
  assert.equal(parseCommand('hello !1'), null);
  const fitted = fitText('the quick brown fox jumps over the lazy dog again and again', 25);
  assert.ok(fitted.length <= 25 && fitted.endsWith('…'), fitted);
});

test('polls: Helix limits are enforced (question ≤60, 2–5 choices ≤25, 15–1800 s)', () => {
  assert.ok(POLL_QUESTION.length <= POLL_LIMITS.titleMax);
  assert.deepEqual(validatePoll({ title: POLL_QUESTION, choices: ['a', 'b'], duration: 45 }), []);
  assert.ok(validatePoll({ title: 'x'.repeat(61), choices: ['a', 'b'], duration: 45 }).length);
  assert.ok(validatePoll({ title: 'q', choices: ['a'], duration: 45 }).length);
  assert.ok(validatePoll({ title: 'q', choices: ['a', 'b', 'c', 'd', 'e', 'f'], duration: 45 }).length);
  assert.ok(validatePoll({ title: 'q', choices: ['a', 'x'.repeat(26)], duration: 45 }).length);
  assert.ok(validatePoll({ title: 'q', choices: ['a', 'b'], duration: 14 }).length);
  assert.ok(validatePoll({ title: 'q', choices: ['a', 'b'], duration: 1801 }).length);
});

test('polls: chat-vote fallback picks the bubble from real chat lines, latest vote per viewer counts', async () => {
  const { studio, engine, chat, seen, advance } = setup();
  studio.state.pendingPanels.push(panel('p1'));
  chat('ana', 'the dragon ate the dice');
  chat('ben', 'roll for initiative');
  chat('cy', 'we are so doomed');
  await flush();
  const poll = await engine.polls.start({ duration: 30 });
  assert.equal(poll.mode, 'chat');
  assert.equal(poll.choices.length, 3);
  const key = poll.choices.find(choice => choice.caption === 'roll for initiative')!.key;
  const other = poll.choices.find(choice => choice.key !== key)!.key;
  chat('v1', `!${other}`); chat('v1', `!${key}`); chat('v2', `!${key}`); chat('v3', `!${other}`);
  await flush();
  assert.equal(engine.polls.view()!.total, 3);
  advance(31_000); engine.tick();
  assert.equal(studio.state.pendingPanels[0]!.caption, 'roll for initiative');
  assert.equal(studio.state.pendingPanels[0]!.voters, 3);
  const result = seen.find(entry => entry.channel === 'poll-result')!.payload as { outcome: string; voters: number };
  assert.equal(result.outcome, 'applied'); assert.equal(result.voters, 3);
});

test('polls: Twitch poll when allowed, falling back to chat votes on a 403', async () => {
  const ok = setup({ twitchPolls: true });
  ok.studio.state.pendingPanels.push(panel('p1'));
  ok.chat('ana', 'line one'); ok.chat('ben', 'line two'); await flush();
  const poll = await ok.engine.polls.start();
  assert.equal(poll.mode, 'twitch');
  const call = ok.helix.calls.find(entry => entry.method === 'createPoll')!.input as { title: string; choices: { title: string }[]; duration: number };
  assert.equal(call.title, POLL_QUESTION); assert.equal(call.choices.length, 2); assert.equal(call.duration, 45);
  ok.bus.emit('stream-event', { t: 0, type: 'poll', poll: { id: poll.id, status: 'COMPLETED', choices: [{ title: 'line two', votes: 1 }, { title: 'line one', votes: 9 }] } } as ParticipationEvent);
  await flush();
  assert.equal(ok.studio.state.pendingPanels[0]!.caption, poll.choices[1]!.caption);

  const refused = setup({ twitchPolls: true }, { affiliate: false });
  refused.studio.state.pendingPanels.push(panel('p1'));
  refused.chat('ana', 'line one'); refused.chat('ben', 'line two'); await flush();
  const fallback = await refused.engine.polls.start();
  assert.equal(fallback.mode, 'chat');
  assert.match(fallback.fallbackReason!, /403/);
});

test('polls: a vote needs a pending panel and two lines, and pauses when the budget is used', async () => {
  const { studio, engine, chat } = setup({}, { budget: 0 });
  await assert.rejects(engine.polls.start(), /paused/);
  const roomy = setup();
  await assert.rejects(roomy.engine.polls.start(), /no panel/);
  roomy.studio.state.pendingPanels.push(panel('p1'));
  roomy.chat('ana', 'only one line'); await flush();
  await assert.rejects(roomy.engine.polls.start(), /two different lines/);
  void studio; void chat;
});

test('polls: flag off ignores !1 votes and the route says how to switch it on', async () => {
  const { studio, engine, chat } = setup({ polls: false });
  studio.state.pendingPanels.push(panel('p1'));
  chat('v1', '!1'); await flush();
  assert.equal(engine.polls.view(), undefined);
  assert.equal(engine.status().poll, null);
});

test('budget: rolling 12 panels per hour', () => {
  let clock = 0;
  const budget = new PanelBudget(12, () => clock);
  for (let index = 0; index < 12; index += 1) assert.ok(budget.take());
  assert.equal(budget.take(), false);
  assert.equal(budget.resetAt(), 3_600_000);
  clock = 3_600_001;
  assert.equal(budget.remaining(), 12);
});

test('Ink me: reward matches the lead decision and Twitch limits, created on connect', async () => {
  assert.deepEqual(validateReward(inkMeReward()), []);
  assert.equal(INK_ME.cost, 500); assert.equal(INK_ME.maxPerUserPerStream, 1); assert.equal(INK_ME.globalCooldownSeconds, 300);
  assert.ok(validateReward({ ...inkMeReward(), title: 'x'.repeat(46) }).length);
  const { bus, engine, helix } = setup();
  bus.emit('twitch-connected', {}); await flush();
  assert.equal(engine.rewards.status, 'ready');
  const created = helix.calls.find(entry => entry.method === 'createCustomReward')!.input as { cost: number; maxPerUserPerStream: number; globalCooldownSeconds: number };
  assert.equal(created.cost, 500); assert.equal(created.maxPerUserPerStream, 1); assert.equal(created.globalCooldownSeconds, 300);
  const off = setup({ inkMe: false });
  off.bus.emit('twitch-connected', {}); await flush();
  assert.equal(off.engine.rewards.status, 'idle');
  const notAffiliate = setup({}, { affiliate: false });
  notAffiliate.bus.emit('twitch-connected', {}); await flush();
  assert.equal(notAffiliate.engine.rewards.status, 'unavailable');
  assert.match(notAffiliate.engine.rewards.error!, /partner or affiliate/);
});

test('Ink me: a redemption drafts a cameo, then fulfils; repeats and cooldown refund', async () => {
  const { bus, engine, helix, studio, chat, advance, seen } = setup();
  bus.emit('twitch-connected', {}); await flush();
  const rewardId = engine.rewards.rewardId!;
  chat('u1', 'draw me as a wizard'); await flush();
  const redeem = (id: string, user: string) => bus.emit('stream-event', { t: 0, type: 'redemption', user, name: user, redemption: { id, rewardId, userLogin: user } } as ParticipationEvent);
  redeem('r1', 'u1'); await flush();
  const cameo = studio.state.pendingPanels.find(entry => entry.id === 'cameo-r1')!;
  assert.equal(cameo.cameo, 'u1'); assert.deepEqual(cameo.dialogue, ['draw me as a wizard']);
  assert.ok(cameo.caption.length <= 60);
  assert.ok(seen.some(entry => entry.channel === 'cameo'));
  await engine.rewards.resolve('r1', 'fulfil');
  assert.deepEqual(helix.calls.at(-1), { method: 'updateRedemptionStatus', input: { rewardId, redemptionIds: ['r1'], status: 'FULFILLED' } });
  redeem('r2', 'u2'); await flush(); // inside the 5-minute cooldown
  assert.equal(engine.rewards.redemptions.find(entry => entry.id === 'r2')!.status, 'canceled');
  advance(301_000);
  redeem('r3', 'u1'); await flush(); // second time this stream
  assert.match(engine.rewards.redemptions.find(entry => entry.id === 'r3')!.note, /1 per viewer per stream/);
  redeem('r1', 'u1'); await flush(); // replayed event is ignored
  assert.equal(engine.rewards.redemptions.filter(entry => entry.id === 'r1').length, 1);
  redeem('r4', 'u4'); await flush();
  await engine.rewards.resolve('r4', 'cancel');
  assert.equal(studio.state.pendingPanels.some(entry => entry.id === 'cameo-r4'), false);
  assert.equal((helix.calls.at(-1)!.input as { status: string }).status, 'CANCELED');
});

test('Ink me: with the panel budget used, redemptions wait unfulfilled and are drafted later', async () => {
  const { bus, engine, studio, advance } = setup({}, { budget: 1 });
  bus.emit('twitch-connected', {}); await flush();
  engine.budget.take();
  bus.emit('stream-event', { t: 0, type: 'redemption', user: 'u1', name: 'u1', redemption: { id: 'r1', rewardId: engine.rewards.rewardId!, userLogin: 'u1' } } as ParticipationEvent);
  await flush();
  assert.equal(engine.rewards.redemptions[0]!.status, 'queued');
  assert.equal(studio.state.pendingPanels.length, 0);
  advance(3_600_001); engine.tick();
  assert.equal(engine.rewards.redemptions[0]!.status, 'drafted');
  assert.equal(studio.state.pendingPanels[0]!.id, 'cameo-r1');
});

test('catch-up: !previously and raids go out on the bus for S3, with cooldown and raid debounce', async () => {
  const { bus, chat, seen, advance, helix } = setup();
  chat('ana', '!previously'); chat('ben', '!previously'); await flush();
  let catchups = seen.filter(entry => entry.channel === 'catchup').map(entry => entry.payload as { reason: string; requestedBy?: string; raider?: string; viewers?: number });
  assert.equal(catchups.length, 1); assert.equal(catchups[0]!.reason, 'command'); assert.equal(catchups[0]!.requestedBy, 'ana');
  assert.ok(helix.calls.some(entry => entry.method === 'sendChatMessage'));
  bus.emit('stream-event', { t: 0, type: 'raid', from: 'friendly', viewers: 42 }); bus.emit('stream-event', { t: 0, type: 'raid', from: 'friendly', viewers: 42 }); await flush();
  catchups = seen.filter(entry => entry.channel === 'catchup').map(entry => entry.payload as { reason: string; raider?: string; viewers?: number });
  assert.equal(catchups.length, 2); assert.equal(catchups[1]!.raider, 'friendly'); assert.equal(catchups[1]!.viewers, 42);
  advance(61_000); chat('ben', '!previously'); await flush();
  assert.equal(seen.filter(entry => entry.channel === 'catchup').length, 3);
  const off = setup({ catchup: false });
  off.chat('ana', '!previously'); off.bus.emit('stream-event', { t: 0, type: 'raid', from: 'x' }); await flush();
  assert.equal(off.seen.filter(entry => entry.channel === 'catchup').length, 0);
});

test('hype train: next new panel becomes the splash and a prediction opens within limits', async () => {
  assert.deepEqual(validatePrediction({ title: HYPE_PREDICTION.title, outcomes: [...HYPE_PREDICTION.outcomes], window: HYPE_PREDICTION.window }), []);
  assert.ok(validatePrediction({ title: 'q', outcomes: ['a'], window: 60 }).length);
  assert.ok(validatePrediction({ title: 'q', outcomes: ['a', 'b'], window: 29 }).length);
  const { bus, engine, studio, helix, seen } = setup();
  studio.state.pendingPanels.push(panel('old'));
  bus.emit('stream-event', { t: 0, type: 'hype', level: 2, phase: 'begin' } as ParticipationEvent); await flush();
  assert.ok(seen.some(entry => entry.channel === 'hype-splash'));
  const created = helix.calls.find(entry => entry.method === 'createPrediction')!.input as { title: string; predictionWindow: number };
  assert.equal(created.title, 'Will they make it?'); assert.equal(created.predictionWindow, 120);
  engine.tick();
  assert.equal(seen.some(entry => entry.channel === 'panel-splash'), false, 'panels from before the train are not splashed');
  studio.state.pendingPanels.push(panel('new', 5)); engine.tick();
  assert.deepEqual(seen.find(entry => entry.channel === 'panel-splash')!.payload, { panelId: 'new', level: 2 });
});

test('prediction: the resolved outcome becomes the next panel\u2019s punchline', async () => {
  assert.equal(punchlineFor('Yes', 12), 'THEY MADE IT! 12 called it.');
  assert.equal(punchlineFor('No'), 'NOT THIS TIME…');
  const { bus, engine, studio, seen } = setup();
  bus.emit('stream-event', { t: 0, type: 'hype_train_begin', level: 1 }); await flush();
  const prediction = engine.hype.prediction!;
  bus.emit('stream-event', { t: 0, type: 'hype', prediction: { id: prediction.id, status: 'RESOLVED', winningOutcomeId: prediction.outcomes[0]!.id, outcomes: [{ id: prediction.outcomes[0]!.id, title: 'Yes', users: 7 }, { id: prediction.outcomes[1]!.id, title: 'No', users: 3 }] } } as ParticipationEvent);
  await flush();
  assert.equal(engine.hype.prediction!.winner, 'Yes');
  studio.state.pendingPanels.push(panel('after', 9)); engine.tick();
  assert.equal(studio.state.pendingPanels[0]!.caption, 'THEY MADE IT! 7 called it.');
  assert.ok(seen.some(entry => entry.channel === 'punchline'));
});

test('director: only mods and the broadcaster can !ink yes / no, oldest panel first', async () => {
  const { studio, chat, advance, engine } = setup();
  studio.state.pendingPanels.push(panel('b', 20), panel('a', 10));
  chat('viewer', '!ink yes'); await flush();
  assert.deepEqual(studio.log, []);
  chat('mod1', '!ink yes', { moderator: true }); await flush();
  assert.deepEqual(studio.log, ['approve:a']);
  chat('mod2', '!ink no', { moderator: true }); await flush();
  assert.deepEqual(studio.log, ['approve:a'], 'debounced');
  advance(2_500); chat('boss', '!ink no', { broadcaster: true }); await flush();
  assert.deepEqual(studio.log, ['approve:a', 'reject:b']);
  assert.throws(() => engine.director.phone('approve', 'gone'), /no longer waiting/);
  const off = setup({ director: false });
  off.studio.state.pendingPanels.push(panel('a'));
  off.chat('mod1', '!ink yes', { moderator: true }); await flush();
  assert.deepEqual(off.studio.log, []);
});

test('!noink: opted-out viewers are never quoted in a vote, cameo\u2019d, or named', async () => {
  const { bus, engine, studio, chat, seen, helix } = setup();
  bus.emit('twitch-connected', {}); await flush();
  studio.state.pendingPanels.push(panel('p1'));
  chat('shy', 'please do not draw me'); chat('ana', 'line a'); chat('ben', 'line b'); await flush();
  chat('shy', '!noink'); await flush();
  assert.ok(helix.calls.some(entry => entry.method === 'sendChatMessage' && /Opt-out noted/.test((entry.input as { message: string }).message)));
  const poll = await engine.polls.start();
  assert.equal(poll.choices.some(choice => /draw me/.test(choice.caption)), false);
  bus.emit('stream-event', { t: 0, type: 'redemption', user: 'shy', name: 'shy', redemption: { id: 'r1', rewardId: engine.rewards.rewardId!, userLogin: 'shy' } } as ParticipationEvent);
  await flush();
  assert.equal(engine.rewards.redemptions[0]!.status, 'canceled');
  assert.equal(engine.rewards.view().redemptions[0]!.name, 'Opted-out viewer');
  assert.equal(studio.state.pendingPanels.some(entry => entry.cameo === 'shy'), false);
  chat('shy', '!previously'); await flush();
  assert.equal((seen.find(entry => entry.channel === 'catchup')!.payload as { requestedBy?: string }).requestedBy, undefined);
});

test('!noink after redeeming or while their line is on the ballot removes them', async () => {
  const { bus, engine, studio, chat, advance } = setup();
  bus.emit('twitch-connected', {}); await flush();
  bus.emit('stream-event', { t: 0, type: 'redemption', user: 'u1', name: 'u1', redemption: { id: 'r1', rewardId: engine.rewards.rewardId!, userLogin: 'u1' } } as ParticipationEvent);
  await flush();
  assert.ok(studio.state.pendingPanels.some(entry => entry.id === 'cameo-r1'));
  chat('ana', 'winner line'); chat('ben', 'other line'); await flush();
  const poll = await engine.polls.start({ panelId: 'cameo-r1', duration: 15 });
  void poll;
  chat('u1', '!noink'); await flush(); await flush();
  assert.equal(studio.state.pendingPanels.some(entry => entry.id === 'cameo-r1'), false);
  assert.equal(engine.rewards.redemptions[0]!.status, 'canceled');
  // Ballot author opts out mid-vote: their line is withdrawn and never lettered.
  studio.state.pendingPanels.push(panel('p2'));
  advance(20_000); engine.tick();
  const second = await engine.polls.start({ panelId: 'p2', duration: 15 });
  const anaKey = second.choices.find(choice => choice.caption === 'winner line')!.key;
  chat('v1', `!${anaKey}`); chat('ana', '!noink'); await flush();
  assert.equal(engine.polls.view()!.choices.find(choice => choice.key === anaKey)!.caption, 'Withdrawn');
  advance(16_000); engine.tick();
  assert.notEqual(studio.state.pendingPanels.find(entry => entry.id === 'p2')!.caption, 'winner line');
});

test('opt-out ledger is sticky, case-insensitive and fails closed when full', () => {
  const ledger = new OptOutLedger(2);
  ledger.add('1', 'Ana');
  assert.ok(ledger.has(undefined, 'ana'));
  assert.ok(ledger.has('1'));
  ledger.add('2', 'b'); ledger.add('3', 'c');
  assert.ok(ledger.has('999', 'stranger'), 'past capacity everyone is treated as opted out');
});

test('flags: every feature defaults off except the !noink acknowledgement', () => {
  const flags = readParticipationFlags({});
  assert.deepEqual(flags, { polls: false, twitchPolls: false, inkMe: false, catchup: false, hype: false, director: false, noink: true, botReplies: false });
  assert.equal(readParticipationFlags({ COMICTOONS_FLAG_POLLS: 'on', COMICTOONS_FLAG_NOINK: '0' }).polls, true);
  assert.equal(readParticipationFlags({ COMICTOONS_FLAG_NOINK: '0' }).noink, false);
});

test('routes: status, flag-off 404s and director actions over HTTP on the mock Helix', async () => {
  const studio = new Studio();
  const bus = createEventBus<ComicToonsBusEvents>();
  const offApp = Fastify();
  await offApp.register(participationRoutes, { studio, eventBus: bus, env: {} });
  const status = await offApp.inject({ method: 'GET', url: '/api/participation/status' });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().received, 0);
  const blocked = await offApp.inject({ method: 'POST', url: '/api/participation/polls', payload: {} });
  assert.equal(blocked.statusCode, 404); assert.match(blocked.json().error, /COMICTOONS_FLAG_POLLS=1/);
  assert.equal((await offApp.inject({ method: 'POST', url: '/api/participation/mock-event', payload: { type: 'chat' } })).statusCode, 404);
  await offApp.close();

  const onBus = createEventBus<ComicToonsBusEvents>();
  const app = Fastify();
  await app.register(participationRoutes, { studio, eventBus: onBus, env: { COMICTOONS_FLAG_DIRECTOR: '1', COMICTOONS_FLAG_INK_ME: '1', COMICTOONS_PARTICIPATION_MOCK: '1' } });
  studio.state.pendingPanels.push(panel('route-a', 1));
  const view = await app.inject({ method: 'GET', url: '/api/participation/director' });
  assert.equal(view.json().enabled, true); assert.equal(view.json().pending[0].id, 'route-a');
  const approved = await app.inject({ method: 'POST', url: '/api/participation/director/approve', payload: { panelId: 'route-a' } });
  assert.equal(approved.statusCode, 200);
  assert.ok(studio.state.panels.some(entry => entry.id === 'route-a'));
  const stale = await app.inject({ method: 'POST', url: '/api/participation/director/reject', payload: { panelId: 'route-a' } });
  assert.equal(stale.statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/participation/mock-connect' })).statusCode, 200);
  await flush();
  assert.equal((await app.inject({ method: 'GET', url: '/api/participation/status' })).json().reward.status, 'ready');
  await app.close();
});
