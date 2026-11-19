import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Studio } from '../apps/server/src/studio.ts';
import { ArtPipeline } from '../apps/server/src/pipeline/imagegen.ts';
import { eventBus } from '../packages/core/src/index.ts';
import type { StreamEvent } from '../packages/core/src/index.ts';
import type { ChatAdapter } from '../apps/server/src/ingest/irc.ts';
import type { ComicPanel } from '../packages/core/src/index.ts';

export interface SyntheticSession { chatEvents: StreamEvent[]; busEvents: StreamEvent[]; durationSeconds: number }

const PHRASES = [
  'this is great', 'no way', 'lets go', 'what a play', 'I did not expect that', 'wow', 'incredible run',
  'cant believe it', 'here we go again', 'love this stream', 'first time here', 'been watching all day',
  'that was close', 'nice', 'oh no', 'back from the brink', 'so good', 'clean', 'textbook', 'perfect timing',
];

/** A synthetic but realistic ten-minute chat session: a steady baseline, two chat velocity
 * spikes, two emote bursts by distinct users, and one each of raid/cheer/hype/redemption/poll. */
export function buildSyntheticSession(): SyntheticSession {
  const durationSeconds = 600;
  const chatEvents: StreamEvent[] = [];
  let seq = 0;
  const nextId = () => `synthetic-${seq++}`;

  const baselineCount = 540;
  for (let i = 0; i < baselineCount; i++) {
    const t = (i / baselineCount) * durationSeconds;
    chatEvents.push({ id: nextId(), t, type: 'chat', user: `viewer-${i % 40}`, name: `Viewer${i % 40}`, text: PHRASES[i % PHRASES.length]! });
  }

  const spikeTimes = [120, 400];
  for (const start of spikeTimes) {
    for (let i = 0; i < 30; i++) {
      chatEvents.push({ id: nextId(), t: start + i * 0.26, type: 'chat', user: `raider-${i % 25}`, name: `Raider${i % 25}`, text: 'GO GO GO!!' });
    }
  }

  const burstTimes = [200, 450];
  for (const start of burstTimes) {
    for (let i = 0; i < 5; i++) {
      chatEvents.push({ id: nextId(), t: start + i * 0.8, type: 'chat', user: `fan-${i}`, name: `Fan${i}`, text: 'KEKW' });
    }
  }

  const busEvents: StreamEvent[] = [
    { id: nextId(), t: 60, type: 'raid', from: 'MoonlightCrew', viewers: 42 },
    { id: nextId(), t: 150, type: 'cheer', user: 'bits-fan', name: 'BitsFan' },
    { id: nextId(), t: 260, type: 'hype', level: 2 },
    { id: nextId(), t: 340, type: 'redemption', user: 'redeemer-1', name: 'Redeemer' },
    { id: nextId(), t: 480, type: 'poll' },
  ];

  chatEvents.sort((a, b) => a.t - b.t);
  return { chatEvents, busEvents, durationSeconds };
}

/** A direct test adapter: bypasses IRC wire parsing and feeds StreamEvents straight into
 * ChatSource's own admission/dedup/rate-limit pipeline, exactly like a real adapter would. */
export function createDirectAdapter() {
  let callbacks: { event: (event: StreamEvent) => void; status: (status: string, retrying?: boolean) => void } | undefined;
  const adapter: ChatAdapter = {
    simulated: true,
    start(cb) { callbacks = cb as typeof callbacks; callbacks!.status('connecting'); callbacks!.status('empty'); },
    stop() { callbacks = undefined; },
  };
  return { adapter, push: (event: StreamEvent) => callbacks?.event(event) };
}

/** A deterministic, fully offline "art provider": a fake fetch returns bytes derived only
 * from the prompt actually sent, so two panels get identical bytes exactly when they asked
 * for the same picture (as a real model would be asked), and a fake ffmpeg transcode passes
 * them straight through. Every prompt sent is passed to onPrompt. No network, no spawn. */
export function createMockArtPipeline(cacheDir: string, onPrompt: (prompt: string) => void = () => {}): ArtPipeline {
  const fakeFetch = (async (url: string, init?: { body?: unknown }) => {
    if (url.endsWith('/accounts')) return { ok: true, json: async () => ({ result: [{ id: 'mock-account' }] }) } as unknown as Response;
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    let prompt = url;
    try { prompt = (JSON.parse(bodyText) as { prompt?: string }).prompt ?? url; } catch { /* Pollinations encodes the prompt in the URL instead. */ }
    onPrompt(prompt);
    return { ok: true, json: async () => ({ result: { image: Buffer.from(`mock-image:${prompt}`).toString('base64') } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const fakeSpawn = (): ChildProcessWithoutNullStreams => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => child.emit('close', null);
    const chunks: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stdin.on('end', () => { child.stdout.end(Buffer.concat(chunks)); child.emit('close', 0); });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return new ArtPipeline({ cacheDir, fetchImpl: fakeFetch, spawnImpl: fakeSpawn, ffmpegPath: '/usr/bin/ffmpeg', budgetPerHour: 10_000, env: { cloudflareToken: 'mock', cloudflareAccountId: 'mock-account' } });
}

export interface ReplayPanel { id: string; caption: string; imageUrl: string; sources: string[]; sfx?: string; mood: string; scene: string; artProvider: string; imageSha256: string }
export interface ReplayReport {
  panelCount: number;
  uniqueImageUrlCount: number;
  uniqueCaptionCount: number;
  panels: ReplayPanel[];
  /** Panels per moment kind, keyed by the kind-specific SFX the writer letters on them. */
  panelsBySfx: Record<string, number>;
  /** Spike/burst panels whose sources are all chat messages fed through the ingest adapter
   * (the eventBus in this replay only carries raid/cheer/hype/redemption/poll). */
  spikePanelCount: number;
  burstPanelCount: number;
  everyPanelHasSources: boolean;
  noSharedImageUrl: boolean;
  noSharedCaption: boolean;
  /** sha256 of the image bytes each panel actually shows (generated cache file or library
   * asset alike), so two different URLs that hold the same picture are caught. */
  distinctImageSha256Count: number;
  missingImageFileCount: number;
  noSharedImageBytes: boolean;
  /** Which art each panel ended up with: the pipeline's provider label, or 'library' for
   * the fallback. In this replay the generator is an offline mock answering in the
   * Cloudflare step's place (see artSource), so 'cloudflare' here means mock-generated. */
  artProviderCounts: Record<string, number>;
  artSource: string;
  /** Every art prompt sent during the replay, and whether any repeated or quoted chat. */
  promptCount: number;
  distinctPromptCount: number;
  noSharedPrompt: boolean;
  promptsQuoteChatOrNames: boolean;
}

/** Runs the synthetic session through Studio's real live path: chat via the ingest
 * adapter (same code as IRC/sample), strong signals via the eventBus seam S1 will use. No
 * real network: a mocked art pipeline stands in for Cloudflare/Pollinations/ffmpeg so
 * panels still get distinct generated-style art beyond the small fixed library pool. */
const libraryDir = resolve(import.meta.dirname, '../fixtures/art/generated');

/** Hashes the bytes behind a panel's /art/generated/<file> URL: the replay's own cache
 * directory first (generated art), then the shipped library directory (fallback art). */
async function imageSha256(imageUrl: string, cacheDir: string): Promise<string> {
  const file = basename(imageUrl.split('?')[0] ?? '');
  for (const dir of [cacheDir, libraryDir]) {
    try { return createHash('sha256').update(await readFile(resolve(dir, file))).digest('hex'); } catch { /* try the next directory */ }
  }
  return 'MISSING';
}

/** Emote-like chat tokens (KEKW, PogChamp): all caps of three or more letters, or camel case. */
function emoteTokens(session: SyntheticSession): string[] {
  const words = session.chatEvents.flatMap((event) => (event.text ?? '').split(/[^A-Za-z0-9]+/));
  return [...new Set(words.filter((word) => /^[A-Z]{3,}$|^[A-Z][a-z]+[A-Z]\w*$/.test(word)))];
}

/** True when a prompt contains any chat line of four or more characters, an emote token
 * from chat, or any user, display or raider name. */
function quotesChatOrNames(prompt: string, session: SyntheticSession): boolean {
  const lower = prompt.toLowerCase();
  const all = [...session.chatEvents, ...session.busEvents];
  const names = all.flatMap((event) => [event.user, event.name, event.from]).filter((name): name is string => !!name);
  const lines = session.chatEvents.map((event) => event.text ?? '').filter((text) => text.length >= 4);
  return names.some((name) => lower.includes(name.toLowerCase())) || lines.some((line) => lower.includes(line.toLowerCase()))
    || emoteTokens(session).some((token) => new RegExp(`\\b${token}\\b`, 'i').test(prompt));
}

export async function runReplay(cacheDir = 'artifacts/tmp/s2-replay-art'): Promise<ReplayReport> {
  const session = buildSyntheticSession();
  const direct = createDirectAdapter();
  let clockMs = 0;
  const prompts: string[] = [];
  const studio = new Studio({ now: () => clockMs, adapterFactory: () => direct.adapter, artPipeline: createMockArtPipeline(cacheDir, (prompt) => prompts.push(prompt)) });
  try {
    studio.useSource('twitch', 'synthetic_channel');
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
    await studio.flushArtUpgrades();

    const allPanels: ComicPanel[] = [...studio.state.panels, ...studio.state.pendingPanels];
    const panels: ReplayPanel[] = await Promise.all(allPanels.map(async (panel) => ({
      id: panel.id, caption: panel.caption, imageUrl: panel.imageUrl, sources: panel.sources ?? [], sfx: panel.sfx, mood: panel.mood,
      scene: panel.scene, artProvider: panel.provenance?.provider ?? 'unknown', imageSha256: await imageSha256(panel.imageUrl, cacheDir),
    })));
    const shas = panels.map((panel) => panel.imageSha256);
    const artProviderCounts: Record<string, number> = {};
    for (const panel of panels) artProviderCounts[panel.artProvider] = (artProviderCounts[panel.artProvider] ?? 0) + 1;
    const chatIds = new Set(session.chatEvents.map((event) => event.id));
    const panelsBySfx: Record<string, number> = {};
    for (const panel of panels) panelsBySfx[panel.sfx ?? 'none'] = (panelsBySfx[panel.sfx ?? 'none'] ?? 0) + 1;
    const fromIngest = (panel: ReplayPanel) => panel.sources.length > 0 && panel.sources.every((id) => chatIds.has(id));
    const imageUrls = panels.map((p) => p.imageUrl);
    const captions = panels.map((p) => p.caption);
    return {
      panelCount: panels.length,
      uniqueImageUrlCount: new Set(imageUrls).size,
      uniqueCaptionCount: new Set(captions).size,
      panels,
      panelsBySfx,
      spikePanelCount: panels.filter((panel) => panel.sfx === 'SPIKE!' && fromIngest(panel)).length,
      burstPanelCount: panels.filter((panel) => panel.sfx === 'SURGE!' && fromIngest(panel)).length,
      everyPanelHasSources: panels.every((p) => p.sources.length >= 1),
      noSharedImageUrl: new Set(imageUrls).size === imageUrls.length,
      noSharedCaption: new Set(captions).size === captions.length,
      distinctImageSha256Count: new Set(shas).size,
      missingImageFileCount: shas.filter((sha) => sha === 'MISSING').length,
      noSharedImageBytes: !shas.includes('MISSING') && new Set(shas).size === shas.length,
      artProviderCounts,
      artSource: 'offline mock generator in the Cloudflare step (image bytes derived from the prompt sent); no network',
      promptCount: prompts.length,
      distinctPromptCount: new Set(prompts).size,
      noSharedPrompt: new Set(prompts).size === prompts.length,
      promptsQuoteChatOrNames: prompts.some((prompt) => quotesChatOrNames(prompt, session)),
    };
  } finally {
    studio.close();
  }
}

export async function writeReplayReport(outputPath: string): Promise<ReplayReport> {
  // A fresh, empty art cache per run, so every hashed image was produced by this run.
  await mkdir('artifacts/tmp', { recursive: true });
  const cacheDir = await mkdtemp(resolve('artifacts/tmp/s2-replay-art-'));
  let report: ReplayReport;
  try { report = await runReplay(cacheDir); } finally { await rm(cacheDir, { recursive: true, force: true }); }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  return report;
}
