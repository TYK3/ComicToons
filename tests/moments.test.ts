import assert from 'node:assert/strict';
import test from 'node:test';
import { MomentDetector } from '../apps/server/src/pipeline/moments.ts';
import type { StreamEvent } from '../packages/core/src/index.ts';

function chat(t: number, user: string, text: string, id?: string): StreamEvent {
  return { id: id ?? `${user}-${t}`, t, type: 'chat', user, name: user, text };
}

test('MOMENTS-01: below threshold chat never opens a moment', () => {
  const detector = new MomentDetector();
  for (let i = 0; i < 5; i++) assert.equal(detector.ingest(chat(i, `viewer-${i}`, 'hello there')), undefined);
  assert.equal(detector.current(), undefined);
  assert.equal(detector.completedMoments().length, 0);
});

test('MOMENTS-02: a chat velocity spike over the trailing baseline opens exactly one moment', () => {
  const detector = new MomentDetector({ spikeMinCount: 6, spikeWindowSeconds: 10, spikeWarmupSeconds: 0 });
  const opens: number[] = [];
  for (let i = 0; i < 6; i++) {
    const moment = detector.ingest(chat(i, `viewer-${i}`, `line ${i}`));
    if (moment) opens.push(i);
  }
  assert.equal(opens.length, 1);
  assert.equal(detector.current()?.kind, 'spike');
  assert.ok(detector.current()!.events.length >= 1);
});

test('MOMENTS-03: an emote burst needs distinct users, not just repeated messages from one user', () => {
  const detector = new MomentDetector({ burstMinUsers: 3, burstWindowSeconds: 8, spikeMinCount: 999 });
  assert.equal(detector.ingest(chat(0, 'a', 'KEKW')), undefined);
  assert.equal(detector.ingest(chat(1, 'a', 'KEKW')), undefined, 'the same user repeating the emote is not a burst');
  assert.equal(detector.ingest(chat(2, 'b', 'KEKW')), undefined);
  const opened = detector.ingest(chat(3, 'c', 'KEKW'));
  assert.ok(opened, 'a third distinct user opens the burst');
  assert.equal(opened!.kind, 'burst');
});

test('MOMENTS-04: strong signals (raid, cheer, hype, legacy hype_train_begin, redemption, poll, clip) open immediately', () => {
  const kinds: StreamEvent['type'][] = ['raid', 'cheer', 'hype', 'hype_train_begin', 'redemption', 'poll', 'clip'];
  for (const type of kinds) {
    const detector = new MomentDetector();
    const moment = detector.ingest({ id: 'e1', t: 0, type, from: 'Crew', viewers: 10 });
    assert.ok(moment, `${type} should open a moment immediately`);
    assert.equal(moment!.kind, type === 'hype_train_begin' ? 'hype' : type);
  }
});

test('MOMENTS-05: strong signals bypass cooldown even right after a spike or burst', () => {
  const detector = new MomentDetector({ spikeMinCount: 3, spikeWindowSeconds: 10, cooldownSeconds: 30, spikeWarmupSeconds: 0 });
  for (let i = 0; i < 3; i++) detector.ingest(chat(i, `viewer-${i}`, `line ${i}`));
  assert.equal(detector.current()?.kind, 'spike');
  const raid = detector.ingest({ id: 'raid-1', t: 3, type: 'raid', from: 'MoonlightCrew', viewers: 40 });
  assert.ok(raid, 'a raid opens a new moment even while a cooldown is active');
  assert.equal(raid!.kind, 'raid');
});

test('MOMENTS-06: a cooldown keeps one burst from reopening a moment on every qualifying message, then allows the next one', () => {
  const detector = new MomentDetector({ spikeMinCount: 4, spikeWindowSeconds: 10, baselineWindowSeconds: 20, cooldownSeconds: 15, idleCloseSeconds: 5, spikeWarmupSeconds: 0 });
  const opened: number[] = [];
  for (let i = 0; i < 4; i++) if (detector.ingest(chat(i, `viewer-${i}`, `line ${i}`))) opened.push(i);
  assert.deepEqual(opened, [3]);
  for (let i = 4; i < 10; i++) if (detector.ingest(chat(i, `viewer-${i}`, `line ${i}`))) opened.push(i);
  assert.deepEqual(opened, [3], 'sustained chat during the cooldown must not reopen a second moment');
  detector.closeIfIdle(50);
  for (let i = 50; i < 56; i++) if (detector.ingest(chat(i, `viewer-${i}`, `line ${i}`))) opened.push(i);
  assert.equal(opened.length, 2, 'once the cooldown and idle window have passed, a new burst opens a second moment');
});

test('MOMENTS-07: an idle moment closes and is recorded in completedMoments()', () => {
  const detector = new MomentDetector({ idleCloseSeconds: 10 });
  detector.ingest({ id: 'raid-1', t: 0, type: 'raid', from: 'Crew', viewers: 5 });
  assert.equal(detector.completedMoments().length, 0);
  const closed = detector.closeIfIdle(11);
  assert.equal(closed?.kind, 'raid');
  assert.equal(detector.current(), undefined);
  assert.equal(detector.completedMoments().length, 1);
});

test('MOMENTS-08: each event records its id so a moment can cite its sources', () => {
  const detector = new MomentDetector();
  const moment = detector.ingest({ id: 'raid-1', t: 0, type: 'raid', from: 'Crew', viewers: 5 });
  assert.deepEqual(moment!.sourceIds, ['raid-1']);
});

test('MOMENTS-09: a moment that never goes idle still has a bounded memory footprint', () => {
  const detector = new MomentDetector({ maxEventsPerMoment: 20 });
  detector.ingest({ id: 'raid-0', t: 0, type: 'raid', from: 'Crew', viewers: 5 });
  for (let i = 1; i < 500; i++) detector.ingest({ id: `raid-${i}`, t: i, type: 'raid', from: 'Crew', viewers: 5 });
  const open = detector.current()!;
  assert.ok(open.events.length <= 20);
  assert.ok(open.sourceIds.length <= 20);
  assert.equal(open.endAt, 499);
});

test('MOMENTS-10: no spike opens during the warm-up, before a baseline exists', () => {
  const detector = new MomentDetector();
  for (let i = 0; i < 12; i++) assert.equal(detector.ingest(chat(i * 0.5, `viewer-${i}`, `line ${i}`)), undefined);
});

test('MOMENTS-11: one user flooding chat is not a crowd spike', () => {
  const detector = new MomentDetector({ spikeWarmupSeconds: 0 });
  for (let i = 0; i < 30; i++) assert.equal(detector.ingest(chat(i * 0.2, 'solo', `line ${i}`, `solo-${i}`)), undefined);
});

test('MOMENTS-12: spike and burst moments cite the lines that made them and a burst records its token', () => {
  const spikes = new MomentDetector({ spikeMinCount: 6, spikeWarmupSeconds: 0 });
  let spike;
  for (let i = 0; i < 6; i++) spike = spikes.ingest(chat(i, `viewer-${i}`, `line ${i}`)) ?? spike;
  assert.equal(spike?.kind, 'spike');
  assert.deepEqual(spike!.sourceIds, ['viewer-0-0', 'viewer-1-1', 'viewer-2-2', 'viewer-3-3', 'viewer-4-4', 'viewer-5-5']);
  assert.equal(spike!.startAt, 0);
  const bursts = new MomentDetector({ burstMinUsers: 3, spikeMinCount: 999 });
  bursts.ingest(chat(0, 'a', 'KEKW', 'k-a'));
  bursts.ingest(chat(1, 'b', 'hello', 'h-b'));
  bursts.ingest(chat(2, 'b', 'kekw lol', 'k-b'));
  const burst = bursts.ingest(chat(3, 'c', 'KEKW KEKW', 'k-c'));
  assert.equal(burst?.kind, 'burst');
  assert.equal(burst!.token, 'kekw');
  assert.deepEqual(burst!.sourceIds, ['k-a', 'k-b', 'k-c']);
});

test('MOMENTS-13: with the default config, the same surge that is ignored during the warm-up opens a spike once the warm-up has passed', () => {
  const quiet = (detector: MomentDetector, until: number) => {
    for (let t = 0; t <= until; t += 5) assert.equal(detector.ingest(chat(t, `regular-${t}`, `steady chat ${t}`)), undefined);
  };
  const surge = (detector: MomentDetector, start: number) => {
    const opened: { t: number; kind: string; startAt: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const t = start + i * 0.25;
      const moment = detector.ingest(chat(t, `crowd-${i % 6}`, `surge line ${i}`, `surge-${start}-${i}`));
      if (moment) opened.push({ t, kind: moment.kind, startAt: moment.startAt });
    }
    return opened;
  };
  const early = new MomentDetector();
  quiet(early, 15);
  assert.deepEqual(surge(early, 20), [], 'twenty seconds in, the warm-up still holds the surge back');

  const late = new MomentDetector();
  quiet(late, 30);
  const opened = surge(late, 31);
  assert.equal(opened.length, 1, 'exactly one spike opens for the surge');
  assert.equal(opened[0]!.kind, 'spike');
  assert.ok(opened[0]!.t >= 30, 'it opens only after the thirty-second warm-up');
  assert.ok(opened[0]!.t < 34, 'and it opens during the surge itself, not later');
  assert.ok(late.current()!.events.some((event) => event.id?.startsWith('surge-31-')), 'the spike cites the surge lines');
});

test('MOMENTS-14: a burst made only of withdrawn lines triggers no moment', () => {
  const config = { burstMinUsers: 3, burstWindowSeconds: 8, spikeMinCount: 999 };
  const control = new MomentDetector(config);
  control.ingest(chat(0, 'a', 'POG', 'p-a'));control.ingest(chat(1, 'b', 'POG', 'p-b'));
  assert.equal(control.ingest(chat(2, 'c', 'POG', 'p-c'))?.kind, 'burst', 'control: three distinct users burst');
  const detector = new MomentDetector(config);
  detector.ingest(chat(0, 'a', 'POG', 'p-a'));detector.ingest(chat(1, 'b', 'POG', 'p-b'));
  detector.forget(['p-a', 'p-b']);
  assert.equal(detector.ingest(chat(2, 'c', 'POG', 'p-c')), undefined);
  assert.equal(detector.ingest(chat(3, 'd', 'POG', 'p-d')), undefined);
  assert.equal(detector.current(), undefined);
  // Live lines still count: a third distinct live user completes a real burst.
  const moment = detector.ingest(chat(4, 'e', 'POG', 'p-e'));
  assert.equal(moment?.kind, 'burst');
  assert.deepEqual(moment!.sourceIds, ['p-c', 'p-d', 'p-e']);
});

test('MOMENTS-15: withdrawn lines stop counting towards the chat spike window and the baseline', () => {
  const config = { spikeMinCount: 6, spikeMinUsers: 3, spikeWindowSeconds: 10, spikeWarmupSeconds: 0, burstMinUsers: 999 };
  const control = new MomentDetector(config);
  for (let i = 0; i < 5; i++) control.ingest(chat(i, `viewer-${i}`, `line ${i}`, `s-${i}`));
  assert.equal(control.ingest(chat(5, 'viewer-5', 'line 5', 's-5'))?.kind, 'spike', 'control: six lines spike');
  const detector = new MomentDetector(config);
  for (let i = 0; i < 5; i++) detector.ingest(chat(i, `viewer-${i}`, `line ${i}`, `s-${i}`));
  detector.forget(new Set(['s-0', 's-1', 's-2', 's-3', 's-4']));
  assert.equal(detector.ingest(chat(5, 'viewer-5', 'line 5', 's-5')), undefined);
  for (let i = 6; i < 10; i++) assert.equal(detector.ingest(chat(i, `viewer-${i}`, `line ${i}`, `s-${i}`)), undefined);
  const moment = detector.ingest(chat(10, 'viewer-10', 'line 10', 's-10'));
  assert.equal(moment?.kind, 'spike');
  assert.ok(moment!.sourceIds.every((id) => Number(id.slice(2)) >= 5), 'the spike cites live lines only');
});

test('MOMENTS-16: forgetUser drops an opted-out user from every window; unknown ids are ignored', () => {
  const detector = new MomentDetector({ burstMinUsers: 3, burstWindowSeconds: 8, spikeMinCount: 999 });
  detector.ingest(chat(0, 'a', 'GG', 'g-a1'));detector.ingest(chat(0.5, 'a', 'GG', 'g-a2'));detector.ingest(chat(1, 'b', 'GG', 'g-b'));
  detector.forgetUser('a');detector.forget(['never-seen']);
  assert.equal(detector.ingest(chat(2, 'c', 'GG', 'g-c')), undefined);
  assert.equal(detector.ingest(chat(3, 'd', 'GG', 'g-d'))?.kind, 'burst');
});
