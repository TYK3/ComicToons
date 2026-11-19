import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComicToonsAdapter } from '../apps/web/src/ui/data/adapter.ts';
import { AdapterProvider } from '../apps/web/src/ui/data/store.tsx';
import type { ImportClient, ImportResponse } from '../apps/web/src/ui/screens/studio/MakeFromLink.tsx';
import { placeImportBubbles, IN_ART_SLOTS } from '../apps/web/src/ui/screens/studio/importLettering.ts';

// The card imports its own CSS (styles/import.css), which Node can't load: empty modules here (as tests/ui-live-b.test.ts).
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, context, next) {'
  + ' if (/\\.css$/.test(url)) return { format: "module", source: "", shortCircuit: true };'
  + ' if (/\\.(webp|png|svg|woff2?)$/.test(url)) return { format: "module", source: "export default " + JSON.stringify(url), shortCircuit: true };'
  + ' return next(url, context); }'));
const { ImportPreview, MakeFromLink, chatLogFormat, clampNote, importSummary } = await import('../apps/web/src/ui/screens/studio/MakeFromLink.tsx');

// IMPORT-1 UI: the "Make a comic from a link" card, rendered server-side (no browser, no network).
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stubAdapter = (extra: object = {}) => ({ kind: 'server', subscribe: () => () => undefined, getSnapshot: () => ({}), ...extra }) as unknown as ComicToonsAdapter;
const card = (adapter: ComicToonsAdapter, client?: ImportClient) =>
  renderToStaticMarkup(createElement(AdapterProvider, { adapter, children: createElement(MakeFromLink, client ? { client } : {}) }));
const client: ImportClient = { importLink: async () => ({ kind: 'live', channel: 'x' }), addSeriesChapter: async () => ({ chapter: { number: 1, title: 't' } }) };
const panel = (id: string, dialogue: string[] = []) => ({ id, caption: `Moment ${id}`, imageUrl: `http://127.0.0.1/thumb/${id}.jpg`, altText: `Moment ${id}`, dialogue });

test('the empty card asks for a link, says the caps, and offers an optional chat log', () => {
  const html = card(stubAdapter(), client);
  const shown = text(html);
  assert.ok(!shown.includes('isn’t available'), shown);
  assert.match(shown, /Make a comic from a link/);
  assert.match(shown, /A video longer than 10 min is cut to its first 10 min, and the result says so\./);
  assert.match(shown, /One clip makes 1–4 panels/);
  assert.match(html, /<input type="file" accept="\.txt,\.json/);
  assert.match(html, /<button type="submit"[^>]*disabled=""/, 'nothing to submit until a link is pasted');
});

test('without import support in the adapter the card says so and cannot submit; an adapter with it is used', () => {
  const missing = card(stubAdapter());
  assert.match(text(missing), /Making comics from links isn’t available in this Studio yet\./);
  assert.match(missing, /<button type="submit"[^>]*disabled=""/);
  assert.ok(!text(card(stubAdapter(client))).includes('isn’t available'), 'an adapter with importLink and addSeriesChapter is picked up');
});

test('clamp copy (lead ruling 22:56): a clamped VOD says in plain words that only its first 10 min were used', () => {
  const note = 'Used the first 10 min of a 47 min video.';
  const result: ImportResponse = { importId: 'a', kind: 'vod', channel: 'somechannel', panels: [panel('Vod2'), panel('Vod4')], note, window: { vodSeconds: 2820, usedSeconds: 600, capped: true, note } };
  assert.equal(clampNote(result), note);
  assert.equal(importSummary(result), '2 panels.');
  const html = renderToStaticMarkup(createElement(ImportPreview, { result }));
  assert.match(html, /<p class="ct-note" data-import-clamp=""><strong>Used the first 10 min of a 47 min video\.<\/strong><\/p>/);
  assert.match(text(html), /Moment Vod2 Moment Vod4/);
  assert.match(text(renderToStaticMarkup(createElement(ImportPreview, { result, saved: { number: 2, title: 'Long stream', note } }))), /Added as chapter 2: Long stream\. Used the first 10 min of a 47 min video\./);
  // An older server without the sentence: the card builds the same words from the window.
  assert.equal(clampNote({ kind: 'vod', window: { vodSeconds: 2820, usedSeconds: 600, capped: true } }), note);
  const whole: ImportResponse = { ...result, note: undefined, window: { vodSeconds: 300, usedSeconds: 300, capped: false } };
  assert.equal(clampNote(whole), undefined);
  assert.equal(importSummary(whole), '2 panels · from a 5 min video.');
  assert.ok(!renderToStaticMarkup(createElement(ImportPreview, { result: whole })).includes('data-import-clamp'));
});

test('IMPORT-1-WIRE: Studio shows the card, and Sample data (the mock adapter) rejects imports with plain words', async () => {
  // mock.ts and Studio import the bundled art and CSS, which Node can't load: empty modules here (as tests/ui-live-b.test.ts).
  register('data:text/javascript,' + encodeURIComponent(
    'export async function load(url, context, next) {'
    + ' if (/\\.css$/.test(url)) return { format: "module", source: "", shortCircuit: true };'
    + ' if (/\\.(webp|png|svg|woff2?)$/.test(url)) return { format: "module", source: "export default " + JSON.stringify(url), shortCircuit: true };'
    + ' return next(url, context); }'));
  Object.assign(globalThis, { location: { hash: '#/studio', pathname: '/ui.html', search: '', origin: 'http://127.0.0.1' } });
  const { MOCK_IMPORT_UNAVAILABLE, MockAdapter } = await import('../apps/web/src/ui/data/mock.ts');
  const { Studio } = await import('../apps/web/src/ui/screens/Studio.tsx');
  const sample = new MockAdapter({ freeze: true, now: Date.UTC(2026, 10, 2, 20, 0, 0), count: 3, pending: 3 });
  const mock: ComicToonsAdapter = sample;
  try {
    const studio = renderToStaticMarkup(createElement(AdapterProvider, { adapter: mock, children: createElement(Studio) }));
    // The card now lives in the Studio's Live setup (under "Create pages from a VOD or clip"), so Sample mode, which
    // cannot import, does not mount it. The card itself is rendered directly with the Sample adapter below.
    assert.equal(studio.match(/id="ct-import-title"/g)?.length ?? 0, 0, 'Sample mode does not mount the import card');
    const studioSource = (await import('node:fs')).readFileSync(new URL('../apps/web/src/ui/screens/Studio.tsx', import.meta.url), 'utf8');
    assert.equal(studioSource.match(/<MakeFromLink\/>/g)?.length, 1, 'the card is mounted once in the Studio, inside Live setup');
    assert.match(studioSource, /\{!sample&&<section className="ct-live-start ct-card"[^]*?<MakeFromLink\/>/, 'only the Live workspace mounts it');
    const { MakeFromLink } = await import('../apps/web/src/ui/screens/studio/MakeFromLink.tsx');
    const card = renderToStaticMarkup(createElement(AdapterProvider, { adapter: mock, children: createElement(MakeFromLink) }));
    assert.equal(card.match(/id="ct-import-title"/g)?.length, 1, 'the card renders once');
    assert.match(card, /<section class="ct-card ct-import-card"/);
    assert.match(text(card), /A video longer than 10 min is cut to its first 10 min, and the result says so\./);
    assert.ok(typeof mock.importLink === 'function' && typeof mock.addSeriesChapter === 'function');
    await assert.rejects(mock.importLink!({ input: 'https://clips.twitch.tv/x' }), { message: MOCK_IMPORT_UNAVAILABLE });
    await assert.rejects(mock.addSeriesChapter!('somechannel', { importId: 'x' }), { message: MOCK_IMPORT_UNAVAILABLE });
  } finally { sample.dispose(); }
});

test('clips: missing ones are named, chat lines are shown as bubbles, a saved chapter is confirmed', () => {
  const result: ImportResponse = { importId: 'b', kind: 'clip', channel: 'somechannel', panels: [panel('Clip', ['hi', 'there'])], missing: ['Gone'] };
  assert.equal(importSummary(result), '1 panel · 1 clip not found: Gone.');
  const shown = text(renderToStaticMarkup(createElement(ImportPreview, { result, saved: { number: 3, title: 'Clutch' } })));
  assert.match(shown, /Moment Clip hi there/, 'both chat lines shown, as bubbles under the art');
  assert.match(shown, /Added as chapter 3: Clutch\./);
  assert.ok(renderToStaticMarkup(createElement(ImportPreview, { result })).includes('alt="Moment Clip"'), 'the panel art is shown with its alt text');
});

test('a channel link reports the live switch; chat log format follows the file name', () => {
  assert.equal(importSummary({ kind: 'live', channel: 'somechannel' }), 'Live chat is now reading #somechannel.');
  assert.equal(chatLogFormat('chat.JSON'), 'json');
  assert.equal(chatLogFormat('chat.txt'), 'txt');
  assert.equal(chatLogFormat('chat'), 'txt');
});

// ART-LIVE-1 / IMPORT-UI-1, Young 00:20: "when generate image text box dont block the face". The existing rule is reused:
// docs/LETTERING_MAPS.md (Placement policy: lettering in an expanding rail outside the art) and tests/lettering.ts:45-58.
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const FACE = { x: 35, y: 30, width: 30, height: 40 }; // fixture face box, percent of the art (centre of the frame)

test('ART-LIVE-1: bubbles never cover a face: in the rail outside the art when the layout allows, else top-band corners clear of every face box, never the centre', () => {
  assert.deepEqual(placeImportBubbles(3, { rail: true, faces: [FACE] }), [{ zone: 'rail' }, { zone: 'rail' }, { zone: 'rail' }], 'rail first, as LETTERING_MAPS.md');
  const inArt = placeImportBubbles(2, { rail: false, faces: [FACE] });
  assert.equal(inArt.length, 2);
  for (const bubble of inArt) {
    assert.equal(bubble.zone, 'art');
    if (bubble.zone !== 'art') continue;
    assert.ok(!overlaps(bubble.box, FACE), `bubble ${JSON.stringify(bubble.box)} overlaps the face box`);
    assert.ok(!overlaps(bubble.box, { x: 40, y: 40, width: 20, height: 20 }), 'never the centre');
  }
  assert.deepEqual(inArt.map(b => b.zone === 'art' && b.box.y), [3, 3], 'top band first');
  // A face in the top-left corner pushes the first bubble to the top right.
  const topLeftFace = { x: 0, y: 0, width: 45, height: 45 };
  const first = placeImportBubbles(1, { rail: false, faces: [topLeftFace] })[0]!;
  assert.ok(first.zone === 'art' && !overlaps(first.box, topLeftFace) && first.box.x > 50, JSON.stringify(first));
  // Faces everywhere: no in-art slot is safe, so the line goes to the rail.
  assert.deepEqual(placeImportBubbles(1, { rail: false, faces: [{ x: 0, y: 0, width: 100, height: 100 }] }), [{ zone: 'rail' }]);
  for (const slot of IN_ART_SLOTS) assert.ok(!overlaps(slot, { x: 30, y: 30, width: 40, height: 40 }), 'no slot reaches the centre');
});

test('ART-LIVE-1: the import preview letters outside the art: the caption bar above it, chat bubbles in a rail below it, nothing inside the art', () => {
  const result: ImportResponse = { kind: 'clip', importId: 'i1', channel: 'somechannel', panels: [panel('Clip', ['first line', 'second line'])] };
  const html = renderToStaticMarkup(createElement(ImportPreview, { result }));
  const art = html.match(/<figure class="ct-panel ct-import-art"[^>]*>([\s\S]*?)<\/figure>/);
  assert.ok(art, 'the panel art is a figure of its own');
  assert.doesNotMatch(art![1]!, /data-lettering-kind|ct-caption|ct-bubble/, 'no caption or bubble inside the art');
  const cap = html.indexOf('data-lettering-kind="caption"'), fig = html.indexOf('<figure class="ct-panel ct-import-art"'), bubble = html.indexOf('data-lettering-kind="bubble"');
  assert.ok(cap >= 0 && cap < fig, 'caption bar above the art');
  assert.ok(bubble > fig, 'bubbles below the art');
  const frame = html.match(/<li class="ct-import-panel">([\s\S]*?)<\/li>/)?.[1] ?? '';
  assert.match(frame, /<figure[\s\S]*<\/figure><div class="ct-import-rail" role="group" aria-label="Chat">[\s\S]*first line[\s\S]*second line/, 'Young 00:33: the chat bubbles are part of the same comic panel frame, under the art');
  assert.match(text(html), /Moment Clip.*first line.*second line/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ImportPreview, { result: { ...result, panels: [panel('Quiet')] } })), /data-lettering-kind="bubble"/, 'no chat, no bubble');
});

test('IMPORT-UI-1: the result has an Open in reader action, and the reader shows the panels at reading size with every word outside the art', async () => {
  const mod = await import('../apps/web/src/ui/screens/studio/MakeFromLink.tsx') as Record<string, unknown>;
  const result: ImportResponse = { kind: 'clip', importId: 'i9', channel: 'somechannel', panels: [panel('One', ['a line']), panel('Two')] };
  const withRead = renderToStaticMarkup(createElement(ImportPreview, { result, onRead: () => undefined } as never));
  assert.match(withRead, /<button type="button" class="ct-btn ct-btn--sm ct-import-read"[^>]*>Open in reader<\/button>/);
  assert.match(withRead, /<ol class="ct-import-panels" data-count="2"/);
  assert.ok(!renderToStaticMarkup(createElement(ImportPreview, { result })).includes('Open in reader'), 'no action without a handler');
  assert.equal(typeof mod.ImportReader, 'function', 'ImportReader is exported');
  const reader = renderToStaticMarkup(createElement(mod.ImportReader as never, { result, onClose: () => undefined } as never));
  assert.match(reader, /role="dialog" aria-modal="true" aria-labelledby="ct-import-reader-title"/);
  assert.match(reader, />Close reader<\/button>/);
  assert.equal(reader.match(/<figure class="ct-panel ct-import-art"/g)?.length, 2);
  for (const fig of reader.match(/<figure[\s\S]*?<\/figure>/g) ?? []) assert.doesNotMatch(fig, /data-lettering-kind/, 'no lettering on the art');
});

test('IMPORT-UI-1: the form lines up: the link box on its own row, then the chat log picker and Make comic on one row', () => {
  const html = card(stubAdapter(), client);
  assert.match(html, /<form class="ct-import-form"/);
  assert.match(html, /<div class="ct-import-row"><label class="ct-field ct-import-chat">Chat log[\s\S]*?<\/label><button type="submit" class="ct-btn ct-import-go"/);
});
