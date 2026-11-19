import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ArtPipeline, buildArtPrompt } from '../apps/server/src/pipeline/imagegen.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

function fakePngChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: (s?: string) => void };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit('close', null);
  setImmediate(() => { child.stdout.end(Buffer.from('fake-png-bytes')); child.emit('close', 0); });
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function withTempCache<T>(run: (cacheDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(resolve('artifacts/tmp/imagegen-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function jsonResponse(body: unknown, ok = true) {
  return async () => ({ ok, json: async () => body }) as unknown as Response;
}
function bytesResponse(bytes: string, ok = true) {
  return async () => ({ ok, arrayBuffer: async () => Buffer.from(bytes).buffer }) as unknown as Response;
}

test('IMAGEGEN-01: Cloudflare success is used and Pollinations is never called', async () => {
  await withTempCache(async (cacheDir) => {
    let pollinationsCalled = false;
    const fetchImpl = (async (url: string) => {
      if (url.includes('pollinations')) { pollinationsCalled = true; return bytesResponse('poll')(); }
      return jsonResponse({ result: { image: Buffer.from('cf-jpeg-bytes').toString('base64') } })();
    }) as unknown as typeof fetch;
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl, spawnImpl: () => fakePngChild(), env: { cloudflareToken: 't', cloudflareAccountId: 'acct' } });
    const result = await pipeline.generate({ prompt: 'a scene', cacheKey: 'key-1' });
    assert.equal(result?.provider, 'cloudflare');
    assert.equal(pollinationsCalled, false);
  });
});

test('IMAGEGEN-02: a failed Cloudflare call falls through to Pollinations', async () => {
  await withTempCache(async (cacheDir) => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('pollinations')) return bytesResponse('poll-bytes')();
      return jsonResponse({}, false)();
    }) as unknown as typeof fetch;
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl, spawnImpl: () => fakePngChild(), env: { cloudflareToken: 't', cloudflareAccountId: 'acct', pollinationsKey: 'p' } });
    const result = await pipeline.generate({ prompt: 'a scene', cacheKey: 'key-2' });
    assert.equal(result?.provider, 'pollinations');
  });
});

test('IMAGEGEN-03: Pollinations retries with model=flux when the first model id is rejected', async () => {
  await withTempCache(async (cacheDir) => {
    const seenModels: string[] = [];
    const fetchImpl = (async (url: string) => {
      const model = new URL(url).searchParams.get('model')!;
      seenModels.push(model);
      return bytesResponse('poll-bytes', model === 'flux')();
    }) as unknown as typeof fetch;
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl, spawnImpl: () => fakePngChild(), env: { pollinationsKey: 'p' } });
    const result = await pipeline.generate({ prompt: 'a scene', cacheKey: 'key-3' });
    assert.equal(result?.provider, 'pollinations');
    assert.deepEqual(seenModels, ['black-forest-labs/flux.1-schnell', 'flux']);
  });
});

test('IMAGEGEN-04: both network providers failing falls through to a manga-inked clip frame', async () => {
  await withTempCache(async (cacheDir) => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('thumb.jpg')) return bytesResponse('clip-still')();
      return jsonResponse({}, false)();
    }) as unknown as typeof fetch;
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl, ffmpegPath: '/usr/bin/ffmpeg', spawnImpl: () => fakePngChild(), env: { cloudflareToken: 't', cloudflareAccountId: 'acct', pollinationsKey: 'p' } });
    const result = await pipeline.generate({ prompt: 'a scene', cacheKey: 'key-4', clip: { url: 'https://clips.twitch.tv/x', thumbnailUrl: 'https://example.test/thumb.jpg' } });
    assert.equal(result?.provider, 'clip-frame');
  });
});

test('IMAGEGEN-05: no network keys and no clip returns undefined so the caller falls back to the library', async () => {
  await withTempCache(async (cacheDir) => {
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl: (async () => ({ ok: false }) as unknown as Response) as unknown as typeof fetch, spawnImpl: () => fakePngChild() });
    const result = await pipeline.generate({ prompt: 'a scene', cacheKey: 'key-5' });
    assert.equal(result, undefined);
  });
});

test('IMAGEGEN-06: a slow provider is abandoned at the timeout and the chain still falls through', async () => {
  await withTempCache(async (cacheDir) => {
    const fetchImpl = (async (_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl, timeoutMs: 30, spawnImpl: () => fakePngChild(), env: { cloudflareToken: 't', cloudflareAccountId: 'acct' } });
    const result = await pipeline.generate({ prompt: 'a scene', cacheKey: 'key-6' });
    assert.equal(result, undefined);
    assert.ok(Date.now() - started < 2000, 'the timeout must be honoured, not the real network timeout');
  });
});

test('IMAGEGEN-07: the hourly budget gates network generation and skips straight to clip-frame once exhausted', async () => {
  await withTempCache(async (cacheDir) => {
    let networkCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('thumb.jpg')) return bytesResponse('clip-still')();
      networkCalls++;
      return jsonResponse({ result: { image: Buffer.from('cf').toString('base64') } })();
    }) as unknown as typeof fetch;
    let clock = 0;
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl, now: () => clock, budgetPerHour: 1, spawnImpl: () => fakePngChild(), env: { cloudflareToken: 't', cloudflareAccountId: 'acct' } });
    const first = await pipeline.generate({ prompt: 'scene 1', cacheKey: 'budget-1' });
    assert.equal(first?.provider, 'cloudflare');
    assert.equal(networkCalls, 1);
    clock += 1000;
    const second = await pipeline.generate({ prompt: 'scene 2', cacheKey: 'budget-2', clip: { url: 'u', thumbnailUrl: 'https://example.test/thumb.jpg' } });
    assert.equal(second?.provider, 'clip-frame');
    assert.equal(networkCalls, 1, 'budget exhausted: no further network attempt');
    clock += 3_600_001;
    const third = await pipeline.generate({ prompt: 'scene 3', cacheKey: 'budget-3' });
    assert.equal(third?.provider, 'cloudflare');
    assert.equal(networkCalls, 2, 'budget refills after a rolling hour');
  });
});

test('IMAGEGEN-08: a cache hit skips the network entirely and returns the same bytes', async () => {
  await withTempCache(async (cacheDir) => {
    let networkCalls = 0;
    const fetchImpl = (async () => { networkCalls++; return jsonResponse({ result: { image: Buffer.from('cf').toString('base64') } })(); }) as unknown as typeof fetch;
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl, spawnImpl: () => fakePngChild(), env: { cloudflareToken: 't', cloudflareAccountId: 'acct' } });
    const first = await pipeline.generate({ prompt: 'scene', cacheKey: 'same-key' });
    assert.equal(networkCalls, 1);
    const second = await pipeline.generate({ prompt: 'scene', cacheKey: 'same-key' });
    assert.equal(networkCalls, 1, 'the second call must be a cache hit');
    assert.deepEqual(second?.buffer, first?.buffer);
    const files = await readdir(cacheDir);
    assert.ok(files.some((file) => /^panel-live-[a-f0-9]+\.png$/.test(file)));
  });
});

test('IMAGEGEN-09: concurrent requests are serialised to at most one generation in flight', async () => {
  await withTempCache(async (cacheDir) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return jsonResponse({ result: { image: Buffer.from('cf').toString('base64') } })();
    }) as unknown as typeof fetch;
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl, spawnImpl: () => fakePngChild(), env: { cloudflareToken: 't', cloudflareAccountId: 'acct' } });
    await Promise.all([
      pipeline.generate({ prompt: 'a', cacheKey: 'conc-1' }),
      pipeline.generate({ prompt: 'b', cacheKey: 'conc-2' }),
      pipeline.generate({ prompt: 'c', cacheKey: 'conc-3' }),
    ]);
    assert.equal(maxInFlight, 1);
  });
});

test('IMAGEGEN-10: the Cloudflare account id is resolved once when unset and cached in memory', async () => {
  await withTempCache(async (cacheDir) => {
    let accountLookups = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/accounts')) { accountLookups++; return jsonResponse({ result: [{ id: 'resolved-acct' }] })(); }
      return jsonResponse({ result: { image: Buffer.from('cf').toString('base64') } })();
    }) as unknown as typeof fetch;
    const pipeline = new ArtPipeline({ cacheDir, fetchImpl, spawnImpl: () => fakePngChild(), env: { cloudflareToken: 't' } });
    await pipeline.generate({ prompt: 'a', cacheKey: 'acct-1' });
    await pipeline.generate({ prompt: 'b', cacheKey: 'acct-2' });
    assert.equal(accountLookups, 1);
  });
});

test('IMAGEGEN-11: the art prompt never includes raw text placeholders, asks for no text or bubbles, and is in colour (ART-PROMPT-1)', () => {
  const prompt = buildArtPrompt('A crowd of new arrivals bursts into a bright doorway.');
  assert.ok(!prompt.includes('Blank empty speech bubbles'));
  assert.ok(/no text/i.test(prompt));
  assert.ok(/full colour/i.test(prompt));
  assert.ok(!/manga ink|black-and-white/i.test(prompt));
});
