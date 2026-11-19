import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ArtPipeline, type ArtPipelineEnv } from '../apps/server/src/pipeline/imagegen.ts';

// Mocked fetch only: nothing leaves the process. Key values are fake placeholders, and every
// log line is checked never to contain one.

function fakePngChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: () => void };
  child.stdout = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => child.emit('close', null);
  setImmediate(() => { child.stdout.end(Buffer.from('fake-png-bytes')); child.emit('close', 0); });
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function withTempCache<T>(run: (cacheDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(resolve('artifacts/tmp/b3-art-budget-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const KEYS: ArtPipelineEnv = { cloudflareToken: 'fake-b3-cf-token', cloudflareAccountId: 'fake-b3-acct', pollinationsKey: 'fake-b3-poll-key' };
const SECRETS = Object.values(KEYS) as string[];

function setup(cacheDir: string, env: ArtPipelineEnv, respond: (url: string) => Response, extra: { budgetPerHour?: number; now?: () => number } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (url: string) => { calls.push(url); return respond(url); }) as unknown as typeof fetch;
  const pipeline = new ArtPipeline({ cacheDir, fetchImpl, spawnImpl: () => fakePngChild(), env, log: (line) => logs.push(line), ...extra });
  return { pipeline, calls, logs };
}
const cfImage = () => new Response(JSON.stringify({ result: { image: Buffer.from('cf').toString('base64') } }), { status: 200 });
const quota = () => new Response('{}', { status: 429 });
const noSecrets = (lines: string[]) => { for (const line of lines) for (const value of SECRETS) assert.ok(!line.includes(value), `log line leaks a key: ${line}`); };

test('B3-N2-01: with no keys configured no image call is possible, so no budget is charged', async () => {
  await withTempCache(async (cacheDir) => {
    const { pipeline, calls, logs } = setup(cacheDir, {}, cfImage, { budgetPerHour: 2 });
    for (let i = 0; i < 5; i++) assert.equal(await pipeline.generate({ prompt: `scene ${i}`, cacheKey: `n2-none-${i}` }), undefined);
    assert.equal(calls.length, 0, 'no network call without keys');
    assert.equal(pipeline.hasBudget(), true, 'five keyless panels leave a budget of two untouched');
    assert.deepEqual(logs, [], 'no keys configured is the normal offline mode and stays quiet');
  });
});

test('B3-N2-02: once every configured key is spent, later panels charge no budget; a fresh UTC day can spend again', async () => {
  await withTempCache(async (cacheDir) => {
    let clock = Date.UTC(2026, 9, 31, 10, 0, 0);
    let answer: () => Response = quota;
    const { pipeline, calls } = setup(cacheDir, KEYS, () => answer(), { budgetPerHour: 3, now: () => clock });
    assert.equal(await pipeline.generate({ prompt: 'a', cacheKey: 'n2-spent-1' }), undefined);
    assert.equal(calls.length, 2, 'both keys tried once and marked spent');
    for (let i = 2; i <= 6; i++) assert.equal(await pipeline.generate({ prompt: `p${i}`, cacheKey: `n2-spent-${i}` }), undefined);
    assert.equal(calls.length, 2, 'spent keys are not called again today');
    assert.equal(pipeline.hasBudget(), true, 'only the panel that really called a provider used budget (1 of 3)');
    clock = Date.UTC(2026, 10, 1, 0, 30, 0);
    answer = cfImage;
    assert.equal((await pipeline.generate({ prompt: 'next day', cacheKey: 'n2-spent-7' }))?.provider, 'cloudflare');
  });
});

test('B3-N3-01: a skip because every key is spent logs one line with the reason and no key values', async () => {
  await withTempCache(async (cacheDir) => {
    const { pipeline, logs } = setup(cacheDir, KEYS, quota);
    await pipeline.generate({ prompt: 'a', cacheKey: 'n3-spent-1' });
    const before = logs.length;
    await pipeline.generate({ prompt: 'b', cacheKey: 'n3-spent-2' });
    const skip = logs.slice(before);
    assert.equal(skip.length, 1, `exactly one line for the skipped panel: ${JSON.stringify(skip)}`);
    assert.match(skip[0]!, /^art skipped: every configured key is spent until the next UTC day \(2 of 2\); next step: clip frame, then library$/);
    noSecrets(logs);
  });
});

test('B3-N3-02: a skip because the hourly budget is used logs one line with the reason and no key values', async () => {
  await withTempCache(async (cacheDir) => {
    let clock = Date.UTC(2026, 9, 31, 12, 0, 0);
    const { pipeline, calls, logs } = setup(cacheDir, KEYS, cfImage, { budgetPerHour: 1, now: () => clock });
    assert.equal((await pipeline.generate({ prompt: 'a', cacheKey: 'n3-budget-1' }))?.provider, 'cloudflare');
    assert.deepEqual(logs, [], 'a successful panel logs nothing');
    clock += 10 * 60_000;
    assert.equal(await pipeline.generate({ prompt: 'b', cacheKey: 'n3-budget-2' }), undefined);
    assert.equal(calls.length, 1, 'no call over budget');
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^art skipped: hourly image budget used \(1 of 1\), next unit in 50 min; next step: clip frame, then library$/);
    noSecrets(logs);
  });
});
