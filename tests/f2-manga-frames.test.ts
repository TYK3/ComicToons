import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMangaPages, mangaShotCrop, mangaStyles} from '../packages/core/src/manga.ts';
import {Studio} from '../apps/server/src/studio.ts';

const sample = () => new Studio().sampleSnapshot().pendingPanels[0]!;
const frames = (panels: ReturnType<typeof sample>[]) => buildMangaPages(panels).flatMap(page => page.panels.map(item => item.panel));

test('a story panel with no dialogue still gets a narrated frame', () => {
  const base = sample();
  const silent = {...base, id: 'silent', dialogue: [], storyCaption: base.caption,
    storyBeats: base.storyBeats!.map(beat => ({...beat, dialogue: []}))};
  const shown = frames([silent]);
  assert.equal(shown.length, silent.storyBeats.length, 'one frame per beat, none dropped');
  assert.ok(shown.every(frame => frame.sourceId === 'silent'));
  assert.deepEqual(shown[0]!.dialogue, [base.caption], 'opening beat is narrated by the caption');
  assert.ok(shown.slice(1).every(frame => frame.dialogue!.length === 0), 'later silent beats are art only');
  assert.ok(shown.every(frame => frame.imageUrl && frame.altText));
});

test('a story panel with no dialogue and no caption still gets an art-only frame', () => {
  const base = sample();
  const blank = {...base, id: 'blank', caption: '', dialogue: [], storyCaption: '', storyBeats: [{...base.storyBeats![0]!, dialogue: [], sfx: ''}]};
  const shown = frames([blank]);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0]!.dialogue, []);
});

test('split frames of one beat never repeat an identical framing', () => {
  const base = sample();
  for (const count of [3, 4, 6, 9]) {
    const lines = Array.from({length: count}, (_, index) => `CHAT: line ${index + 1}`);
    const busy = {...base, id: `busy-${count}`, dialogue: lines, storyCaption: base.caption,
      storyBeats: [{...base.storyBeats![0]!, dialogue: lines}]};
    const shown = frames([busy]);
    assert.equal(shown.length, Math.ceil(count / 2), `${count} lines -> two balloons per frame`);
    assert.deepEqual(shown.flatMap(frame => frame.dialogue), lines, 'every line kept in order');
    const framings = shown.map(frame => `${frame.imageUrl}|${frame.crop!.zoom}|${frame.crop!.x}|${frame.crop!.y}`);
    assert.equal(new Set(framings).size, shown.length, `${count} lines: distinct framing per frame`);
    assert.deepEqual(shown.map(frame => frame.crop!.shot), shown.map((_, index) => index));
    assert.deepEqual(shown[0]!.crop, {shot: 0, zoom: 1, x: 50, y: 50}, 'first frame shows the whole illustration');
  }
});

test('every continuation crop has a matching style rule shared by all renderers', () => {
  for (let shot = 1; shot <= 12; shot++) {
    const crop = mangaShotCrop(shot);
    assert.ok(crop.zoom > 1 && crop.x >= 0 && crop.x <= 100 && crop.y >= 0 && crop.y <= 100);
    assert.ok(mangaStyles.includes(`[data-panel-id$="-${shot}"] .panel-art>img{transform:scale(${crop.zoom});transform-origin:${crop.x}% ${crop.y}%}`), `rule for shot ${shot}`);
  }
  assert.ok(!mangaStyles.includes('[data-panel-id$="-0"]'), 'first frames keep the full art');
});

test('panels with one or two lines keep a single full frame', () => {
  const shown = frames([sample()]);
  assert.ok(shown.every(frame => frame.crop!.shot === 0));
});
