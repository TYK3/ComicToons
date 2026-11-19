import assert from 'node:assert/strict';
import test from 'node:test';
import { Studio } from '../apps/server/src/studio.ts';
import { MomentDetector } from '../apps/server/src/pipeline/moments.ts';
import { eventBus } from '../packages/core/src/index.ts';
import type { StreamEvent } from '../packages/core/src/index.ts';
import { createDirectAdapter } from '../scripts/s2-replay-core.ts';

/** Every in-memory record the studio keeps about chat: per-minute chat drafts, moment drafts
 * (snapshot and the detector's live object) and the detector's own windows and history. */
function memory(studio: Studio): string {
  const inner = studio as unknown as {
    liveDrafts: Map<string, unknown>; momentDrafts: Map<string, unknown>;
    moments: { open?: unknown; completed: unknown[]; recentChat: unknown[]; tokenUses: unknown[] };
  };
  return JSON.stringify({
    liveDrafts: [...inner.liveDrafts], momentDrafts: [...inner.momentDrafts],
    open: inner.moments.open, completed: inner.moments.completed, recentChat: inner.moments.recentChat, tokenUses: inner.moments.tokenUses,
  });
}
const panelsOf = (studio: Studio) => [...studio.state.panels, ...studio.state.pendingPanels];
const shown = (studio: Studio) => JSON.stringify(panelsOf(studio));

function liveStudio(channel: string) {
  const direct = createDirectAdapter();
  let clock = 0;
  const studio = new Studio({ now: () => clock, adapterFactory: () => direct.adapter});
  studio.useSource('twitch', channel);
  const irc = (event: StreamEvent) => { clock = event.t * 1000; direct.push(event); };
  return { studio, irc };
}
const chat = (id: string, user: string, text: string, t: number): StreamEvent => ({ id, t, type: 'chat', user, name: user, text });

test('B2-CLEARMSG-01: a deleted line is removed from in-memory moment and panel source records, not just marked', () => {
  const { studio, irc } = liveStudio('clear_channel');
  try {
    irc(chat('a1', 'ann', 'KEKW line-from-ann', 1));
    irc(chat('b1', 'bob', 'KEKW line-from-bob', 2));
    irc(chat('c1', 'cat', 'KEKW line-from-cat', 3));
    irc(chat('d1', 'dan', 'KEKW line-from-dan', 4));
    const burst = panelsOf(studio).find((panel) => panel.sfx === 'SURGE!');
    assert.ok(burst, 'the KEKW burst opened a moment panel');
    assert.ok(memory(studio).includes('line-from-bob') && memory(studio).includes('"b1"'), 'the line is recorded before the delete');
    irc({ id: 'clr1', t: 5, type: 'chat', text: '', withdraw: 'message', targetId: 'b1', moderator: true });
    assert.ok(!memory(studio).includes('line-from-bob'), 'the deleted text is gone from every in-memory record');
    assert.ok(!memory(studio).includes('"b1"'), 'the deleted message id is gone too (no withdrawn marker is kept)');
    assert.ok(!shown(studio).includes('line-from-bob'), 'no panel quotes it');
    for (const panel of panelsOf(studio)) assert.ok(!(panel.sources ?? []).includes('b1'), `${panel.id} no longer cites it as a source`);
    assert.ok(shown(studio).includes('line-from-ann') && shown(studio).includes('line-from-cat'), 'other lines stay');
  } finally { studio.close(); }
});

test('B2-CLEARUSER-01: a targeted clear (withdraw "user") drops only that chatter\u2019s lines; other users are kept; it is not an opt-out', () => {
  const { studio, irc } = liveStudio('clearuser_channel');
  try {
    irc(chat('a1', 'ann', 'KEKW ann-one', 1));
    irc(chat('b1', 'bob', 'KEKW bob-one', 2));
    irc(chat('c1', 'cat', 'KEKW cat-one', 3));
    irc(chat('b2', 'bob', 'bob-two again', 4));
    assert.ok(memory(studio).includes('bob-one') && memory(studio).includes('bob-two'));
    // EventSub channel.chat.clear_user_messages arrives on the bus in the core withdraw-by-user shape.
    eventBus.emit('stream-event', { id: 'clear-bob', t: 5, type: 'chat', withdraw: 'user', targetUser: 'bob', moderator: true });
    for (const text of ['bob-one', 'bob-two']) {
      assert.ok(!memory(studio).includes(text), `${text} is deleted from in-memory records`);
      assert.ok(!shown(studio).includes(text), `${text} is no longer quoted`);
    }
    assert.ok(!/"b1"|"b2"/.test(memory(studio)), 'bob\u2019s message ids are gone from in-memory records');
    for (const text of ['ann-one', 'cat-one']) assert.ok(shown(studio).includes(text) && memory(studio).includes(text), `${text} (another user) is kept`);
    irc(chat('b3', 'bob', 'bob-later line', 70));
    assert.ok(shown(studio).includes('bob-later line'), 'a clear is not an opt-out: bob\u2019s later lines can be quoted');
  } finally { studio.close(); }
});

test('B2-SOURCE-01: the same chat message via EventSub (bus) and IRC is counted and quoted once, in either order', () => {
  for (const order of ['bus-first', 'irc-first'] as const) {
    const { studio, irc } = liveStudio(`dedupe_${order.replace('-', '_')}`);
    try {
      irc(chat('warm', 'ann', 'hello there', 1));
      // The live session (and its detector) starts with the first IRC line; watch that detector.
      const counted: string[] = [];
      const detector = (studio as unknown as { moments: MomentDetector }).moments;
      const ingest = detector.ingest.bind(detector);
      detector.ingest = (event: StreamEvent) => { counted.push(event.id ?? ''); return ingest(event); };
      const line = chat('same-1', 'bob', 'only once please', 2);
      const viaBus = () => eventBus.emit('stream-event', { ...line });
      const viaIrc = () => irc({ ...line });
      if (order === 'bus-first') { viaBus(); viaIrc(); } else { viaIrc(); viaBus(); }
      assert.deepEqual(counted.filter((id) => id === 'same-1'), ['same-1'], `${order}: the detector counts the line once`);
      const quoted = panelsOf(studio).flatMap((panel) => panel.dialogue).filter((text) => text === 'only once please');
      assert.equal(quoted.length, 1, `${order}: the line is quoted once`);
    } finally { studio.close(); }
  }
});

test('B2-EVENTSUB-01: an EventSub-connected session is live Twitch: raids, cheers, bits, hype, redemptions and predictions open panels', () => {
  const studio = new Studio({});
  try {
    eventBus.emit('stream-event', { id: 'pre-raid', t: 1, type: 'raid', from: 'early_crew', viewers: 20 });
    assert.equal(studio.state.source?.active, 'sample', 'before EventSub connects, bus signals stay out of the sample issue');
    assert.ok(!shown(studio).includes('early_crew'));
    eventBus.emit('twitch-connected', { source: 'eventsub', channel: 'eventsub_channel' });
    assert.equal(studio.state.source?.active, 'twitch', 'EventSub alone makes the session live Twitch');
    assert.equal(studio.state.status, 'live');
    assert.equal(panelsOf(studio).length, 0, 'the live issue starts empty (no sample panels mixed in)');
    const signals: StreamEvent[] = [
      { id: 'es-raid', t: 10, type: 'raid', from: 'big_crew', viewers: 120 },
      { id: 'es-cheer', t: 100, type: 'cheer', user: 'gem', name: 'gem', text: 'cheer100 go' },
      { id: 'es-bits', t: 200, type: 'bits', user: 'gem2', name: 'gem2', text: 'bits 50' },
      { id: 'es-hype', t: 300, type: 'hype', level: 2 },
      { id: 'es-redeem', t: 400, type: 'redemption', user: 'pat', name: 'pat', text: 'Hydrate' },
      { id: 'es-predict', t: 500, type: 'prediction', text: 'Will we win?' },
    ];
    for (const signal of signals) eventBus.emit('stream-event', signal);
    const sfx = panelsOf(studio).map((panel) => panel.sfx);
    assert.equal(panelsOf(studio).length, signals.length, `one panel per signal (got ${JSON.stringify(sfx)})`);
    for (const want of ['RAID!', 'CHEER!', 'HYPE!', 'INK!', 'VOTE!']) assert.ok(sfx.includes(want), `${want} panel opened`);
    assert.equal(sfx.filter((value) => value === 'CHEER!').length, 2, 'bits open a cheer panel');
    eventBus.emit('stream-event', chat('es-chat', 'viewer', 'eventsub chat line', 520));
    assert.ok(shown(studio).includes('eventsub chat line'), 'EventSub chat is quoted while it is the chat source');
    eventBus.emit('twitch-disconnected', { source: 'eventsub', channel: 'eventsub_channel' });
    assert.equal(studio.state.source?.active, 'sample', 'with IRC idle, an EventSub disconnect falls back to Sample Data');
  } finally { studio.close(); }
});

test('B2-EVENTSUB-02: an IRC drop does not end a session that EventSub still carries', () => {
  const { studio, irc } = liveStudio('both_channel');
  try {
    irc(chat('x1', 'ann', 'first line', 1));
    eventBus.emit('twitch-connected', { source: 'eventsub', channel: 'both_channel' });
    studio.useSource('sample');
    assert.equal(studio.state.source?.active, 'twitch', 'still live through EventSub');
    assert.ok(shown(studio).includes('first line'), 'the live issue is kept');
    eventBus.emit('twitch-disconnected', { source: 'eventsub' });
    assert.equal(studio.state.source?.active, 'sample');
  } finally { studio.close(); }
});

test('B2-MOMENTS-FORGET: MomentDetector.forget deletes matching records from the open moment, history and windows', () => {
  const detector = new MomentDetector({ burstMinUsers: 2 });
  detector.ingest(chat('1', 'a', 'KEKW one', 1));
  const opened = detector.ingest(chat('2', 'b', 'KEKW two', 2));
  assert.ok(opened);
  detector.ingest(chat('3', 'c', 'plain three', 3));
  assert.equal(detector.forget((event) => event.user === 'b'), 3, 'the open moment, the spike window and the burst window each held it');
  assert.deepEqual(detector.current()!.events.map((event) => event.id), ['1', '3']);
  assert.deepEqual(detector.current()!.sourceIds, ['1', '3']);
  detector.close();
  assert.equal(detector.forget((event) => event.id === '3'), 2, 'finalised moments are pruned too');
  assert.deepEqual(detector.completedMoments()[0]!.events.map((event) => event.id), ['1']);
});

test('B2-TIMEOUT-01: a targeted CLEARCHAT with a ban duration (a timeout) removes that user\u2019s lines but is NOT an opt-out', () => {
  for (const path of ['irc', 'bus'] as const) {
    const { studio, irc } = liveStudio(`timeout_${path}`);
    try {
      irc(chat('a1', 'ann', 'KEKW ann-keeps', 1));
      irc(chat('t1', 'tim', 'KEKW tim-before', 2));
      irc(chat('c1', 'cat', 'KEKW cat-keeps', 3));
      assert.ok(memory(studio).includes('tim-before'));
      assert.ok(panelsOf(studio).some((panel) => panel.sfx === 'SURGE!'), `${path}: the KEKW burst opened a moment draft quoting tim`);
      const timeout: StreamEvent = { id: `clearchat-${path}`, t: 4, type: 'chat', text: '', withdraw: 'user', targetUser: 'tim', banDuration: 600, moderator: true };
      if (path === 'irc') irc(timeout); else eventBus.emit('stream-event', timeout);
      assert.ok(!memory(studio).includes('tim-before') && !memory(studio).includes('"t1"'), `${path}: tim\u2019s line is deleted from in-memory moment drafts and records`);
      assert.ok(!shown(studio).includes('tim-before'), `${path}: no panel quotes tim\u2019s cleared line`);
      assert.ok(shown(studio).includes('ann-keeps') && shown(studio).includes('cat-keeps'), `${path}: other users are kept`);
      const denied = (studio as unknown as { deniedUsers: Set<string> }).deniedUsers;
      assert.equal(denied.has('tim'), false, `${path}: a timeout does not opt tim out`);
      irc(chat('t2', 'tim', 'tim-after the timeout', 70));
      assert.ok(shown(studio).includes('tim-after the timeout'), `${path}: tim\u2019s later lines can still appear`);
    } finally { studio.close(); }
  }
});

test('B2-TIMEOUT-02: only an explicit command opts out; a moderator\u2019s empty or non-command event never does', () => {
  const { studio, irc } = liveStudio('explicit_only');
  try {
    const denied = (studio as unknown as { deniedUsers: Set<string> }).deniedUsers;
    irc({ id: 'm-clear', t: 1, type: 'chat', text: '', withdraw: 'user', targetUser: 'zed', moderator: true });
    irc({ id: 'm-clear-ban', t: 2, type: 'chat', text: '', withdraw: 'user', targetUser: 'zed', banDuration: 86400, moderator: true });
    assert.equal(denied.has('zed'), false, 'clears and bans never land in the opt-out set');
    irc(chat('z1', 'zed', '!optout', 3));
    assert.equal(denied.has('zed'), true, 'the explicit !optout does');
  } finally { studio.close(); }
});
