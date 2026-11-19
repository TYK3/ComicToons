// MEM-1a: one unit test per memory cap from report-mem-1.md (#1 helper, #7, #8, #9, #10).
// No sockets or ports: the SSE writer is driven through a stand-in response whose writes never drain.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import {createEventBus, type ComicPanel, type ComicToonsBusEvents} from '../packages/core/src/index.ts';
import {CatchupTriggers, OptOutLedger} from '../apps/server/src/participation/commands.ts';
import {HypeAndPredictions} from '../apps/server/src/participation/predictions.ts';
import {RecapStore, readEditionTitle, writeEditionTitle} from '../apps/server/src/recaps.ts';
import {MomentDetector, defaultMomentConfig} from '../apps/server/src/pipeline/moments.ts';
import {Studio} from '../apps/server/src/studio.ts';

/** A response whose peer never reads: every write is queued and 'drain' only fires when the test says so. */
class StalledResponse extends EventEmitter {
  writableLength = 0; destroyed = false; writableEnded = false; frames: string[] = [];
  write(chunk: string) { this.frames.push(chunk); this.writableLength += Buffer.byteLength(chunk); return this.writableLength < 16_384; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  drainAll() { this.writableLength = 0; this.emit('drain'); }
}

test('MEM-1a #1 sseWriter: a stalled client keeps at most the cap queued, holds only the latest state and is dropped', async () => {
  const {sseWriter} = await import('../apps/server/src/comics/routes.ts') as {sseWriter?: (res: unknown, limits?: object, now?: () => number) => {latest(frame: string): void; event(frame: string): void}};
  assert.equal(typeof sseWriter, 'function', 'comics/routes.ts exports sseWriter');
  let clock = 0;
  const res = new StalledResponse();
  const writer = sseWriter!(res, {softBytes: 64 * 1024, hardBytes: 256 * 1024, stallMs: 30_000}, () => clock);
  const frame = (n: number) => `event: state\ndata: ${JSON.stringify({n, pad: 'x'.repeat(4000)})}\n\n`;
  for (let n = 0; n < 500; n++) { writer.latest(frame(n)); writer.event(`event: stream-event\ndata: {"n":${n}}\n\n`); clock += 10; }
  assert.ok(res.writableLength <= 64 * 1024 + 8 * 1024, `queued ${res.writableLength} bytes after 500 state changes`);
  assert.equal(res.destroyed, false, 'not dropped before the stall window');
  res.drainAll();
  assert.match(res.frames.at(-1)!, /"n":499/, 'on drain it sends the newest state, not the backlog');
  // Stalled again for longer than stallMs: the next write attempt drops the client.
  for (let n = 500; n < 520; n++) writer.latest(frame(n));
  clock += 30_001; writer.event(': heartbeat\n\n');
  assert.equal(res.destroyed, true, 'a client that has not drained for 30 s is dropped');
  const hard = new StalledResponse();
  const big = sseWriter!(hard, {softBytes: 1e12, hardBytes: 100_000, stallMs: 1e12}, () => 0);
  for (let n = 0; n < 50; n++) big.latest(frame(n));
  assert.equal(hard.destroyed, true, 'over the hard byte cap the client is dropped');
});

test('MEM-1a #7 lastRaid: raiders older than the 60 s window are forgotten', () => {
  let clock = 0;
  const triggers = new CatchupTriggers({bus: createEventBus<ComicToonsBusEvents>(), optOuts: new OptOutLedger(), now: () => clock});
  for (let i = 0; i < 500; i++) { triggers.raid({type: 'raid', from: `raider_${i}`, viewers: 3} as never); clock += 61_000; }
  const size = (triggers as unknown as {lastRaid: Map<string, number>}).lastRaid.size;
  assert.ok(size <= 1, `lastRaid holds ${size} raiders after 500 raids a minute apart`);
  // Still deduplicates inside the window.
  assert.ok(triggers.raid({type: 'raid', from: 'twice', viewers: 1} as never));
  clock += 1000;
  assert.equal(triggers.raid({type: 'raid', from: 'twice', viewers: 1} as never), null);
});

test('MEM-1a #8 predictions seen: bounded to pending plus the 512 most recent ids, and the splash still lands on the next new panel', () => {
  const panel = (id: string) => ({id, caption: id} as ComicPanel);
  const studio = {state: {panels: [] as ComicPanel[], pendingPanels: [] as ComicPanel[], elapsed: 0, approvalMode: true}, moderate() {}, caption() {}};
  const bus = createEventBus<ComicToonsBusEvents>();
  const splashes: string[] = [];
  bus.on('panel-splash', payload => splashes.push((payload as {panelId: string}).panelId));
  const hype = new HypeAndPredictions({studio, bus, now: () => 0, helix: null, usePredictions: false});
  for (let i = 0; i < 2000; i++) { studio.state.pendingPanels = [panel(`p${i}`), panel(`p${i + 1}`)]; hype.observe(); }
  const seen = (hype as unknown as {seen: Set<string>}).seen;
  assert.ok(seen.size <= 512, `seen holds ${seen.size} ids after 2001 panels`);
  assert.ok(seen.has('p1999') && seen.has('p2000'), 'pending ids are kept');
  void hype.onHype({type: 'hype_train_begin', level: 2} as never);
  hype.observe();
  assert.deepEqual(splashes, [], 'panels drafted before hype began are not the splash');
  studio.state.pendingPanels = [...studio.state.pendingPanels, panel('after-hype')];
  hype.observe();
  assert.deepEqual(splashes, ['after-hype']);
});

test('MEM-1a #9 RecapStore: the in-memory record cache is an LRU of 20; older recaps reload from disk', async () => {
  const directory = await mkdtemp(resolve('artifacts/tmp/mem-1a-recaps-'));
  const store = new RecapStore(directory);
  const studio = new Studio();
  try {
    const state = structuredClone(studio.sampleSnapshot());
    for (let i = 0; i < 30; i++) await store.write(`issue-${i}`, {...state, streamTitle: `Issue ${i}`});
    const records = (store as unknown as {records: Map<string, unknown>}).records;
    assert.ok(records.size <= 20, `records holds ${records.size} after 30 saves`);
    assert.equal((await store.read('issue-0')).streamTitle, 'Issue 0', 'an evicted recap still reads from disk');
    assert.ok(records.size <= 20);
  } finally { studio.close(); }
});

test('MEM-1a #10 moments: completed moments default to the last 50', () => {
  assert.equal(defaultMomentConfig.maxCompletedMoments, 50);
  const detector = new MomentDetector({idleCloseSeconds: 10});
  for (let i = 0; i < 80; i++) { detector.ingest({id: `raid-${i}`, t: i * 1000, type: 'raid', from: 'Crew', viewers: 5}); detector.closeIfIdle(i * 1000 + 11); }
  assert.ok(detector.completedMoments().length <= 50, `${detector.completedMoments().length} completed moments kept`);
  assert.ok(detector.completedMoments().length > 0);
});

test('MEM-1a r1 #8 (M6) predictions seen: pruning never drops a panel that is still pending, so it never counts as new again', () => {
  const panel = (id: string) => ({id, caption: id} as ComicPanel);
  const studio = {state: {panels: [] as ComicPanel[], pendingPanels: [panel('held')] as ComicPanel[], elapsed: 0, approvalMode: true}, moderate() {}, caption() {}};
  const bus = createEventBus<ComicToonsBusEvents>();
  const splashes: string[] = [];
  bus.on('panel-splash', payload => splashes.push((payload as {panelId: string}).panelId));
  const hype = new HypeAndPredictions({studio, bus, now: () => 0, helix: null, usePredictions: false});
  // 'held' waits in the queue the whole time; 511 other panels pass through, so seen is exactly full (512).
  for (let i = 0; i < 511; i++) { studio.state.pendingPanels = [panel('held'), panel(`q${i}`)]; hype.observe(); }
  // Hype begins while 'late' is drafted but not yet observed: markSeen takes seen past the cap, so the next
  // observe prunes with no fresh panel, and 'held' is the oldest id in seen.
  studio.state.pendingPanels = [panel('held'), panel('late')];
  void hype.onHype({type: 'hype_train_begin', level: 2} as never);
  hype.observe();
  const seen = (hype as unknown as {seen: Set<string>}).seen;
  assert.ok(seen.has('held'), 'a pending id survives the prune');
  assert.ok(seen.size <= 512, `seen holds ${seen.size} ids`);
  hype.observe();
  assert.deepEqual(splashes, [], 'a panel drafted before hype began is never the splash');
  studio.state.pendingPanels = [panel('held'), panel('late'), panel('after-hype')];
  hype.observe();
  assert.deepEqual(splashes, ['after-hype']);
});

test('MEM-1a r1 #9 (M8) edition titles: the output-directory map forgets the oldest of 1000 names, and a read records it again', async () => {
  const directory = await mkdtemp(resolve('artifacts/tmp/mem-1a-outdirs-'));
  const store = new RecapStore(directory);
  const studio = new Studio();
  try {
    await store.write('outdir-first', structuredClone(studio.sampleSnapshot()));
    await store.read('outdir-first');
    await writeEditionTitle('outdir-first', 'First edition');
    assert.equal(await readEditionTitle('outdir-first'), 'First edition');
    // 1000 other names: 999 recorded by read() even though no recap exists for them, then one real saved recap.
    for (let i = 0; i < 999; i++) await store.read(`outdir-other-${i}`).catch(() => undefined);
    await store.write('outdir-recent', structuredClone(studio.sampleSnapshot()));
    await store.read('outdir-recent');
    assert.equal(await readEditionTitle('outdir-first'), undefined, 'the oldest name was forgotten');
    await assert.rejects(writeEditionTitle('outdir-first', 'Again'), /Save the recap before naming its edition/);
    await writeEditionTitle('outdir-recent', 'Recent edition');
    assert.equal(await readEditionTitle('outdir-recent'), 'Recent edition', 'the newest name is still known');
    await store.read('outdir-first');
    assert.equal(await readEditionTitle('outdir-first'), 'First edition', 'a read records the name again and the title is on disk');
  } finally { studio.close(); }
});
