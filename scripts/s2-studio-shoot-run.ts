import { readProductEnv } from '../packages/core/src/env.mjs';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../apps/server/src/app.ts';
import { ArtPipeline, type ArtRequest } from '../apps/server/src/pipeline/imagegen.ts';
import { eventBus } from '../packages/core/src/index.ts';
import { buildSyntheticSession, createDirectAdapter } from './s2-replay-core.ts';

/** Scene phrases (from describeScene) that identify which moment kind a prompt is for, and
 * how many panels of that kind get real art: the ones the on-air page will show (first
 * spike, first raid, both bursts). Four images in total. */
const REAL_ART_KINDS: [kind: string, scene: string, limit: number][] = [
  ['spike', 'wall of speech-shaped bursts', 1],
  ['burst', 'ring of identical small bursts', 2],
  ['raid', 'bright doorway', 1],
];
const REAL_ART_BUDGET = REAL_ART_KINDS.reduce((sum, [, , limit]) => sum + limit, 0);

/** Real network art for this proof, but only for the first few panels of a few moment
 * kinds (so only a handful of images are ever generated); every other panel keeps the
 * kind-matched library art Studio assigned when it opened. Keys come from the environment
 * and are never printed. Without COMICTOONS_ART_NETWORK=1 no pipeline is injected at all and
 * every panel shows library art. */
class SelectiveArtPipeline extends ArtPipeline {
  /** "<kind>-<n>" -> provider:file, 'pending' or 'failed'. */
  readonly generatedKinds = new Map<string, string>();
  override async generate(request: ArtRequest) {
    const match = REAL_ART_KINDS.find(([, scene]) => request.prompt.includes(scene));
    if (!match) return undefined;
    const [kind, , limit] = match;
    const used = [...this.generatedKinds.keys()].filter((key) => key.startsWith(`${kind}-`)).length;
    if (used >= limit) return undefined;
    const key = `${kind}-${used + 1}`;
    this.generatedKinds.set(key, 'pending');
    const result = await super.generate(request);
    this.generatedKinds.set(key, result ? `${result.provider}:${result.fileName}` : 'failed');
    return result;
  }
}

const apiPort = Number(readProductEnv('COMICTOONS_API_PORT') ?? 3102);
const webPort = Number(readProductEnv('COMICTOONS_WEB_PORT') ?? 4102);
const outDir = process.argv[2] ?? resolve(import.meta.dirname, '../../panelcast-xfer/shots-s2');

async function waitForHttpOk(url: string, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

// The cache dir is left at its default (fixtures/art/generated) rather than outDir: that is
// the one real directory app.ts's frozen /art/generated/:file route actually serves from.
// panel-live-* is git-ignored, and this script deletes its own cache files when it is done.
const generatedDir = resolve(import.meta.dirname, '../fixtures/art/generated');
const networkArt = readProductEnv('COMICTOONS_ART_NETWORK') === '1';
const realArt = networkArt ? new SelectiveArtPipeline({ cacheDir: generatedDir, budgetPerHour: REAL_ART_BUDGET }) : undefined;
console.log(`network art: ${networkArt ? 'on (at most ' + REAL_ART_BUDGET + ' images)' : 'off (library art only)'}`);
const direct = createDirectAdapter();
let clockMs = 0;
const options = { adapterFactory: () => direct.adapter, now: () => clockMs, ...(realArt ? { artPipeline: realArt } : {}) };
const app = createApp(options as Parameters<typeof createApp>[0]);
await app.listen({ host: '127.0.0.1', port: apiPort });
console.log(`Server listening on ${apiPort}`);

// Own process group, so the whole npm -> vite -> esbuild tree is stopped together below.
const web = spawn('npm', ['run', 'dev', '-w', '@comictoons/web'], {
  cwd: resolve(import.meta.dirname, '..'), detached: true,
  env: { ...process.env, COMICTOONS_WEB_PORT: String(webPort), COMICTOONS_API_PORT: String(apiPort), COMICTOONS_OPEN: '0' },
  stdio: 'inherit',
});

try {
  await waitForHttpOk(`http://127.0.0.1:${webPort}/`);

  const ingestResponse = await fetch(`http://127.0.0.1:${apiPort}/api/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'twitch', channel: 'synthetic_demo' }),
  });
  console.log('ingest ->', await ingestResponse.text());

  const session = buildSyntheticSession();
  let busIndex = 0;
  for (const event of session.chatEvents) {
    clockMs = Math.round(event.t * 1000);
    while (busIndex < session.busEvents.length && session.busEvents[busIndex]!.t <= event.t) {
      eventBus.emit('stream-event', session.busEvents[busIndex]!);
      busIndex++;
    }
    direct.push(event);
  }
  while (busIndex < session.busEvents.length) { eventBus.emit('stream-event', session.busEvents[busIndex]!); busIndex++; }

  type Panel = { id: string; caption: string; imageUrl: string; scene?: string; sfx?: string; provenance?: { provider?: string } };
  const readState = async () => (await (await fetch(`http://127.0.0.1:${apiPort}/api/state`)).json()) as { pendingPanels: Panel[]; panels: Panel[] };
  if (realArt) {
    // Wait (bounded) for the few real-art upgrades to land in place.
    for (let i = 0; i < 240 && [...realArt.generatedKinds.values()].some((v) => v === 'pending'); i++) await new Promise((r) => setTimeout(r, 500));
  } else await new Promise((r) => setTimeout(r, 500));
  const state = await readState();
  console.log(`pendingPanels after feeding: ${state.pendingPanels.length}`);

  // Put a spread of distinct moment kinds on air through the normal moderation API: the
  // first spike, burst, raid and hype panels (the ones that get real art when network art
  // is on), then others. The on-air view shows the latest manga page (at most six frames,
  // two balloons per frame), so keep the total within one page so every pick is visible.
  type Pick = Panel & { dialogue?: string[] };
  const framesOf = (panel: Pick) => Math.max(1, Math.ceil((panel.dialogue?.length ?? 0) / 2));
  const pick: Pick[] = [];
  let frames = 0;
  const pending = state.pendingPanels as Pick[];
  const ordered = [...['SPIKE!', 'SURGE!', 'RAID!', 'HYPE!', 'CHEER!', 'INK!', 'VOTE!'].map((sfx) => pending.find((p) => p.sfx === sfx)), ...pending].filter((p): p is Pick => !!p);
  for (const panel of ordered) {
    if (pick.includes(panel) || frames + framesOf(panel) > 6 || pick.length >= 6) continue;
    pick.push(panel); frames += framesOf(panel);
  }
  for (const panel of pick) {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ panelId: panel.id }) });
    if (!response.ok) throw new Error(`approve failed: HTTP ${response.status}`);
  }
  const onAir = (await readState()).panels;

  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(`http://127.0.0.1:${webPort}/studio`, { waitUntil: 'networkidle' });
  const cells = page.locator('.preview-stage .manga-cell');
  await cells.first().waitFor({ timeout: 15_000 });
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined))); });
  await page.waitForTimeout(500);
  const visible = await page.evaluate(() => [...document.querySelectorAll('.preview-stage .manga-cell')].map((cell) => ({
    sourceId: cell.getAttribute('data-source-id') ?? '',
    imageUrl: cell.querySelector('img')?.getAttribute('src') ?? '',
    loaded: !!(cell.querySelector('img') as HTMLImageElement | null)?.naturalWidth,
    text: (cell.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
  })));
  await page.screenshot({ path: resolve(outDir, 'studio-distinct.png'), fullPage: true });
  await page.locator('.live-preview').screenshot({ path: resolve(outDir, 'studio-distinct-onair.png') });
  await browser.close();

  const realArtFiles: Record<string, string> = {};
  if (realArt) {
    for (const [kind, value] of realArt.generatedKinds) {
      const [provider, fileName] = value.split(':');
      if (!fileName) { realArtFiles[kind] = value; continue; }
      await copyFile(resolve(generatedDir, fileName), resolve(outDir, `studio-real-art-${kind}.png`));
      realArtFiles[kind] = `${provider} -> studio-real-art-${kind}.png`;
    }
  }
  // Hash the bytes behind every on-air image (generated cache or library asset alike), before
  // the cache files are deleted below, so distinct URLs holding the same picture are caught.
  const sha256Of = async (imageUrl: string) => {
    try { return createHash('sha256').update(await readFile(resolve(generatedDir, imageUrl.split('/').pop() ?? ''))).digest('hex'); } catch { return 'MISSING'; }
  };
  const onAirHashes = await Promise.all(onAir.map((p) => sha256Of(p.imageUrl)));
  const summary = {
    networkArt,
    realArt: realArtFiles,
    onAir: onAir.map((p, i) => ({ id: p.id, sfx: p.sfx, caption: p.caption, scene: p.scene, imageUrl: p.imageUrl, provider: p.provenance?.provider, imageSha256: onAirHashes[i] })),
    distinctOnAirImageSha256: new Set(onAirHashes).size,
    visibleCells: visible,
    visibleCellCount: visible.length,
    distinctVisiblePanels: new Set(visible.map((v) => v.sourceId)).size,
    uniqueVisibleImages: new Set(visible.map((v) => v.imageUrl)).size,
    allVisibleImagesLoaded: visible.every((v) => v.loaded),
    uniqueOnAirCaptions: new Set(onAir.map((p) => p.caption)).size,
  };
  await writeFile(resolve(outDir, 'studio-distinct.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  try { if (web.pid) process.kill(-web.pid, 'SIGTERM'); } catch { web.kill('SIGTERM'); }
  await app.close();
  for (const entry of await readdir(generatedDir)) if (entry.startsWith('panel-live-')) await unlink(resolve(generatedDir, entry));
}
