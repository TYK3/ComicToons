import assert from 'node:assert/strict';
import test from 'node:test';
import { sceneReadiness, COMIC_GENERATION_RULES } from '../packages/core/src/story-flow.ts';
import { MomentDetector } from '../apps/server/src/pipeline/moments.ts';
import { Studio } from '../apps/server/src/studio.ts';

test('chat reactions and clip URLs alone cannot unlock a scene reconstruction', () => {
  assert.equal(sceneReadiness({frames:0,transcriptReviewed:false,timelineReviewed:false}).ready, false);
  assert.equal(sceneReadiness({frames:6,transcriptReviewed:false,timelineReviewed:true}).ready, false);
  assert.equal(sceneReadiness({frames:4,transcriptReviewed:true,timelineReviewed:true}).ready, true);
});
test('the inspector exposes measured chat velocity, warm-up and cooldown without changing detection', () => {
  const detector = new MomentDetector({spikeWarmupSeconds:0});
  for (let i=0;i<6;i++) detector.ingest({id:`e${i}`,type:'chat',t:i,user:`viewer${i}`,text:'hello'});
  const stats = detector.diagnostics(5);
  assert.equal(stats.recent,6); assert.equal(stats.distinctUsers,6); assert.equal(stats.cooldownRemaining,30);
  assert.equal(detector.current()?.kind,'spike');
});
test('an empty inspector never claims sample content is real footage or analysed speech', () => {
  const studio = new Studio();
  try { const report=studio.storyFlow(); assert.equal(report.connected,false); assert.equal(report.moments.length,0);
    assert.equal(report.capabilities.videoAnalysis,false); assert.equal(report.capabilities.speechTranscription,false);
  } finally { studio.close(); }
});
test('production rules enforce inside-panel lettering, evidence and one collection model', () => {
  const rules=COMIC_GENERATION_RULES.join(' ');
  assert.match(rules,/INSIDE each panel/);assert.match(rules,/Never cover a face/);assert.match(rules,/4–6-panel/);
  assert.match(rules,/never to the streamer/);assert.match(rules,/not two different stories/);
});
