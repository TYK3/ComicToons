import assert from 'node:assert/strict';
import test from 'node:test';
import {buildIssue,fixtures,splitStoryLine} from '../packages/core/src/index.ts';
import {Studio} from '../apps/server/src/studio.ts';
import {renderExport} from '../apps/server/src/export.ts';

test('exports describe the actual approved issue and carry local fonts and licenses',async()=>{
  const studio=new Studio();studio.state.panels=buildIssue(fixtures[0]!).panels.slice(0,3);
  const {html,shareHtml,fontLicenses}=await renderExport(studio.state);
  assert.ok(html.includes('3 APPROVED MOMENTS'));
  assert.ok(shareHtml.includes('3 APPROVED PANELS'));
  assert.ok(!shareHtml.includes('FOUR PANELS'));
  assert.ok(html.includes('data:font/woff2;base64,'));
  assert.ok(fontLicenses.includes('SIL OPEN FONT LICENSE'));
  studio.state.panels=studio.state.panels.slice(0,1);
  assert.ok((await renderExport(studio.state)).shareHtml.includes('1 APPROVED PANEL'));
});

test('standalone export escapes issue and panel text and rejects remote art URLs',async()=>{
  const studio=new Studio();studio.replay('tabletop-night');studio.moderate('approve');
  studio.state.issueTitle='</title><script>alert(1)</script>';
  studio.state.panels[0]!.caption='<img src=x onerror=alert(1)>';
  studio.state.panels[0]!.imageUrl='https://untrusted.invalid/art.png';
  const {html,shareHtml}=await renderExport(studio.state);
  for(const output of [html,shareHtml]){
    assert.ok(!output.includes('<script>'));
    assert.ok(!output.includes('<img src=x'));
    assert.ok(!output.includes('https://untrusted.invalid'));
    assert.ok(output.includes('&lt;img src=x onerror=alert(1)&gt;'));
  }
});

test('export preserves every dialogue character across integrated balloons and continuation frames', async () => {
  const studio = new Studio(); studio.replay('tabletop-night'); studio.moderate('approve');
  const lines = ['A complete dialogue line with no omissions. '.repeat(8), 'مرحبا بالأصدقاء! 🎉🧑🏽‍🚀'];
  studio.state.panels[0]!.dialogue = lines;
  const { html, shareHtml } = await renderExport(studio.state);
  for (const output of [html, shareHtml]) {
    for (const line of lines) for (const chunk of splitStoryLine(line)) assert.ok(output.includes(chunk));
    assert.ok(output.includes('data-lettering-placement="in-art"'));
    assert.ok(!output.includes('class="lettering-rail"'));
    assert.ok(!/<div class="art">(?:(?!<\/div>).)*data-lettering-kind/s.test(output));
  }
});
