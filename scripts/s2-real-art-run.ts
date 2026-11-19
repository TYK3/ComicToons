import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ArtPipeline, buildArtPrompt } from '../apps/server/src/pipeline/imagegen.ts';
import { describeScene } from '../apps/server/src/pipeline/writer.ts';
import type { LiveMoment } from '../apps/server/src/pipeline/moments.ts';

const imagePath = process.argv[2];
const jsonPath = process.argv[3];
if (!imagePath || !jsonPath) throw new Error('Usage: s2-real-art-run.ts <image-output-path> <json-output-path>');

const moment: LiveMoment = {
  kind: 'hype', startAt: 0, endAt: 0, score: 40,
  events: [{ id: 'proof-hype', t: 0, type: 'hype', level: 2 }],
  sourceIds: ['proof-hype'],
};
const prompt = buildArtPrompt(describeScene(moment));

const hasCloudflare = !!process.env.CLOUDFLARE_API_TOKEN;
const hasPollinations = !!process.env.POLLINATIONS_API_KEY;

/** A side-channel diagnostic only: explains *why* Cloudflare did or didn't serve the
 * request below, without ever printing the token itself. */
async function probeCloudflareAccount(): Promise<string> {
  if (!hasCloudflare) return 'no CLOUDFLARE_API_TOKEN set';
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
    const body = (await response.json()) as { result?: unknown[]; errors?: unknown[] };
    if (!response.ok) return `GET /accounts returned HTTP ${response.status}`;
    if (!body.result?.length) return 'GET /accounts returned HTTP 200 but an empty account list, so no account id could be resolved (the token likely lacks Account Read, or has zero accounts)';
    return `GET /accounts resolved ${body.result.length} account(s) successfully`;
  } catch (error) {
    return `GET /accounts threw: ${(error as Error).message}`;
  }
}
const cloudflareDiagnosis = await probeCloudflareAccount();

const pipeline = new ArtPipeline({ cacheDir: dirname(imagePath), timeoutMs: 25_000 });
const result = await pipeline.generate({ prompt, cacheKey: `s2-real-art-proof:${Date.now()}` });

await mkdir(dirname(imagePath), { recursive: true });
if (!result) {
  await writeFile(jsonPath, JSON.stringify({
    provider: null, prompt, bytes: 0, ms: null,
    note: 'Every step in the chain failed or was skipped (no clip, so step c is a no-op); the caller falls back to the library.',
    hasCloudflareToken: hasCloudflare, hasPollinationsKey: hasPollinations, cloudflareDiagnosis,
  }, null, 2));
  console.log('No provider served this request; see the json report for diagnostics.');
  process.exit(1);
}

const ext = 'png';
await writeFile(`${imagePath}.${ext}`, result.buffer);
await writeFile(jsonPath, JSON.stringify({
  provider: result.provider,
  prompt,
  bytes: result.buffer.length,
  ms: result.ms,
  hasCloudflareToken: hasCloudflare,
  hasPollinationsKey: hasPollinations,
  cloudflareDiagnosis,
  note: result.provider === 'cloudflare'
    ? 'Cloudflare Workers AI served this request directly.'
    : `Cloudflare did not serve this request; the chain fell through to ${result.provider}. Why: ${cloudflareDiagnosis}.`,
}, null, 2));
console.log(`Saved ${result.buffer.length} bytes from provider "${result.provider}" in ${result.ms}ms.`);
