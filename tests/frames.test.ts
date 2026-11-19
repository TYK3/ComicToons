import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inkClipFrame } from '../apps/server/src/pipeline/frames.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

function fakeChild(behaviour: (child: EventEmitter & { stdout: PassThrough; stdin: PassThrough }) => void): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: (signal?: string) => void };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => { child.emit('close', null); };
  setImmediate(() => behaviour(child));
  return child as unknown as ChildProcessWithoutNullStreams;
}

function fetchReturning(buffer: Buffer, ok = true) {
  return async () => ({ ok, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }) as unknown as Response;
}

test('FRAMES-01: no clip is a no-op', async () => {
  const result = await inkClipFrame(undefined, { spawnImpl: () => { throw new Error('must not spawn'); } });
  assert.equal(result, undefined);
});

test('FRAMES-02: ffmpeg missing falls through gracefully', async () => {
  const result = await inkClipFrame({ url: 'https://clips.twitch.tv/x', thumbnailUrl: 'https://example.test/thumb.jpg' }, {
    ffmpegPath: '/no/such/ffmpeg-binary', fetchImpl: fetchReturning(Buffer.from('jpg-bytes')),
  });
  assert.equal(result, undefined);
});

test('FRAMES-03: a successful download and ffmpeg run returns the inked buffer', async () => {
  const result = await inkClipFrame({ url: 'https://clips.twitch.tv/x', thumbnailUrl: 'https://example.test/thumb.jpg' }, {
    ffmpegPath: '/usr/bin/ffmpeg',
    fetchImpl: fetchReturning(Buffer.from('jpg-bytes')),
    spawnImpl: () => fakeChild((child) => { child.stdout.end(Buffer.from('inked-bytes')); child.emit('close', 0); }),
  });
  assert.ok(result);
  assert.equal(result!.buffer.toString(), 'inked-bytes');
  assert.ok(result!.ms >= 0);
});

test('FRAMES-04: a non-zero ffmpeg exit code falls through', async () => {
  const result = await inkClipFrame({ url: 'https://clips.twitch.tv/x', thumbnailUrl: 'https://example.test/thumb.jpg' }, {
    ffmpegPath: '/usr/bin/ffmpeg',
    fetchImpl: fetchReturning(Buffer.from('jpg-bytes')),
    spawnImpl: () => fakeChild((child) => { child.emit('close', 1); }),
  });
  assert.equal(result, undefined);
});

test('FRAMES-05: a failed thumbnail download falls through without spawning ffmpeg', async () => {
  const result = await inkClipFrame({ url: 'https://clips.twitch.tv/x', thumbnailUrl: 'https://example.test/thumb.jpg' }, {
    ffmpegPath: '/usr/bin/ffmpeg',
    fetchImpl: fetchReturning(Buffer.from(''), false),
    spawnImpl: () => { throw new Error('must not spawn after a failed download'); },
  });
  assert.equal(result, undefined);
});

test('FRAMES-06: a hung ffmpeg process is killed at the timeout and falls through', async () => {
  const result = await inkClipFrame({ url: 'https://clips.twitch.tv/x', thumbnailUrl: 'https://example.test/thumb.jpg' }, {
    ffmpegPath: '/usr/bin/ffmpeg',
    timeoutMs: 30,
    fetchImpl: fetchReturning(Buffer.from('jpg-bytes')),
    spawnImpl: () => fakeChild(() => { /* never closes */ }),
  });
  assert.equal(result, undefined);
});

test('FRAMES-07: a fetch that throws (network down) falls through', async () => {
  const result = await inkClipFrame({ url: 'https://clips.twitch.tv/x', thumbnailUrl: 'https://example.test/thumb.jpg' }, {
    ffmpegPath: '/usr/bin/ffmpeg',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(result, undefined);
});
