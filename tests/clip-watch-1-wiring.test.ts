import assert from 'node:assert/strict';
import test from 'node:test';
import { eventBus, type StreamEvent } from '@comictoons/core';
import { MomentDetector, defaultMomentConfig } from '../apps/server/src/pipeline/moments.ts';
import { Studio } from '../apps/server/src/studio.ts';
import { clipEvent, type ClipStreamEvent } from '../apps/server/src/ingest/clips.ts';
import { createDirectAdapter } from '../scripts/s2-replay-core.ts';
import { liveAppFixture } from './twitch-live-app-fixture.ts';

const T0 = Date.parse('2026-10-31T19:00:00Z');
const polled = (id: string, t: number, viewCount = 0): ClipStreamEvent => clipEvent({ id, url: `https://clips.example.test/${id}`, thumbnailUrl: `https://thumbs.example.test/${id}.jpg`, viewCount, createdAt: T0 + t * 1000, title: `Clip ${id}` }, T0);

test('moments: polled clips open one moment only as a cluster, scored by count, framed by the most-viewed clip', () => {
  assert.equal(defaultMomentConfig.clipClusterMinClips, 3);
  assert.equal(defaultMomentConfig.clipClusterWindowSeconds, 120);
  const detector = new MomentDetector();
  assert.equal(detector.ingest(polled('a', 0, 2)), undefined);
  assert.equal(detector.ingest(polled('b', 40, 11)), undefined, 'two clips are not a moment');
  const opened = detector.ingest(polled('c', 80, 5));
  assert.ok(opened);
  assert.equal(opened.kind, 'clip');
  assert.deepEqual(opened.sourceIds, ['clip-a', 'clip-b', 'clip-c']);
  assert.equal(opened.score, 45);
  assert.deepEqual(opened.frame, { url: 'https://clips.example.test/b', thumbnailUrl: 'https://thumbs.example.test/b.jpg' });
  assert.equal(detector.ingest(polled('d', 90)), undefined, 'a fourth clip joins, it does not open another moment');
  assert.equal(detector.current()?.score, 60, 'the score rises with the clip count');
  const wide = new MomentDetector();
  for (const [id, t] of [['x', 0], ['y', 60], ['z', 121]] as const) assert.equal(wide.ingest(polled(id, t)), undefined);
});

test('moments: a clip event without a polled clip keeps the strong-signal path', () => {
  const detector = new MomentDetector();
  const opened = detector.ingest({ id: 'legacy', t: 5, type: 'clip', name: 'someone' });
  assert.equal(opened?.kind, 'clip'); assert.equal(opened?.frame, undefined);
});

test('studio: polled clips count as "Clips: N" and a cluster panel carries the clip and its frame', () => {
  const direct = createDirectAdapter(); let clock = 0;
  const studio = new Studio({ adapterFactory: () => direct.adapter, now: () => clock});
  try {
    studio.useSource('twitch', 'approved_test'); direct.push({ id: 'anchor', t: 0, type: 'chat', user: 'anchor', text: 'anchor stays' });
    assert.equal(studio.state.clips, 0);
    for (const event of [polled('a', 10, 1), polled('a', 10, 1), polled('b', 20, 8), polled('c', 30, 3)]) { clock = event.t * 1000; eventBus.emit('stream-event', event as StreamEvent); }
    assert.equal(studio.state.clips, 3, 'the same clip id is counted once');
    const panel = [...studio.state.panels, ...studio.state.pendingPanels].find(item => item.clipUrl);
    assert.ok(panel, 'the cluster made a panel');
    assert.equal(panel.clipUrl, 'https://clips.example.test/b');
    assert.equal(panel.frameUrl, 'https://thumbs.example.test/b.jpg');
  } finally { studio.close(); }
});

test('app: a signed-in Live session polls Get Clips with an app token and stream end stops it', async () => {
  const requests: string[] = [];
  let clipsServed = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/token') { requests.push(`token ${new URLSearchParams(String(init?.body)).get('grant_type')}`); return Response.json({ access_token: 'app-test-token', expires_in: 3600 }); }
    if (url.pathname === '/helix/clips') {
      requests.push(`clips ${url.searchParams.get('broadcaster_id')} ${new Headers(init?.headers).get('authorization')}`);
      clipsServed++;
      return Response.json({ data: clipsServed === 1 ? [{ id: 'live-a', url: 'https://clips.twitch.tv/live-a', thumbnail_url: 'https://clips-media-assets2.jtvnw.net/live-a.jpg', view_count: 1, created_at: new Date().toISOString(), title: 'A clip' }] : [], pagination: {} });
    }
    return Response.json({ data: [] });
  }) as typeof globalThis.fetch;
  const live = await liveAppFixture({ helix: { fetch } });
  try {
    const waitFor = async (check: () => Promise<boolean> | boolean, label: string) => {
      const deadline = Date.now() + 5000;
      while (!(await check())) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 50)); }
    };
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual(requests, [], 'signed out: no clip polling');
    await live.signIn(); await live.startIRC();
    live.irc({ id: 'chat-1', t: 1, type: 'chat', user: 'viewer', text: 'hello' });
    await waitFor(async () => (await live.state()).clips === 1, 'the polled clip reaches the studio counter');
    assert.equal(requests[0], 'token client_credentials');
    assert.equal(requests[1], 'clips 1337 Bearer app-test-token');
    eventBus.emit('stream-offline', { broadcasterId: '1337' });
    const after = requests.length;
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(requests.length, after, 'no polling after stream end');
  } finally { await live.close(); }
});
