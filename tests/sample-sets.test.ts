import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {buildSampleSets, SAMPLE_FIXTURES} from '../scripts/build-samples.ts';
import {sampleStory} from '../packages/core/src/story.ts';

const samplesDir = resolve(import.meta.dirname, '../apps/web/public/samples');
type Json = Record<string, unknown>;
const read = (path: string): Json => JSON.parse(readFileSync(join(samplesDir, path), 'utf8')) as Json;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPath = (value: unknown, prefix: string) => typeof value === 'string' && value.startsWith(`${prefix}/`) && !value.includes('..') && !value.startsWith('/');

/** Validates one value against the manifest field list in report-sample-sets-1.md. */
function expectKeys(value: unknown, where: string, required: Record<string, (v: unknown) => boolean>, optional: Record<string, (v: unknown) => boolean> = {}) {
  assert.ok(isObject(value), `${where} is an object`);
  for (const [key, check] of Object.entries(required)) assert.ok(key in value && check(value[key]), `${where}.${key} is present and well-typed`);
  for (const key of Object.keys(value)) {
    assert.ok(key in required || key in optional, `${where}.${key} is in the field list`);
    if (key in optional) assert.ok(optional[key]!(value[key]), `${where}.${key} is well-typed`);
  }
}
const str = (v: unknown) => typeof v === 'string' && v.length > 0;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
function expectPanel(panel: unknown, where: string, id: string) {
  expectKeys(panel, where, {id: str, caption: str, dialogue: strings, scene: str, characters: strings, mood: str, altText: str,
    imageUrl: v => isPath(v, `${id}/art`), at: num, origin: v => v === 'sample'},
  {sfx: v => typeof v === 'string', composition: num, bubblePlacement: str, storyCaption: v => typeof v === 'string', storyBeats: Array.isArray,
    atlas: isObject, sourceId: str, crop: isObject, lettering: isObject, provenance: isObject});
  for (const beat of ((panel as Json).storyBeats as Json[] | undefined) ?? []) assert.ok(isPath(beat.imageUrl, `${id}/art`), `${where} beat art is a samples path`);
}
/** Every "/samples/"-relative image path inside a JSON document. */
function imagePaths(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) imagePaths(item, out);
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) {
    if (key === 'imageUrl' && typeof item === 'string') out.push(item); else imagePaths(item, out);
  }
  return out;
}
function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name)) : [relative(samplesDir, join(dir, name)).split(sep).join('/')]).sort();
}
/** Files build:samples produces: everything except the hand-made web story art in samples/stories. */
function generatedFiles(dir: string): string[] {
  return listFiles(dir).filter(path => !path.startsWith('stories/'));
}

test('sample manifest validates against the published field list', () => {
  const manifest = read('manifest.json');
  expectKeys(manifest, 'manifest', {schemaVersion: v => v === 1, fixtures: Array.isArray});
  const fixtures = manifest.fixtures as Json[];
  assert.deepEqual(fixtures.map(f => f.id), ['tabletop-night', 'speedrun-fail', 'irl-cooking']);
  for (const fixture of fixtures) {
    const id = fixture.id as string;
    expectKeys(fixture, id, {id: str, title: str, theme: str, sample: v => v === true, panels: v => v === `${id}/panels.json`, panelCount: num,
      art: v => strings(v) && (v as string[]).every(p => isPath(p, `${id}/art`)), catchup: isObject, comicBook: isObject, manga: isObject});
    expectKeys(fixture.catchup, `${id}.catchup`, {channel: str, minutes: num, panels: Array.isArray, panelCount: num, approvedCount: num, sample: v => v === true}, {raidLine: str});
    const catchup = fixture.catchup as Json;
    (catchup.panels as unknown[]).forEach((panel, i) => expectPanel(panel, `${id}.catchup.panels[${i}]`, id));
    assert.equal(catchup.panelCount, (catchup.panels as unknown[]).length);
    expectKeys(fixture.comicBook, `${id}.comicBook`, {title: str, cover: v => isPath(v, `${id}/book`), pages: v => strings(v) && (v as string[]).every(p => isPath(p, `${id}/book`)), chapters: Array.isArray});
    const book = fixture.comicBook as Json;
    assert.equal(book.cover, (book.pages as string[])[0], 'cover is the first page');
    (book.chapters as unknown[]).forEach((chapter, i) => expectKeys(chapter, `${id}.chapters[${i}]`, {title: str, start: num, end: num, panels: num, cameos: num, page: num}));
    expectKeys(fixture.manga, `${id}.manga`, {title: str, volumes: Array.isArray});
    ((fixture.manga as Json).volumes as unknown[]).forEach((volume, i) => expectKeys(volume, `${id}.volumes[${i}]`,
      {number: num, title: str, chapter: str, highlightId: str, pages: v => strings(v) && (v as string[]).every(p => isPath(p, `${id}/manga`))}));
  }
});

test('every fixture has all four parts and every referenced file exists', () => {
  const manifest = read('manifest.json');
  const referenced = new Set(['manifest.json']);
  for (const fixture of manifest.fixtures as Json[]) {
    const id = fixture.id as string;
    const panels = read(fixture.panels as string) as unknown as unknown[];
    assert.ok(Array.isArray(panels) && panels.length > 0, `${id}: approved panels`);
    assert.equal(fixture.panelCount, panels.length);
    panels.forEach((panel, i) => expectPanel(panel, `${id}.panels[${i}]`, id));
    assert.ok(((fixture.catchup as Json).panels as unknown[]).length > 0, `${id}: catch-up`);
    const book = fixture.comicBook as Json; const volumes = (fixture.manga as Json).volumes as Json[];
    assert.ok((book.pages as string[]).length > 1, `${id}: comic book cover and pages`);
    assert.equal(read(book.cover as string).kind, 'cover');
    assert.ok(volumes.length > 0 && volumes.every(v => (v.pages as string[]).length > 0), `${id}: manga volumes with pages`);
    const documents = [fixture.panels as string, ...(book.pages as string[]), ...volumes.flatMap(v => v.pages as string[])];
    const images = [...imagePaths(fixture.catchup), ...documents.flatMap(path => imagePaths(read(path)))];
    for (const path of [...documents, ...images, ...(fixture.art as string[])]) {
      assert.ok(existsSync(join(samplesDir, path)), `${path} exists`);
      referenced.add(path);
    }
    assert.deepEqual([...new Set(images)].sort(), [...(fixture.art as string[])].sort(), `${id}: art lists exactly the images used`);
  }
  // samples/stories holds the hand-made page art for the web Sample stories (not produced by build:samples); it is
  // checked for completeness below instead.
  assert.deepEqual(generatedFiles(samplesDir), [...referenced].sort(), 'no unreferenced files in samples');
  const stories = listFiles(samplesDir).filter(path => path.startsWith('stories/'));
  assert.deepEqual(stories, ['cooking', 'speedrun', 'tabletop'].flatMap(art => ['blossom', 'festival', 'lagoon', 'sunset'].map(theme => `stories/${art}-${theme}.png`)).sort(), 'every Sample story has page art in all four themes');
});

test('every panel in a set uses its own fixture art, never another stream\'s', () => {
  // MF5: the shared library art (one gaming streamer) leaked into the cooking and tabletop stories.
  const manifest = read('manifest.json');
  for (const fixture of manifest.fixtures as Json[]) {
    const id = fixture.id as string;
    const asset = sampleStory(id)?.asset;
    assert.ok(asset, `${id}: has its own story art`);
    const own = new RegExp(`^${id}/art/panel-story-${asset}-\\d+\\.png$`);
    const book = fixture.comicBook as Json; const volumes = (fixture.manga as Json).volumes as Json[];
    const documents = [fixture.panels as string, ...(book.pages as string[]), ...volumes.flatMap(v => v.pages as string[])];
    const images = [...imagePaths(fixture.catchup), ...documents.flatMap(path => imagePaths(read(path))), ...(fixture.art as string[])];
    const stray = [...new Set(images.filter(path => !own.test(path)))].sort();
    assert.deepEqual(stray, [], `${id}: every panel's art is ${id}'s own story art`);
  }
});

test('build is offline and deterministic, and the committed sets are current', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network is not allowed while building samples'); }) as typeof fetch;
  try {
    const first = await buildSampleSets(); const second = await buildSampleSets();
    assert.deepEqual([...first.keys()].sort(), [...second.keys()].sort());
    for (const [path, bytes] of first) assert.ok(bytes.equals(second.get(path)!), `${path} is byte-identical on rerun`);
    assert.deepEqual([...first.keys()].sort(), generatedFiles(samplesDir), 'committed file list matches a fresh build');
    for (const [path, bytes] of first) assert.ok(bytes.equals(readFileSync(join(samplesDir, path))), `${path} matches a fresh build (run npm run build:samples)`);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(SAMPLE_FIXTURES.map(f => f.id), ['tabletop-night', 'speedrun-fail', 'irl-cooking']);
});
