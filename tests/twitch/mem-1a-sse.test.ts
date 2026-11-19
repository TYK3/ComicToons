// MEM-1a #1: an SSE client that never reads must not grow the server's write queue without bound.
// Real server (createApp, in process) on 127.0.0.1:3120 with a scripted chat adapter (no IRC, no Twitch).
// A raw socket opens /api/events and /api/comics/events and never reads; the server side of each socket is
// corked, which is what a full kernel send buffer looks like to Node (writes queue in userland, no 'drain').
// 500 chat lines and 250 catch-ups then flow (a stream-event frame per line, a catch-up frame per catch-up, state every 500 ms).
import assert from 'node:assert/strict';
import type {IncomingMessage, ServerResponse} from 'node:http';
import net from 'node:net';
import {after, before, test} from 'node:test';
import {createApp} from '../../apps/server/src/app.ts';
import type {ChatAdapter} from '../../apps/server/src/ingest/irc.ts';
import {APP_PORT, sleep} from './helpers.ts';

type Callbacks = Parameters<ChatAdapter['start']>[0];
const LIMITS = {softBytes: 16 * 1024, hardBytes: 64 * 1024, stallMs: 2000};
let callbacks: Callbacks | undefined;
let app: ReturnType<typeof createApp> | undefined;
const responses = new Map<string, ServerResponse>();
const base = `http://127.0.0.1:${APP_PORT}`;

before(async () => {
  app = createApp({
    logger: false, sse: LIMITS,
    adapterFactory: () => ({start(c: Callbacks) { callbacks = c; c.status('empty'); }, stop() {}}),
    env: {NODE_ENV: 'test', COMICTOONS_ART_NETWORK: '0', PANELCAST_ART_NETWORK: '0', COMICTOONS_PARTICIPATION_MOCK: '0'},
  } as Parameters<typeof createApp>[0]);
  app.server.on('request', (req: IncomingMessage, res: ServerResponse) => { if (req.headers['x-mem-1a']) responses.set(String(req.headers['x-mem-1a']), res); });
  await app.listen({host: '127.0.0.1', port: APP_PORT});
});
after(async () => { await app?.close(); app = undefined; });

/** Opens an SSE stream on a raw socket that is never read, and corks the server's side of it. */
async function stalledClient(path: string, tag: string) {
  const socket = net.connect({host: '127.0.0.1', port: APP_PORT});
  socket.pause();
  socket.on('error', () => undefined);
  await new Promise<void>(done => socket.once('connect', () => done()));
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${APP_PORT}\r\nAccept: text/event-stream\r\nX-Mem-1a: ${tag}\r\n\r\n`);
  const end = Date.now() + 5000;
  while (!responses.has(tag)) { if (Date.now() > end) throw new Error(`no server response for ${tag}`); await sleep(20); }
  const res = responses.get(tag)!;
  res.socket!.cork();
  return {socket, res};
}

test('MEM-1a SSE: a stalled /api/events or /api/comics/events client stays under the byte cap and is dropped; a reading client keeps up', async t => {
  const ingest = await fetch(`${base}/api/ingest`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({mode: 'twitch', channel: 'memtest'})});
  assert.ok(ingest.ok, `ingest ${ingest.status}`);
  const state = await stalledClient('/api/events', 'state');
  const comics = await stalledClient('/api/comics/events', 'comics');
  // A healthy reader alongside.
  const reader = new AbortController();
  let readBytes = 0, lastFrame = '';
  const reading = fetch(`${base}/api/events`, {signal: reader.signal}).then(async response => {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { readBytes += chunk.byteLength; lastFrame = Buffer.from(chunk).toString('utf8').slice(-200); }
  }).catch(() => undefined);

  let peak = {state: 0, comics: 0};
  const sample = () => {
    peak = {state: Math.max(peak.state, state.res.writableLength), comics: Math.max(peak.comics, comics.res.writableLength)};
  };
  const started = Date.now();
  for (let i = 0; i < 500; i++) {
    callbacks!.event({id: `m${i}`, type: 'chat', t: i, user: `u${i % 97}`, name: `u${i % 97}`, text: `line ${i} ${'words '.repeat(20)}`});
    if (i % 2 === 1) { await fetch(`${base}/api/catchup`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({minutes: 20, reason: 'manual'})}); }
    sample();
    await sleep(18);
  }
  // Let state ticks and the stall window run out.
  const settle = Date.now() + LIMITS.stallMs + 2500;
  while (Date.now() < settle) { sample(); await sleep(100); }
  t.diagnostic(`pumped 500 chat lines and 250 catch-ups in ${Date.now() - started} ms`);
  t.diagnostic(`/api/events stalled: peak writableLength ${peak.state} B, now ${state.res.writableLength} B, destroyed ${state.res.destroyed}`);
  t.diagnostic(`/api/comics/events stalled: peak writableLength ${peak.comics} B, now ${comics.res.writableLength} B, destroyed ${comics.res.destroyed}`);
  t.diagnostic(`reading client received ${readBytes} B`);
  const frameAllowance = 16 * 1024;
  assert.ok(peak.state <= LIMITS.hardBytes + frameAllowance, `/api/events queue peaked at ${peak.state} B (cap ${LIMITS.hardBytes})`);
  assert.ok(peak.comics <= LIMITS.hardBytes + frameAllowance, `/api/comics/events queue peaked at ${peak.comics} B (cap ${LIMITS.hardBytes})`);
  assert.equal(state.res.destroyed, true, 'the stalled /api/events client was dropped');
  assert.equal(comics.res.destroyed, true, 'the stalled /api/comics/events client was dropped');
  assert.ok(readBytes > 50_000, `the reading client kept receiving (${readBytes} B)`);
  assert.ok(lastFrame.length > 0);
  reader.abort(); await reading;
  state.socket.destroy(); comics.socket.destroy();
});
