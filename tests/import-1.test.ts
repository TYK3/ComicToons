// IMPORT-1: paste a Twitch link (VOD, clip or channel), get a short comic, and log it to the channel's manga
// series. Everything runs against a fake Helix on loopback (port 0) with an in-process egress guard: any
// non-loopback connect or fetch is refused and recorded, and the test asserts none happened. The art
// network stays off (COMICTOONS_ART_NETWORK unset), so no frame is fetched or inked unless a test injects it.
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type Server} from 'node:http';
import net, {type AddressInfo} from 'node:net';
import {mkdtemp, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';
import Fastify, {type FastifyInstance} from 'fastify';
import {appendChapter, emptyChannelSeries, type SeriesChapter} from '../packages/core/src/manga.ts';
import {MAX_PANELS, MAX_VOD_SECONDS, SINGLE_CLIP_MAX_PANELS, vodClampNote} from '../apps/server/src/import/caps.ts';
import {parseImportInput, parseImportUrl} from '../apps/server/src/import/urls.ts';
import {parseHelixDuration} from '../apps/server/src/import/helix.ts';
import {parseChatLog} from '../apps/server/src/import/chatlog.ts';
import {buildPanelsFromClips, selectVodClips, type ImportClip} from '../apps/server/src/import/panels.ts';
import {ImportResults} from '../apps/server/src/import/results.ts';
import {importArtPrompt, importRoutes} from '../apps/server/src/import/routes.ts';
import {ChannelSeriesStore} from '../apps/server/src/series/store.ts';
import {seriesRoutes} from '../apps/server/src/series/routes.ts';
import {directorGuard} from '../apps/server/src/director-access.ts';
import type {TwitchAuthProvider} from '../apps/server/src/twitch-api/types.ts';

// ---- egress guard ------------------------------------------------------------------------------
const egress: string[] = [];
const local = (host?: string) => !host || host === 'localhost' || host === '::1' || host === '[::1]' || (/^127\./.test(host) && net.isIP(host) === 4);
const realConnect = net.Socket.prototype.connect;
const realFetch = globalThis.fetch;
before(() => {
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = (Array.isArray(args[0]) ? args[0] : args) as unknown[];
    const options = first[0] as {host?: string; path?: string} | number | string;
    const host = typeof options === 'object' ? options?.host : typeof first[1] === 'string' ? first[1] : undefined;
    if (!(typeof options === 'object' && options?.path) && !local(host)) { egress.push(`connect ${host}`); throw new Error(`refused non-loopback connect to ${host}`); }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof realConnect;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!local(url.hostname)) { egress.push(`fetch ${url.host}`); return Promise.reject(new Error(`refused fetch to ${url.host}`)); }
    return realFetch(input, init);
  }) as typeof fetch;
});
after(() => { net.Socket.prototype.connect = realConnect; globalThis.fetch = realFetch; });

// ---- URL parsing -------------------------------------------------------------------------------
describe('IMPORT-1 URL parsing', () => {
  const good: [string, ReturnType<typeof parseImportUrl>][] = [
    ['https://clips.twitch.tv/BraveTinyOtter-AbC_12', {kind: 'clip', slug: 'BraveTinyOtter-AbC_12'}],
    ['clips.twitch.tv/BraveTinyOtter-AbC_12', {kind: 'clip', slug: 'BraveTinyOtter-AbC_12'}],
    ['https://clips.twitch.tv/BraveTinyOtter-AbC_12?tt_medium=x', {kind: 'clip', slug: 'BraveTinyOtter-AbC_12'}],
    ['https://www.twitch.tv/somechannel/clip/BraveTinyOtter-AbC_12', {kind: 'clip', slug: 'BraveTinyOtter-AbC_12', channel: 'somechannel'}],
    ['twitch.tv/SomeChannel/clip/BraveTinyOtter-AbC_12?filter=clips', {kind: 'clip', slug: 'BraveTinyOtter-AbC_12', channel: 'somechannel'}],
    // IMPORT-LIVE-1: the share link the Twitch site gives today carries ?range=7d.
    ['https://www.twitch.tv/SomeChannel/clip/QuietBraveOtterPogChamp-ugHoE6TBMdKO_dVc?range=7d', {kind: 'clip', slug: 'QuietBraveOtterPogChamp-ugHoE6TBMdKO_dVc', channel: 'somechannel'}],
    ['https://m.twitch.tv/somechannel/clip/BraveTinyOtter-AbC_12', {kind: 'clip', slug: 'BraveTinyOtter-AbC_12', channel: 'somechannel'}],
    ['https://www.twitch.tv/videos/2915943191', {kind: 'vod', id: '2915943191'}],
    ['twitch.tv/videos/2915943191?t=0h1m2s', {kind: 'vod', id: '2915943191'}],
    ['  https://twitch.tv/SomeChannel  ', {kind: 'live', channel: 'somechannel'}],
  ];
  for (const [input, expected] of good) test(`accepts ${input.trim()}`, () => assert.deepEqual(parseImportUrl(input), expected));

  const bad = ['', '   ', 'not a link', 'https://youtube.com/watch?v=x', 'https://twitch.tv/videos/abc', 'https://twitch.tv/videos/',
    'https://clips.twitch.tv/', 'https://twitch.tv/chan/clip/', 'https://twitch.tv/chan/clip/bad slug', 'https://twitch.tv/a/b',
    'javascript:alert(1)', 'ftp://twitch.tv/videos/1', 'https://evil.example/twitch.tv/videos/1', 'https://twitch.tv.evil.example/videos/1',
    'https://twitch.tv/directory', 'https://user:pass@twitch.tv/videos/1'];
  for (const input of bad) test(`refuses ${JSON.stringify(input)} with a clear 400`, () => {
    assert.throws(() => parseImportUrl(input), (error: {code?: string; status?: number; message: string}) =>
      error.code === 'bad-url' && error.status === 400 && error.message.length > 0 && !/at \w+ \(/.test(error.message));
  });

  test('the box: one link, several clip links (one per line), never a mix', () => {
    assert.deepEqual(parseImportInput('https://clips.twitch.tv/A1\n\n twitch.tv/c/clip/B2 \n'), {kind: 'clips', slugs: ['A1', 'B2'], channel: 'c'});
    assert.deepEqual(parseImportInput('https://twitch.tv/videos/1'), {kind: 'vod', id: '1'});
    assert.throws(() => parseImportInput('https://clips.twitch.tv/A1\nhttps://twitch.tv/videos/1'), /every line is a clip/);
    const tooMany = Array.from({length: MAX_PANELS + 1}, (_, index) => `https://clips.twitch.tv/C${index}`).join('\n');
    assert.throws(() => parseImportInput(tooMany), new RegExp(`up to ${MAX_PANELS} clip links`, 'i'));
    assert.equal((parseImportInput(tooMany.split('\n').slice(0, MAX_PANELS).join('\n')) as {slugs: string[]}).slugs.length, MAX_PANELS);
  });
});

// ---- caps, durations, chat log, panels ---------------------------------------------------------
test('caps are the ruled config constants', () => {
  assert.equal(MAX_VOD_SECONDS, 600);
  assert.equal(MAX_PANELS, 6);
  assert.equal(SINGLE_CLIP_MAX_PANELS, 4);
});

test('clamp copy (lead ruling 22:56): a VOD over 10 min says, in plain words, that only its first 10 min were used', () => {
  assert.equal(vodClampNote(47 * 60), 'Used the first 10 min of a 47 min video.');
  assert.equal(vodClampNote(2504), 'Used the first 10 min of a 42 min video.');
  assert.equal(vodClampNote(2 * 3600 + 51 * 60 + 18), 'Used the first 10 min of a 171 min video.');
  assert.equal(vodClampNote(MAX_VOD_SECONDS), undefined, 'exactly 10 min: the whole video was used');
  assert.equal(vodClampNote(300), undefined);
});

test('Helix video durations', () => {
  assert.equal(parseHelixDuration('41m44s'), 2504);
  assert.equal(parseHelixDuration('2h51m18s'), 10278);
  assert.equal(parseHelixDuration('35s'), 35);
  assert.equal(parseHelixDuration(''), undefined);
  assert.equal(parseHelixDuration('soon'), undefined);
});

test('chat log: .txt and .json, unsafe text dropped, bad JSON is a clear error', () => {
  assert.deepEqual(parseChatLog('[00:01:02] viewer1: hello\nplain line\n\n', 'txt').map(line => [line.t, line.user, line.text]),
    [[62, 'viewer1', 'hello'], [undefined, undefined, 'plain line']]);
  assert.deepEqual(parseChatLog(JSON.stringify([{t: 3, user: 'v', text: 'hi'}, {message: 'yo'}, {nope: 1}]), 'json').map(line => line.text), ['hi', 'yo']);
  assert.throws(() => parseChatLog('{oops', 'json'), (error: {code?: string}) => error.code === 'bad-chat-log');
});

const clip = (index: number, over: Partial<ImportClip & {viewCount: number}> = {}): ImportClip & {viewCount: number} => ({
  id: `Clip${index}`, title: `Clip title ${index}`, thumbnailUrl: `http://127.0.0.1:9/thumb/${index}.jpg`, url: `https://clips.twitch.tv/Clip${index}`,
  createdAt: Date.UTC(2026, 9, 31, 20, 0, 0) + index * 60_000, viewCount: index, ...over,
});
const caps = {maxPanels: MAX_PANELS, singleClipMaxPanels: SINGLE_CLIP_MAX_PANELS};

test(`a single clip makes 1-${SINGLE_CLIP_MAX_PANELS} panels from its title, thumbnail and the optional chat log`, () => {
  const one = [clip(1)];
  const lines = (count: number) => Array.from({length: count}, (_, index) => ({text: `line ${index + 1}`}));
  const none = buildPanelsFromClips(one, [], caps, {expandSingleClip: true});
  assert.equal(none.length, 1);
  assert.equal(none[0]!.caption, 'Clip title 1');
  assert.equal(none[0]!.imageUrl, one[0]!.thumbnailUrl);
  assert.equal(none[0]!.origin, 'twitch');
  assert.equal(buildPanelsFromClips(one, lines(2), caps, {expandSingleClip: true}).length, 2);
  const many = buildPanelsFromClips(one, lines(10), caps, {expandSingleClip: true});
  assert.equal(many.length, SINGLE_CLIP_MAX_PANELS);
  assert.deepEqual(many.flatMap(panel => panel.dialogue), lines(10).map(line => line.text), 'every line kept, in order, never reordered');
  assert.ok(many.every(panel => panel.imageUrl === one[0]!.thumbnailUrl));
});

test(`VOD clips: only clips inside the capped window, at most ${MAX_PANELS}, the most viewed, in time order`, () => {
  const start = clip(0).createdAt;
  const clips = [...Array.from({length: 9}, (_, index) => clip(index, {viewCount: [5, 90, 1, 70, 60, 2, 80, 50, 40][index]})),
    clip(20, {viewCount: 999})]; // 20 min in: outside a 10-min window
  const chosen = selectVodClips(clips, {startedAt: start, endedAt: start + MAX_VOD_SECONDS * 1000}, MAX_PANELS);
  assert.equal(chosen.length, MAX_PANELS);
  assert.deepEqual(chosen.map(item => item.id), ['Clip1', 'Clip3', 'Clip4', 'Clip6', 'Clip7', 'Clip8']);
  const panels = buildPanelsFromClips(chosen, [], caps, {sessionStartedAt: start, expandSingleClip: false});
  assert.equal(panels.length, MAX_PANELS, 'one panel per clip');
  assert.deepEqual(panels.map(panel => panel.at), [60, 180, 240, 360, 420, 480]);
  assert.equal(buildPanelsFromClips(Array.from({length: 9}, (_, index) => clip(index)), [], caps, {expandSingleClip: false}).length, MAX_PANELS);
});

// ---- series ------------------------------------------------------------------------------------
const chapter = (id: string, over: Partial<SeriesChapter> = {}): SeriesChapter => ({id, title: `Chapter ${id}`, sourceUrl: `https://clips.twitch.tv/${id}`, sourceKind: 'clip', createdAt: 1, panels: [], ...over});

test('appendChapter is pure and keeps the order chapters were added', () => {
  const empty = emptyChannelSeries('somechannel');
  const one = appendChapter(empty, chapter('a'));
  const two = appendChapter(one, chapter('b'));
  assert.deepEqual(empty.chapters, []);
  assert.deepEqual(one.chapters.map(item => item.id), ['a']);
  assert.deepEqual(two.chapters.map(item => item.id), ['a', 'b']);
});

test('the series store persists appends atomically, one file per channel', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-1-series-'));
  const store = new ChannelSeriesStore(directory);
  await store.append('somechannel', chapter('a'));
  await store.append('somechannel', chapter('b'));
  const reopened = new ChannelSeriesStore(directory);
  assert.deepEqual((await reopened.read('somechannel')).chapters.map(item => item.id), ['a', 'b']);
  assert.deepEqual((await reopened.read('otherchannel')).chapters, []);
  assert.deepEqual((await readdir(directory)).sort(), ['somechannel.json'], 'no temp files left behind');
  await assert.rejects(reopened.read('../etc'), /channel/i);
});

// ---- the routes end to end, against a fake Helix -----------------------------------------------
const VOD_START = Date.UTC(2026, 9, 31, 19, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
interface FakeClip { id: string; broadcaster_id: string; broadcaster_name: string; title: string; created_at: string; view_count: number; url: string; thumbnail_url: string; video_id: string; vod_offset: number | null; duration: number }

function fakeHelix() {
  const requests: URL[] = [];
  let origin = '';
  const clips: FakeClip[] = [];
  const addClip = (id: string, minutes: number, views: number, broadcaster = '1001', name = 'SomeChannel') => clips.push({id, broadcaster_id: broadcaster, broadcaster_name: name,
    title: `Moment ${id}`, created_at: iso(VOD_START + minutes * 60_000), view_count: views, url: `https://clips.twitch.tv/${id}`,
    thumbnail_url: `https://static-cdn.jtvnw.net/fake-import/${id}-preview-480x272.jpg`, video_id: '', vod_offset: null, duration: 30});
  const videos: Record<string, {id: string; user_id: string; user_login: string; title: string; created_at: string; duration: string; thumbnail_url: string; url: string}> = {};
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', origin);
    requests.push(url);
    if (req.headers.authorization !== 'Bearer fake-app-token' || req.headers['client-id'] !== 'fake-client') { res.writeHead(401).end(); return; }
    const json = (body: unknown) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
    if (url.pathname === '/helix/videos') { const video = videos[url.searchParams.get('id') ?? '']; json({data: video ? [video] : [], pagination: {}}); return; }
    if (url.pathname === '/helix/clips') {
      const ids = url.searchParams.getAll('id');
      if (ids.length) { json({data: clips.filter(item => ids.includes(item.id)), pagination: {}}); return; }
      const from = Date.parse(url.searchParams.get('started_at') ?? ''), to = Date.parse(url.searchParams.get('ended_at') ?? '');
      json({data: clips.filter(item => item.broadcaster_id === url.searchParams.get('broadcaster_id') && Date.parse(item.created_at) >= from && Date.parse(item.created_at) <= to), pagination: {}});
      return;
    }
    res.writeHead(404).end();
  });
  return {
    requests, clips, videos, addClip,
    async start() { await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; return origin; },
    stop: () => new Promise<void>(done => server.close(() => done())),
  };
}

const auth: TwitchAuthProvider = {getAuth: async () => ({clientId: 'fake-client', accessToken: 'fake-app-token', broadcasterId: '', login: ''}), refresh: async () => {}} as TwitchAuthProvider;

describe('IMPORT-1 routes end to end (fake Helix on loopback)', () => {
  const helix = fakeHelix();
  let app: FastifyInstance; let base = ''; let seriesDirectory = ''; let framesDirectory = '';
  const liveCalls: [string, string][] = [];
  type Panel = {caption: string; at: number; imageUrl: string; frameUrl?: string; dialogue: string[]};
  type ResponseBody = {error: string; kind: string; channel?: string; title: string; importId: string; panels: Panel[]; missing?: string[];
    window?: {vodSeconds: number; usedSeconds: number; capped: boolean}; book?: unknown; series?: unknown;
    note?: string; chapter: {title: string; sourceKind: string; sourceUrl: string; panels: Panel[]; note?: string}};
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json() as ResponseBody};
  };
  before(async () => {
    const helixOrigin = await helix.start();
    helix.videos['500'] = {id: '500', user_id: '1001', user_login: 'somechannel', title: 'Long stream', created_at: iso(VOD_START), duration: '41m44s', thumbnail_url: '', url: 'https://www.twitch.tv/videos/500'};
    helix.videos['501'] = {id: '501', user_id: '1001', user_login: 'somechannel', title: 'Short stream', created_at: iso(VOD_START), duration: '5m0s', thumbnail_url: '', url: 'https://www.twitch.tv/videos/501'};
    helix.videos['502'] = {id: '502', user_id: '2002', user_login: 'quietchannel', title: 'No clips', created_at: iso(VOD_START), duration: '3m0s', thumbnail_url: '', url: 'https://www.twitch.tv/videos/502'};
    [[1, 5], [2, 90], [3, 1], [4, 70], [5, 60], [6, 2], [7, 80], [8, 50], [9, 40], [25, 999]].forEach(([minute, views]) => helix.addClip(`Vod${minute}`, minute!, views!));
    // IMPORT-LIVE-1: real Twitch had short VODs (583 s, 590 s) with no clips. 503/504 are those shapes on the fake.
    helix.videos['503'] = {id: '503', user_id: '2002', user_login: 'quietchannel', title: 'Almost ten', created_at: iso(VOD_START), duration: '9m50s', thumbnail_url: '', url: 'https://www.twitch.tv/videos/503'};
    helix.videos['504'] = {id: '504', user_id: '2002', user_login: 'quietchannel', title: 'Long and quiet', created_at: iso(VOD_START), duration: '47m0s', thumbnail_url: '', url: 'https://www.twitch.tv/videos/504'};
    helix.addClip('MadeLater_1', 60 * 24, 9, '2002', 'QuietChannel'); // made a day after the stream, from its VOD
    helix.addClip('Single-Clip_1', 1, 3, '3003');
    helix.addClip('Other_2', 2, 3, '3003');
    // IMPORT-LIVE-1 r2: clips whose Helix urls fail clip-url-1's allow-list (safeClipUrl in ingest/clips.ts).
    helix.addClip('Unsafe_Thumb', 3, 3, '3003'); helix.clips.at(-1)!.thumbnail_url = 'http://169.254.169.254/latest/meta-data/x-preview-480x272.jpg';
    helix.addClip('Unsafe_Url', 4, 3, '3003'); helix.clips.at(-1)!.url = 'https://evil.example/Unsafe_Url';
    helix.addClip('Unsafe_Port', 4, 3, '3003'); helix.clips.at(-1)!.url = 'https://www.twitch.tv:8443/somechannel/clip/Unsafe_Port';
    helix.addClip('Unsafe_Host', 4, 3, '3003'); helix.clips.at(-1)!.url = 'https://www.twitch.tv.evil.example/somechannel/clip/Unsafe_Host';
    // The url shape real Helix returns today (IMPORT-LIVE-1 live check, 1 Nov 2026): twitch.tv/<channel>/clip/<slug>, not clips.twitch.tv.
    helix.addClip('Real_Shape_1', 5, 3, '3003'); helix.clips.at(-1)!.url = 'https://www.twitch.tv/somechannel/clip/Real_Shape_1';
    seriesDirectory = await mkdtemp(join(tmpdir(), 'import-1-route-series-'));
    framesDirectory = await mkdtemp(join(tmpdir(), 'import-1-route-frames-'));
    app = Fastify({logger: false});
    const results = new ImportResults();
    const guard = directorGuard(undefined);
    await app.register(importRoutes, {studio: {useSource: (mode: 'sample' | 'twitch', channel?: string) => { liveCalls.push([mode, channel ?? '']); return {ok: true}; }} as never,
      client: {auth, baseUrl: `${helixOrigin}/helix`}, results, guard, framesDirectory, env: {}});
    await app.register(seriesRoutes, {store: new ChannelSeriesStore(seriesDirectory), results, guard});
    base = await app.listen({host: '127.0.0.1', port: 0});
  });
  after(async () => { await app?.close(); await helix.stop(); });

  test(`a long VOD: the window is capped at ${MAX_VOD_SECONDS / 60} min and the ${MAX_PANELS} most viewed clips in it make one panel each`, async () => {
    const {status, body} = await post('/api/import', {input: 'https://www.twitch.tv/videos/500'});
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.kind, 'vod');
    assert.equal(body.channel, 'somechannel');
    assert.deepEqual(body.window, {vodSeconds: 2504, usedSeconds: MAX_VOD_SECONDS, capped: true, note: 'Used the first 10 min of a 42 min video.'});
    assert.equal(body.note, 'Used the first 10 min of a 42 min video.', 'the result says so in plain words');
    const lookup = helix.requests.filter(url => url.pathname === '/helix/clips' && url.searchParams.get('broadcaster_id') === '1001').at(-1)!;
    assert.equal(lookup.searchParams.get('started_at'), new Date(VOD_START).toISOString());
    assert.equal(lookup.searchParams.get('ended_at'), new Date(VOD_START + MAX_VOD_SECONDS * 1000).toISOString(), 'Get Clips asked for the capped window only');
    assert.equal(body.panels.length, MAX_PANELS);
    assert.deepEqual(body.panels.map((panel: {caption: string}) => panel.caption), ['Moment Vod2', 'Moment Vod4', 'Moment Vod5', 'Moment Vod7', 'Moment Vod8', 'Moment Vod9']);
    assert.deepEqual(body.panels.map((panel: {at: number}) => panel.at), [120, 240, 300, 420, 480, 540]);
    assert.ok(body.panels.every((panel: {imageUrl: string}) => panel.imageUrl.startsWith('https://static-cdn.jtvnw.net/fake-import/')), 'art network off: the clip thumbnail is the frame');
    assert.ok(body.book && body.series, 'the normal comic book and manga outputs come back too');
    assert.equal(typeof body.importId, 'string');
  });

  test('a short VOD uses its whole length; a VOD with no clips and a missing VOD are clear errors', async () => {
    const short = await post('/api/import', {input: 'twitch.tv/videos/501'});
    assert.equal(short.status, 200);
    assert.deepEqual(short.body.window, {vodSeconds: 300, usedSeconds: 300, capped: false});
    assert.deepEqual(short.body.panels.map((panel: {caption: string}) => panel.caption), ['Moment Vod1', 'Moment Vod2', 'Moment Vod3', 'Moment Vod4', 'Moment Vod5'], 'a clip at exactly 5:00 is inside the window');
    const none = await post('/api/import', {input: 'twitch.tv/videos/502'});
    assert.equal(none.status, 404); assert.match(none.body.error, /No clips/);
    const missing = await post('/api/import', {input: 'twitch.tv/videos/999'});
    assert.equal(missing.status, 404); assert.match(missing.body.error, /private, deleted, or could not be found/);
  });

  test('IMPORT-LIVE-1 defect: "no clips" says the real length, is not a clamp for a short VOD, and does not advise making a clip', async () => {
    const short = await post('/api/import', {input: 'https://www.twitch.tv/videos/503'});
    assert.equal(short.status, 404);
    assert.equal(short.body.error, 'No clips were made during this 10 min video, so there is nothing to turn into panels. Paste a clip link instead.');
    const long = await post('/api/import', {input: 'https://www.twitch.tv/videos/504'});
    assert.equal(long.status, 404);
    assert.equal(long.body.error, 'No clips were made in the first 10 min of this 47 min video, so there is nothing to turn into panels. Paste a clip link instead.');
    // Why "Make a clip, then try again" was wrong: Get Clips filters on when a clip was made, so a clip made after the stream is never in the window.
    assert.ok(helix.clips.some(clip => clip.id === 'MadeLater_1'));
    assert.doesNotMatch(short.body.error + long.body.error, /Make a clip/);
  });

  test('a single clip URL, in both forms, looked up with GET /helix/clips?id=, makes 1-4 panels', async () => {
    const plain = await post('/api/import', {input: 'https://clips.twitch.tv/Single-Clip_1'});
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(plain.body.kind, 'clip'); assert.equal(plain.body.panels.length, 1); assert.equal(plain.body.title, 'Moment Single-Clip_1');
    assert.equal(plain.body.channel, 'somechannel');
    assert.ok(helix.requests.some(url => url.pathname === '/helix/clips' && url.searchParams.getAll('id').join() === 'Single-Clip_1'));
    const chatLog = Array.from({length: 9}, (_, index) => `[00:00:0${index}] viewer${index}: line ${index}`).join('\n');
    const withChat = await post('/api/import', {input: 'https://www.twitch.tv/somechannel/clip/Single-Clip_1', chatLog, chatLogFormat: 'txt'});
    assert.equal(withChat.status, 200);
    assert.equal(withChat.body.panels.length, SINGLE_CLIP_MAX_PANELS);
    assert.equal(withChat.body.panels.flatMap((panel: {dialogue: string[]}) => panel.dialogue).length, 9);
    assert.deepEqual(withChat.body.panels.map((panel: {dialogue: string[]}) => panel.dialogue.length), [3, 2, 2, 2], 'balanced, contiguous, none empty');
    const missing = await post('/api/import', {input: 'https://clips.twitch.tv/NoSuchClip'});
    assert.equal(missing.status, 404); assert.match(missing.body.error, /clip is private, deleted, or could not be found/);
  });

  test('several clip URLs make one panel each, in the order pasted; missing ones are listed', async () => {
    const {status, body} = await post('/api/import', {input: 'https://clips.twitch.tv/Other_2\nhttps://clips.twitch.tv/Gone\nclips.twitch.tv/Single-Clip_1'});
    assert.equal(status, 200);
    assert.deepEqual(body.panels.map((panel: {caption: string}) => panel.caption), ['Moment Other_2', 'Moment Single-Clip_1']);
    assert.deepEqual(body.missing, ['Gone']);
  });

  test('bad input is a 400 with a message; a channel link starts the read-only live session', async () => {
    const bad = await post('/api/import', {input: 'https://youtube.com/watch?v=1'});
    assert.equal(bad.status, 400); assert.match(bad.body.error, /not a Twitch link/);
    const badLog = await post('/api/import', {input: 'https://clips.twitch.tv/Single-Clip_1', chatLog: '{', chatLogFormat: 'json'});
    assert.equal(badLog.status, 400); assert.match(badLog.body.error, /JSON/);
    const live = await post('/api/import', {input: 'https://twitch.tv/SomeChannel'});
    assert.equal(live.status, 200); assert.equal(live.body.kind, 'live');
    assert.deepEqual(liveCalls, [['twitch', 'somechannel']]);
  });

  test('an import is appended to the channel series as a chapter, and survives a new store', async () => {
    const empty = await (await fetch(`${base}/api/channel-series/somechannel`)).json() as {channel: string; chapters: unknown[]};
    assert.deepEqual(empty, {channel: 'somechannel', chapters: []});
    const first = await post('/api/import', {input: 'https://clips.twitch.tv/Single-Clip_1'});
    const second = await post('/api/import', {input: 'twitch.tv/videos/501'});
    const a = await post('/api/channel-series/somechannel/chapters', {importId: first.body.importId, title: 'The otter strikes'});
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.chapter.title, 'The otter strikes');
    assert.equal(a.body.chapter.sourceKind, 'clip');
    assert.equal(a.body.chapter.sourceUrl, 'https://clips.twitch.tv/Single-Clip_1');
    const b = await post('/api/channel-series/somechannel/chapters', {importId: second.body.importId});
    assert.equal(b.status, 201);
    assert.equal(b.body.chapter.title, 'Short stream', 'the title defaults to the import title');
    assert.equal(b.body.chapter.panels.length, 5);
    assert.equal(b.body.chapter.note, undefined, 'a short VOD was used whole: no clamp note');
    const series = await (await fetch(`${base}/api/channel-series/somechannel`)).json() as {chapters: {title: string; sourceKind: string; number: number}[]};
    assert.deepEqual(series.chapters.map(item => [item.number, item.title, item.sourceKind]), [[1, 'The otter strikes', 'clip'], [2, 'Short stream', 'vod']]);
    assert.deepEqual((await new ChannelSeriesStore(seriesDirectory).read('somechannel')).chapters.map(item => item.title), ['The otter strikes', 'Short stream']);
    const unknown = await post('/api/channel-series/somechannel/chapters', {importId: '00000000-0000-4000-8000-000000000000'});
    assert.equal(unknown.status, 404); assert.match(unknown.body.error, /Import it again/);
    const badChannel = await post('/api/channel-series/bad..name/chapters', {importId: first.body.importId});
    assert.equal(badChannel.status, 400);
  });

  test('a clamped VOD keeps its plain-words note in the series chapter', async () => {
    const long = await post('/api/import', {input: 'https://www.twitch.tv/videos/500'});
    const added = await post('/api/channel-series/clampchannel/chapters', {importId: long.body.importId});
    assert.equal(added.status, 201);
    assert.equal(added.body.chapter.note, 'Used the first 10 min of a 42 min video.');
  });

  test('writes need the director key when one is set', async () => {
    const guarded = Fastify({logger: false});
    const results = new ImportResults();
    const guard = directorGuard('a-test-key');
    await guarded.register(importRoutes, {studio: {useSource: () => ({})} as never, client: {auth, baseUrl: 'http://127.0.0.1:9/helix'}, results, guard, framesDirectory, env: {}});
    await guarded.register(seriesRoutes, {store: new ChannelSeriesStore(seriesDirectory), results, guard});
    const imported = await guarded.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/x'}});
    assert.equal(imported.statusCode, 401);
    const appended = await guarded.inject({method: 'POST', url: '/api/channel-series/somechannel/chapters', payload: {importId: 'x'}});
    assert.equal(appended.statusCode, 401);
    assert.equal((await guarded.inject({method: 'GET', url: '/api/channel-series/somechannel'})).statusCode, 200, 'reading the series stays open, like other reads');
    await guarded.close();
  });

  test('with the art network on, clip frames are inked and served locally', async () => {
    const inkApp = Fastify({logger: false});
    const results = new ImportResults();
    let calls = 0;
    await inkApp.register(importRoutes, {studio: {useSource: () => ({})} as never, client: {auth, baseUrl: `${new URL(helix.requests[0]!.href).origin}/helix`}, results,
      guard: directorGuard(undefined), framesDirectory, env: {COMICTOONS_ART_NETWORK: '1'}, inkFrame: async () => { calls++; return {buffer: Buffer.from('fake-png'), ms: 1}; }});
    const {statusCode, json} = await inkApp.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Single-Clip_1'}});
    assert.equal(statusCode, 200);
    const panel = json().panels[0] as {imageUrl: string; frameUrl?: string};
    assert.equal(calls, 1);
    assert.match(panel.imageUrl, /^\/api\/import\/frame\/[a-f0-9-]{36}\.png$/);
    assert.match(panel.frameUrl ?? '', /^https:\/\/static-cdn\.jtvnw\.net\/fake-import\//, 'the original thumbnail is kept as frameUrl');
    const frame = await inkApp.inject({method: 'GET', url: panel.imageUrl});
    assert.equal(frame.statusCode, 200); assert.equal(frame.body, 'fake-png');
    assert.equal((await inkApp.inject({method: 'GET', url: '/api/import/frame/..%2F..%2Fetc.png'})).statusCode, 404);
    await inkApp.close();
  });

  test('Twitch trouble is a 4xx with a plain message, never a 5xx (the Studio reads 5xx as "server unreachable")', async () => {
    const origin = new URL(helix.requests[0]!.href).origin;
    const signedOut = Fastify({logger: false});
    await signedOut.register(importRoutes, {studio: {useSource: () => ({})} as never, client: {auth: {getAuth: async () => undefined, refresh: async () => undefined}, baseUrl: `${origin}/helix`},
      results: new ImportResults(), guard: directorGuard(undefined), framesDirectory, env: {}});
    const before = helix.requests.length;
    const none = await signedOut.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Single-Clip_1'}});
    assert.equal(none.statusCode, 409); assert.match(none.json().error, /not set up on this machine/);
    assert.equal(helix.requests.length, before, 'no app credentials: no Helix request at all');
    await signedOut.close();
    const broken = Fastify({logger: false});
    await broken.register(importRoutes, {studio: {useSource: () => ({})} as never, client: {auth, baseUrl: `${origin}/no-such-helix`},
      results: new ImportResults(), guard: directorGuard(undefined), framesDirectory, env: {}});
    const down = await broken.inject({method: 'POST', url: '/api/import', payload: {input: 'https://www.twitch.tv/videos/500'}});
    assert.equal(down.statusCode, 424); assert.match(down.json().error, /Twitch could not be reached/);
    await broken.close();
  });

  test('with the art network off, nothing is inked even when an inker is available', async () => {
    const offApp = Fastify({logger: false});
    let calls = 0;
    await offApp.register(importRoutes, {studio: {useSource: () => ({})} as never, client: {auth, baseUrl: `${new URL(helix.requests[0]!.href).origin}/helix`}, results: new ImportResults(),
      guard: directorGuard(undefined), framesDirectory, env: {}, inkFrame: async () => { calls++; return {buffer: Buffer.from('fake-png'), ms: 1}; }});
    const {statusCode, json} = await offApp.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Single-Clip_1'}});
    assert.equal(statusCode, 200);
    assert.equal(calls, 0);
    assert.match(json().panels[0].imageUrl, /^https:\/\/static-cdn\.jtvnw\.net\/fake-import\//, 'the clip thumbnail is the frame');
    assert.equal(json().panels[0].frameUrl, undefined);
    await offApp.close();
  });

  test('ART-LIVE-1: the art prompt never carries a viewer handle or a quoted title (the image model draws quoted words as lettering)', () => {
    // Seen live: a quoted title with a viewer's handle came back lettered into the art.
    const prompt = importArtPrompt('WHO TF IS Fake_Viewer99 @someone xX42Xx "quoted" lol');
    for (const handle of ['Fake_Viewer99', '@someone', 'someone', 'xX42Xx', '"']) assert.ok(!prompt.includes(handle), `no ${handle} in the prompt`);
    assert.match(prompt, /who tf is quoted lol/, 'the plain words stay, so the art still fits the clip');
    assert.match(prompt, /No text, letters, speech bubbles or captions/);
    assert.doesNotMatch(importArtPrompt('Fake_Viewer99 @someone 1234'), /Fake|someone|1234/, 'a title of only handles leaves a plain scene');
  });

  test('ART-LIVE-1 r2 (00:22/00:23): the art prompt asks for no text, letters, speech bubbles or captions, leaves clear space for the app\'s lettering, wears the active theme (Festival by default), and carries no viewer names', () => {
    const title = 'WHO TF IS Fake_Viewer99 @someone';
    const festival = importArtPrompt(title);
    assert.match(festival, /no text, letters, speech bubbles or captions/i, 'the explicit no-text clause');
    assert.doesNotMatch(festival, /black-and-white|blank empty speech bubbles/i, 'no ask for a plain or bubbled panel');
    assert.match(festival, /full colou?r/i);
    assert.match(festival, /teal, amber and coral/i, 'Festival style words by default');
    assert.match(festival, /empty space (along|at) the top/i, 'room for captions and bubbles away from faces');
    for (const name of ['Fake_Viewer99', 'someone']) assert.ok(!festival.includes(name), `no ${name}`);
    assert.equal(importArtPrompt(title, 'ink'), festival, 'a legacy or unknown theme resolves to Festival');
    assert.match(importArtPrompt(title, 'lagoon'), /cobalt, cyan and lime/i, 'another theme brings its own words');
  });

  test('ART-LIVE-1 r3: title words reach the prompt lowercased, as mood only (image 2 still lettered the capitalised title words)', () => {
    const prompt = importArtPrompt('WHO TF IS THIS');
    assert.match(prompt, /mood: who tf is this\b/);
    assert.doesNotMatch(prompt, /\bWHO\b|\bTHIS\b/);
  });

  test('ART-LIVE-1: with the art network on and a provider key set, panels are drawn by the art chain (Cloudflare first), and the response says which provider drew each', async () => {
    const base = `${new URL(helix.requests[0]!.href).origin}/helix`;
    const keys = {CLOUDFLARE_API_TOKEN: 'cf-test-token-not-real', CLOUDFLARE_ACCOUNT_ID: 'cf-test-account-not-real', IMAGE_BUDGET_PER_HOUR: '12'};
    const asked: {prompt: string; cacheKey: string; clip?: {url: string; thumbnailUrl: string}}[] = [];
    let answer: {provider: 'cloudflare'; imageUrl: string; fileName: string; ms: number; buffer: Buffer} | undefined = {provider: 'cloudflare', imageUrl: '/art/generated/panel-live-abc123.png', fileName: 'panel-live-abc123.png', ms: 42, buffer: Buffer.from('png')};
    const art = {generate: async (request: (typeof asked)[number]) => { asked.push(request); return answer; }};
    let inks = 0;
    const inkFrame = async () => { inks++; return {buffer: Buffer.from('fake-png'), ms: 1}; };
    const make = async (env: Record<string, string>) => {
      const app = Fastify({logger: false});
      await app.register(importRoutes, {studio: {useSource: () => ({})} as never, client: {auth, baseUrl: base}, results: new ImportResults(), guard: directorGuard(undefined), framesDirectory, env, inkFrame, art} as never);
      return app;
    };
    const on = await make({COMICTOONS_ART_NETWORK: '1', ...keys});
    const drawn = await on.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Single-Clip_1'}});
    assert.equal(drawn.statusCode, 200);
    const panel = drawn.json().panels[0] as {imageUrl: string; frameUrl?: string; caption: string};
    assert.equal(panel.imageUrl, '/art/generated/panel-live-abc123.png', 'the generated image is the panel art');
    assert.match(panel.frameUrl ?? '', /^https:\/\/static-cdn\.jtvnw\.net\/fake-import\//, 'the clip thumbnail is kept as frameUrl');
    assert.equal(asked.length, 1);
    assert.match(asked[0]!.prompt, /manga/i);
    assert.match(asked[0]!.prompt, /mood: moment\b/, 'the prompt describes the clip by the plain words of its title');
    assert.match(asked[0]!.clip?.thumbnailUrl ?? '', /^https:\/\/static-cdn\.jtvnw\.net\//, 'the chain gets the allow-listed thumbnail for its clip-frame step');
    assert.deepEqual(drawn.json().art, [{clipId: 'Single-Clip_1', provider: 'cloudflare', ms: 42}]);
    assert.equal(inks, 0, 'no separate local ink when the chain drew the panel');
    assert.doesNotMatch(drawn.body, /cf-test-(token|account)/, 'no key or account id in the response');
    // Nothing from the chain (every key spent, budget used): the local ink of the clip frame is the fallback, as before.
    answer = undefined;
    const fell = await on.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Single-Clip_1'}});
    assert.equal(fell.statusCode, 200);
    assert.match(fell.json().panels[0].imageUrl, /^\/api\/import\/frame\/[a-f0-9-]{36}\.png$/);
    assert.equal(fell.json().art, undefined);
    assert.equal(inks, 1);
    await on.close();
    // Art network off (keys present) or on without any key: the chain is never asked.
    asked.length = 0;
    for (const env of [{...keys}, {COMICTOONS_ART_NETWORK: '1'}] as Record<string, string>[]) {
      const app = await make(env);
      assert.equal((await app.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Single-Clip_1'}})).statusCode, 200);
      await app.close();
    }
    assert.equal(asked.length, 0, 'the art chain only runs with the art network on and a provider key set');
  });

  test('IMPORT-LIVE-1 r2: a clip looked up by id is allow-listed: its link (clips.twitch.tv or the real twitch.tv/<channel>/clip form) and its thumbnail (*.jtvnw.net)', async () => {
    const base = `${new URL(helix.requests[0]!.href).origin}/helix`;
    const inked: string[] = [];
    const artOn = Fastify({logger: false});
    await artOn.register(importRoutes, {studio: {useSource: () => ({})} as never, client: {auth, baseUrl: base}, results: new ImportResults(), guard: directorGuard(undefined), framesDirectory,
      env: {COMICTOONS_ART_NETWORK: '1'}, inkFrame: async (clip: {thumbnailUrl: string}) => { inked.push(clip.thumbnailUrl); return {buffer: Buffer.from('fake-png'), ms: 1}; }});
    const thumb = await artOn.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Unsafe_Thumb'}});
    assert.equal(thumb.statusCode, 200, 'the clip itself is fine; only its thumbnail is refused');
    assert.deepEqual(inked, [], 'an unsafe thumbnail is never handed to the inker (it fetches server-side)');
    assert.doesNotMatch(JSON.stringify(thumb.json().panels), /169\.254/);
    await artOn.close();
    const artOff = Fastify({logger: false});
    await artOff.register(importRoutes, {studio: {useSource: () => ({})} as never, client: {auth, baseUrl: base}, results: new ImportResults(), guard: directorGuard(undefined), framesDirectory, env: {}});
    const shown = await artOff.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Unsafe_Thumb'}});
    assert.equal(shown.statusCode, 200);
    assert.equal(shown.json().panels[0].imageUrl, '', 'with the art network off, the unsafe thumbnail is not shown either');
    const link = await artOff.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Unsafe_Url'}});
    assert.equal(link.statusCode, 404, 'a clip whose own url is not clips.twitch.tv is dropped, as getClips drops it');
    assert.equal(link.json().error, 'This clip is private, deleted, or could not be found.');
    for (const slug of ['Unsafe_Port', 'Unsafe_Host']) assert.equal((await artOff.inject({method: 'POST', url: '/api/import', payload: {input: `https://clips.twitch.tv/${slug}`}})).statusCode, 404, slug);
    // Real Helix answers with https://www.twitch.tv/<channel>/clip/<slug>: that must still import (clips.ts's allow-list refuses it; see the report).
    const real = await artOff.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Real_Shape_1'}});
    assert.equal(real.statusCode, 200, 'the url form real Helix returns today is accepted');
    assert.equal(real.json().panels[0].clipUrl, 'https://www.twitch.tv/somechannel/clip/Real_Shape_1');
    // The share link as the Twitch site gives it today (channel form, ?range=7d) goes through to the same clip.
    const shared = await artOff.inject({method: 'POST', url: '/api/import', payload: {input: 'https://www.twitch.tv/somechannel/clip/Real_Shape_1?range=7d'}});
    assert.equal(shared.statusCode, 200);
    assert.equal(shared.json().panels.length, 1);
    assert.equal(shared.json().panels[0].clipUrl, 'https://www.twitch.tv/somechannel/clip/Real_Shape_1');
    const mixed = await artOff.inject({method: 'POST', url: '/api/import', payload: {input: 'https://clips.twitch.tv/Single-Clip_1\nhttps://clips.twitch.tv/Unsafe_Url'}});
    assert.equal(mixed.statusCode, 200);
    assert.deepEqual(mixed.json().missing, ['Unsafe_Url']);
    assert.doesNotMatch(JSON.stringify(mixed.json().panels), /evil\.example/);
    await artOff.close();
  });

  test('no non-loopback connect or fetch happened', () => assert.deepEqual(egress, []));
});

test('ART-LIVE-1 r4 (the lead, 00:31): no lettering or logos on headsets, clothing or screens (image 3 drew a brand word on a headset, image 7 a mark on a monitor)', () => {
  const prompt = importArtPrompt('reaction clip');
  assert.match(prompt, /no (text|lettering), logos or brand marks on headsets, clothing or screens/i);
  assert.match(prompt, /screens show only abstract shapes and colour/i);
  assert.match(prompt, /No text, letters, speech bubbles or captions/, 'the r2 clause stays');
});
