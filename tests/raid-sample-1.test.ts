import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eventBus } from '@comictoons/core';
import { createApp } from '../apps/server/src/app.ts';
import { ircFixture } from './ingest-fixture.ts';

// RAID-SAMPLE-1: on a live session, a quiet spell of chat (60 s with no new line, which a raid
// does not reset) used to drop the source to Sample Data, so the Studio swapped to the sample issue
// and the overlay went blank. Seen as "the app flips to Sample when a raid catch-up ends".
const momentConfig = { spikeMinCount: 1, spikeMinUsers: 1, spikeWarmupSeconds: 0, cooldownSeconds: 0 };
type Frame = { source?: { active?: string }; panels?: { id: string }[]; issueTitle?: string };

test('RAID-SAMPLE-1: a raid catch-up on a live session gives 0 sample state frames over 15 s', async () => {
  const recapDirectory = await mkdtemp(resolve('artifacts/tmp/raid-sample-1-'));
  let clock = 1_000_000;
  const source = ircFixture(() => clock);
  const app = createApp({ recapDirectory, adapterFactory: () => source.adapter, now: () => clock, momentConfig, logger: false });
  const controller = new AbortController();
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await app.inject({ method: 'POST', url: '/api/ingest', payload: { mode: 'twitch', channel: 'approved_test' } })).statusCode, 200);
    source.welcome();
    source.chat('line-1', 'The dragon took the loot again.', 'viewer1');
    source.chat('line-2', 'Not the loot again, dragon.', 'viewer2');
    const live = (await app.inject('/api/state')).json() as Frame & { pendingPanels: { id: string }[] };
    assert.equal(live.source?.active, 'twitch');
    assert.ok(live.pendingPanels.length > 0, 'chat drafted a panel');
    assert.equal((await app.inject({ method: 'POST', url: '/api/approve', payload: { all: true } })).statusCode, 200);
    const onAir = ((await app.inject('/api/state')).json() as Frame).panels!.map(panel => panel.id);
    assert.ok(onAir.length > 0, 'a panel is on air');

    const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let text = '';
    void (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += Buffer.from(value!).toString('utf8'); } })().catch(() => undefined);

    // The demo's timing: the last chat line, then a raid about 50 s later, and its catch-up.
    clock += 50_000;
    source.feed(`@id=raid-1;msg-id=raid;msg-param-login=raid_demo;msg-param-viewerCount=42 :tmi.twitch.tv USERNOTICE #approved_test\r\n`);
    eventBus.emit('catchup', { reason: 'raid', raider: 'raid_demo', viewers: 42 });
    const polled: Frame[] = [];
    for (let step = 0; step < 30; step++) { clock += 500; polled.push((await app.inject('/api/state')).json() as Frame); }
    await new Promise(done => setTimeout(done, 1_200)); // let /api/events push its 500 ms state frames

    const frames = text.split('\n\n').filter(block => block.startsWith('event: state')).map(block => JSON.parse(block.split('\ndata: ')[1]!) as Frame);
    assert.ok(frames.length > 0, 'state frames were streamed');
    const sampleFrames = [...frames, ...polled].filter(frame => frame.source?.active !== 'twitch');
    assert.equal(sampleFrames.length, 0, `sample state frames: ${sampleFrames.map(frame => frame.issueTitle).join(', ')}`);
    const last = polled.at(-1)!;
    assert.deepEqual(last.panels!.map(panel => panel.id), onAir, 'the on-air panels stay on the overlay');
  } finally {
    controller.abort();
    await app.close();
  }
});

test('RAID-SAMPLE-1: ten quiet minutes on a live session keep the live issue, not the sample one', async () => {
  const recapDirectory = await mkdtemp(resolve('artifacts/tmp/raid-sample-1-quiet-'));
  let clock = 1_000_000;
  const source = ircFixture(() => clock);
  const app = createApp({ recapDirectory, adapterFactory: () => source.adapter, now: () => clock, momentConfig, logger: false });
  try {
    await app.inject({ method: 'POST', url: '/api/ingest', payload: { mode: 'twitch', channel: 'approved_test' } });
    source.welcome();
    source.chat('line-1', 'The dragon took the loot again.', 'viewer1');
    await app.inject({ method: 'POST', url: '/api/approve', payload: { all: true } });
    const onAir = ((await app.inject('/api/state')).json() as Frame).panels!.map(panel => panel.id);
    for (let minute = 1; minute <= 10; minute++) {
      clock += 60_000;
      const state = (await app.inject('/api/state')).json() as Frame;
      assert.equal(state.source?.active, 'twitch', `minute ${minute}`);
      assert.deepEqual(state.panels!.map(panel => panel.id), onAir, `minute ${minute}`);
    }
    source.chat('line-2', 'Back from the snack run.', 'viewer2');
    assert.equal(((await app.inject('/api/state')).json() as Frame).source?.active, 'twitch');
  } finally {
    await app.close();
  }
});
