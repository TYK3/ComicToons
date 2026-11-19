import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {ReferenceGenerator,ProviderError,validateConfig,referenceFrameLimit,CLOUDFLARE_VISION_MODEL,type FrameInput,type ProviderConfig} from '../apps/server/src/scenes/providers.ts';
import {referenceDefaults} from '../apps/server/src/pipeline/credentials.ts';
import type {ScenePlan} from '@comictoons/core';
import {composeCloudflarePage,panelLettering} from '../apps/server/src/scenes/cloudflare-page.ts';

const config:ProviderConfig={provider:'cloudflare',model:'@cf/black-forest-labs/flux-2-klein-9b',key:'fake-cloudflare-test-secret',accountId:'a'.repeat(32)};
async function evidence(){
  const buffer=await sharp({create:{width:1280,height:720,channels:3,background:'#4477aa'}}).jpeg().toBuffer();
  const frames:FrameInput[]=Array.from({length:4},(_,i)=>({id:`frame-${i}`,capturedAt:i*1000,videoTime:i,url:'controlled-test-source',sha256:'controlled',buffer}));
  const plan:ScenePlan={supported:true,highlight:false,title:'Controlled test',reason:'Observed evidence',panels:frames.map(f=>({frameId:f.id,description:'Observed scene',narration:'Observed fact',chatIds:[]}))};
  return {buffer,frames,plan};
}
test('Cloudflare explicitly selects one account and requires its matching id',()=>{
  const env={COMICTOONS_IMAGE_PROVIDER:'cloudflare',CLOUDFLARE_API_TOKEN:config.key,CLOUDFLARE_ACCOUNT_ID:config.accountId,CLOUDFLARE_API_TOKEN_2:'fake-second-secret',CLOUDFLARE_ACCOUNT_ID_2:'b'.repeat(32)};
  assert.equal(referenceDefaults(env).length,1);assert.deepEqual(referenceDefaults(env)[0],config);
  assert.equal(referenceDefaults({...env,CLOUDFLARE_REFERENCE_SLOT:'2'})[0]?.key,env.CLOUDFLARE_API_TOKEN_2);
  assert.deepEqual(referenceDefaults({...env,CLOUDFLARE_REFERENCE_SLOT:'3'}),[]);
  assert.throws(()=>validateConfig({...config,accountId:undefined}),/matching/);assert.equal(referenceFrameLimit(config),4);
});
test('Cloudflare analyses all source images, uploads resized references and genuinely reviews output plus sources',async()=>{
  const {buffer,frames,plan}=await evidence();let visionCalls=0,drawCalls=0;
  const generator=new ReferenceGenerator((async(url,init)=>{
    assert.equal(new Headers(init?.headers).get('Authorization'),`Bearer ${config.key}`);
    assert.equal(String(url).includes(config.key),false);
    if(String(url).includes('/models/search'))return Response.json({success:true,result:[{name:new URL(String(url)).searchParams.get('search')}]});
    if(String(url).endsWith(CLOUDFLARE_VISION_MODEL)){
      const body=JSON.parse(init?.body as string);assert.equal(body.response_format.type,'json_object');
      const images=body.messages[1].content.filter((p:{type:string})=>p.type==='image_url');assert.equal(images.length,visionCalls===0?4:5);
      if(visionCalls===0)assert.equal(images[0].image_url.url,`data:image/jpeg;base64,${buffer.toString('base64')}`);else assert.match(images[0].image_url.url,/^data:image\/png;base64,/);
      return Response.json({success:true,result:{response:visionCalls++===0?plan:JSON.stringify({safe:false,reason:'Controlled quality hold'})}});
    }
    drawCalls++;assert.equal(String(url).endsWith(config.model),true);assert.equal(new Headers(init?.headers).has('Content-Type'),false);
    const form=init?.body as FormData;assert.equal(form.get('width'),'768');assert.equal(form.get('height'),'432');assert.match(String(form.get('prompt')),/No text/);assert.match(String(form.get('prompt')),/rear view stays a rear view/);
    const file=form.get('input_image_0') as File;assert.equal(file.type,'image/jpeg');const metadata=await sharp(Buffer.from(await file.arrayBuffer())).metadata();assert.ok(metadata.width!<512&&metadata.height!<512);
    assert.equal(form.has('input_image_1'),false);return Response.json({success:true,result:{image:buffer.toString('base64')}});
  }) as typeof fetch);
  await generator.check(config);const observed=await generator.analyse(config,frames,[]);const image=await generator.draw(config,observed,frames,[],'festival');
  assert.equal((await sharp(image).metadata()).width,1024);assert.equal((await generator.review(config,image,observed,undefined,frames)).safe,false);assert.equal(visionCalls,2);assert.equal(drawCalls,4);
  const revised=await generator.draw(config,observed,frames,[],'festival',undefined,{text:'Exact author edit',attribution:'Chat chose'});
  assert.notDeepEqual(revised,image);assert.equal(drawCalls,4,'lettering revision must reuse source art');
  await generator.review(config,revised,observed,undefined,frames,{text:'Exact author edit',attribution:'Chat chose'});assert.equal(visionCalls,3,'revision still requires a fresh review');
});
test('deterministic Cloudflare lettering preserves exact attribution and rejects overflow',async()=>{
  const {buffer,plan}=await evidence();plan.panels[0]!.chatIds=['chat'];
  const chat=[{id:'chat',text:'Exact <text> & punctuation!',capturedAt:0,user:'private'}];
  assert.deepEqual(panelLettering(plan,chat,0,{text:'Author exact words',attribution:'Author'}),['Author: Author exact words','Chat: Exact <text> & punctuation!']);
  plan.panels[0]!.narration=' ';assert.deepEqual(panelLettering(plan,chat,0),['Observed scene','Chat: Exact <text> & punctuation!']);
  const output=await composeCloudflarePage([buffer,buffer,buffer,buffer],plan,chat);const meta=await sharp(output).metadata();assert.equal(meta.width,1024);assert.ok(meta.height!>=960);
  await assert.rejects(composeCloudflarePage([buffer,buffer,buffer,buffer],plan,chat,{text:'word '.repeat(200),attribution:'Author'}),/exceeds/);
});
test('Cloudflare rejects excess references, quotas, invalid JSON and unsuccessful envelopes without a fallback',async()=>{
  const {frames,plan}=await evidence();let calls=0;
  const noRequests=new ReferenceGenerator((async()=>{calls++;throw Error('must not request');}) as typeof fetch);
  await assert.rejects(noRequests.draw(config,plan,[...frames,frames[0]!],[],'festival'),/cannot accept/);assert.equal(calls,0);
  for(const response of [new Response('private provider details',{status:429}),Response.json({success:false,errors:[{message:config.key}]}),Response.json({success:true,result:{response:'not json'}})]){
    calls=0;const api=new ReferenceGenerator((async()=>{calls++;return response;}) as typeof fetch);
    await assert.rejects(api.analyse(config,frames,[]),error=>error instanceof ProviderError&&!error.message.includes(config.key));assert.equal(calls,1);
  }
});
