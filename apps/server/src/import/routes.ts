import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyPluginAsync, onRequestHookHandler } from 'fastify';
import { buildBook, buildSeries } from '../../../../packages/core/src/manga.ts';
import { readProductEnv } from '../../../../packages/core/src/env.mjs';
import { getClips } from '../ingest/clips.ts';
import { inkClipFrame, type ClipRef, type InkFrameResult } from '../pipeline/frames.ts';
import { ArtPipeline, type ArtPipelineEnv, type ArtRequest, type GeneratedArt } from '../pipeline/imagegen.ts';
import { resolveMangaTheme, type MangaTheme, type MangaThemeId } from '../../../../packages/core/src/theme.ts';
import { TwitchSignedOutError } from '../twitch-api/errors.ts';
import type { FetchLike, TwitchAuthProvider } from '../twitch-api/types.ts';
import type { Studio } from '../studio.ts';
import { validChannel } from '../ingest/irc.ts';
import { MAX_PANELS, MAX_VOD_SECONDS, SINGLE_CLIP_MAX_PANELS, vodClampNote, vodNoClipsMessage } from './caps.ts';
import { parseChatLog, type ChatLogLine } from './chatlog.ts';
import { ImportError } from './errors.ts';
import { getClipsById, getVideoById } from './helix.ts';
import { buildPanelsFromClips, selectVodClips, type ImportClip } from './panels.ts';
import type { ImportResult, ImportResults } from './results.ts';
import { parseImportInput } from './urls.ts';

const root = resolve(import.meta.dirname, '../../../..');

export interface ImportRouteOptions {
  /** `state.mangaTheme` (read only) picks the colour words for generated art; Festival when unset. */
  studio: Pick<Studio, 'useSource'> & { state?: { mangaTheme?: MangaTheme } };
  /** Helix auth (an app token) and base URL, shared by getClips() and the tiny by-id client. */
  client: { auth: TwitchAuthProvider; baseUrl?: string; fetch?: FetchLike };
  results: ImportResults;
  /** The app's directorGuard: imports and live starts are Studio writes. */
  guard: onRequestHookHandler;
  /** Reads COMICTOONS_ART_NETWORK: clip frames are only fetched and inked when it is '1'. */
  env?: Record<string, string | undefined>;
  /** Where inked frames are written; a temp directory in tests, never the repo. */
  framesDirectory?: string;
  /** Test seam for inkClipFrame (thumbnail download plus local ffmpeg). */
  inkFrame?: (clip: ClipRef) => Promise<InkFrameResult | undefined>;
  /** ART-LIVE-1 test seam for the art chain (pipeline/imagegen.ts: Cloudflare, then Pollinations, then an inked clip frame). */
  art?: { generate(request: ArtRequest): Promise<GeneratedArt | undefined> };
}

/** Which provider drew a panel and how long it took; never a key, token or account id. */
export interface ImportArt { clipId: string; provider: GeneratedArt['provider']; ms: number }
type FramedClip = ImportClip & { art?: ImportArt };

/** The art chain's key slots, from the env this route was given (the box env by default). */
function artEnv(env: Record<string, string | undefined>): ArtPipelineEnv {
  return {
    cloudflareToken: env.CLOUDFLARE_API_TOKEN, cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareToken2: env.CLOUDFLARE_API_TOKEN_2, cloudflareAccountId2: env.CLOUDFLARE_ACCOUNT_ID_2,
    cloudflareToken3: env.CLOUDFLARE_API_TOKEN_3, cloudflareAccountId3: env.CLOUDFLARE_ACCOUNT_ID_3,
    pollinationsKey: env.POLLINATIONS_API_KEY, pollinationsKey2: env.POLLINATIONS_API_KEY_2, pollinationsKey3: env.POLLINATIONS_API_KEY_3,
  };
}
/** Colour words per theme (packages/core/src/theme.ts palettes), so generated art is colourful and on-theme. */
const THEME_ART_WORDS: Record<MangaThemeId, string> = {
  festival: 'teal, amber and coral palette, warm festival lights, cream paper tones',
  sunset: 'magenta, orange and gold palette, warm sunset glow',
  lagoon: 'cobalt, cyan and lime palette, cool aqua light',
  blossom: 'violet, pink and mint palette, soft lilac light',
};
/**
 * The import route's own art prompt. It follows the same rules as the shared buildPanelArtPrompt in pipeline/imagegen.ts
 * (full colour in the active theme's palette, no text of any kind, clear space along the top so a caption never covers a
 * face, no viewer names), but works from a clip title rather than a paraphrased scene, so it has its own wording.
 * Seen live (ART-LIVE-1): the model letters quoted words into the art, garbled and with viewer handles. So:
 * - the scene uses only the plain words of the clip title; no quotes, and no word that looks like a handle (an @mention, or a word with a digit or an underscore);
 * - an explicit clause asks for no text, letters, speech bubbles or captions (the app letters over the art);
 * - clear empty space is left along the top, so lettering never has to cover a face (Young, 00:20);
 * - the active theme's colour words are used (Festival by default).
 * Plain-word names can't be told apart from other words: GAP.
 */
export function importArtPrompt(title: string, theme?: unknown): string {
  const words = title.split(/\s+/).filter(word => word && !word.startsWith('@') && !/[0-9_]/.test(word))
    .map(word => word.replace(/[^\p{L}'?!-]/gu, '')).filter(Boolean).slice(0, 16);
  // Lowercased and given as mood only: capitalised title words still came back lettered into the art (image 2).
  const scene = words.length ? `A live streamer reacting on stream (mood: ${words.join(' ').toLowerCase()}).` : 'A live streamer reacting on stream.';
  return `Full colour anime manga panel illustration, bold clean ink lines, cel shading, vivid ${THEME_ART_WORDS[resolveMangaTheme(theme)]}. ${scene} `
    + 'Dramatic composition with the subject and faces in the lower two thirds and clear empty space along the top of the frame. '
    + 'No text, letters, speech bubbles or captions anywhere in the image; no logos, signs or screens with writing; no text, logos or brand marks on headsets, clothing or screens, and screens show only abstract shapes and colour.';
}

const FRAME_FILE = /^[a-f0-9-]{36}\.png$/;

export const importRoutes: FastifyPluginAsync<ImportRouteOptions> = async (app, options) => {
  const framesDirectory = options.framesDirectory ?? resolve(root, 'artifacts/import-frames');
  const env = options.env ?? process.env;
  const artNetwork = readProductEnv('COMICTOONS_ART_NETWORK', env) === '1';
  // ART-LIVE-1: the art chain runs only with the art network on AND a provider key set; without a key the local ink below is used as before.
  const slots = artEnv(env);
  const keyed = Object.values(slots).some(Boolean);
  let chain = options.art;
  const artChain = () => (chain ??= new ArtPipeline({ env: slots, budgetPerHour: Number(env.IMAGE_BUDGET_PER_HOUR) || undefined }));
  const caps = { maxPanels: MAX_PANELS, singleClipMaxPanels: SINGLE_CLIP_MAX_PANELS };

  /**
   * With the art network on: the art chain draws the panel (Cloudflare first) when a provider key is set; otherwise, or when
   * the chain gives nothing (keys spent, budget used), the clip's thumbnail is inked locally and served from here.
   * With it off (or on any failure) the thumbnail is the frame.
   */
  const withFrame = async (clip: ImportClip): Promise<FramedClip> => {
    if (!artNetwork || !clip.thumbnailUrl) return clip;
    if (keyed) {
      const prompt = importArtPrompt(clip.title, options.studio.state?.mangaTheme);
      const drawn = await artChain().generate({ prompt, cacheKey: `import:${clip.id}:${prompt}`, clip: { url: clip.url, thumbnailUrl: clip.thumbnailUrl } }).catch(() => undefined);
      if (drawn) return { ...clip, inkedUrl: drawn.imageUrl, art: { clipId: clip.id, provider: drawn.provider, ms: drawn.ms } };
    }
    const result = await (options.inkFrame ?? inkClipFrame)({ url: clip.url, thumbnailUrl: clip.thumbnailUrl }).catch(() => undefined);
    if (!result) return clip;
    await mkdir(framesDirectory, { recursive: true });
    const file = `${randomUUID()}.png`;
    await writeFile(resolve(framesDirectory, file), result.buffer);
    return { ...clip, inkedUrl: `/api/import/frame/${file}` };
  };

  const finish = (result: ImportResult, extra: Record<string, unknown> = {}, framed: FramedClip[] = []) => {
    const importId = options.results.add(result);
    const art = framed.flatMap(clip => clip.art ? [clip.art] : []);
    return { importId, ...result, ...extra, ...(art.length ? { art } : {}), book: buildBook(result.panels, { title: result.title }), series: buildSeries(result.panels, { title: result.title }) };
  };

  app.get('/api/import/frame/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!FRAME_FILE.test(file)) return reply.code(404).send({ error: 'Frame not found.' });
    try { return reply.header('Cache-Control', 'public, max-age=86400').type('image/png').send(await readFile(resolve(framesDirectory, file))); }
    catch { return reply.code(404).send({ error: 'Frame not found.' }); }
  });

  app.post('/api/import', {
    onRequest: options.guard,
    schema: { body: { type: 'object', additionalProperties: false, required: ['input'], properties: {
      input: { type: 'string', minLength: 1, maxLength: 4000 },
      chatLog: { type: 'string', maxLength: 2_000_000 },
      chatLogFormat: { type: 'string', enum: ['txt', 'json'] },
    } } },
  }, async (req, reply) => {
    const body = req.body as { input: string; chatLog?: string; chatLogFormat?: 'txt' | 'json' };
    try {
      const parsed = parseImportInput(body.input);
      const chatLog: ChatLogLine[] = body.chatLog ? parseChatLog(body.chatLog, body.chatLogFormat ?? 'txt') : [];
      const sourceUrl = body.input.trim();

      if (parsed.kind === 'live') return { kind: 'live', channel: parsed.channel, state: options.studio.useSource('twitch', parsed.channel) };

      if (parsed.kind === 'vod') {
        const video = await getVideoById(options.client, parsed.id);
        if (!video) throw new ImportError('not-found', 'This VOD is private, deleted, or could not be found.');
        // The window is capped: a long VOD is read from its start for MAX_VOD_SECONDS, not refused.
        const usedSeconds = Math.min(video.durationSeconds, MAX_VOD_SECONDS);
        const window = { startedAt: video.createdAt, endedAt: video.createdAt + usedSeconds * 1000 };
        const { clips } = await getClips(options.client, { broadcasterId: video.userId, startedAt: window.startedAt, endedAt: window.endedAt, maxPages: 1 });
        const chosen = selectVodClips(clips, window, MAX_PANELS);
        if (chosen.length === 0) throw new ImportError('no-clips', vodNoClipsMessage(video.durationSeconds, usedSeconds));
        const framed = await Promise.all(chosen.map(withFrame));
        const panels = buildPanelsFromClips(framed, chatLog, caps, { sessionStartedAt: video.createdAt, expandSingleClip: false });
        const note = vodClampNote(video.durationSeconds, usedSeconds);
        return finish({ kind: 'vod', sourceUrl, title: video.title || `VOD ${video.id}`, ...(validChannel(video.userLogin) ? { channel: video.userLogin } : {}), panels, ...(note ? { note } : {}) },
          { window: { vodSeconds: video.durationSeconds, usedSeconds, capped: video.durationSeconds > MAX_VOD_SECONDS, ...(note ? { note } : {}) } }, framed);
      }

      const found = await getClipsById(options.client, parsed.slugs);
      const bySlug = new Map(found.map(clip => [clip.id, clip]));
      const ordered = parsed.slugs.map(slug => bySlug.get(slug)).filter((clip): clip is NonNullable<typeof clip> => !!clip);
      if (ordered.length === 0) throw new ImportError('not-found', parsed.slugs.length === 1 ? 'This clip is private, deleted, or could not be found.' : 'None of these clips could be found.');
      const missing = parsed.slugs.filter(slug => !bySlug.has(slug));
      const framed = await Promise.all(ordered.map(withFrame));
      const panels = buildPanelsFromClips(framed, chatLog, caps, { expandSingleClip: true });
      const named = ordered[0]!.broadcasterName?.toLowerCase();
      const channel = parsed.channel ?? (named && validChannel(named) ? named : undefined);
      return finish({ kind: 'clip', sourceUrl, title: ordered.length === 1 ? (ordered[0]!.title || 'Clip') : 'Imported clips', ...(channel ? { channel } : {}), panels },
        missing.length ? { missing } : {}, framed);
    } catch (error) {
      if (error instanceof ImportError) return reply.code(error.status).send({ error: error.message });
      // Never 5xx for Twitch trouble: the Studio adapter reads any 5xx as "Studio server unreachable" and hides the message.
      if (error instanceof TwitchSignedOutError) return reply.code(409).send({ error: 'Twitch app access is not set up on this machine, so VOD and clip links cannot be read.' });
      if (error instanceof Error && /exporting|valid Twitch channel/i.test(error.message)) return reply.code(409).send({ error: error.message });
      req.log.error({ err: error }, 'import failed');
      return reply.code(424).send({ error: 'Twitch could not be reached for this import. Try again shortly.' });
    }
  });
};
