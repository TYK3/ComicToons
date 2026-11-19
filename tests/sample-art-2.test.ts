import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
import { buildIssue, fixtures, getFixture, sampleStory } from '@comictoons/core';
import { illustrateIssue, LibraryProvider } from '../apps/server/src/pipeline/library.ts';
import { Studio } from '../apps/server/src/studio.ts';

// SAMPLE-ART-2: each Sample story keeps to its own art, in every style. The shared library art (one gaming streamer in a purple
// hoodie) must not appear in the tabletop, speedrun or cooking samples, in the web mock or in a Studio replay.
// The mock imports bundled art, which Node can't load, so image and CSS imports become their file URL here.
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, context, next) {'
  + ' if (/\\.css$/.test(url)) return { format: "module", source: "", shortCircuit: true };'
  + ' if (/\\.(webp|png|svg|woff2?)$/.test(url)) return { format: "module", source: "export default " + JSON.stringify(url), shortCircuit: true };'
  + ' return next(url, context); }'));
Object.assign(globalThis, { location: { hash: '#/studio', pathname: '/ui.html', search: '', origin: 'http://127.0.0.1' } });
const { MockAdapter } = await import('../apps/web/src/ui/data/mock.ts');

const SAMPLES = ['tabletop-night', 'speedrun-fail', 'irl-cooking'] as const;
const file = (url: string) => url.split('/').pop()!.split('?')[0]!;
/** The art files in a panel: its main image, its asset and every story beat. */
const artOf = (panel: { imageUrl: string; provenance?: { asset?: string }; storyBeats?: readonly { imageUrl: string }[] }) =>
  [file(panel.imageUrl), ...(panel.provenance?.asset ? [panel.provenance.asset] : []), ...(panel.storyBeats ?? []).map(beat => file(beat.imageUrl))];
function strays(id: string, panels: Parameters<typeof artOf>[0][]): string[] {
  const asset = sampleStory(id)?.asset;
  assert.ok(asset, `${id} has its own story art`);
  const own = new RegExp(`^panel-story-${asset}-\\d+\\.png$`);
  return [...new Set(panels.flatMap(artOf).filter(name => !own.test(name)))].sort();
}

test('web mock: every Sample issue and series uses only its own story art', async () => {
  const adapter = new MockAdapter({ freeze: true });
  try {
    for (const id of SAMPLES) {
      const issue = await adapter.getIssue(`sample-${id}`, 'festival');
      assert.ok(issue.panels.length > 0, `${id}: issue has panels`);
      assert.deepEqual(strays(id, issue.panels), [], `${id}: issue art is ${id}'s own`);
      const series = await adapter.getSeries(`sample-${id}`, 'festival');
      const panels = series.episodes.flatMap(episode => [episode.highlight, ...episode.panels]);
      assert.ok(panels.length > 0, `${id}: series has panels`);
      assert.deepEqual(strays(id, panels), [], `${id}: series art is ${id}'s own`);
    }
  } finally { adapter.dispose(); }
});

// Every style, Noir included, uses only the fixture's own frames (option A, SAMPLE-ART-2). As TH-ART requires, the
// label is the requested direction; the frames themselves have no Noir version.
const LABEL: Record<string, string> = { risograph: 'pop-ink', 'pop-ink': 'pop-ink', noir: 'midnight-noir', 'midnight-noir': 'midnight-noir' };
const STYLES = ['risograph', 'pop-ink', 'noir', 'midnight-noir'] as const;
const manifest: { file: string; style: string }[] = JSON.parse(readFileSync(new URL('../fixtures/art/generated/manifest.json', import.meta.url), 'utf8'));

test('library: a Sample replay in every style illustrates each panel from its own fixture only', () => {
  for (const style of STYLES) for (const id of SAMPLES) {
    const issue = illustrateIssue(buildIssue(getFixture(id), style), style, new LibraryProvider());
    assert.ok(issue.panels.length > 0 && issue.panels.every(panel => panel.provenance?.fallback === false), `${id}/${style}: every panel has library art`);
    assert.deepEqual(strays(id, issue.panels), [], `${id}/${style}: replay art is ${id}'s own`);
    assert.ok(issue.panels.every(panel => !manifest.some(entry => entry.file === panel.provenance?.asset)), `${id}/${style}: no shared library art`);
    assert.ok(issue.panels.every(panel => panel.provenance?.style === LABEL[style]), `${id}/${style}: labelled with the requested direction`);
    // A saved recap is JSON: an own-art panel must survive the round trip unchanged (no `lettering: undefined` key).
    assert.deepEqual(JSON.parse(JSON.stringify(issue.panels)), issue.panels, `${id}/${style}: replay panels survive JSON`);
  }
});

test('library: own fixture frames carry the requested direction label, in every style', () => {
  const ownArt = [{ file: 'panel-story-tabletop-0.png', altText: 'Juniper and Pixel enter the crystal vault.' }];
  for (const style of STYLES) {
    const pick = new LibraryProvider().generate({ scene: 'x', tags: [], mood: 'playful', style, used: new Set(), ownArt });
    assert.equal(pick?.asset, 'panel-story-tabletop-0.png', `${style}: own frame picked`);
    assert.equal(pick?.style, LABEL[style], `${style}: requested direction label`);
  }
});

test('Studio: replaying each Sample fixture picks only that fixture\'s art, in every style', () => {
  for (const style of ['risograph', 'noir'] as const) for (const id of SAMPLES) {
    const realNow = Date.now; let clock = 0; Date.now = () => clock;
    const studio = new Studio();
    try {
      studio.settings({ approvalMode: true });
      studio.replay(id, 60, style);
      clock += (studio.state.duration / 60) * 1000 + 1;
      studio.tick();
      const panels = [...studio.state.panels, ...studio.state.pendingPanels];
      assert.ok(panels.length > 0, `${id}/${style}: replay produced panels`);
      assert.deepEqual(strays(id, panels), [], `${id}/${style}: Studio replay art is ${id}'s own`);
    } finally { Date.now = realNow; studio.close(); }
  }
});

test('library: callers without a Sample story keep the shared library pick', () => {
  const pick = new LibraryProvider().generate({ scene: 'A clutch comeback victory.', tags: ['clutch', 'comeback'], mood: 'triumphant', style: 'risograph', used: new Set() });
  assert.equal(pick?.asset, 'panel-02-clutch-comeback.webp');
  assert.ok(fixtures.length >= SAMPLES.length);
});
