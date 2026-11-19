import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ArtPipeline, type ArtPipelineEnv } from '../apps/server/src/pipeline/imagegen.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

// Every test uses a mocked fetch: no request leaves the process. Key values are fake
// placeholders and the logs are checked to never contain them.

function fakePngChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: (s?: string) => void };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit('close', null);
  setImmediate(() => { child.stdout.end(Buffer.from('fake-png-bytes')); child.emit('close', 0); });
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function withTempCache<T>(run: (cacheDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(resolve('artifacts/tmp/imagegen-rotation-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const cfImage = () => new Response(JSON.stringify({ result: { image: Buffer.from('cf-jpeg').toString('base64') } }), { status: 200 });
const pollImage = () => new Response(Buffer.from('poll-bytes'), { status: 200 });
const status = (code: number, body = '{}') => new Response(body, { status: code });

interface Call { provider: 'cloudflare' | 'pollinations' | 'accounts'; key: string; url: string }
type Responder = (call: Call) => Response | Promise<Response>;

/** Mock fetch that records which key (by its fake value) each call used. */
function mockFetch(respond: Responder) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    const key = (init?.headers?.Authorization ?? '').replace(/^Bearer /, '');
    const provider = url.includes('pollinations') ? 'pollinations' : url.endsWith('/accounts') ? 'accounts' : 'cloudflare';
    const call = { provider, key, url } as Call;
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ALL_KEYS: ArtPipelineEnv = {
  cloudflareToken: 'fake-cf-token-one', cloudflareAccountId: 'fake-acct-one',
  cloudflareToken2: 'fake-cf-token-two', cloudflareAccountId2: 'fake-acct-two',
  cloudflareToken3: 'fake-cf-token-three', cloudflareAccountId3: 'fake-acct-three',
  pollinationsKey: 'fake-poll-key-one', pollinationsKey2: 'fake-poll-key-two', pollinationsKey3: 'fake-poll-key-three',
};
const SECRET_VALUES = Object.values(ALL_KEYS) as string[];

function assertNoSecrets(lines: string[]) {
  for (const line of lines) for (const value of SECRET_VALUES) assert.ok(!line.includes(value), `log line must not contain a key or account id: ${line}`);
}

function pipelineWith(cacheDir: string, fetchImpl: typeof fetch, env: ArtPipelineEnv, extra: { now?: () => number; budgetPerHour?: number; timeoutMs?: number } = {}) {
  const logs: string[] = [];
  const pipeline = new ArtPipeline({ cacheDir, fetchImpl, spawnImpl: () => fakePngChild(), env, log: (line) => logs.push(line), ...extra });
  return { pipeline, logs };
}

test('ROTATION-01: a 429 on cloudflare#1 moves to cloudflare#2 (same provider) and logs why by slot, never the key', async () => {
  await withTempCache(async (cacheDir) => {
    const { calls, fetchImpl } = mockFetch((call) => call.key === 'fake-cf-token-one' ? status(429) : call.provider === 'cloudflare' ? cfImage() : pollImage());
    const { pipeline, logs } = pipelineWith(cacheDir, fetchImpl, ALL_KEYS);
    const result = await pipeline.generate({ prompt: 'scene', cacheKey: 'rot-1' });
    assert.equal(result?.provider, 'cloudflare');
    assert.deepEqual(calls.map((c) => c.key), ['fake-cf-token-one', 'fake-cf-token-two']);
    assert.ok(calls[1].url.includes('/accounts/fake-acct-two/'), 'slot 2 uses its own account id');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /cloudflare#1 HTTP 429: rate limit or quota; key spent until the next UTC day; trying cloudflare#2/);
    assertNoSecrets(logs);
  });
});

test('ROTATION-02: 402 and a structured quota code also rotate keys; a key-independent failure goes straight to the next provider', async () => {
  await withTempCache(async (cacheDir) => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.key === 'fake-cf-token-one') return status(402);
      if (call.key === 'fake-cf-token-two') return status(400, '{"errors":[{"code":4006,"message":"Request failed"}]}');
      if (call.key === 'fake-cf-token-three') return status(503);
      return pollImage();
    });
    const { pipeline, logs } = pipelineWith(cacheDir, fetchImpl, ALL_KEYS);
    const result = await pipeline.generate({ prompt: 'scene', cacheKey: 'rot-2' });
    assert.equal(result?.provider, 'pollinations');
    assert.deepEqual(calls.map((c) => c.key), ['fake-cf-token-one', 'fake-cf-token-two', 'fake-cf-token-three', 'fake-poll-key-one']);
    assert.match(logs[0], /cloudflare#1 HTTP 402: payment required or out of credits; key spent/);
    assert.match(logs[1], /cloudflare#2 HTTP 400: quota exhausted; key spent .*trying cloudflare#3/);
    assert.match(logs[2], /cloudflare#3 HTTP 503: provider error; next provider: pollinations/);
    assert.equal(pipeline.isKeySpent('cloudflare#3'), false, 'a 5xx is not the key\'s fault, so the key is not marked spent');
    assertNoSecrets(logs);
  });
});

test('ROTATION-03: the chain leaves Cloudflare only after every Cloudflare key is spent, then rotates Pollinations keys the same way', async () => {
  await withTempCache(async (cacheDir) => {
    const { calls, fetchImpl } = mockFetch((call) => call.provider === 'cloudflare' ? status(429) : call.key === 'fake-poll-key-three' ? pollImage() : status(429));
    const { pipeline, logs } = pipelineWith(cacheDir, fetchImpl, ALL_KEYS);
    const result = await pipeline.generate({ prompt: 'scene', cacheKey: 'rot-3' });
    assert.equal(result?.provider, 'pollinations');
    assert.deepEqual(calls.map((c) => c.key), ['fake-cf-token-one', 'fake-cf-token-two', 'fake-cf-token-three', 'fake-poll-key-one', 'fake-poll-key-two', 'fake-poll-key-three']);
    assert.match(logs[2], /cloudflare#3 HTTP 429: .*no keys left, next provider: pollinations/);
    assert.match(logs[4], /pollinations#2 HTTP 429: .*trying pollinations#3/);
    assert.equal(logs.length, 5);
    assertNoSecrets(logs);
  });
});

test('ROTATION-04: a spent key is remembered for the rest of the UTC day and retried from the next UTC day', async () => {
  await withTempCache(async (cacheDir) => {
    let clock = Date.UTC(2026, 9, 31, 22, 0, 0);
    let slotOneQuota = true;
    const { calls, fetchImpl } = mockFetch((call) => call.key === 'fake-cf-token-one' && slotOneQuota ? status(429) : cfImage());
    const { pipeline } = pipelineWith(cacheDir, fetchImpl, ALL_KEYS, { now: () => clock });
    await pipeline.generate({ prompt: 'a', cacheKey: 'day-1' });
    assert.deepEqual(calls.map((c) => c.key), ['fake-cf-token-one', 'fake-cf-token-two']);
    assert.equal(pipeline.isKeySpent('cloudflare#1'), true);
    slotOneQuota = false;
    clock += 90 * 60_000; // 23:30 UTC, same day
    calls.length = 0;
    await pipeline.generate({ prompt: 'b', cacheKey: 'day-2' });
    assert.deepEqual(calls.map((c) => c.key), ['fake-cf-token-two'], 'the spent key is skipped for the rest of the day');
    clock += 31 * 60_000; // 00:01 UTC, next day
    calls.length = 0;
    assert.equal(pipeline.isKeySpent('cloudflare#1'), false);
    await pipeline.generate({ prompt: 'c', cacheKey: 'day-3' });
    assert.deepEqual(calls.map((c) => c.key), ['fake-cf-token-one'], 'slot 1 is first again on the next UTC day');
  });
});

test('ROTATION-05: missing key slots are skipped silently', async () => {
  await withTempCache(async (cacheDir) => {
    const { calls, fetchImpl } = mockFetch((call) => call.provider === 'cloudflare' ? cfImage() : pollImage());
    const { pipeline, logs } = pipelineWith(cacheDir, fetchImpl, { cloudflareToken3: 'fake-cf-token-three', cloudflareAccountId3: 'fake-acct-three' });
    const result = await pipeline.generate({ prompt: 'scene', cacheKey: 'rot-5' });
    assert.equal(result?.provider, 'cloudflare');
    assert.deepEqual(calls.map((c) => c.key), ['fake-cf-token-three']);
    assert.deepEqual(logs, [], 'unset slots 1 and 2 produce no log lines');

    const none = pipelineWith(cacheDir, fetchImpl, {});
    assert.equal(await none.pipeline.generate({ prompt: 'scene', cacheKey: 'rot-5b' }), undefined);
    assert.deepEqual(none.logs, []);
    assert.equal(calls.length, 1, 'no keys at all: no network call');
  });
});

test('ROTATION-06: timeouts and account lookups are logged by slot with a short reason; each slot looks up its own account', async () => {
  await withTempCache(async (cacheDir) => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.provider === 'accounts') return call.key === 'fake-cf-token-one' ? status(403) : new Response(JSON.stringify({ result: [{ id: 'fake-acct-two' }] }), { status: 200 });
      if (call.provider === 'cloudflare') return new Promise<Response>(() => { /* never answers: timeout */ });
      return pollImage();
    });
    const env: ArtPipelineEnv = { cloudflareToken: 'fake-cf-token-one', cloudflareToken2: 'fake-cf-token-two', pollinationsKey: 'fake-poll-key-one' };
    const { pipeline, logs } = pipelineWith(cacheDir, fetchImpl, env, { timeoutMs: 30 });
    const result = await pipeline.generate({ prompt: 'scene', cacheKey: 'rot-6' });
    assert.equal(result?.provider, 'pollinations');
    assert.deepEqual(calls.map((c) => `${c.provider}:${c.key}`), ['accounts:fake-cf-token-one', 'accounts:fake-cf-token-two', 'cloudflare:fake-cf-token-two', 'pollinations:fake-poll-key-one']);
    assert.match(logs[0], /cloudflare#1 HTTP 403: account lookup: key rejected; key spent .*trying cloudflare#2/);
    assert.match(logs[1], /cloudflare#2 no HTTP status: timeout after 30 ms; next provider: pollinations/);
    assertNoSecrets(logs);
  });
});

test('ROTATION-07: the hourly budget is global: one unit per panel however many keys it tries, and no key resets it', async () => {
  await withTempCache(async (cacheDir) => {
    let clock = Date.UTC(2026, 9, 31, 12, 0, 0);
    // Every panel exhausts cloudflare#1 and #2 for this call only (a fresh pipeline per key would
    // reset nothing): slot 3 answers, so each panel costs three calls but one budget unit.
    const { calls, fetchImpl } = mockFetch((call) => call.provider === 'cloudflare' ? cfImage() : pollImage());
    const { pipeline } = pipelineWith(cacheDir, fetchImpl, ALL_KEYS, { now: () => clock });
    for (let i = 0; i < 12; i++) {
      const result = await pipeline.generate({ prompt: `panel ${i}`, cacheKey: `budget-${i}` });
      assert.equal(result?.provider, 'cloudflare', `panel ${i} is within the default budget of 12`);
      clock += 60_000;
    }
    const before = calls.length;
    assert.equal(pipeline.hasBudget(), false, 'twelve panels spend the default hourly budget');
    assert.equal(await pipeline.generate({ prompt: 'panel 13', cacheKey: 'budget-13' }), undefined);
    assert.equal(calls.length, before, 'the 13th panel makes no network call even though unspent keys remain on both providers');
  });
});

test('ROTATION-08: key rotation inside one panel spends a single budget unit', async () => {
  await withTempCache(async (cacheDir) => {
    let quotaFor = new Set(['fake-cf-token-one', 'fake-cf-token-two', 'fake-cf-token-three', 'fake-poll-key-one']);
    const { calls, fetchImpl } = mockFetch((call) => quotaFor.has(call.key) ? status(429) : call.provider === 'cloudflare' ? cfImage() : pollImage());
    const { pipeline } = pipelineWith(cacheDir, fetchImpl, ALL_KEYS, { budgetPerHour: 2 });
    const first = await pipeline.generate({ prompt: 'a', cacheKey: 'one-unit-1' });
    assert.equal(first?.provider, 'pollinations');
    assert.equal(calls.length, 5, 'five key attempts for one panel');
    assert.equal(pipeline.hasBudget(), true, 'five attempts cost one unit of a budget of two');
    quotaFor = new Set();
    const second = await pipeline.generate({ prompt: 'b', cacheKey: 'one-unit-2' });
    assert.equal(second?.provider, 'pollinations', 'spent Cloudflare keys stay skipped for the day');
    assert.equal(pipeline.hasBudget(), false);
    const before = calls.length;
    assert.equal(await pipeline.generate({ prompt: 'c', cacheKey: 'one-unit-3' }), undefined);
    assert.equal(calls.length, before);
  });
});

test('ROTATION-09: without an explicit env the _2 and _3 variable names are read from the process environment', async () => {
  const names = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN_2', 'CLOUDFLARE_ACCOUNT_ID_2', 'CLOUDFLARE_API_TOKEN_3', 'CLOUDFLARE_ACCOUNT_ID_3', 'POLLINATIONS_API_KEY', 'POLLINATIONS_API_KEY_2', 'POLLINATIONS_API_KEY_3'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.CLOUDFLARE_API_TOKEN_2 = 'fake-env-cf-two';
    process.env.CLOUDFLARE_ACCOUNT_ID_2 = 'fake-env-acct-two';
    process.env.POLLINATIONS_API_KEY_3 = 'fake-env-poll-three';
    await withTempCache(async (cacheDir) => {
      const { calls, fetchImpl } = mockFetch((call) => call.provider === 'cloudflare' ? status(429) : pollImage());
      const logs: string[] = [];
      const pipeline = new ArtPipeline({ cacheDir, fetchImpl, spawnImpl: () => fakePngChild(), log: (line) => logs.push(line) });
      const result = await pipeline.generate({ prompt: 'scene', cacheKey: 'env-1' });
      assert.equal(result?.provider, 'pollinations');
      assert.deepEqual(calls.map((c) => c.key), ['fake-env-cf-two', 'fake-env-poll-three']);
      assert.ok(calls[0].url.includes('/accounts/fake-env-acct-two/'));
      assert.match(logs[0], /^art fall-through: cloudflare#2 HTTP 429/);
      assert.ok(logs.every((line) => !line.includes('fake-env-')));
    });
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});


test('ROTATION-10: unrelated prompt and size limits fall through without resting slot 1', async () => {
  for (const [httpStatus, body] of [
    [400, 'prompt length exceeded'],
    [500, '{"error":{"code":"invalid_size","message":"image size limit exceeded"}}'],
    [400, '{"error":{"message":"rate limit parameter is invalid"}}'],
  ] as const) {
    await withTempCache(async (cacheDir) => {
      let reject = true;
      const { calls, fetchImpl } = mockFetch((call) => call.provider === 'cloudflare'
        ? reject ? status(httpStatus, body) : cfImage() : pollImage());
      const { pipeline, logs } = pipelineWith(cacheDir, fetchImpl, ALL_KEYS);
      assert.equal((await pipeline.generate({ prompt: 'a', cacheKey: 'non-quota-1' }))?.provider, 'pollinations');
      assert.deepEqual(calls.map((call) => call.key), ['fake-cf-token-one', 'fake-poll-key-one']);
      assert.equal(pipeline.isKeySpent('cloudflare#1'), false);
      assert.match(logs[0], /next provider: pollinations/);
      reject = false;
      calls.length = 0;
      assert.equal((await pipeline.generate({ prompt: 'b', cacheKey: 'non-quota-2' }))?.provider, 'cloudflare');
      assert.deepEqual(calls.map((call) => call.key), ['fake-cf-token-one']);
      assertNoSecrets(logs);
    });
  }
});

test('ROTATION-11: structured quota codes rotate keys even without a quota message', async () => {
  for (const body of [
    { errors: [{ code: 'quota_exceeded', message: 'Request failed' }] },
    { error: { code: 'insufficient_quota', message: 'Request failed' } },
    { error: { type: 'daily_limit_exceeded', message: 'Request failed' } },
  ]) {
    await withTempCache(async (cacheDir) => {
      const { calls, fetchImpl } = mockFetch((call) => call.key === 'fake-cf-token-one'
        ? status(400, JSON.stringify(body)) : cfImage());
      const { pipeline, logs } = pipelineWith(cacheDir, fetchImpl, ALL_KEYS);
      assert.equal((await pipeline.generate({ prompt: 'a', cacheKey: 'structured-quota-1' }))?.provider, 'cloudflare');
      assert.deepEqual(calls.map((call) => call.key), ['fake-cf-token-one', 'fake-cf-token-two']);
      assert.equal(pipeline.isKeySpent('cloudflare#1'), true);
      calls.length = 0;
      await pipeline.generate({ prompt: 'b', cacheKey: 'structured-quota-2' });
      assert.deepEqual(calls.map((call) => call.key), ['fake-cf-token-two']);
      assertNoSecrets(logs);
    });
  }
});

// CX1 tests inject every credential slot and response; ambient provider keys are never read.
test('CX1-01: plain daily-quota words on a 400 do not rest the key for the next panel',async()=>{
  await withTempCache(async cacheDir=>{
    const {calls,fetchImpl}=mockFetch(call=>call.provider==='cloudflare'?status(400,'daily quota exceeded'):pollImage());
    const {pipeline}=pipelineWith(cacheDir,fetchImpl,{cloudflareToken:ALL_KEYS.cloudflareToken,cloudflareAccountId:ALL_KEYS.cloudflareAccountId,pollinationsKey:ALL_KEYS.pollinationsKey});
    await pipeline.generate({prompt:'cx1 scene',cacheKey:'cx1-01-first'});
    calls.length=0;
    await pipeline.generate({prompt:'cx1 next scene',cacheKey:'cx1-01-next'});
    assert.equal(calls[0]?.provider,'cloudflare','the next panel must retry the same Cloudflare key');
    assert.equal(calls[0]?.key,ALL_KEYS.cloudflareToken);
    assert.equal(pipeline.isKeySpent('cloudflare#1'),false);
  });
});

test('CX1-02: numeric Cloudflare daily-neuron codes rest the key without HTTP 429',async t=>{
  for(const code of [3036,4006])await t.test(`code ${code}`,async()=>{
    await withTempCache(async cacheDir=>{
      const {calls,fetchImpl}=mockFetch(call=>call.provider==='cloudflare'?status(400,JSON.stringify({errors:[{code,message:'Request failed'}]})):pollImage());
      const {pipeline}=pipelineWith(cacheDir,fetchImpl,{cloudflareToken:ALL_KEYS.cloudflareToken,cloudflareAccountId:ALL_KEYS.cloudflareAccountId,pollinationsKey:ALL_KEYS.pollinationsKey});
      await pipeline.generate({prompt:'cx1 coded scene',cacheKey:`cx1-02-${code}-first`});
      assert.equal(pipeline.isKeySpent('cloudflare#1'),true,`code ${code} must rest the key`);
      calls.length=0;
      await pipeline.generate({prompt:'cx1 coded next scene',cacheKey:`cx1-02-${code}-next`});
      assert.equal(calls.some(call=>call.provider==='cloudflare'),false);
    });
  });
});

test('CX1-03: HTTP 429 with Cloudflare code 3040 is transient capacity and does not rest the key',async()=>{
  await withTempCache(async cacheDir=>{
    const {calls,fetchImpl}=mockFetch(call=>call.provider==='cloudflare'?status(429,JSON.stringify({errors:[{code:3040,message:'Out of capacity'}]})):pollImage());
    const {pipeline}=pipelineWith(cacheDir,fetchImpl,{cloudflareToken:ALL_KEYS.cloudflareToken,cloudflareAccountId:ALL_KEYS.cloudflareAccountId,pollinationsKey:ALL_KEYS.pollinationsKey});
    await pipeline.generate({prompt:'cx1 capacity scene',cacheKey:'cx1-03-first'});
    calls.length=0;
    await pipeline.generate({prompt:'cx1 capacity retry',cacheKey:'cx1-03-next'});
    assert.equal(calls[0]?.provider,'cloudflare');
    assert.equal(calls[0]?.key,ALL_KEYS.cloudflareToken);
    assert.equal(pipeline.isKeySpent('cloudflare#1'),false);
  });
});

test('CX1-04: Cloudflare skip reasons are logged once and reveal no credentials or prompt',async t=>{
  for(const reason of ['no keys','all spent'] as const)await t.test(reason,async()=>{
    await withTempCache(async cacheDir=>{
      const prompt='cx1-private-prompt-not-for-logs';
      const {fetchImpl}=mockFetch(call=>call.provider==='cloudflare'?status(429):pollImage());
      const env:ArtPipelineEnv={};
      env.pollinationsKey=ALL_KEYS.pollinationsKey;
      if(reason==='all spent')Object.assign(env,{cloudflareToken:ALL_KEYS.cloudflareToken,cloudflareAccountId:ALL_KEYS.cloudflareAccountId});
      const {pipeline,logs}=pipelineWith(cacheDir,fetchImpl,env);
      if(reason==='all spent'){await pipeline.generate({prompt,cacheKey:'cx1-04-exhaust'});logs.length=0;}
      assert.equal((await pipeline.generate({prompt,cacheKey:`cx1-04-${reason}`}))?.provider,'pollinations');
      assertNoSecrets(logs);
      for(const line of logs)assert.equal(line.includes(prompt),false,'prompt text is never logged');
      const skipped=logs.filter(line=>/cloudflare/i.test(line));
      assert.equal(skipped.length,1,'exactly one line explains the provider skip');
      assert.match(skipped[0],reason==='no keys'?/no.*key|not configured/i:/spent/i);
    });
  });
});
