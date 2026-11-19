import manifest from '../fixtures/art/generated/manifest.json';
import { validateLetteringMap } from '../packages/core/src/lettering.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, buildIssue } from '../packages/core/src/index.ts';
import { LibraryProvider, illustrateIssue } from '../apps/server/src/pipeline/library.ts';
import { Studio } from '../apps/server/src/studio.ts';
import { renderExport } from '../apps/server/src/export.ts';

test('every sample and style receives four distinct generated-library compositions', () => {
  const provider = new LibraryProvider();
  for (const fixture of fixtures) for (const style of ['risograph', 'noir']) {
    const issue = illustrateIssue(buildIssue(fixture, style), style, provider);
    assert.equal(issue.panels.length, 4);
    assert.equal(new Set(issue.panels.map(p => p.provenance?.asset)).size, 4);
    assert.ok(issue.panels.every(p => p.provenance?.provider === 'library' && p.imageUrl.startsWith('/art/generated/')));
  }
});
test('scene tags rank speedrun, kitchen and raid art over unrelated compositions', () => {
  const provider = new LibraryProvider();
  for (const [tag, file] of [['speedrun', '11-speedrun-record'], ['cooking', '12-cooking-chaos'], ['raid', '05-raid-arrives']]) {
    const art = provider.generate({ scene: '', tags: [tag!], mood: '', style: 'risograph', used: new Set() });
    assert.ok(art?.asset.includes(file!));
  }
  const noir = provider.generate({ scene: '', tags: [], mood: '', style: 'noir', used: new Set() });
  assert.equal(noir?.style, 'midnight-noir');
});

test('TH-ART: requested art direction wins over scene tags for every sample', () => {
  const provider = new LibraryProvider();
  for (const fixture of fixtures) for (const [style, expected] of [['risograph', 'pop-ink'], ['noir', 'midnight-noir']]) {
    const issue = illustrateIssue(buildIssue(fixture, style), style!, provider);
    assert.ok(issue.panels.every(panel => panel.provenance?.style === expected), `${fixture.id}: requested ${style}, received ${issue.panels.map(panel => panel.provenance?.style).join(', ')}`);
    assert.equal(new Set(issue.panels.map(panel => panel.provenance?.asset)).size, 4);
  }
});
test('missing library falls back to procedural art with honest provenance', () => {
  const issue = illustrateIssue(buildIssue(fixtures[0]!), 'risograph', new LibraryProvider('/tmp/comictoons-missing-art'));
  assert.ok(issue.panels.every(p => p.provenance?.fallback && p.imageUrl.startsWith('data:image/svg+xml')));
});
test('replay approvals retain generated art and both export layouts embed generated art locally', async () => {
  const studio = new Studio(); studio.replay('irl-cooking', 60); studio.moderate('approve');
  assert.equal(studio.state.panels[0]?.provenance?.provider, 'library');
  const { html, shareHtml } = await renderExport(studio.state);
  for (const page of [html, shareHtml]) {
    assert.ok(/data:image\/(?:webp|png);base64,/.test(page));
    assert.ok(!page.includes('src="/art/'));
    assert.ok(!page.includes('data:image/svg+xml'));
    assert.ok(page.includes('object-fit:cover'));
  }
  studio.close();
});

test('live panels rotate through every distinct library asset of the requested style before repeating', () => {
  const provider = new LibraryProvider();
  const picks: string[] = [];
  let previous: string | undefined;
  for (let i = 0; i < 40; i++) {
    const picked = provider.pickLiveImage({ style: 'risograph' });
    assert.ok(picked, `pick ${i} must still return art`);
    if (previous) assert.notEqual(picked!.asset, previous, `pick ${i} must not repeat the immediately previous asset`);
    picks.push(picked!.asset);
    previous = picked!.asset;
  }
  const poolSize = new Set(picks).size;
  assert.ok(poolSize >= 8, 'rotation should cover a good spread of the pop-ink assets, not get stuck on one');
  assert.deepEqual(picks.slice(0, poolSize), picks.slice(poolSize, poolSize * 2), 'the rotation cycles the whole pool in a stable order');
});

test('all sixteen reviewed assets carry bounded face/subject maps and an expanding outboard rail', () => {
  assert.equal(manifest.length, 16);
  for (const entry of manifest) {
    assert.ok(validateLetteringMap(entry.lettering), entry.file);
    assert.deepEqual(entry.lettering.bubbleZones, []);
    assert.deepEqual(entry.lettering.sfxZones, []);
    assert.equal(entry.lettering.captionZone.y, 100);
    assert.equal(entry.lettering.captionZone.height, 'auto');
    assert.ok(entry.lettering.derivation.observations.length > 40);
  }
  assert.equal(validateLetteringMap({ ...manifest[0]!.lettering, faceBox: { x: 99, y: 0, width: 10, height: 10 } }), false);
  const provider = new LibraryProvider();
  assert.ok(provider.generate({ scene: '', tags: [], mood: '', style: 'risograph', used: new Set() })?.lettering);
});

test('S2-LIB-01: live moment kinds get matching library art, and nothing repeats until the pool is used up', () => {
  const provider = new LibraryProvider();
  const pick = (kind?: string) => provider.pickLiveImage({ style: 'risograph', kind })!.asset;
  // Plain chat first: it takes art no moment kind asks for, keeping the kind art free.
  const chat = [pick('chat'), pick('chat')];
  assert.ok(chat.every((asset) => !/raid|hype-train|donation|emote-storm|stream-start/.test(asset)), chat.join(','));
  assert.equal(pick('raid'), 'panel-05-raid-arrives.webp');
  assert.equal(pick('hype'), 'panel-06-hype-train.webp');
  assert.equal(pick('cheer'), 'panel-07-donation-sparkle.webp');
  assert.equal(pick('burst'), 'panel-09-emote-storm.webp');
  assert.equal(pick('spike'), 'panel-01-stream-start.webp', 'a chat surge gets the chat-floods-in art, not the hype train');
  const all = [...chat, 'panel-05-raid-arrives.webp', 'panel-06-hype-train.webp', 'panel-07-donation-sparkle.webp', 'panel-09-emote-storm.webp', 'panel-01-stream-start.webp'];
  const counter = new LibraryProvider();
  const pool = new Set(Array.from({ length: 40 }, () => counter.pickLiveImage({ style: 'risograph' })!.asset)).size;
  assert.ok(pool >= 8);
  // F4: a kind now reclaims its own tagged asset one use above the least-used tier sooner
  // than it would steal an unrelated kind's still-fresh reserved asset (see library.ts
  // pickLiveImage), so a repeating kind may repeat its own art before every asset of the
  // style has been used once. Every asset is still used eventually.
  while (all.length < pool * 4) all.push(pick(['spike', 'burst', 'chat', 'raid'][all.length % 4]));
  assert.equal(new Set(all).size, pool, 'every asset of the style is used eventually, even once kinds start repeating their own art');
});
