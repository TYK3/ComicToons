import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {ReferenceGenerator,validateConfig,type FrameInput} from '../apps/server/src/scenes/providers.ts';
import {sourcePlan} from '../apps/server/src/scenes/source-page.ts';
import {referenceDefaults} from '../apps/server/src/pipeline/credentials.ts';
test('explicit source-frame mode composes and reletters full frames without any network call',async()=>{
  const generator=new ReferenceGenerator((async()=>{throw Error('Source mode must not call a provider');}) as typeof fetch);
  const config={provider:'source' as const,model:'source-frames',key:''};validateConfig(config);await generator.check(config);
  const buffer=await readFile(new URL('../fixtures/art/generated/panel-01-stream-start.webp',import.meta.url));
  const frames:FrameInput[]=Array.from({length:4},(_,i)=>({id:`f${i}`,capturedAt:i*10000,videoTime:i*10,url:'local',sha256:`hash${i}`,buffer}));
  const chat=[{id:'chat1',text:'Go & win <kart>',user:'owner',capturedAt:10000}];
  const plan=await generator.analyse(config,frames,chat);assert.equal(plan.highlight,false);assert.deepEqual(plan.panels[0]!.chatIds,['chat1']);assert.match(plan.reason,/No AI illustration/);
  const page=await generator.draw(config,plan,frames,chat,'festival');const info=await sharp(page).metadata();assert.equal(info.width,1024);assert.ok(info.height!>800);
  const revised=await generator.draw(config,plan,frames,chat,'festival',undefined,{text:'Keep racing','attribution':'Chat chose'});assert.equal(page.equals(revised),false);
  const review=await generator.review(config,revised,plan);assert.equal(review.safe,true);assert.match(review.reason,/No AI illustration or automated visual review/);
  assert.throws(()=>sourcePlan(frames.slice(0,3),chat),/Four actual/);assert.equal(referenceDefaults({COMICTOONS_IMAGE_PROVIDER:'source'})[0]!.provider,'source');
});
