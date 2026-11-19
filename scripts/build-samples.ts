/**
 * Builds the keyless, offline sample sets under apps/web/public/samples from the three
 * made-up fixtures: approved panels, the Catch-up recap, the end-of-stream comic book and
 * the manga series. It runs the real studio pipeline (replay, approve, catch-up, book,
 * series) with library art from fixtures/art and the art network off, so a rerun gives
 * byte-identical output. Usage: npm run build:samples
 */
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Studio} from '../apps/server/src/studio.ts';
import {studioCatchup} from '../apps/server/src/comics/routes.ts';
import {buildBook, buildMangaPages, buildSeries} from '../packages/core/src/manga.ts';
import {sampleStory} from '../packages/core/src/story.ts';
import type {ComicPanel, MangaTheme} from '../packages/core/src/index.ts';

const root = resolve(import.meta.dirname, '..');
export const SAMPLES_DIR = resolve(root, 'apps/web/public/samples');
/** Fixture order and the Look each set is shown in. */
export const SAMPLE_FIXTURES: readonly {id: string; theme: MangaTheme}[] = [
  {id: 'tabletop-night', theme: 'festival'},
  {id: 'speedrun-fail', theme: 'sunset'},
  {id: 'irl-cooking', theme: 'lagoon'},
];
const LIBRARY_ART = /^\/art\/generated\/(panel-[a-z0-9-]+\.(?:webp|png))$/;
const pad = (n: number) => String(n).padStart(2, '0');
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Rewrites every imageUrl to a /samples/-relative path and records the art it needs. */
function localiseArt<T>(value: T, id: string, art: Set<string>): T {
  if (Array.isArray(value)) return value.map(item => localiseArt(item, id, art)) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key !== 'imageUrl' || item === undefined) return [key, localiseArt(item, id, art)];
    const file = typeof item === 'string' ? LIBRARY_ART.exec(item)?.[1] : undefined;
    if (!file) throw new Error(`${id}: panel art must come from fixtures/art (got a non-library image)`);
    art.add(file);
    return [key, `${id}/art/${file}`];
  })) as T;
}

/**
 * MF5: the replay illustrates each panel from the shared library pool (one gaming streamer in a purple hoodie,
 * picked by style and tags only), so cooking and tabletop panels got gaming art. A sample set shows only its own
 * fixture's story frames: the panel's main art becomes its first story beat, with that beat's scene as alt text.
 * The library lettering map belonged to the swapped-out image, so it is dropped (lettering falls back to defaults).
 */
function ownStoryArt(panel: ComicPanel, id: string): ComicPanel {
  const asset = sampleStory(id)?.asset;
  const own = (url: string) => asset !== undefined && url.startsWith(`/art/generated/panel-story-${asset}-`);
  const beat = panel.storyBeats?.[0];
  if (!beat || !own(beat.imageUrl) || !panel.storyBeats!.every(b => own(b.imageUrl))) throw new Error(`${id}: ${panel.id} has no story art of its own`);
  const rest = {...panel};
  delete rest.lettering;
  return {...rest, imageUrl: beat.imageUrl, altText: beat.scene, scene: beat.scene,
    provenance: {...(panel.provenance ?? {provider: 'library', style: 'pop-ink', fallback: false}), asset: beat.imageUrl.split('/').pop()!}};
}

/** Replays one fixture to the end on a fixed clock, approves every panel and returns the studio. */
function replayToEnd(id: string, theme: MangaTheme): Studio {
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    const studio = new Studio();
    studio.settings({mangaTheme: theme, approvalMode: true});
    studio.replay(id, 60, 'risograph');
    clock += (studio.state.duration / 60) * 1000 + 1;
    studio.tick();
    studio.moderate('approve', undefined, true);
    return studio;
  } finally { Date.now = realNow; }
}

/** Every sample file, keyed by its path relative to the samples directory. */
export async function buildSampleSets(): Promise<Map<string, Buffer>> {
  process.env.COMICTOONS_ART_NETWORK = '0';
  const files = new Map<string, Buffer>();
  const manifest = {schemaVersion: 1, fixtures: [] as unknown[]};
  for (const {id, theme} of SAMPLE_FIXTURES) {
    const studio = replayToEnd(id, theme);
    try {
      const art = new Set<string>();
      const approved: ComicPanel[] = studio.state.panels.map(panel => ownStoryArt({...panel, origin: 'sample' as const}, id));
      const panels = localiseArt(approved, id, art);
      const title = studio.state.issueTitle || studio.state.streamTitle;
      const recap = studioCatchup(studio);
      const catchup = localiseArt({...recap, panels: recap.panels.map(panel => ownStoryArt(panel, id))}, id, art);
      const book = buildBook(panels, {title});
      const series = buildSeries(panels, {title});
      files.set(`${id}/panels.json`, json(panels));
      const bookPages = book.pages.map(page => {
        const path = `${id}/book/page-${pad(page.number)}.json`;
        files.set(path, json(page));
        return path;
      });
      const volumes = series.episodes.map(episode => {
        const pages = buildMangaPages(episode.panels).map(page => {
          const path = `${id}/manga/volume-${pad(episode.number)}/page-${pad(page.number)}.json`;
          files.set(path, json(page));
          return path;
        });
        return {number: episode.number, title: episode.title, chapter: episode.chapter, highlightId: episode.highlight.id, pages};
      });
      const artPaths = [...art].sort().map(file => `${id}/art/${file}`);
      for (const file of [...art].sort()) files.set(`${id}/art/${file}`, await readFile(resolve(root, 'fixtures/art/generated', file)));
      manifest.fixtures.push({id, title, theme: studio.state.mangaTheme, sample: true, panels: `${id}/panels.json`, panelCount: panels.length, art: artPaths,
        catchup, comicBook: {title: book.title, cover: bookPages[0], pages: bookPages, chapters: book.chapters}, manga: {title: series.title, volumes}});
    } finally { studio.close(); }
  }
  files.set('manifest.json', json(manifest));
  return files;
}

/** Replaces the samples directory with a fresh build. */
export async function writeSampleSets(outDir = SAMPLES_DIR): Promise<{files: number; bytes: number}> {
  const files = await buildSampleSets();
  await rm(outDir, {recursive: true, force: true});
  let bytes = 0;
  for (const path of [...files.keys()].sort()) {
    const target = join(outDir, path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, files.get(path)!);
    bytes += files.get(path)!.length;
  }
  return {files: files.size, bytes};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {files, bytes} = await writeSampleSets();
  console.log(`Wrote ${files} sample files (${(bytes / 1024 / 1024).toFixed(2)} MB) to apps/web/public/samples`);
}
