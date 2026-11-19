import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMangaPages, splitStoryLine, fixtures, buildIssue} from '../packages/core/src/index.ts';
import {illustrateIssue} from '../apps/server/src/pipeline/library.ts';
import {renderExport} from '../apps/server/src/export.ts';
import {Studio} from '../apps/server/src/studio.ts';

test('STORY-APPROVAL: six connected shots belong only to their four approved source moments', () => {
  for (const fixture of fixtures) {
    const issue = illustrateIssue(buildIssue(fixture), 'noir');
    const before = JSON.stringify(issue);
    const pages = buildMangaPages(issue.panels);
    const shots = pages.flatMap(page => page.panels.map(item => item.panel));
    assert.equal(shots.length, 6);
    assert.deepEqual(shots.map(panel => panel.atlas?.frame), [0,1,2,3,4,5]);
    assert.equal(new Set(shots.map(panel => panel.imageUrl)).size, 6);
    const omitted = issue.panels[2]!;
    const reduced = buildMangaPages(issue.panels.filter(panel => panel.id !== omitted.id)).flatMap(page => page.panels);
    assert.ok(reduced.every(item => item.panel.sourceId !== omitted.id));
    assert.ok(reduced.every(item => ![3,4].includes(item.panel.atlas!.frame)));
    assert.equal(JSON.stringify(issue), before);
    issue.panels[0]!.dialogue = [];
    assert.equal(buildMangaPages(issue.panels).flatMap(page => page.panels).length, 6);
  }
});

test('STORY-LENGTH: long comments add panels/pages without truncating Unicode or mutating the issue', () => {
  const issue = illustrateIssue(buildIssue(fixtures[0]!), 'noir');
  const line = 'One more try! 👩🏽‍🚀 مرحبا بالأصدقاء! '.repeat(14);
  const chunks = splitStoryLine(line);
  assert.equal(chunks.join(''), line);
  assert.ok(chunks.every(chunk => [...chunk].length <= 76));
  issue.panels[0]!.dialogue = [line];
  const pages = buildMangaPages(issue.panels);
  assert.ok(pages.length > 1);
  const continuation = pages.flatMap(page => page.panels).filter(item => item.panel.sourceId === issue.panels[0]!.id && item.panel.atlas?.frame === 0);
  assert.equal(continuation.flatMap(item => item.panel.dialogue).join(''), line);
  assert.ok(pages.every(page => page.panels.length <= 6));
});

test('STORY-ROWS: dense continuation frames fill complete rows without gaps or reordering', () => {
  for (let count = 1; count <= 18; count++) for (let mask = 0; mask < 64; mask++) {
    const frames = Array.from({length:count}, (_, index) => ({id:`frame-${index}`,at:index,caption:'Scene',
      atlas:{frame:index % 6,columns:2,rows:3},dialogue:['x'.repeat(mask & (1 << (index % 6)) ? 120 : 24)]}));
    const before = JSON.stringify(frames);
    const pages = buildMangaPages(frames);
    assert.deepEqual(pages.flatMap(page => page.panels.map(item => item.panel.id)),frames.map(frame => frame.id));
    for (const page of pages) {
      let used = 0, rows = 0;
      for (const {panel,span} of page.panels) {
        assert.ok(used + span <= 12, `Unfilled row before ${panel.id}: ${used}+${span}`);
        if (panel.dialogue[0]!.length > 100) assert.equal(span,12,'Dense balloons retain a full-width frame');
        used += span;
        if (used === 12) { used = 0; rows++; }
      }
      assert.equal(used,0,'The last row must reach the page edge');
      assert.ok(rows <= 3,'Continue onto another page instead of adding a fourth row');
    }
    assert.equal(JSON.stringify(frames),before);
  }
  const standard = illustrateIssue(buildIssue(fixtures[0]!), 'noir');
  assert.deepEqual(buildMangaPages(standard.panels)[0]!.panels.map(item => item.span),[7,5,6,6,8,4]);
});

test('STORY-EDIT-EXPORT: caption edits appear in the art; exports embed local story art and escape chat', async () => {
  const studio = new Studio(); studio.replay('tabletop-night');
  studio.caption(studio.state.pendingPanels[0]!.id, 'This roll is for the whole crew.');
  studio.moderate('approve');
  assert.equal(buildMangaPages(studio.state.panels)[0]!.panels[0]!.panel.dialogue[0], 'This roll is for the whole crew.');
  studio.state.panels[0]!.dialogue = ['<script>NOT CODE</script>', 'CHAT: <img src=x onerror=alert(1)>'];
  // Use matching first line so this case isolates dialogue escaping from caption override.
  studio.state.panels[0]!.storyCaption = studio.state.panels[0]!.caption;
  const {html, shareHtml} = await renderExport(studio.state);
  for (const document of [html, shareHtml]) {
    assert.ok(document.includes('data:image/png;base64,'));
    assert.ok(document.includes('data-lettering-placement="in-art"'));
    assert.ok(!document.includes('class="lettering-rail"'));
    assert.ok(!document.includes('src="/art/'));
    assert.ok(!document.includes('<script>NOT CODE</script>'));
    assert.ok(document.includes('&lt;script&gt;NOT CODE&lt;/script&gt;'));
    assert.ok(document.includes('&lt;img src=x onerror=alert(1)&gt;'));
  }
  studio.close();
});
