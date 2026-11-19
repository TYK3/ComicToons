import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Studio } from '../apps/server/src/studio.ts';
import { createApp } from '../apps/server/src/app.ts';
import { eventBus } from '../packages/core/src/index.ts';
import { ircFixture } from './ingest-fixture.ts';

// CLOCK-1: the Studio stream clock (AppBar "Stream time", from studio.elapsed) froze during a live
// session whenever no chat line was being quoted, e.g. while raids, commands and the catch-up ran.
// Since RAID-SAMPLE-1 a quiet channel stays Live indefinitely, so the clock must keep running then too.
const fakeClock = (start = 1_000_000) => {
  let now = start;
  return { now: () => now, advance: (seconds: number) => { now += seconds * 1000; } };
};

test('CLOCK-1-01: the live stream clock keeps running through a quiet spell with no quoted chat', () => {
  const clock = fakeClock();
  const studio = new Studio({ now: clock.now });
  try {
    eventBus.emit('twitch-connected', { source: 'eventsub', channel: 'clock_channel' });
    assert.equal(studio.state.status, 'live');
    clock.advance(71);
    eventBus.emit('stream-event', { id: 'clock-chat-1', type: 'chat', t: 71, user: 'viewer-1', name: 'Viewer', text: 'hello there' });
    assert.equal(Math.floor(studio.tick().elapsed ?? 0), 71);
    // Two quiet minutes: a raid and a command arrive, but no chat line is quoted.
    clock.advance(60);
    eventBus.emit('stream-event', { id: 'clock-raid-1', type: 'raid', t: 131, from: 'raider', viewers: 3 });
    eventBus.emit('stream-event', { id: 'clock-cmd-1', type: 'chat', t: 131, user: 'viewer-1', name: 'Viewer', text: '!previously' });
    clock.advance(60);
    assert.equal(Math.floor(studio.tick().elapsed ?? 0), 191, 'the clock advanced with wall time, not only with quoted chat');
  } finally { studio.close(); }
});

test('CLOCK-1-02: an older chat event time does not pull the live clock back', () => {
  const clock = fakeClock();
  const studio = new Studio({ now: clock.now });
  try {
    eventBus.emit('twitch-connected', { source: 'eventsub', channel: 'clock_channel_2' });
    clock.advance(30);
    assert.equal(Math.floor(studio.tick().elapsed ?? 0), 30);
    eventBus.emit('stream-event', { id: 'clock-chat-2', type: 'chat', t: 12, user: 'viewer-2', name: 'Viewer Two', text: 'late line' });
    assert.equal(Math.floor(studio.tick().elapsed ?? 0), 30, 'an older event time does not pull the clock back');
  } finally { studio.close(); }
});

test('CLOCK-1-03: a chat time ahead of wall time is kept; tick() never moves the clock backwards', () => {
  const clock = fakeClock();
  const studio = new Studio({ now: clock.now });
  try {
    eventBus.emit('twitch-connected', { source: 'eventsub', channel: 'clock_channel_3' });
    clock.advance(10);
    eventBus.emit('stream-event', { id: 'clock-chat-3', type: 'chat', t: 40, user: 'viewer-3', name: 'Viewer Three', text: 'ahead of the wall clock' });
    assert.equal(Math.floor(studio.tick().elapsed ?? 0), 40, 'wall time (10 s) must not replace the later chat time (40 s)');
    clock.advance(5);
    assert.equal(Math.floor(studio.tick().elapsed ?? 0), 40);
    clock.advance(40);
    assert.equal(Math.floor(studio.tick().elapsed ?? 0), 55, 'once wall time passes the chat time, the clock follows wall time again');
  } finally { studio.close(); }
});

test('CLOCK-1-04: a restored live session resumes its clock from the archived time', () => {
  const clock = fakeClock();
  const studio = new Studio({ now: clock.now });
  try {
    eventBus.emit('twitch-connected', { source: 'eventsub', channel: 'clock_channel_4' });
    clock.advance(100);
    assert.equal(Math.floor(studio.tick().elapsed ?? 0), 100);
    eventBus.emit('twitch-disconnected', { source: 'eventsub', channel: 'clock_channel_4' });
    assert.notEqual(studio.state.status, 'live', 'the session is archived while disconnected');
    clock.advance(500);
    eventBus.emit('twitch-connected', { source: 'eventsub', channel: 'clock_channel_4' });
    assert.equal(studio.state.status, 'live');
    assert.equal(Math.floor(studio.state.elapsed), 100, 'the archived session came back');
    clock.advance(20);
    assert.equal(Math.floor(studio.tick().elapsed ?? 0), 120, 'the clock resumes from 100 s, not from the moment of restore');
  } finally { studio.close(); }
});

test('CLOCK-1-05: with RAID-SAMPLE-1, ten quiet minutes on IRC stay Live and the clock keeps counting', async () => {
  await mkdir(resolve('artifacts/tmp'), { recursive: true });
  const recapDirectory = await mkdtemp(resolve('artifacts/tmp/clock-1-quiet-'));
  let now = 1_000_000;
  const source = ircFixture(() => now);
  const app = createApp({ recapDirectory, adapterFactory: () => source.adapter, now: () => now, logger: false });
  try {
    await app.inject({ method: 'POST', url: '/api/ingest', payload: { mode: 'twitch', channel: 'approved_test' } });
    source.welcome();
    source.chat('line-1', 'The dragon took the loot again.', 'viewer1');
    const start = ((await app.inject('/api/state')).json() as { elapsed: number }).elapsed;
    for (let minute = 1; minute <= 10; minute++) {
      now += 60_000;
      const state = (await app.inject('/api/state')).json() as { elapsed: number; status: string; source?: { active?: string } };
      assert.equal(state.source?.active, 'twitch', `minute ${minute}: still Live`);
      assert.equal(state.status, 'live', `minute ${minute}`);
      assert.equal(Math.floor(state.elapsed - start), minute * 60, `minute ${minute}: the clock moved with the quiet minute`);
    }
  } finally { await app.close(); }
});
