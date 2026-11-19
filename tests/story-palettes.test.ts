import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { sampleStoryIssue, panelArtUrl } from '../apps/web/src/ui/data/sampleStories.ts';
import { lookStyles } from '../packages/core/src/theme.ts';
import { comicScenes, letteringPocket } from '../apps/web/src/ui/data/lettering.ts';

for (const fixture of ['tabletop-night', 'speedrun-fail', 'irl-cooking']) {
  test(`${fixture}: manga has five complete pages and the same complete collected book`, () => {
    const issue = sampleStoryIssue(`sample-${fixture}`, 'festival');
    assert.equal(issue.storyPanels?.length, 20);
    assert.equal(issue.panels.length, 20);
    assert.deepEqual(issue.panels, issue.storyPanels);
    assert.equal(new Set(issue.storyPanels!.map(panel => panel.caption)).size, 20);
    assert.equal(new Set(issue.storyPanels!.map(panel => panel.art.atlas?.cell)).size, 20);
    assert.equal(issue.panels.at(-1)?.id, issue.storyPanels!.at(-1)?.id);
    for (const panel of issue.storyPanels!) {
      assert.ok(panel.dialogue[0]);
      assert.equal(panel.origin, 'sample');
      assert.equal(panel.art.tone, 'colour');
      assert.equal(panel.art.atlas?.columns, 4);
      assert.equal(panel.art.atlas?.rows, 5);
    }
  });
  test(`${fixture}: all four painted palettes ship locally`, () => {
    const panel = sampleStoryIssue(`sample-${fixture}`, 'festival').panels[0]!;
    const urls = ['festival', 'sunset', 'lagoon', 'blossom'].map(look => panelArtUrl(panel, look as 'festival'));
    assert.equal(new Set(urls).size, 4);
    for (const url of urls) assert.ok(existsSync(new URL(`../apps/web/public${url}`, import.meta.url)), url);
  });
}
test('artwork is displayed without gradients, colour grading or desaturation', () => {
  assert.doesNotMatch(lookStyles, /linear-gradient|grayscale|sepia|soft-light|multiply/);
  assert.match(lookStyles, /filter:none/);
});

test('legacy chat dialogue stays complete across face-safe illustrated frames', () => {
  const panel = sampleStoryIssue('sample-tabletop-night', 'festival').panels[0]!;
  const dialogue = ['he said i’m cheating because i killed him once lmao', 'Another complete quote. '.repeat(15)];
  const legacy = { ...panel, art: { width: 1280, height: 720, tone: 'colour' as const }, dialogue,
    provenance: { provider: 'library', asset: 'panel-15-sunset-goodbye.webp', style: 'pop-ink', fallback: true } };
  const pocket = letteringPocket(legacy)!;
  assert.ok(pocket);
  const scenes = comicScenes([legacy]);
  assert.ok(scenes.length > 2);
  assert.equal(scenes.flatMap(scene => scene.dialogue).join(' '), dialogue.join(' ').replace(/\s+/g, ' ').trim());
  assert.ok(scenes.every(scene => scene.dialogue.length === 1 && scene.art.bubble));
  for (const face of [{ x:31,y:16,width:14,height:24 },{ x:53,y:53,width:14,height:26 }]) {
    assert.ok(pocket.x + pocket.width <= face.x || pocket.x >= face.x + face.width || pocket.y + pocket.height <= face.y || pocket.y >= face.y + face.height);
  }
});

test('unmapped art never receives an invented face-safe bubble placement', () => {
  const panel = sampleStoryIssue('sample-tabletop-night', 'festival').panels[0]!;
  assert.equal(letteringPocket({ ...panel, art:{width:1280,height:720,tone:'colour'}, provenance:undefined }), undefined);
});
