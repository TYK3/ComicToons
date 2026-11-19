import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import { createEventBus } from '@comictoons/core';
import {
  ClipPoller, ClipsRateLimitedError, createAppTokenAuth, createClipWatch, defaultClipClusterConfig, getClips,
  initialClipClusterState, polledClipOf, safeClipUrl, stepClipCluster, type ClipStreamEvent, type ClusterClip, type PollTimers,
} from '../apps/server/src/ingest/clips.ts';
import { TwitchApiError } from '../apps/server/src/twitch-api/errors.ts';
import type { FetchLike, TwitchAuthProvider } from '../apps/server/src/twitch-api/types.ts';

// Every host this file reaches, through fetch or a DNS lookup. Only loopback is allowed.
const hosts: string[] = [];
const loopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
const realLookup = dns.lookup; const realPromisesLookup = dns.promises.lookup; const realFetch = globalThis.fetch;
before(() => {
  (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => { hosts.push(host); return (realLookup as (...args: unknown[]) => unknown)(host, ...rest); };
  (dns.promises as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => { hosts.push(host); return (realPromisesLookup as (...args: unknown[]) => unknown)(host, ...rest); };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => { hosts.push(new URL(input instanceof Request ? input.url : input).hostname); return realFetch(input, init); }) as typeof fetch;
});
after(() => { (dns as { lookup: unknown }).lookup = realLookup; (dns.promises as { lookup: unknown }).lookup = realPromisesLookup; globalThis.fetch = realFetch; });
const tracedFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

type Reply = { status?: number; headers?: Record<string, string>; body?: unknown };
type Seen = { method: string; url: URL; headers: http.IncomingHttpHeaders; body: string };
/** A loopback Helix (and id) fake: replies come from a queue, then from `fallback`. */
async function helixFake(fallback: (seen: Seen) => Reply = () => ({ body: { data: [], pagination: {} } })) {
  const seen: Seen[] = []; const queue: Reply[] = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const item: Seen = { method: req.method ?? '', url: new URL(req.url ?? '/', 'http://127.0.0.1'), headers: req.headers, body };
      seen.push(item);
      const reply = queue.shift() ?? fallback(item);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, queue, base, helix: `${base}/helix`, clips: () => seen.filter(item => item.url.pathname === '/helix/clips'), close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const staticAuth = (): TwitchAuthProvider & { refreshes: number } => {
  let token = 'fake-app-token-1';
  const auth = { refreshes: 0, async getAuth() { return { clientId: 'fake-client', accessToken: token, broadcasterId: '', login: '' }; }, async refresh() { auth.refreshes++; token = `fake-app-token-${auth.refreshes + 1}`; } };
  return auth;
};
const T0 = Date.parse('2026-10-31T19:00:00Z');
const raw = (id: string, secondsIn: number, views = 0) => ({ id, url: `https://clips.twitch.tv/${id}`, thumbnail_url: `https://clips-media-assets2.jtvnw.net/${id}.jpg`, view_count: views, created_at: new Date(T0 + secondsIn * 1000).toISOString(), title: `Clip ${id}`, creator_name: 'Viewer' });

/** Hand-driven timers: nothing runs until advance(). */
class FakeTimers implements PollTimers {
  now = 0; private tasks: { at: number; task: () => void; id: number }[] = []; private next = 1;
  set(task: () => void, ms: number) { const id = this.next++; this.tasks.push({ at: this.now + ms, task, id }); return id; }
  clear(handle: unknown) { this.tasks = this.tasks.filter(item => item.id !== handle); }
  get pending() { return this.tasks.map(item => item.at - this.now); }
  /** Moves the clock and runs what is due, letting each poll finish before the next. */
  async advance(ms: number, poller?: ClipPoller) {
    const target = this.now + ms;
    for (;;) {
      this.tasks.sort((a, b) => a.at - b.at);
      const due = this.tasks[0];
      if (!due || due.at > target) break;
      this.tasks.shift(); this.now = due.at; due.task(); await poller?.settled();
    }
    this.now = target;
  }
}

test('getClips sends a read-only Get Clips request with the app token and maps the clips', async () => {
  const fake = await helixFake(); after(fake.close);
  fake.queue.push({ body: { data: [raw('a', 5, 7), { id: '', url: 'x' }], pagination: {} } });
  const result = await getClips({ auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch }, { broadcasterId: '424242', startedAt: T0, endedAt: T0 + 3_600_000 });
  const [request] = fake.clips();
  assert.equal(request!.method, 'GET');
  assert.equal(request!.url.searchParams.get('broadcaster_id'), '424242');
  assert.equal(request!.url.searchParams.get('started_at'), '2026-10-31T19:00:00.000Z');
  assert.equal(request!.url.searchParams.get('ended_at'), '2026-10-31T20:00:00.000Z');
  assert.equal(request!.url.searchParams.get('first'), '100');
  assert.equal(request!.headers['client-id'], 'fake-client');
  assert.equal(request!.headers.authorization, 'Bearer fake-app-token-1');
  assert.deepEqual(result, { pages: 1, truncated: false, clips: [{ id: 'a', url: 'https://clips.twitch.tv/a', thumbnailUrl: 'https://clips-media-assets2.jtvnw.net/a.jpg', viewCount: 7, createdAt: T0 + 5000, title: 'Clip a', creatorName: 'Viewer' }] });
});

test('getClips follows the pagination cursor and stops at the page cap', async () => {
  let page = 0;
  const fake = await helixFake(() => { page++; return { body: { data: [raw(`p${page}`, page)], pagination: { cursor: `cursor-${page}` } } }; }); after(fake.close);
  const client = { auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch };
  const capped = await getClips(client, { broadcasterId: '1', maxPages: 3 });
  assert.deepEqual(capped.clips.map(clip => clip.id), ['p1', 'p2', 'p3']);
  assert.equal(capped.pages, 3); assert.equal(capped.truncated, true);
  assert.deepEqual(fake.clips().map(item => item.url.searchParams.get('after')), [null, 'cursor-1', 'cursor-2']);
  const clamped = await getClips(client, { broadcasterId: '1', maxPages: 500 });
  assert.equal(clamped.pages, 10, 'the cap never goes above 10 pages (about 1,000 clips)');
  fake.queue.push({ body: { data: [raw('last', 1)], pagination: { cursor: 'more' } } }, { body: { data: [raw('end', 2)], pagination: {} } });
  const done = await getClips(client, { broadcasterId: '1' });
  assert.deepEqual([done.clips.map(clip => clip.id), done.truncated], [['last', 'end'], false]);
});

test('getClips refreshes once on 401, throws a rate-limit error on 429 and an API error otherwise', async () => {
  const fake = await helixFake(); after(fake.close);
  const auth = staticAuth(); const client = { auth, baseUrl: fake.helix, fetch: tracedFetch };
  fake.queue.push({ status: 401 }, { body: { data: [raw('ok', 1)] } });
  assert.equal((await getClips(client, { broadcasterId: '1' })).clips.length, 1);
  assert.equal(auth.refreshes, 1);
  assert.equal(fake.clips().at(-1)!.headers.authorization, 'Bearer fake-app-token-2');
  fake.queue.push({ status: 429, headers: { 'Ratelimit-Reset': String(Math.ceil(Date.now() / 1000) + 20) } });
  await assert.rejects(getClips(client, { broadcasterId: '1' }), (error: unknown) => error instanceof ClipsRateLimitedError && error.hasReset && error.retryAfterMs > 15_000 && error.retryAfterMs <= 21_000);
  fake.queue.push({ status: 500 });
  await assert.rejects(getClips(client, { broadcasterId: '1' }), (error: unknown) => error instanceof TwitchApiError && error.status === 500 && !(error instanceof ClipsRateLimitedError));
  fake.queue.push({ status: 401 }, { status: 401 });
  await assert.rejects(getClips(client, { broadcasterId: '1' }), (error: unknown) => error instanceof TwitchApiError && error.status === 401);
});

test('the app token comes from client credentials, is cached, and refresh mints a new one', async () => {
  let minted = 0;
  const fake = await helixFake(seen => seen.url.pathname === '/oauth2/token' ? { body: { access_token: `minted-${++minted}`, expires_in: 3600, token_type: 'bearer' } } : { body: { data: [] } }); after(fake.close);
  const auth = createAppTokenAuth({ clientId: 'fake-client', clientSecret: 'fake-secret', authBaseUrl: fake.base, fetch: tracedFetch });
  const [first, second] = await Promise.all([auth.getAuth(), auth.getAuth()]);
  assert.equal(first?.accessToken, 'minted-1'); assert.equal(second?.accessToken, 'minted-1');
  const tokenRequests = fake.seen.filter(item => item.url.pathname === '/oauth2/token');
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0]!.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenRequests[0]!.body)), { client_id: 'fake-client', client_secret: 'fake-secret', grant_type: 'client_credentials' });
  await auth.refresh();
  assert.equal((await auth.getAuth())?.accessToken, 'minted-2');
  assert.equal(await createAppTokenAuth({ clientId: 'fake-client', clientSecret: '', authBaseUrl: fake.base, fetch: tracedFetch }).getAuth(), undefined);
});

test('the poller asks right away, then every 30 s, from the newest clip it has seen', async () => {
  const fake = await helixFake(); after(fake.close);
  fake.queue.push({ body: { data: [raw('a', 10), raw('b', 40)] } });
  const timers = new FakeTimers(); const events: ClipStreamEvent[] = [];
  const poller = new ClipPoller({ client: { auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch }, broadcasterId: '424242', sessionStartedAt: T0, emit: event => events.push(event), timers });
  poller.start(); poller.start();
  assert.deepEqual(timers.pending, [0]);
  await timers.advance(0, poller);
  assert.equal(fake.clips().length, 1);
  assert.equal(fake.clips()[0]!.url.searchParams.get('started_at'), new Date(T0).toISOString());
  assert.deepEqual(timers.pending, [30_000]);
  await timers.advance(29_999, poller);
  assert.equal(fake.clips().length, 1, 'nothing before 30 s');
  await timers.advance(1, poller);
  assert.equal(fake.clips().length, 2);
  assert.equal(fake.clips()[1]!.url.searchParams.get('started_at'), new Date(T0 + 40_000).toISOString());
  await timers.advance(60_000, poller);
  assert.equal(fake.clips().length, 4);
  assert.deepEqual(events.map(event => [event.id, event.type, event.t, event.clip.url, event.clip.thumbnailUrl, event.clip.viewCount]), [
    ['clip-a', 'clip', 10, 'https://clips.twitch.tv/a', 'https://clips-media-assets2.jtvnw.net/a.jpg', 0],
    ['clip-b', 'clip', 40, 'https://clips.twitch.tv/b', 'https://clips-media-assets2.jtvnw.net/b.jpg', 0],
  ]);
  poller.stop();
});

test('the poller emits each clip id once, even when Helix sends it again', async () => {
  const fake = await helixFake(); after(fake.close);
  fake.queue.push({ body: { data: [raw('b', 20, 3), raw('a', 10, 1)] } }, { body: { data: [raw('b', 20, 9), raw('c', 25)] } }, { body: { data: [raw('c', 25), raw('a', 10)] } });
  const timers = new FakeTimers(); const ids: string[] = [];
  const poller = new ClipPoller({ client: { auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch }, broadcasterId: '1', sessionStartedAt: T0, emit: event => ids.push(event.clip.id), timers });
  poller.start();
  await timers.advance(60_000, poller);
  assert.equal(fake.clips().length, 3);
  assert.deepEqual(ids, ['a', 'b', 'c'], 'oldest first, no repeats');
  assert.equal(poller.clipsSeen, 3);
  poller.stop();
});

test('a 429 waits for Ratelimit-Reset when present, otherwise backs off up to 5 minutes', async () => {
  const fake = await helixFake(); after(fake.close);
  const timers = new FakeTimers(); const logs: string[] = [];
  const poller = new ClipPoller({ client: { auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch }, broadcasterId: '1', sessionStartedAt: T0, emit: () => {}, timers, log: line => logs.push(line) });
  fake.queue.push({ status: 429, headers: { 'Ratelimit-Reset': String(Math.ceil(Date.now() / 1000) + 45) } });
  poller.start(); await timers.advance(0, poller);
  assert.ok(poller.lastDelayMs > 40_000 && poller.lastDelayMs <= 46_000, `reset header honoured (${poller.lastDelayMs})`);
  await timers.advance(poller.lastDelayMs, poller);
  assert.equal(poller.lastDelayMs, 30_000, 'back to the normal cadence after a good answer');
  fake.queue.push({ status: 429, headers: { 'Ratelimit-Reset': String(Math.floor(Date.now() / 1000)) } });
  await timers.advance(30_000, poller);
  assert.equal(poller.lastDelayMs, 30_000, 'a reset that has passed never polls faster than every 30 s');
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) { fake.queue.push({ status: 429 }); await timers.advance(poller.lastDelayMs, poller); waits.push(poller.lastDelayMs); }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 300_000, 300_000]);
  fake.queue.push({ status: 503 });
  await timers.advance(poller.lastDelayMs, poller);
  assert.equal(poller.lastDelayMs, 300_000, 'other failures back off too');
  await timers.advance(poller.lastDelayMs, poller);
  assert.equal(poller.lastDelayMs, 30_000);
  assert.ok(logs.some(line => line.includes('HTTP 429')));
  assert.ok(logs.every(line => !line.includes('fake-app-token')), 'logs never carry the token');
  poller.stop();
});

test('stream end stops the poller, a poll in flight emits nothing, and the next Live session starts again', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = await helixFake(); after(fake.close);
  const slowFetch: FetchLike = async (input, init) => { const response = await tracedFetch(input, init); if (new URL(input).pathname === '/helix/clips' && fake.clips().length === 2) await gate; return response; };
  const bus = createEventBus<{ 'stream-offline': { broadcasterId?: string } }>();
  const timers = new FakeTimers(); const ids: string[] = []; let asked = 0;
  const watch = createClipWatch({ client: { auth: staticAuth(), baseUrl: fake.helix, fetch: slowFetch }, broadcaster: async () => { asked++; return '424242'; }, bus, emit: event => ids.push(event.clip.id), timers, now: () => T0 });
  watch.sync(true); watch.sync(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asked, 1); assert.ok(watch.poller?.running);
  const first = watch.poller!;
  await timers.advance(0, first);
  assert.equal(fake.clips().length, 1);
  fake.queue.push({ body: { data: [raw('late', 50)] } });
  await timers.advance(30_000);
  bus.emit('stream-offline', { broadcasterId: '424242' });
  release(); await first.settled();
  assert.equal(first.running, false); assert.equal(watch.poller, undefined);
  assert.deepEqual(ids, [], 'the poll that was in flight at stream end emits nothing');
  assert.deepEqual(timers.pending, [], 'no poll is left scheduled');
  watch.sync(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(watch.poller, undefined, 'still Live in the studio after stream end: no restart');
  watch.sync(false); watch.sync(true); await new Promise(resolve => setImmediate(resolve));
  assert.ok((watch.poller as ClipPoller | undefined)?.running, 'a new Live session starts a new poller');
  watch.sync(false);
  assert.equal(watch.poller, undefined);
  watch.close();
  assert.deepEqual(timers.pending, []);
});

test('signed out: the watch does not poll', async () => {
  const timers = new FakeTimers();
  const watch = createClipWatch({ client: { auth: staticAuth(), baseUrl: 'http://127.0.0.1:9/helix', fetch: tracedFetch }, broadcaster: async () => undefined, emit: () => {}, timers });
  watch.sync(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(watch.poller, undefined); assert.deepEqual(timers.pending, []);
  watch.close();
});

const clip = (id: string, t: number, viewCount = 0): ClusterClip => ({ id, t, viewCount, url: `https://clips.twitch.tv/${id}`, thumbnailUrl: `https://clips-media-assets2.jtvnw.net/${id}.jpg` });
const run = (clips: ClusterClip[], config = defaultClipClusterConfig) => {
  let state = initialClipClusterState(); const steps = [];
  for (const item of clips) { const step = stepClipCluster(state, item, config); state = step.state; steps.push(step); }
  return steps;
};

test('cluster rule: 2 clips do not open a moment, 3 distinct clips do', () => {
  assert.deepEqual(defaultClipClusterConfig, { clipClusterMinClips: 3, clipClusterWindowSeconds: 120, clipClusterCooldownSeconds: 120 });
  assert.equal(run([clip('a', 0), clip('b', 30)]).some(step => step.opened), false);
  assert.equal(run([clip('a', 0), clip('a', 10), clip('b', 30)]).some(step => step.opened), false, 'the same clip twice counts once');
  const steps = run([clip('a', 0, 4), clip('b', 30, 12), clip('c', 60, 9)]);
  assert.deepEqual(steps.map(step => !!step.opened), [false, false, true]);
  assert.deepEqual(steps[2]!.opened!.clips.map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(steps[2]!.opened!.frame, { url: 'https://clips.twitch.tv/b', thumbnailUrl: 'https://clips-media-assets2.jtvnw.net/b.jpg' }, 'the most-viewed clip gives the frame');
});

test('cluster rule: 3 clips within 119 s open a moment, across 121 s they do not', () => {
  assert.ok(run([clip('a', 0), clip('b', 60), clip('c', 119)])[2]!.opened);
  assert.ok(run([clip('a', 0), clip('b', 60), clip('c', 120)])[2]!.opened, '120 s is still inside the window');
  assert.equal(run([clip('a', 0), clip('b', 60), clip('c', 121)])[2]!.opened, undefined);
  assert.equal(run([clip('a', 0), clip('c', 121), clip('b', 60)])[2]!.opened, undefined, 'order of arrival does not matter');
});

test('cluster rule: one cluster gives one moment, then a cooldown', () => {
  const steps = run([clip('a', 0), clip('b', 10), clip('c', 20), clip('d', 30), clip('e', 40), clip('f', 50), clip('g', 139), clip('h', 150), clip('i', 160), clip('j', 170)]);
  assert.deepEqual(steps.map(step => step.opened ? 'open' : step.merge ? 'merge' : '-'), ['-', '-', 'open', 'merge', 'merge', 'merge', 'merge', '-', '-', 'open']);
  assert.deepEqual(steps[9]!.opened!.clips.map(item => item.id), ['h', 'i', 'j'], 'clips before the cooldown ended are not reused');
});

test('polledClipOf reads only polled clip events, so older clip events keep their path', () => {
  const polled = polledClipOf({ id: 'clip-a', t: 12, type: 'clip', clip: { id: 'a', url: 'u', thumbnailUrl: 'th', viewCount: 2, createdAt: T0 } } as ClipStreamEvent);
  assert.deepEqual(polled && { id: polled.id, t: polled.t, viewCount: polled.viewCount, url: polled.url, thumbnailUrl: polled.thumbnailUrl }, { id: 'a', t: 12, viewCount: 2, url: 'u', thumbnailUrl: 'th' });
  assert.equal(polledClipOf({ t: 1, type: 'clip', name: 'x' }), undefined);
  assert.equal(polledClipOf({ t: 1, type: 'chat', text: 'hi' }), undefined);
});

test('safeClipUrl accepts only a plain https link to clips.twitch.tv or a *.jtvnw.net subdomain', () => {
  assert.equal(safeClipUrl('https://clips.twitch.tv/Abc'), 'https://clips.twitch.tv/Abc');
  assert.equal(safeClipUrl('https://clips-media-assets2.jtvnw.net/x.jpg'), 'https://clips-media-assets2.jtvnw.net/x.jpg');
  assert.equal(safeClipUrl('https://static-cdn.jtvnw.net/x.jpg'), 'https://static-cdn.jtvnw.net/x.jpg');
  assert.equal(safeClipUrl('HTTPS://CLIPS.TWITCH.TV/Abc'), 'https://clips.twitch.tv/Abc', 'the host is lower-cased');
  assert.equal(safeClipUrl('https://clips.twitch.tv/A\tbc'), 'https://clips.twitch.tv/Abc', 'a stray tab in the path is stripped like the URL parser does, not treated as a port bypass');
  assert.equal(safeClipUrl('https://clips.twitch.tv\\Abc'), 'https://clips.twitch.tv/Abc', 'a backslash path separator is still a plain path, not an open authority');

  const rejected = [
    'http://clips.twitch.tv/a', 'https://clips.twitch.tv.evil.example/a', 'https://evil-jtvnw.net/a', 'https://jtvnw.net/a',
    'https://evil.example/clips.twitch.tv', 'https://clips.twitch.tv@evil.example/a', 'https://user:pass@clips.twitch.tv/a',
    'https://user@clips.twitch.tv/a', 'https://clips.twitch.tv:443/a', 'https://clips.twitch.tv:8443/a',
    'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'data:image/png;base64,AAAA',
    'https://clips.twitch.tv./a', 'https://x.jtvnw.net./a',
    '', 'not a url', 'https://', '//clips.twitch.tv/a', 'clips.twitch.tv/a',
    // A tab, LF or CR hidden inside an explicit port, or a backslash standing in for the '/' before
    // the path: the URL parser silently drops or reinterprets these, so the raw authority is where
    // the bypass has to be caught.
    'https://clips.twitch.tv:8\t443/a', 'https://clips.twitch.tv:84\n43/a', 'https://clips.twitch.tv:8443\\a',
    'https://clips.twitch.tv:4\t43/a', 'https://clips.twitch.tv:\r443/a', 'https://clips.twitch.tv:443\\a',
    'https://x.jtvnw.net:8443\\a.jpg',
    // A third slash hides the authority from the raw check; url.port still sees the port.
    'https:///clips.twitch.tv:8443/a',
  ];
  for (const value of rejected) assert.equal(safeClipUrl(value), undefined, value);
  for (const value of [null, undefined, 42, {}]) assert.equal(safeClipUrl(value), undefined, String(value));
});

test('getClips drops a clip with a lookalike url and blanks (never drops) a clip with an unsafe thumbnail', async () => {
  const fake = await helixFake(); after(fake.close);
  fake.queue.push({ body: { data: [
    raw('good', 1),
    { ...raw('lookalike', 2), url: 'https://clips.twitch.tv.evil.example/lookalike' },
    { ...raw('js-thumb', 3), thumbnail_url: 'javascript:alert(1)' },
    { ...raw('http-thumb', 4), thumbnail_url: 'http://clips-media-assets2.jtvnw.net/http-thumb.jpg' },
  ], pagination: {} } });
  const result = await getClips({ auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch }, { broadcasterId: '1' });
  assert.deepEqual(result.clips.map(item => item.id), ['good', 'js-thumb', 'http-thumb'], 'the lookalike clip url is dropped entirely');
  assert.equal(result.clips.find(item => item.id === 'good')!.thumbnailUrl, 'https://clips-media-assets2.jtvnw.net/good.jpg');
  assert.equal(result.clips.find(item => item.id === 'js-thumb')!.thumbnailUrl, '', 'an unsafe thumbnail is blanked, not kept');
  assert.equal(result.clips.find(item => item.id === 'http-thumb')!.thumbnailUrl, '', 'a non-https thumbnail is blanked, not kept');
});

test('getClips drops a clip whose url hides a port bypass and blanks a thumbnail that hides one', async () => {
  const fake = await helixFake(); after(fake.close);
  fake.queue.push({ body: { data: [
    raw('good', 1),
    { ...raw('port-bypass', 2), url: 'https://clips.twitch.tv:8\t443/a' },
    { ...raw('thumb-bypass', 3), thumbnail_url: 'https://clips-media-assets2.jtvnw.net:8443\\t.jpg' },
  ], pagination: {} } });
  const result = await getClips({ auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch }, { broadcasterId: '1' });
  assert.deepEqual(result.clips.map(item => item.id), ['good', 'thumb-bypass'], 'the clip whose url hides a port bypass is dropped entirely');
  assert.equal(result.clips.find(item => item.id === 'thumb-bypass')!.thumbnailUrl, '', 'a thumbnail that hides a port bypass is blanked, not kept');
});

test('getClips maps a real Helix Get Clips fixture, whose url is a www.twitch.tv clip link', async () => {
  const fake = await helixFake(); after(fake.close);
  const slug = 'BraveTinyOtterSketch-Zx9_Qw3rTy-12AbCd';
  const thumb = `https://static-cdn.jtvnw.net/twitch-clips-thumbnails-prod/${slug}/9f1c2e4a-0b3d-4f5e-8a6b-7c8d9e0f1a2b/preview-480x272.jpg`;
  fake.queue.push({ body: { data: [{
    id: 'helix-fixture-1',
    url: `https://www.twitch.tv/inkwell_tester/clip/${slug}`,
    embed_url: `https://clips.twitch.tv/embed?clip=${slug}`,
    broadcaster_id: '111', broadcaster_name: 'inkwell_tester',
    creator_id: '222', creator_name: 'sketch_viewer_7',
    video_id: '333', game_id: '444', language: 'en',
    title: 'Panel test clip', view_count: 17, created_at: new Date(T0 + 5_000).toISOString(),
    thumbnail_url: thumb, duration: 12.3, vod_offset: null, is_featured: false,
  }], pagination: {} } });
  const result = await getClips({ auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch }, { broadcasterId: '111' });
  assert.deepEqual(result.clips.map(item => item.id), ['helix-fixture-1'], 'a real Helix clip url is kept, not dropped');
  const [kept] = result.clips;
  assert.equal(kept!.url, `https://www.twitch.tv/inkwell_tester/clip/${slug}`);
  assert.equal(kept!.thumbnailUrl, thumb);
  assert.equal(kept!.title, 'Panel test clip');
  assert.equal(kept!.creatorName, 'sketch_viewer_7');
});

test("safeClipUrl(x, 'clip') also accepts the Helix clip url shape on www.twitch.tv/twitch.tv", () => {
  const ch = 'inkwell_tester'; const slug = 'BraveTinyOtterSketch-Zx9_Qw3rTy-12AbCd';
  assert.equal(safeClipUrl(`https://www.twitch.tv/${ch}/clip/${slug}`, 'clip'), `https://www.twitch.tv/${ch}/clip/${slug}`);
  assert.equal(safeClipUrl(`https://twitch.tv/${ch}/clip/${slug}`, 'clip'), `https://twitch.tv/${ch}/clip/${slug}`);
  assert.equal(safeClipUrl(`https://www.twitch.tv/${ch}/clip/${slug}/`, 'clip'), `https://www.twitch.tv/${ch}/clip/${slug}/`, 'a single trailing slash is fine');
  assert.equal(safeClipUrl(`https://www.twitch.tv/${ch}/clip/${slug}?foo=bar`, 'clip'), `https://www.twitch.tv/${ch}/clip/${slug}?foo=bar`, 'a query string is fine');
  assert.equal(safeClipUrl(`HTTPS://WWW.TWITCH.TV/${ch}/clip/${slug}`, 'clip'), `https://www.twitch.tv/${ch}/clip/${slug}`, 'the host is lower-cased');
  const longChannel = 'a'.repeat(25);
  assert.equal(safeClipUrl(`https://www.twitch.tv/${longChannel}/clip/${slug}`, 'clip'), `https://www.twitch.tv/${longChannel}/clip/${slug}`, 'a 25-char channel is still fine');
  assert.equal(safeClipUrl(`https://www.twitch.tv/under_score_42/clip/${slug}`, 'clip'), `https://www.twitch.tv/under_score_42/clip/${slug}`);
  assert.equal(safeClipUrl('https://clips.twitch.tv/Abc', 'clip'), 'https://clips.twitch.tv/Abc', 'clips.twitch.tv is still accepted alongside the new rule');

  const rejected = [
    'https://www.twitch.tv/videos/1', `https://www.twitch.tv/${ch}`, `https://www.twitch.tv/${ch}/clip`,
    `https://www.twitch.tv/${ch}/clip/`, `https://www.twitch.tv/${ch}/clips/${slug}`, `https://www.twitch.tv/${ch}/CLIP/${slug}`,
    `https://www.twitch.tv/${ch}/clip/${slug}/extra`, `https://www.twitch.tv//clip/${slug}`,
    `https://www.twitch.tv/extra/${ch}/clip/${slug}`, `https://www.twitch.tv/videos/${ch}/clip/${slug}`,
    `https://www.twitch.tv/${'a'.repeat(26)}/clip/${slug}`, `https://www.twitch.tv/chan-nel/clip/${slug}`,
    `https://www.twitch.tv/chan.nel/clip/${slug}`, `https://www.twitch.tv/${ch}/clip/has.dot`,
    `https://www.twitch.tv/${ch}/clip/has%2Fslash`, `https://www.twitch.tv/${ch}/clip/a/../../videos/1`,
    `http://www.twitch.tv/${ch}/clip/${slug}`, `https://m.twitch.tv/${ch}/clip/${slug}`,
    `https://www.twitch.tv.evil.example/${ch}/clip/${slug}`, `https://evil.example/www.twitch.tv/${ch}/clip/${slug}`,
    `https://www.twitch.tv./${ch}/clip/${slug}`, `https://user@www.twitch.tv/${ch}/clip/${slug}`,
    `https://www.twitch.tv@evil.example/${ch}/clip/${slug}`, `https://www.twitch.tv:443/${ch}/clip/${slug}`,
    `https://twitch.tv:8443/${ch}/clip/${slug}`, `https://www.twitch.tv:8\t443/${ch}/clip/${slug}`,
    `https://www.twitch.tv:8443\\${ch}/clip/${slug}`, `https:///www.twitch.tv:8443/${ch}/clip/${slug}`,
    'https://clips.twitch.tv.evil.example/a',
  ];
  for (const value of rejected) assert.equal(safeClipUrl(value, 'clip'), undefined, value);
});

test('thumbnails stay strict: a www.twitch.tv clip link is never accepted as a thumbnail', async () => {
  const ch = 'inkwell_tester'; const slug = 'BraveTinyOtterSketch-Zx9_Qw3rTy-12AbCd';
  const clipUrl = `https://www.twitch.tv/${ch}/clip/${slug}`;
  assert.equal(safeClipUrl(clipUrl), undefined, 'the default kind is thumbnail');
  assert.equal(safeClipUrl(clipUrl, 'thumbnail'), undefined);
  const fake = await helixFake(); after(fake.close);
  fake.queue.push({ body: { data: [{ ...raw('thumb-is-clip-url', 1), thumbnail_url: clipUrl }], pagination: {} } });
  const result = await getClips({ auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch }, { broadcasterId: '1' });
  assert.deepEqual(result.clips.map(item => item.id), ['thumb-is-clip-url'], 'the clip is kept even though its thumbnail is unsafe');
  assert.equal(result.clips[0]!.thumbnailUrl, '', 'a www.twitch.tv clip link is blanked, not kept, as a thumbnail');
});

test('getClips keeps a real www.twitch.tv clip url and drops the other www.twitch.tv shapes', async () => {
  const ch = 'inkwell_tester'; const slug = 'BraveTinyOtterSketch-Zx9_Qw3rTy-12AbCd';
  const fake = await helixFake(); after(fake.close);
  fake.queue.push({ body: { data: [
    { ...raw('kept', 1), url: `https://www.twitch.tv/${ch}/clip/${slug}` },
    { ...raw('not-a-clip-path', 2), url: 'https://www.twitch.tv/videos/1' },
    { ...raw('no-clip-segment', 3), url: `https://www.twitch.tv/${ch}` },
    { ...raw('http-not-https', 4), url: `http://www.twitch.tv/${ch}/clip/${slug}` },
  ], pagination: {} } });
  const result = await getClips({ auth: staticAuth(), baseUrl: fake.helix, fetch: tracedFetch }, { broadcasterId: '1' });
  assert.deepEqual(result.clips.map(item => item.id), ['kept'], 'only the real Helix clip url shape is kept');
  assert.equal(result.clips[0]!.url, `https://www.twitch.tv/${ch}/clip/${slug}`);
});

test('no host other than loopback was looked up or fetched', () => {
  assert.ok(hosts.length > 0, 'the trace saw the loopback traffic');
  assert.deepEqual(hosts.filter(host => !loopback(host)), []);
});
