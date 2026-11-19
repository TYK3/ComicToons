import { readProductEnv } from '../../../../packages/core/src/env.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ffmpegAvailable, inkClipFrame, runFfmpeg, type ClipRef, type SpawnImpl } from './frames.ts';
import { resolveMangaTheme, type MangaThemeId } from '@comictoons/core';

export type ArtProvider = 'cloudflare' | 'pollinations' | 'clip-frame';
export interface GeneratedArt { buffer: Buffer; provider: ArtProvider; fileName: string; imageUrl: string; ms: number }
export interface ArtRequest { prompt: string; cacheKey: string; clip?: ClipRef }
/** Key slots per provider. Slot 1 is the original variable; slots 2 and 3 are optional
 * spares (CLOUDFLARE_API_TOKEN_2 / CLOUDFLARE_ACCOUNT_ID_2, POLLINATIONS_API_KEY_2, ...). */
export interface ArtPipelineEnv {
  cloudflareToken?: string; cloudflareAccountId?: string;
  cloudflareToken2?: string; cloudflareAccountId2?: string;
  cloudflareToken3?: string; cloudflareAccountId3?: string;
  pollinationsKey?: string; pollinationsKey2?: string; pollinationsKey3?: string;
}
export interface ArtPipelineOptions {
  timeoutMs?: number;
  budgetPerHour?: number;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ffmpegPath?: string;
  spawnImpl?: SpawnImpl;
  env?: ArtPipelineEnv;
  /** Receives one line per fall-through. Lines name the key by slot only (e.g.
   * "cloudflare#2"), never a key, token or account id. Defaults to console.warn. */
  log?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BUDGET_PER_HOUR = 12;
const KEY_SLOTS = [1, 2, 3] as const;

interface KeySlot { label: string; token: string; accountId?: string }
/** The result of one provider call with one key. `keySpent` marks failures that belong to
 * the key (quota, payment, rejected key), so the next key of the same provider is tried. */
type Attempt<T> = { ok: true; value: T } | { ok: false; status?: number; reason: string; keySpent: boolean };

function readEnvSlots(): ArtPipelineEnv {
  const env = process.env;
  return {
    cloudflareToken: env.CLOUDFLARE_API_TOKEN, cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareToken2: env.CLOUDFLARE_API_TOKEN_2, cloudflareAccountId2: env.CLOUDFLARE_ACCOUNT_ID_2,
    cloudflareToken3: env.CLOUDFLARE_API_TOKEN_3, cloudflareAccountId3: env.CLOUDFLARE_ACCOUNT_ID_3,
    pollinationsKey: env.POLLINATIONS_API_KEY, pollinationsKey2: env.POLLINATIONS_API_KEY_2, pollinationsKey3: env.POLLINATIONS_API_KEY_3,
  };
}

const QUOTA_CODES = new Set([
  'quota_exceeded', 'insufficient_quota', 'daily_quota_exceeded', 'daily_limit_exceeded',
  'rate_limit_exceeded', 'rate_limit_error', 'insufficient_balance', 'insufficient_credits',
  'billing_hard_limit_reached', '3036', '4006',
]);
function hasErrorCode(body: unknown, codes: ReadonlySet<string>): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const error = body as Record<string, unknown>;
  if ([error.code, error.type].some((code) => (typeof code === 'string' || typeof code === 'number') && codes.has(String(code).toLowerCase()))) return true;
  return hasErrorCode(error.error, codes) || (Array.isArray(error.errors) && error.errors.some(item => hasErrorCode(item, codes)));
}

/** Classifies a non-OK response by status and structured codes with a short, fixed reason. Bodies are
 * never copied into the reason, so nothing from the provider reaches the log. */
async function classifyFailure(response: Response): Promise<{ status?: number; reason: string; keySpent: boolean }> {
  const status = typeof response.status === 'number' ? response.status : undefined;
  if (status === 402) return { status, reason: 'payment required or out of credits', keySpent: true };
  if (status === 401 || status === 403) return { status, reason: 'key rejected', keySpent: true };
  let body: unknown;
  try { body = JSON.parse(typeof response.text === 'function' ? (await response.text()).slice(0, 2000) : ''); } catch { /* status-only classification for non-JSON bodies */ }
  if (status === 429 && hasErrorCode(body, new Set(['3040']))) return { status, reason: 'transient capacity', keySpent: false };
  if (status === 429) return { status, reason: 'rate limit or quota', keySpent: true };
  if (hasErrorCode(body, QUOTA_CODES)) return { status, reason: 'quota exhausted', keySpent: true };
  return { status, reason: status && status >= 500 ? 'provider error' : 'request rejected', keySpent: false };
}

/** Runs one provider call with a hard deadline: the request is aborted at the timeout and,
 * even if the transport ignores the abort, the chain moves on at that moment. */
async function attempt<T>(run: (signal: AbortSignal) => Promise<Attempt<T>>, timeoutMs: number): Promise<Attempt<T>> {
  const controller = new AbortController();
  const timedOut: Attempt<T> = { ok: false, reason: `timeout after ${timeoutMs} ms`, keySpent: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Attempt<T>>((settle) => { timer = setTimeout(() => { controller.abort(); settle(timedOut); }, timeoutMs); });
  const call = run(controller.signal).catch((): Attempt<T> => (controller.signal.aborted ? timedOut : { ok: false, reason: 'network error', keySpent: false }));
  try { return await Promise.race([call, deadline]); } finally { clearTimeout(timer); }
}

/** UTC calendar day, e.g. "2026-10-31"; a spent key is retried from the next UTC day. */
function utcDay(at: number): string { return new Date(at).toISOString().slice(0, 10); }

/**
 * Orchestrates the manga art chain for one live panel: Cloudflare Workers AI, then
 * Pollinations, then a manga-inked clip frame, with an hourly budget on the two network
 * steps, a disk cache keyed by prompt hash, and at most one generation in flight at a
 * time. The final library fallback lives in pipeline/library.ts and is applied by the
 * caller when this pipeline returns undefined (no key, no budget, no clip, all failed).
 *
 * Key rotation: each network provider has up to three key slots. A key that answers with
 * 429 (except Cloudflare capacity code 3040), 402, 401/403 or a quota code is marked spent until the next UTC day and the next
 * slot of the same provider is tried; the chain moves to the next provider once every
 * configured key of this one is spent, or straight away on a failure that is not about the
 * key (timeout, network error, 5xx, missing image, failed transcode). Unset slots are
 * skipped without a log line. The hourly budget is one global count per panel, however
 * many keys a panel tries, and is charged only when a call is possible: with no keys
 * configured, or every key spent, nothing is charged. A panel skipped because every key is
 * spent or the budget is used gets one log line with the reason.
 */
export class ArtPipeline {
  private readonly timeoutMs: number;
  private readonly budgetPerHour: number;
  private readonly cacheDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ffmpegPath: string;
  private readonly spawnImpl?: SpawnImpl;
  private readonly env: ArtPipelineEnv;
  private readonly log: (line: string) => void;
  private readonly cachedAccountIds = new Map<string, string>();
  /** Slot label -> UTC day on which it was spent. */
  private readonly spentKeys = new Map<string, string>();
  private budgetUses: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ArtPipelineOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.budgetPerHour = options.budgetPerHour ?? (Number(process.env.IMAGE_BUDGET_PER_HOUR) || DEFAULT_BUDGET_PER_HOUR);
    this.cacheDir = options.cacheDir ?? readProductEnv('COMICTOONS_ART_CACHE_DIR') ?? resolve(import.meta.dirname, '../../../../fixtures/art/generated');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ffmpegPath = options.ffmpegPath ?? '/usr/bin/ffmpeg';
    this.spawnImpl = options.spawnImpl;
    // An explicit env object (as every test supplies) is authoritative on its own, so a
    // partial override in a test can never accidentally pick up real host secrets for the
    // fields it left out.
    this.env = options.env ?? readEnvSlots();
    this.log = options.log ?? ((line) => console.warn(line));
  }

  private pruneBudget(): void {
    const cutoff = this.now() - 3_600_000;
    this.budgetUses = this.budgetUses.filter((at) => at > cutoff);
  }

  hasBudget(): boolean { this.pruneBudget(); return this.budgetUses.length < this.budgetPerHour; }

  /** True when this panel may call a provider: some configured key is unspent and the hourly
   * budget has room. With no keys configured (the offline default) it stays quiet; when keys
   * exist but every one is spent, or the budget is used, it logs one line naming the reason,
   * with counts only, never a key, token or account id (N3). */
  private networkCallPossible(): boolean {
    const configured = [...this.cloudflareSlots(), ...this.pollinationsSlots()];
    if (!configured.length) return false;
    const next = 'next step: clip frame, then library';
    if (configured.every((slot) => this.isKeySpent(slot.label))) {
      this.log(`art skipped: every configured key is spent until the next UTC day (${configured.length} of ${configured.length}); ${next}`);
      return false;
    }
    if (!this.hasBudget()) {
      const refill = this.budgetUses.length ? `next unit in ${Math.max(1, Math.ceil((Math.min(...this.budgetUses) + 3_600_000 - this.now()) / 60_000))} min` : 'the budget is set to zero';
      this.log(`art skipped: hourly image budget used (${this.budgetUses.length} of ${this.budgetPerHour}), ${refill}; ${next}`);
      return false;
    }
    return true;
  }
  private spendBudget(): void { this.budgetUses.push(this.now()); }

  private cloudflareSlots(): KeySlot[] {
    const tokens = [this.env.cloudflareToken, this.env.cloudflareToken2, this.env.cloudflareToken3];
    const accounts = [this.env.cloudflareAccountId, this.env.cloudflareAccountId2, this.env.cloudflareAccountId3];
    return KEY_SLOTS.flatMap((slot, i) => tokens[i] ? [{ label: `cloudflare#${slot}`, token: tokens[i]!, accountId: accounts[i] || undefined }] : []);
  }

  private pollinationsSlots(): KeySlot[] {
    const keys = [this.env.pollinationsKey, this.env.pollinationsKey2, this.env.pollinationsKey3];
    return KEY_SLOTS.flatMap((slot, i) => keys[i] ? [{ label: `pollinations#${slot}`, token: keys[i]! }] : []);
  }

  /** True while the slot is marked spent for the current UTC day. */
  isKeySpent(label: string): boolean {
    const day = this.spentKeys.get(label);
    if (day === undefined) return false;
    if (day === utcDay(this.now())) return true;
    this.spentKeys.delete(label);
    return false;
  }

  private fallThrough(label: string, failure: { status?: number; reason: string }, next: string): void {
    const status = failure.status === undefined ? 'no HTTP status' : `HTTP ${failure.status}`;
    this.log(`art fall-through: ${label} ${status}: ${failure.reason}; ${next}`);
  }

  private async resolveCloudflareAccount(slot: KeySlot): Promise<Attempt<string>> {
    if (slot.accountId) return { ok: true, value: slot.accountId };
    const cached = this.cachedAccountIds.get(slot.label);
    if (cached) return { ok: true, value: cached };
    const result = await attempt<string>(async (signal) => {
      const response = await this.fetchImpl('https://api.cloudflare.com/client/v4/accounts', {
        signal, headers: { Authorization: `Bearer ${slot.token}` },
      });
      if (!response.ok) { const failure = await classifyFailure(response); return { ok: false, ...failure, reason: `account lookup: ${failure.reason}` }; }
      const id = ((await response.json()) as { result?: { id?: string }[] })?.result?.[0]?.id;
      return id ? { ok: true, value: id } : { ok: false, reason: 'account lookup: no account on this key', keySpent: true };
    }, this.timeoutMs);
    if (result.ok) this.cachedAccountIds.set(slot.label, result.value);
    return result;
  }

  private async cloudflareCall(slot: KeySlot, prompt: string): Promise<Attempt<Buffer>> {
    const account = await this.resolveCloudflareAccount(slot);
    if (!account.ok) return account;
    return attempt<Buffer>(async (signal) => {
      const response = await this.fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account.value}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${slot.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, steps: 4 }),
      });
      if (!response.ok) return { ok: false, ...(await classifyFailure(response)) };
      const body = (await response.json()) as { result?: { image?: string } };
      if (!body?.result?.image) return { ok: false, status: response.status, reason: 'no image in response', keySpent: false };
      return { ok: true, value: Buffer.from(body.result.image, 'base64') };
    }, this.timeoutMs);
  }

  private async pollinationsCall(slot: KeySlot, prompt: string): Promise<Attempt<Buffer>> {
    let last: Attempt<Buffer> = { ok: false, reason: 'not attempted', keySpent: false };
    for (const model of ['black-forest-labs/flux.1-schnell', 'flux']) {
      last = await attempt<Buffer>(async (signal) => {
        const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${encodeURIComponent(model)}`;
        const response = await this.fetchImpl(url, { signal, headers: { Authorization: `Bearer ${slot.token}` } });
        if (!response.ok) return { ok: false, ...(await classifyFailure(response)) };
        return { ok: true, value: Buffer.from(await response.arrayBuffer()) };
      }, this.timeoutMs);
      // Only a rejected model id is worth a retry with the fallback model on the same key.
      if (last.ok || last.keySpent) return last;
    }
    return last;
  }

  /** Tries each unspent key of one provider in slot order. Returns a PNG, or undefined once
   * the provider has nothing left to offer for this panel (every reason is logged). */
  private async runProvider(provider: 'cloudflare' | 'pollinations', prompt: string, nextStep: string): Promise<Buffer | undefined> {
    const configured = provider === 'cloudflare' ? this.cloudflareSlots() : this.pollinationsSlots();
    const slots = configured.filter((slot) => !this.isKeySpent(slot.label));
    if (provider === 'cloudflare' && !slots.length) this.fallThrough('cloudflare', { reason: configured.length ? 'all configured keys spent' : 'no keys configured' }, nextStep);
    for (const [index, slot] of slots.entries()) {
      const result = provider === 'cloudflare' ? await this.cloudflareCall(slot, prompt) : await this.pollinationsCall(slot, prompt);
      const nextKey = slots[index + 1];
      if (!result.ok) {
        if (result.keySpent) {
          this.spentKeys.set(slot.label, utcDay(this.now()));
          this.fallThrough(slot.label, result, `key spent until the next UTC day; ${nextKey ? `trying ${nextKey.label}` : `no keys left, ${nextStep}`}`);
          continue;
        }
        this.fallThrough(slot.label, result, nextStep);
        return undefined;
      }
      const png = await this.toPng(result.value);
      if (png) return png;
      this.fallThrough(slot.label, { reason: 'PNG transcode failed' }, nextStep);
      return undefined;
    }
    return undefined;
  }

  /** Transcodes an arbitrary provider image to PNG so it always matches the frozen
   * /art/generated/:file route's extension allow-list, regardless of source encoding. */
  private async toPng(buffer: Buffer): Promise<Buffer | undefined> {
    if (!ffmpegAvailable(this.ffmpegPath)) return undefined;
    return runFfmpeg(buffer, ['-hide_banner', '-loglevel', 'error', '-i', '-', '-f', 'image2', '-vframes', '1', '-vcodec', 'png', '-'],
      { ffmpegPath: this.ffmpegPath, timeoutMs: this.timeoutMs, spawnImpl: this.spawnImpl });
  }

  private fileName(hash: string): string { return `panel-live-${hash}.png`; }
  private cachePath(hash: string): string { return resolve(this.cacheDir, this.fileName(hash)); }
  private metaPath(hash: string): string { return resolve(this.cacheDir, `panel-live-${hash}.json`); }

  private async readCache(hash: string): Promise<{ buffer: Buffer; provider: ArtProvider } | undefined> {
    try {
      const buffer = await readFile(this.cachePath(hash));
      let provider: ArtProvider = 'cloudflare';
      try { provider = (JSON.parse(await readFile(this.metaPath(hash), 'utf8')) as { provider: ArtProvider }).provider; } catch { /* legacy cache entry without a sidecar */ }
      return { buffer, provider };
    } catch { return undefined; }
  }

  private async writeCache(hash: string, buffer: Buffer, provider: ArtProvider): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.cachePath(hash), buffer);
    await writeFile(this.metaPath(hash), JSON.stringify({ provider }));
  }

  private hash(key: string): string { return createHash('sha256').update(key).digest('hex'); }

  /** Runs the chain for one panel. Returns undefined when every step is skipped or fails,
   * so the caller applies the existing-library fallback (provider 'library'). */
  async generate(request: ArtRequest): Promise<GeneratedArt | undefined> {
    const job = this.queue.catch(() => undefined).then(() => this.runChain(request));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async runChain(request: ArtRequest): Promise<GeneratedArt | undefined> {
    const hash = this.hash(request.cacheKey);
    const make = (buffer: Buffer, provider: ArtProvider, ms: number): GeneratedArt => ({ buffer, provider, ms, fileName: this.fileName(hash), imageUrl: `/art/generated/${this.fileName(hash)}` });
    const cached = await this.readCache(hash);
    if (cached) return make(cached.buffer, cached.provider, 0);
    const started = this.now();
    if (this.networkCallPossible()) {
      // One budget unit per panel, global across every provider and key slot, and only when
      // at least one unspent key can actually make a call (N2).
      this.spendBudget();
      const cloudflarePng = await this.runProvider('cloudflare', request.prompt, 'next provider: pollinations');
      if (cloudflarePng) { await this.writeCache(hash, cloudflarePng, 'cloudflare'); return make(cloudflarePng, 'cloudflare', this.now() - started); }
      const pollinationsPng = await this.runProvider('pollinations', request.prompt, 'next step: clip frame, then library');
      if (pollinationsPng) { await this.writeCache(hash, pollinationsPng, 'pollinations'); return make(pollinationsPng, 'pollinations', this.now() - started); }
    }
    const framed = await inkClipFrame(request.clip, { timeoutMs: this.timeoutMs, ffmpegPath: this.ffmpegPath, spawnImpl: this.spawnImpl, fetchImpl: this.fetchImpl });
    const framedPng = framed && (await this.toPng(framed.buffer));
    if (framedPng) { await this.writeCache(hash, framedPng, 'clip-frame'); return make(framedPng, 'clip-frame', this.now() - started); }
    return undefined;
  }
}

/** ART-PROMPT-1: colour words per theme, from each theme's blurb in packages/core/src/theme.ts. */
const ART_THEME_WORDS: Record<MangaThemeId, string> = {
  festival: 'Full colour comic illustration in a bright festival palette of teal, amber and coral, warm festival lights',
  sunset: 'Full colour comic illustration in a warm sunset palette of magenta, orange and gold',
  lagoon: 'Full colour comic illustration in a cool lagoon palette of cobalt, cyan and lime',
  blossom: 'Full colour comic illustration in a soft blossom palette of violet, pink and mint',
};
/** Said once, outright: the caption and dialogue are laid over the art later as real text. */
const ART_NO_TEXT = 'No text of any kind in the image: no letters, words, numbers, speech bubbles, balloons, captions, signs, banners or logos.';
const ART_LAYOUT = 'Leave clear empty space along the top of the frame for a caption added later, and keep every face clear of the top of the frame so a caption never covers a face.';
/** Scene wording that would make a model draw text or bubbles is redrawn as light and colour. */
const SCENE_REWRITES: readonly [RegExp, string][] = [
  [/\bspeech-shaped bursts\b/gi, 'bursts of colour'],
  [/\b(?:blank\s+)?(?:empty\s+)?speech\s+(?:bubbles|balloons)\b/gi, 'bursts of light'],
  [/\b(?:blank\s+)?(?:empty\s+)?speech\s+(?:bubble|balloon)\b/gi, 'burst of light'],
  [/\b(?:bubbles|balloons)\b/gi, 'bursts of light'],
  [/\b(?:bubble|balloon)\b/gi, 'burst of light'],
  [/\bneon signs\b/gi, 'neon lights'],
  [/\bsigns\b/gi, 'lights'],
  [/\bsign\b/gi, 'light'],
  [/\b(?:captions?|letters|lettering|text)\b/gi, ''],
];
/** Drops viewer names: any name passed in, @handles, and handle-shaped words (an underscore, or
 * letters and digits mixed, or a capital inside a word), so no name can be drawn or lettered. */
function withoutNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) if (name.trim()) out = out.replace(new RegExp(`@?\\b${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '');
  return out
    .replace(/@\w+/g, '')
    .replace(/\b\w*_\w*\b/g, '')
    .replace(/\b(?=\w*[A-Za-z])(?=\w*\d)\w+\b/g, '')
    .replace(/\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g, '');
}
function tidy(text: string): string {
  return text
    .replace(/\b(?:from|for|by|with|to|of)\s+(?:and|or)\s+/gi, '')
    .replace(/\s+(?:and|or)\s+(?=[,.!?]|$)/gi, '')
    .replace(/\s+(?:from|for|by|with|to|of|and|or)\s*(?=[,.!?]|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/(^|[.!?]\s+)([a-z])/g, (_match, lead: string, first: string) => lead + first.toUpperCase())
    .trim();
}

/** ART-PROMPT-1: the one art prompt for live Studio panels and imported clips, so both follow the
 * same rules: the active theme's colour words (Festival by default; legacy or unknown ids resolve
 * to Festival), no text of any kind in the art, clear space for the caption, no face under it, and
 * no viewer names. `scene` must already be a paraphrase (never raw chat); `names` are removed too. */
export function buildPanelArtPrompt(input: { scene: string; theme?: string; names?: readonly string[] }): string {
  const theme = resolveMangaTheme(input.theme);
  let scene = withoutNames(input.scene, input.names ?? []);
  for (const [pattern, replacement] of SCENE_REWRITES) scene = scene.replace(pattern, replacement);
  scene = tidy(scene);
  return `${ART_THEME_WORDS[theme]}, expressive faces, dramatic panel composition. ${scene} ${ART_LAYOUT} ${ART_NO_TEXT}`;
}

/** The live Studio panel prompt: buildPanelArtPrompt with the active theme (Festival when none is passed). */
export function buildArtPrompt(sceneDescription: string, theme?: string): string {
  return buildPanelArtPrompt({ scene: sceneDescription, theme });
}
