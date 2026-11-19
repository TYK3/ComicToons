import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildReport, renderMarkdown, type Sample, type TrialInput } from '../scripts/trial-run/report.ts';
import { assertLoopback, directorKey, parseArgs, runTrial, serverEnv, type ServerHandle } from '../scripts/trial-run/harness.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const T0 = Date.UTC(2026, 9, 31, 3, 0, 0);
const panel = (id: string, origin: 'twitch' | 'sample' = 'twitch', extra: Record<string, unknown> = {}) => ({ id, origin, ...extra });
function state(received: number, connection: string, options: { active?: 'twitch' | 'sample'; reason?: string; panels?: ReturnType<typeof panel>[]; pending?: ReturnType<typeof panel>[] } = {}) {
  return { status: 'live', source: { requested: 'twitch', active: options.active ?? (connection === 'live' ? 'twitch' : 'sample'), connection, reason: options.reason, channel: 'inkstreamer', simulated: false, received },
    panels: options.panels ?? [], pendingPanels: options.pending ?? [] };
}
function input(samples: Sample[], extra: Partial<TrialInput> = {}): TrialInput {
  return { source: 'twitch', channel: 'inkstreamer', requestedMinutes: 2, apiPort: 3125, webPort: 4125, intervalSeconds: 5, outDir: '/tmp/x', serverPid: 4242,
    startedAt: T0, ingestStartedAt: T0 + 1_000, endedAt: T0 + 121_000, directorKeySet: false, errors: [], samples, ...extra };
}

test('trial-run report: measures chat lines, lines per minute, panels, reconnects, fallbacks, errors and duration from the samples', () => {
  const samples: Sample[] = [
    { at: T0 + 1_000, state: state(0, 'connecting') },
    { at: T0 + 31_000, state: state(40, 'live', { pending: [panel('irc-a-0')] }), participation: { received: 3, helix: 'mock' } },
    { at: T0 + 61_000, state: state(70, 'disconnected', { reason: 'disconnected', active: 'sample', panels: [panel('sample-1', 'sample')] }) },
    { at: T0 + 91_000, state: state(90, 'live', { panels: [panel('irc-a-0')], pending: [panel('irc-a-1')] }) },
    { at: T0 + 121_000, state: state(120, 'empty', { reason: 'empty', active: 'sample' }), participation: { received: 5, helix: 'mock' }, stateError: undefined },
  ];
  const report = buildReport(input(samples, { errors: [{ at: T0 + 50_000, where: 'sample /api/participation/status', message: 'timeout' }] }));
  assert.deepEqual(report.metrics.chatLines, { value: 120, note: report.metrics.chatLines.note });
  assert.equal(report.metrics.linesPerMinute.value, 60, '120 lines over the 2 minutes from ingest start to the last sample');
  assert.equal(report.metrics.panelsDrafted.value, 2, 'twitch-origin panels only, counted once each');
  assert.equal(report.metrics.panelsApproved.value, 1);
  assert.equal(report.metrics.reconnects.value, 1, 'live → disconnected → live');
  assert.equal(report.metrics.fallbackEvents.value, 2);
  assert.deepEqual(report.fallbacks.map(event => event.reason), ['disconnected', 'empty']);
  assert.deepEqual(report.fallbackByReason, { disconnected: 1, empty: 1 });
  assert.equal(report.metrics.errors.value, 1);
  assert.equal(report.metrics.durationSeconds.value, 121);
  assert.equal(report.metrics.busEventsReceived.value, 5);
  assert.equal(report.metrics.liveShareOfSamples.value, 40);
  assert.ok('gap' in report.momentsByKind, 'no moment kind on panels: GAP');
});

test('trial-run report: a chat counter that restarts is summed across segments, never lost', () => {
  const report = buildReport(input([
    { at: T0 + 1_000, state: state(30, 'live') },
    { at: T0 + 31_000, state: state(50, 'live') },
    { at: T0 + 61_000, state: state(4, 'live') },
    { at: T0 + 121_000, state: state(10, 'live') },
  ]));
  assert.equal(report.metrics.chatLines.value, 60);
});

test('trial-run report: with no successful sample every sampled number is a GAP, but duration and errors are still measured', () => {
  const report = buildReport(input([
    { at: T0 + 1_000, stateError: 'connect ECONNREFUSED' },
    { at: T0 + 6_000, stateError: 'connect ECONNREFUSED' },
  ], { errors: [{ at: T0, where: 'server', message: 'exited early with code 1' }] }));
  for (const key of ['chatLines', 'linesPerMinute', 'panelsDrafted', 'panelsApproved', 'reconnects', 'fallbackEvents', 'liveShareOfSamples', 'busEventsReceived'] as const) {
    assert.ok('gap' in report.metrics[key], `${key} is a GAP`);
    assert.match((report.metrics[key] as { gap: string }).gap, /\S/);
  }
  assert.equal(report.metrics.durationSeconds.value, 121);
  assert.equal(report.metrics.errors.value, 3, 'one harness error plus the two failed samples');
});

test('trial-run report: moments by kind are counted when the server exposes a kind, otherwise GAP', () => {
  const withKinds = buildReport(input([
    { at: T0 + 1_000, state: state(5, 'live', { pending: [panel('irc-1', 'twitch', { momentKind: 'spike' }), panel('irc-2', 'twitch', { momentKind: 'raid' })] }) },
    { at: T0 + 61_000, state: state(9, 'live', { pending: [panel('irc-2', 'twitch', { momentKind: 'raid' }), panel('irc-3', 'twitch', { momentKind: 'spike' })] }) },
  ]));
  assert.deepEqual(withKinds.momentsByKind, { value: { raid: 1, spike: 2 } });
  const without = buildReport(input([{ at: T0 + 1_000, state: state(5, 'live', { pending: [panel('irc-1')] }) }]));
  assert.ok('gap' in without.momentsByKind);
});

test('trial-run report: the sample source marks Twitch-only numbers as GAP and counts sample panels', () => {
  const report = buildReport(input([
    { at: T0 + 1_000, state: { status: 'replaying', source: { requested: 'sample', active: 'sample', connection: 'sample', simulated: false, received: 0 }, panels: [], pendingPanels: [panel('p1', 'sample')] } },
    { at: T0 + 61_000, state: { status: 'ready', source: { requested: 'sample', active: 'sample', connection: 'sample', simulated: false, received: 0 }, panels: [], pendingPanels: [panel('p1', 'sample'), panel('p2', 'sample')] } },
  ], { source: 'sample', channel: undefined }));
  assert.ok('gap' in report.metrics.chatLines);
  assert.ok('gap' in report.metrics.linesPerMinute);
  assert.ok('gap' in report.metrics.reconnects);
  assert.equal(report.metrics.samplePanelsShown.value, 2);
  assert.equal(report.metrics.fallbackEvents.value, 0);
});

test('trial-run markdown: every metric has a row, GAPs say GAP with a reason, and nothing reads undefined or NaN', () => {
  const report = buildReport(input([{ at: T0 + 1_000, stateError: 'boom' }]));
  const markdown = renderMarkdown(report);
  for (const label of ['Chat lines received', 'Lines per minute', 'Moments by kind', 'Panels drafted', 'Reconnects', 'Fallback-to-sample events', 'Errors', 'Duration']) assert.match(markdown, new RegExp(label));
  assert.match(markdown, /GAP: /);
  assert.doesNotMatch(markdown, /undefined|NaN|\[object Object\]/);
  assert.match(markdown, /Art network \| off/);
  const live = renderMarkdown(buildReport(input([{ at: T0 + 1_000, state: state(12, 'live') }, { at: T0 + 61_000, state: state(3, 'empty', { reason: 'empty', active: 'sample' }) }])));
  assert.match(live, /\| empty \| 1 \|/);
  assert.doesNotMatch(live, /undefined|NaN/);
});

test('trial-run args: defaults to ports 3125/4125, a 5 s interval and an output folder outside the repo', () => {
  const options = parseArgs(['--channel', 'InkStreamer', '--minutes', '30'], { repoRoot, env: {}, now: T0 });
  assert.ok(!('help' in options));
  if ('help' in options) return;
  assert.equal(options.channel, 'inkstreamer');
  assert.equal(options.source, 'twitch');
  assert.equal(options.minutes, 30);
  assert.equal(options.apiPort, 3125);
  assert.equal(options.webPort, 4125);
  assert.equal(options.intervalSeconds, 5);
  assert.ok(!options.outDir.startsWith(repoRoot + '/'), 'default output is outside the repo');
  const custom = parseArgs(['--channel', 'a_b', '--minutes', '0.5', '--api-port', '3999', '--web-port', '4999', '--out', '/tmp/trial-x', '--interval', '2'], { repoRoot, env: {}, now: T0 });
  assert.deepEqual('help' in custom ? undefined : [custom.apiPort, custom.webPort, custom.outDir, custom.intervalSeconds, custom.minutes], [3999, 4999, resolve('/tmp/trial-x'), 2, 0.5]);
  assert.deepEqual(parseArgs(['--help'], { repoRoot, env: {}, now: T0 }), { help: true });
});

test('trial-run args: rejects a bad channel, bad minutes, clashing ports and an output folder inside the repo', () => {
  const parse = (argv: string[]) => parseArgs(argv, { repoRoot, env: {}, now: T0 });
  assert.throws(() => parse(['--minutes', '5']), /channel/i);
  assert.throws(() => parse(['--channel', 'bad name!', '--minutes', '5']), /channel/i);
  assert.throws(() => parse(['--channel', 'ok', '--minutes', '0']), /minutes/i);
  assert.throws(() => parse(['--channel', 'ok', '--minutes', 'lots']), /minutes/i);
  assert.throws(() => parse(['--channel', 'ok', '--minutes', '5', '--api-port', '4125']), /port/i);
  assert.throws(() => parse(['--channel', 'ok', '--minutes', '5', '--out', join(repoRoot, 'artifacts', 'trial')]), /outside the repo/i);
  assert.throws(() => parse(['--channel', 'ok', '--minutes', '5', '--out', repoRoot]), /outside the repo/i);
  assert.throws(() => parse(['--channel', 'ok', '--minutes', '5', '--bogus']), /unknown/i);
  const sample = parse(['--source', 'sample', '--minutes', '1']);
  assert.ok(!('help' in sample) && sample.source === 'sample' && sample.channel === undefined);
});

test('trial-run server env: art network forced off whatever the environment says, provider keys blanked, cache outside the repo', () => {
  const env = serverEnv({ COMICTOONS_ART_NETWORK: '1', PANELCAST_ART_NETWORK: '1', CLOUDFLARE_API_TOKEN: 'cf-placeholder', POLLINATIONS_API_KEY_2: 'p-placeholder', PATH: '/usr/bin' }, { apiPort: 3125, outDir: '/tmp/trial-y' });
  assert.equal(env.COMICTOONS_ART_NETWORK, '0');
  assert.equal(env.PANELCAST_ART_NETWORK, '0');
  assert.equal(env.CLOUDFLARE_API_TOKEN, '');
  assert.equal(env.POLLINATIONS_API_KEY_2, '');
  assert.equal(env.COMICTOONS_ART_CACHE_DIR, join('/tmp/trial-y', 'art-cache'));
  assert.equal(env.COMICTOONS_API_PORT, '3125');
  assert.equal(env.PATH, '/usr/bin');
  const flagged = serverEnv({ COMICTOONS_FLAG_INK_ME: '1', COMICTOONS_FLAG_TWITCH_POLLS: 'true', PANELCAST_FLAG_HYPE: 'on', COMICTOONS_FLAG_BOT_REPLIES: '1', COMICTOONS_FLAG_POLLS: '1' }, { apiPort: 3125, outDir: '/tmp/trial-y' });
  for (const name of ['INK_ME', 'TWITCH_POLLS', 'HYPE', 'BOT_REPLIES']) {
    assert.equal(flagged[`COMICTOONS_FLAG_${name}`], '0', `${name}: a feature that writes to Twitch is forced off`);
    assert.equal(flagged[`PANELCAST_FLAG_${name}`], '0', `${name}: legacy prefix forced off too`);
  }
  assert.equal(flagged.COMICTOONS_FLAG_POLLS, '1', 'in-app features are left as configured');
});

test('trial-run safety: only loopback URLs are allowed, and the director key comes from env with a blank value meaning none', () => {
  assert.doesNotThrow(() => assertLoopback('http://127.0.0.1:3125/api/state'));
  assert.throws(() => assertLoopback('https://api.twitch.tv/helix/chat/messages'), /loopback/);
  assert.throws(() => assertLoopback('http://irc.chat.twitch.tv/'), /loopback/);
  assert.equal(directorKey({ COMICTOONS_DIRECTOR_KEY: 'k1', PANELCAST_DIRECTOR_KEY: 'k2' }), 'k1');
  assert.equal(directorKey({ PANELCAST_DIRECTOR_KEY: 'k2' }), 'k2');
  assert.equal(directorKey({ COMICTOONS_DIRECTOR_KEY: '  ' }), undefined);
  assert.equal(directorKey({}), undefined);
});

/** A fake server process plus a fake fetch standing in for its HTTP API. */
function fakeWorld(options: { exitEarlyAfter?: number } = {}) {
  const requests: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const stops: number[] = [];
  let clock = T0; let received = 0; let started = 0; let alive = false; let samplesTaken = 0;
  const startServer = async (): Promise<ServerHandle> => {
    started += 1; alive = true;
    return { pid: 777001, logPath: 'server.log', exited: () => alive ? undefined : { code: 1, signal: null }, stop: async () => { stops.push(777001); alive = false; return { code: 0, signal: 'SIGTERM' }; } };
  };
  const fetchImpl = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    requests.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (!alive) throw new Error('connect ECONNREFUSED');
    const path = new URL(url).pathname;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/state') {
      samplesTaken += 1; received += 7;
      if (options.exitEarlyAfter && samplesTaken > options.exitEarlyAfter) alive = false;
      return json(state(received, 'live', { pending: [panel(`irc-${samplesTaken}`)] }));
    }
    if (path === '/api/participation/status') return json({ received: 2, helix: 'mock' });
    if (path === '/api/twitch/status') return json({ connected: true, channel: 'inkstreamer' });
    if (path === '/api/ingest') return json({ ok: true });
    return new Response('{}', { status: 404 });
  };
  return { requests, stops, startServer, fetchImpl, started: () => started, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
}

test('trial-run harness: starts one server, samples with the director header, stops exactly that PID and writes only to the output folder', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'trial-run-test-'));
  try {
    const world = fakeWorld();
    const secret = 'director-placeholder-value';
    const result = await runTrial({ source: 'twitch', channel: 'inkstreamer', minutes: 1, apiPort: 3125, webPort: 4125, intervalSeconds: 5, outDir, repoRoot },
      { env: { COMICTOONS_DIRECTOR_KEY: secret }, startServer: world.startServer, fetch: world.fetchImpl, now: world.now, sleep: world.sleep, log: () => {} });
    assert.equal(world.started(), 1);
    assert.deepEqual(world.stops, [777001]);
    assert.equal(result.report.run.serverPid, 777001);
    assert.ok(world.requests.every(request => request.url.startsWith('http://127.0.0.1:3125/')), 'loopback only, harness port only');
    assert.ok(world.requests.every(request => request.headers['x-comictoons-director-key'] === secret), 'director header on every request');
    const ingest = world.requests.find(request => request.url.endsWith('/api/ingest'))!;
    assert.deepEqual(JSON.parse(ingest.body!), { mode: 'twitch', channel: 'inkstreamer' });
    assert.ok(world.requests.filter(request => request.method === 'POST').every(request => request.url.endsWith('/api/ingest')), 'the only write is selecting the source');
    assert.ok(result.report.run.samples >= 12, 'about every 5 s for a minute');
    assert.equal(result.report.metrics.chatLines.value, 7 * result.report.run.samples);
    assert.deepEqual(readdirSync(outDir).sort(), ['samples.jsonl', 'trial-report.json', 'trial-report.md']);
    for (const file of readdirSync(outDir)) assert.doesNotMatch(readFileSync(join(outDir, file), 'utf8'), new RegExp(secret), `${file} never contains the key`);
    assert.equal(JSON.parse(readFileSync(join(outDir, 'trial-report.json'), 'utf8')).run.directorKeySet, true);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});

test('trial-run harness: a server that dies mid-run is recorded as an error and the report is still written', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'trial-run-test-'));
  try {
    const world = fakeWorld({ exitEarlyAfter: 3 });
    const result = await runTrial({ source: 'twitch', channel: 'inkstreamer', minutes: 1, apiPort: 3125, webPort: 4125, intervalSeconds: 5, outDir, repoRoot },
      { env: {}, startServer: world.startServer, fetch: world.fetchImpl, now: world.now, sleep: world.sleep, log: () => {} });
    assert.ok(result.report.errors.some(error => /server exited/i.test(error.message)));
    assert.ok(world.requests.every(request => !('x-comictoons-director-key' in request.headers)), 'no header without a key');
    assert.ok(readdirSync(outDir).includes('trial-report.md'));
    assert.equal(result.report.run.directorKeySet, false);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
