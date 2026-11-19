import { validateLetteringMap, sampleStory } from '@comictoons/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComicIssue, ComicPanel, LetteringMap } from '@comictoons/core';

export interface LibraryEntry { lettering: LetteringMap; file: string; tags: string[]; mood: string; style: string; characters: string[]; sceneSummary: string }
/** `ownArt`, when set, limits the pick to that Sample fixture's own story frames (best first); the shared pool is never used. */
export interface ImageRequest { scene: string; tags: string[]; mood: string; style: string; used: Set<string>; ownArt?: readonly { file: string; altText: string }[] }
export interface ImageResult { lettering?: LetteringMap; imageUrl: string; provider: string; asset: string; style: string; altText: string }
export interface PanelImageProvider { readonly id: string; generate(request: ImageRequest): ImageResult | undefined }
const directory = resolve(import.meta.dirname, '../../../../fixtures/art/generated');
const canonicalStyle = (style: string) => ['noir', 'midnight-noir'].includes(style) ? 'midnight-noir' : 'pop-ink';

/** Trusted, project-owned manifest only. Raw chat never enters an image request. */
export class LibraryProvider implements PanelImageProvider {
  readonly id = 'library';
  private entries: LibraryEntry[] = [];
  private images = new Map<string, string>();
  private liveUses = new Map<string, number>();
  constructor(private dir = directory) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
      if (Array.isArray(manifest)) this.entries = manifest.filter((e): e is LibraryEntry => !!e && typeof e === 'object' &&
        typeof e.file === 'string' && /^panel-[a-z0-9-]+\.webp$/.test(e.file) && Array.isArray(e.tags) && e.tags.every((t: unknown) => typeof t === 'string') &&
        typeof e.mood === 'string' && typeof e.style === 'string' && typeof e.sceneSummary === 'string' && validateLetteringMap(e.lettering));
    } catch { /* Missing/corrupt library is an explicit procedural fallback. */ }
  }
  generate(request: ImageRequest): ImageResult | undefined {
    if (request.ownArt) return this.pickOwnArt(request, request.ownArt);
    const words = new Set([...request.tags, ...request.scene.toLowerCase().split(/[^a-z0-9-]+/)]);
    const ranked = this.entries.filter(e => e.style === canonicalStyle(request.style) && !request.used.has(e.file)).map((entry, index) => ({ entry, index,
      score: entry.tags.reduce((sum, tag) => sum + (words.has(tag) ? 10 : 0), 0) + (entry.mood === request.mood ? 3 : 0) + (entry.style === canonicalStyle(request.style) ? 4 : 0),
    })).sort((a, b) => b.score - a.score || a.index - b.index);
    for (const { entry } of ranked) {
      try {
        let imageUrl = this.images.get(entry.file);
        if (!imageUrl) {
          const bytes = readFileSync(resolve(this.dir, entry.file));
          if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') continue;
          imageUrl = `/art/generated/${entry.file}`; this.images.set(entry.file, imageUrl);
        }
        request.used.add(entry.file);
        return { imageUrl, lettering: entry.lettering, provider: this.id, asset: entry.file, style: entry.style, altText: entry.sceneSummary };
      } catch { /* Try another local asset before falling back. */ }
    }
  }
  /** SAMPLE-ART-2: a Sample replay takes its own fixture's story frame (a PNG next to the library), never the shared
   * gaming-streamer pool, in every style. The style label is the requested direction (the TH-ART contract); the frames
   * themselves have no Noir version. No lettering map: the library maps describe the shared images, not these frames. */
  private pickOwnArt(request: ImageRequest, ownArt: readonly { file: string; altText: string }[]): ImageResult | undefined {
    for (const { file, altText } of ownArt) {
      if (!/^panel-story-[a-z0-9]+-\d+\.png$/.test(file) || request.used.has(file)) continue;
      try {
        let imageUrl = this.images.get(file);
        if (!imageUrl) {
          const bytes = readFileSync(resolve(this.dir, file));
          if (bytes.toString('latin1', 1, 4) !== 'PNG') continue;
          imageUrl = `/art/generated/${file}`; this.images.set(file, imageUrl);
        }
        request.used.add(file);
        return { imageUrl, provider: this.id, asset: file, style: canonicalStyle(request.style), altText };
      } catch { /* Try the next own frame; never borrow another set's art. */ }
    }
  }
  /** Live panels cycle the whole pool of the requested style, so no asset repeats until
   * every asset has been used the same number of times. Within the least-used tier, a moment
   * kind takes matching art where it can (a raid gets the raid art, an emote burst the
   * emote-storm art, a spike the chat-flood art); plain chat takes art no kind asks for
   * first, keeping the kind-specific assets free for the moments they suit. If chat has
   * already exhausted every unreserved asset at this tier and had to borrow a kind's tagged
   * asset, that kind may still reclaim its own art one use above the least-used tier, rather
   * than losing it to whichever reserved asset the general fallback would otherwise pick. */
  pickLiveImage(request: Pick<ImageRequest, 'style'> & { kind?: string }): ImageResult | undefined {
    const eligible = this.entries.filter((entry) => entry.style === canonicalStyle(request.style));
    if (!eligible.length) return undefined;
    const uses = (entry: LibraryEntry) => this.liveUses.get(entry.file) ?? 0;
    const least = Math.min(...eligible.map(uses));
    const byIndex = eligible.map((entry, index) => ({ entry, index }));
    const fresh = byIndex.filter((item) => uses(item.entry) === least);
    const wanted = request.kind ? liveKindTags[request.kind] ?? [] : [];
    const score = (entry: LibraryEntry, tags: string[]) => tags.reduce((sum, tag, rank) => sum + (entry.tags.includes(tag) ? tags.length - rank : 0), 0);
    const reserved = (entry: LibraryEntry) => Object.values(liveKindTags).some((tags) => score(entry, tags) > 0);
    const rank = (a: { entry: LibraryEntry; index: number }, b: { entry: LibraryEntry; index: number }) => score(b.entry, wanted) - score(a.entry, wanted) || a.index - b.index;
    const matchedFresh = fresh.filter((item) => score(item.entry, wanted) > 0).sort(rank);
    const general = [...fresh].sort((a, b) => Number(reserved(a.entry)) - Number(reserved(b.entry)) || a.index - b.index);
    const matched = matchedFresh.length || !wanted.length || !reserved(general[0]!.entry) ? matchedFresh
      : byIndex.filter((item) => uses(item.entry) <= least + 1 && score(item.entry, wanted) > 0).sort(rank);
    const entry = (matched[0] ?? general[0])!.entry;
    try {
      let imageUrl = this.images.get(entry.file);
      if (!imageUrl) {
        const bytes = readFileSync(resolve(this.dir, entry.file));
        if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return undefined;
        imageUrl = `/art/generated/${entry.file}`; this.images.set(entry.file, imageUrl);
      }
      this.liveUses.set(entry.file, (this.liveUses.get(entry.file) ?? 0) + 1);
      return { imageUrl, lettering: entry.lettering, provider: this.id, asset: entry.file, style: entry.style, altText: entry.sceneSummary };
    } catch { return undefined; }
  }
}
/** Manifest tags that suit each live moment kind, best first. Plain chat has none on purpose. */
const liveKindTags: Record<string, string[]> = {
  raid: ['raid', 'arrival', 'crowd'],
  hype: ['hype train', 'speed', 'subscribers'],
  cheer: ['donation', 'sparkle', 'celebration'],
  burst: ['emotes', 'spam'],
  spike: ['chat', 'hype', 'reaction'],
  redemption: ['sparkle', 'celebration', 'victory'],
  poll: ['cliffhanger', 'tension', 'comeback'],
  clip: ['clutch', 'record', 'reaction'],
};
const captions: Record<string, string[]> = {
  'tabletop-night': ['The vault run begins. Chat settles in for the ride.', 'One close call sends the whole chat into suspense.', 'The comeback roll lands—and the studio erupts.', 'A new crew arrives just in time to celebrate.'],
  'speedrun-fail': ['The record is in sight. Every second counts.', 'One tiny mistake becomes a legendary detour.', 'The crew rallies behind one more attempt.', 'The comeback lands. Chat can finally breathe.'],
  'irl-cooking': ['The pancake experiment gets a little too ambitious.', 'A small mishap becomes chat’s favourite moment.', 'The crew turns the chaos into a celebration.', 'One last wave before the kitchen closes.'],
};
const sceneTags: Record<string, string[][]> = {
  'tabletop-night': [['start', 'chat'], ['boss', 'tension'], ['clutch', 'victory'], ['raid', 'crowd']],
  'speedrun-fail': [['speedrun', 'record'], ['fail', 'oops'], ['hype train', 'speed'], ['clutch', 'comeback']],
  'irl-cooking': [['cooking', 'flames'], ['fail', 'funny'], ['celebration', 'sparkle'], ['end', 'sunset']],
};
export function illustrateIssue(issue: ComicIssue, style: string, provider: PanelImageProvider = new LibraryProvider()): ComicIssue {
  const used = new Set<string>();
  const story = sampleStory(issue.id);
  return { ...issue, panels: issue.panels.map((panel: ComicPanel, index) => {
    // Extra establishing/action shots share their source moment's approval. They
    // never reveal a rejected or pending moment, and sample chat stays labelled.
    const frames = [[0, 1], [2], [3, 4], [5]][index] ?? [];
    // A Sample story is drawn only from its own frames (SAMPLE-ART-2); other issues keep the shared library pick.
    const ownArt = story ? frames.map(frame => ({ file: `panel-story-${story.asset}-${frame}.png`, altText: story.scenes[frame]! })) : undefined;
    const result = provider.generate({ scene: panel.scene, tags: sceneTags[issue.id]?.[index] ?? [], mood: panel.mood, style, used, ownArt });
    const storyBeats = story && result ? frames.map(frame => ({frame,
      imageUrl: `/art/generated/panel-story-${story.asset}-${frame}.png`, scene: story.scenes[frame]!,
      dialogue: [story.speech[frame]!, `CHAT: ${story.chat[frame]!}`], sfx: story.effects[frame], climax: frame === 4,
    })) : undefined;
    return result ? { ...panel, storyBeats, storyCaption: captions[issue.id]?.[index] ?? panel.caption,
      dialogue: storyBeats?.[0]?.dialogue ?? panel.dialogue, imageUrl: result.imageUrl,
      // Own story frames carry no lettering map; leave the key out so a saved (JSON) recap reads back identical.
      ...(ownArt && !result.lettering ? {} : { lettering: result.lettering }), altText: result.altText, scene: result.altText,
      caption: captions[issue.id]?.[index] ?? panel.caption, sfx: ['GO!', 'GASP!', 'POW!', 'WHOOSH!'][index % 4],
      provenance: { provider: result.provider, asset: result.asset, style: result.style, fallback: false } } : {
      ...panel, provenance: { provider: 'procedural', style, fallback: true },
    };
  }) };
}
