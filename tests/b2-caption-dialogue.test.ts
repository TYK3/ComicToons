import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMangaPages } from '../packages/core/src/index.ts';
import type { ComicPanel } from '../packages/core/src/index.ts';
import { Studio } from '../apps/server/src/studio.ts';

/** Every lettered line of a panel's opening beat, as the manga pages show it (balloons are
 * split into short chunks, so the lines are joined back together for comparison). */
function openingLettering(panel: ComicPanel): string {
  const frames = buildMangaPages([panel]).flatMap((page) => page.panels.map((item) => item.panel));
  return frames.filter((frame) => frame.id.startsWith(`${panel.id}-shot-0-`)).flatMap((frame) => frame.dialogue).join(' ');
}

function pendingStoryPanel() {
  const studio = new Studio();
  studio.useSource('sample');
  const panel = studio.state.pendingPanels.find((item) => item.storyBeats?.length && item.dialogue.length >= 2)!;
  assert.ok(panel, 'the sample source drafts a pending story panel with at least two dialogue lines');
  return { studio, panel };
}

test('B2-CAPTION-01: editing a caption before approval keeps every dialogue line, in the data and on the page', () => {
  const { studio, panel } = pendingStoryPanel();
  const dialogue = [...panel.dialogue];
  const before = openingLettering(panel);
  studio.caption(panel.id, 'A brand new caption from the director.');
  const edited = studio.state.pendingPanels.find((item) => item.id === panel.id)!;
  assert.equal(edited.caption, 'A brand new caption from the director.');
  assert.deepEqual(edited.dialogue, dialogue, 'the caption edit leaves the dialogue untouched');
  assert.equal(openingLettering(edited), `A brand new caption from the director. ${before}`,
    'the edited caption gets its own opening balloon and every original dialogue line is still lettered after it');
  studio.moderate('approve', panel.id);
  const approved = studio.state.panels.find((item) => item.id === panel.id)!;
  assert.equal(approved.caption, 'A brand new caption from the director.');
  assert.deepEqual(approved.dialogue, dialogue);
  assert.equal(openingLettering(approved), `A brand new caption from the director. ${before}`, 'approval keeps caption and dialogue separate');
  studio.close();
});

test('B2-CAPTION-02: editing dialogue before approval keeps the caption, and both edits can be combined', () => {
  const { studio, panel } = pendingStoryPanel();
  const caption = panel.caption;
  studio.dialogue(panel.id, ['We made it to the vault!', 'CHAT: Open it already.']);
  let edited = studio.state.pendingPanels.find((item) => item.id === panel.id)!;
  assert.equal(edited.caption, caption, 'a dialogue edit leaves the caption untouched');
  assert.deepEqual(edited.dialogue, ['We made it to the vault!', 'CHAT: Open it already.']);
  assert.match(openingLettering(edited), /We made it to the vault! CHAT: Open it already\./);
  studio.caption(panel.id, 'The crew finally reaches the vault.');
  studio.dialogue(panel.id, ['<b>Second</b> line me@example.com', '   ']);
  edited = studio.state.pendingPanels.find((item) => item.id === panel.id)!;
  assert.equal(edited.caption, 'The crew finally reaches the vault.', 'a later dialogue edit keeps the edited caption');
  assert.deepEqual(edited.dialogue, ['Second line [redacted]'], 'dialogue is sanitised like captions; blank lines are dropped');
  assert.equal(openingLettering(edited), 'The crew finally reaches the vault. Second line [redacted]', 'edited caption balloon, then the edited dialogue');
  assert.throws(() => studio.dialogue(panel.id, ['  ']), /Write at least one line/);
  studio.moderate('approve', panel.id);
  assert.throws(() => studio.dialogue(panel.id, ['Too late.']), /no longer waiting for review/);
  studio.close();
});
