import assert from 'node:assert/strict';
import test from 'node:test';
import { Studio } from '../apps/server/src/studio.ts';

test('live speed changes preserve the playhead and approved comic', () => {
  const originalNow = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  try {
    const studio = new Studio();
    studio.replay('tabletop-night', 60);
    studio.moderate('approve');
    clock += 1000;
    studio.settings({ speed: 10 });
    assert.equal(studio.state.elapsed, 60);
    clock += 1000;
    assert.equal(studio.tick().elapsed, 70);
    assert.equal(studio.state.panels.length, 1);
    studio.close();
  } finally { Date.now = originalNow; }
});

test('edited captions stay pending until approval; rejection undo is single use', () => {
  const studio = new Studio();
  studio.replay('tabletop-night', 1);
  const id = studio.state.pendingPanels[0]!.id;
  studio.caption(id, '<script>bad</script> A new story me@example.com');
  assert.equal(studio.state.panels.length, 0);
  assert.equal(studio.state.pendingPanels[0]!.caption, 'bad A new story [redacted]');
  const rejected = studio.moderate('reject', id);
  assert.equal(studio.state.pendingPanels.length, 0);
  studio.undo(rejected.undoToken);
  assert.equal(studio.state.pendingPanels[0]!.id, id);
  assert.throws(() => studio.undo(rejected.undoToken), /expired/);
  const approved = studio.moderate('approve');
  assert.equal(studio.state.panels.length, 1);
  studio.undo(approved.undoToken);
  assert.equal(studio.state.panels.length, 0);
  assert.equal(studio.state.pendingPanels.length, 1);
  studio.close();
});

test('auto-publish releases pending panels and panic invalidates old undo tokens', () => {
  const studio = new Studio();
  studio.replay('tabletop-night', 1);
  const { undoToken } = studio.moderate('reject');
  studio.undo(undoToken);
  studio.settings({ approvalMode: false });
  assert.equal(studio.state.panels.length, 1);
  assert.equal(studio.state.pendingPanels.length, 0);
  studio.settings({ approvalMode: true });
  studio.stop();
  assert.equal(studio.state.panels.length, 0);
  assert.equal(studio.state.status, 'stopped');
  assert.throws(() => studio.undo(undoToken));
  studio.close();
});

test('undo expires after thirty seconds and is invalidated by replay', () => {
  const originalNow = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  try {
    const studio = new Studio();
    studio.replay('tabletop-night', 1);
    const rejected = studio.moderate('reject');
    clock += 30_001;
    assert.throws(() => studio.undo(rejected.undoToken), /expired/);
    studio.replay('tabletop-night', 1);
    const approved = studio.moderate('approve');
    studio.replay('speedrun-fail', 1);
    assert.throws(() => studio.undo(approved.undoToken), /expired/);
    studio.close();
  } finally { Date.now = originalNow; }
});

import { eventBus } from '../packages/core/src/index.ts';
import type { ComicPanel } from '../packages/core/src/index.ts';
import { ircFixture } from './ingest-fixture.ts';
import type { ArtPipeline } from '../apps/server/src/pipeline/imagegen.ts';
import { createMockArtPipeline } from '../scripts/s2-replay-core.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A simulated IRC session driven only through the chat ingest path (no eventBus). */
function ingestOnlyStudio(momentConfig: ConstructorParameters<typeof Studio>[0] extends infer O ? O extends { momentConfig?: infer M } ? M : never : never = {}, artPipeline?: ArtPipeline) {
  let clock = 0;
  const source = ircFixture(() => clock);
  const studio = new Studio({ adapterFactory: () => source.adapter, now: () => clock, momentConfig, artPipeline });
  studio.useSource('twitch', 'approved_test');
  source.welcome();
  const all = (): ComicPanel[] => [...studio.state.panels, ...studio.state.pendingPanels];
  return { studio, source, all, advance: (ms: number) => { clock += ms; } };
}

function baseline(live: ReturnType<typeof ingestOnlyStudio>, from: number, seconds: number) {
  const phrases = ['nice run', 'this boss again', 'love the music', 'back from the brink', 'so close'];
  for (let s = from; s < from + seconds; s++) {
    live.source.chat(`base-${s}`, `${phrases[s % phrases.length]} ${s}`, `viewer-${s % 8}`);
    live.advance(1000);
  }
}

test('S2-INGEST-01: the chat ingest path alone turns a velocity spike and an emote burst into kind-specific panels', () => {
  const live = ingestOnlyStudio();
  try {
    baseline(live, 0, 40);
    for (let i = 0; i < 30; i++) { live.source.chat(`surge-${i}`, 'GO GO GO', `crowd-${i % 10}`); live.advance(100); }
    baseline(live, 44, 40);
    for (let i = 0; i < 4; i++) { live.source.chat(`kekw-${i}`, 'KEKW', `fan-${i}`); live.advance(500); }
    baseline(live, 86, 5);

    const panels = live.all();
    const spike = panels.find((panel) => panel.sfx === 'SPIKE!');
    const burst = panels.find((panel) => panel.sfx === 'SURGE!');
    assert.ok(spike, `a spike panel exists; captions: ${panels.map((p) => p.caption).join(' | ')}`);
    assert.ok(burst, 'a burst panel exists');
    assert.match(spike!.caption, /^Chat erupts all at once: .*"GO GO GO"/);
    assert.equal(spike!.mood, 'energetic');
    assert.equal(spike!.dialogue[0], 'GO GO GO', 'the crowd line leads the spike dialogue');
    assert.ok(spike!.sources!.some((id) => id.startsWith('surge-')), 'the spike cites the surge messages');
    assert.match(burst!.caption, /^The same reaction floods chat: 4 viewers spam KEKW at once\.$/);
    assert.equal(burst!.mood, 'electric');
    assert.deepEqual([...burst!.sources!].filter((id) => id.startsWith('kekw-')).sort(), ['kekw-0', 'kekw-1', 'kekw-2', 'kekw-3']);
    assert.equal(panels.filter((panel) => panel.sfx === 'SPIKE!').length, 1, 'one surge, one spike panel');
    assert.equal(panels.filter((panel) => panel.sfx === 'SURGE!').length, 1, 'one burst, one burst panel');
    assert.equal(new Set(panels.map((panel) => panel.caption)).size, panels.length, 'no two panels share a caption');
    assert.equal(new Set(panels.map((panel) => panel.imageUrl)).size, panels.length, 'no two panels share an image');
    assert.ok(panels.every((panel) => !/\(#\d+\)/.test(panel.caption)), 'no numeric uniqueness suffixes');
    assert.ok(panels.every((panel) => /^irc-/.test(panel.id)));
  } finally { live.studio.close(); }
});

test('S2-INGEST-02: deletes and opt-outs reach spike/burst panels; a panel left with no quotable line is purged', () => {
  const live = ingestOnlyStudio();
  try {
    baseline(live, 0, 40);
    for (let i = 0; i < 30; i++) { live.source.chat(`surge-${i}`, 'GO GO GO', `crowd-${i % 10}`); live.advance(100); }
    const spikeId = live.all().find((panel) => panel.sfx === 'SPIKE!')!.id;
    const spikeSources = () => live.all().find((panel) => panel.id === spikeId)!.sources!;
    assert.ok(spikeSources().includes('surge-5'));
    live.source.feed('@login=u;target-msg-id=surge-5 :tmi.twitch.tv CLEARMSG #approved_test :GO GO GO\r\n');
    assert.ok(!spikeSources().includes('surge-5'), 'a deleted line is no longer cited');
    live.source.chat('out-1', '!noink', 'crowd-6');
    assert.ok(!spikeSources().some((id) => id === 'surge-6' || id === 'surge-16' || id === 'surge-26'), 'an opted-out user is no longer quoted or cited');

    baseline(live, 44, 40);
    for (let i = 0; i < 3; i++) { live.source.chat(`kekw-${i}`, 'KEKW', `fan-${i}`); live.advance(500); }
    assert.ok(live.all().some((panel) => panel.sfx === 'SURGE!'));
    for (let i = 0; i < 3; i++) live.source.chat(`optout-${i}`, '!noink', `fan-${i}`);
    assert.ok(!live.all().some((panel) => panel.sfx === 'SURGE!'), 'the burst panel is purged once none of its voices may be quoted');
    assert.ok(!JSON.stringify(live.studio.state).includes('KEKW'));
  } finally { live.studio.close(); }
});

test('S2-INGEST-03: an event id already fed to the detector over the bus is not counted again by the ingest path', () => {
  const live = ingestOnlyStudio({ spikeMinCount: 4, spikeMinUsers: 2, spikeMultiplier: 1, spikeWarmupSeconds: 0 });
  try {
    live.source.chat('warm', 'first line', 'a');
    live.advance(100);
    eventBus.emit('stream-event', { id: 'dup-1', t: 0.1, type: 'chat', user: 'b', text: 'bus line one' });
    eventBus.emit('stream-event', { id: 'dup-2', t: 0.1, type: 'chat', user: 'c', text: 'bus line two' });
    live.source.chat('dup-1', 'bus line one', 'b');
    live.source.chat('dup-2', 'bus line two', 'c');
    assert.ok(!live.all().some((panel) => panel.sfx === 'SPIKE!'), 'three distinct messages must not count as five');
    live.source.chat('fresh-4', 'a fourth line', 'd');
    assert.equal(live.all().filter((panel) => panel.sfx === 'SPIKE!').length, 1, 'the fourth distinct message opens exactly one spike');
  } finally { live.studio.close(); }
});

test('S2-INGEST-04: chat that follows a bus raid becomes that raid panel\'s real-chat dialogue', () => {
  const live = ingestOnlyStudio();
  try {
    live.source.chat('pre', 'hello all', 'a');
    eventBus.emit('stream-event', { id: 'raid-1', t: 0, type: 'raid', from: 'MoonlightCrew', viewers: 42 });
    live.source.chat('r1', 'welcome raiders', 'b');
    live.source.chat('r2', 'hi moonlight crew', 'c');
    const raid = live.all().find((panel) => panel.sfx === 'RAID!')!;
    assert.equal(raid.caption, 'A raid crashes in: MoonlightCrew arrives with 42 viewers.');
    assert.deepEqual(raid.dialogue, ['welcome raiders', 'hi moonlight crew']);
    assert.deepEqual(raid.sources, ['raid-1', 'r1', 'r2']);
  } finally { live.studio.close(); }
});

test('S2-ART-01: every live panel sends a different, chat-free art prompt built from its own content', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 's2-art-'));
  const prompts: string[] = [];
  const live = ingestOnlyStudio({}, createMockArtPipeline(cacheDir, (prompt) => prompts.push(prompt)));
  try {
    baseline(live, 0, 40);
    for (let i = 0; i < 30; i++) { live.source.chat(`surge-${i}`, 'GO GO GO', `crowd-${i % 10}`); live.advance(100); }
    baseline(live, 44, 40);
    for (let i = 0; i < 4; i++) { live.source.chat(`kekw-${i}`, 'KEKW', `fan-${i}`); live.advance(500); }
    baseline(live, 86, 40);
    for (let i = 0; i < 30; i++) { live.source.chat(`surge2-${i}`, 'GO GO GO', `crowd-${i % 10}`); live.advance(100); }
    baseline(live, 130, 5);
    await live.studio.flushArtUpgrades();
    const panels = live.all();
    assert.equal(panels.filter((panel) => panel.sfx === 'SPIKE!').length, 2, 'two surges, two spike panels');
    assert.equal(prompts.length, panels.length, 'one prompt per panel');
    assert.equal(new Set(prompts).size, prompts.length, `no two panels ask for the same picture:\n${prompts.join('\n')}`);
    assert.equal(new Set(panels.map((panel) => panel.imageUrl)).size, panels.length);
    assert.equal(new Set(panels.map((panel) => panel.scene)).size, panels.length, 'alt text differs too');
    const spikes = panels.filter((panel) => panel.sfx === 'SPIKE!').map((panel) => panel.scene);
    assert.ok(spikes.every((scene) => /wall of speech-shaped bursts/.test(scene) && /crowd/.test(scene)));
    assert.match(panels.find((panel) => panel.sfx === 'SURGE!')!.scene, /laughter/, 'the KEKW burst is drawn as laughter, not as the word');
    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /GO GO GO|KEKW|crowd-\d|fan-\d|viewer-\d|nice run|this boss again|love the music|back from the brink|so close/i);
    }
  } finally { live.studio.close(); rmSync(cacheDir, { recursive: true, force: true }); }
});

test('S2-ART-02: without network art, spike, burst and raid panels start on matching library art', () => {
  const live = ingestOnlyStudio();
  try {
    baseline(live, 0, 40);
    for (let i = 0; i < 30; i++) { live.source.chat(`surge-${i}`, 'GO GO GO', `crowd-${i % 10}`); live.advance(100); }
    baseline(live, 44, 40);
    for (let i = 0; i < 4; i++) { live.source.chat(`kekw-${i}`, 'KEKW', `fan-${i}`); live.advance(500); }
    eventBus.emit('stream-event', { id: 'lib-raid', t: 90, type: 'raid', from: 'Crew', viewers: 30 });
    const panels = live.all();
    const asset = (sfx: string) => panels.find((panel) => panel.sfx === sfx)?.provenance?.asset;
    assert.equal(asset('SPIKE!'), 'panel-01-stream-start.webp');
    assert.equal(asset('SURGE!'), 'panel-09-emote-storm.webp');
    assert.equal(asset('RAID!'), 'panel-05-raid-arrives.webp');
    assert.equal(new Set(panels.map((panel) => panel.imageUrl)).size, panels.length, 'still no shared library image');
  } finally { live.studio.close(); }
});
