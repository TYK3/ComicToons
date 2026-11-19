import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {imageCredentials,referenceDefaults,type ImageCredential} from '../apps/server/src/pipeline/credentials.ts';
import {BasicImageGenerator,imageCredentialStatus,credentialIssue} from '../apps/server/src/pipeline/provider-smoke.ts';
import {ReferenceGenerator,type ProviderConfig,type FrameInput} from '../apps/server/src/scenes/providers.ts';
import {SceneSessions} from '../apps/server/src/scenes/sessions.ts';
import type {ScenePlan} from '@comictoons/core';

const image=()=>readFile(new URL('../fixtures/art/generated/panel-01-stream-start.webp',import.meta.url));
const keys=['fake-gemini-secret-one','fake-gemini-secret-two','fake-gemini-secret-three'];
test('three credential slots are deduplicated and status never exposes secrets or account ids',()=>{
  const env={GEMINI_API_KEY:keys[0],GEMINI_API_KEY_2:keys[1],GEMINI_API_KEY_3:keys[2],POLLINATIONS_API_KEY:'fake-pollinations-secret',POLLINATIONS_API_KEY_2:'fake-pollinations-secret',CLOUDFLARE_API_TOKEN:'fake-cloudflare-secret',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32)};
  assert.equal(imageCredentials(env).length,5);
  const status=JSON.stringify(imageCredentialStatus(env));for(const value of Object.values(env))assert.equal(status.includes(value),false);
  assert.equal(imageCredentialStatus(env).find(s=>s.provider==='pollinations'&&s.slot===2)!.status,'empty-or-duplicate');
  assert.equal(credentialIssue({provider:'pollinations',slot:1,key:'pk_publishable_is_not_secret'}),'secret-key-required');
  assert.equal(credentialIssue({provider:'cloudflare',slot:1,key:'fake-cloudflare-secret'}),'matching-account-id-required');
});
test('explicit reference provider does not silently select another configured provider',()=>{
  assert.deepEqual(referenceDefaults({COMICTOONS_IMAGE_PROVIDER:'gemini',OPENAI_API_KEY:'fake-openai-secret'}),[]);
  assert.deepEqual(referenceDefaults({COMICTOONS_IMAGE_PROVIDER:'openai',GEMINI_API_KEY:keys[0]}),[]);
  assert.deepEqual(referenceDefaults({COMICTOONS_IMAGE_PROVIDER:'pollinations',GEMINI_API_KEY:keys[0]}),[]);
  assert.deepEqual(referenceDefaults({COMICTOONS_IMAGE_PROVIDER:'unrecognised-provider',GEMINI_API_KEY:keys[0],OPENAI_API_KEY:'fake-openai-secret'}),[]);
  assert.deepEqual(referenceDefaults({COMICTOONS_IMAGE_PROVIDER:'pollinations',POLLINATIONS_API_KEY:'sk_fake-pollinations-secret'}).map(c=>({provider:c.provider,model:c.model})),[{provider:'pollinations',model:'google/gemini-3.1-flash-image'}]);
  assert.deepEqual(referenceDefaults({GEMINI_API_KEY_2:keys[1],GEMINI_API_KEY_3:keys[2]}).map(c=>c.key),keys.slice(1));
});

test('OpenAI server default honours an explicit model without changing the existing fallback model',()=>{
  const key='fake-openai-project-key';
  assert.deepEqual(referenceDefaults({COMICTOONS_IMAGE_PROVIDER:'openai',OPENAI_API_KEY:key,OPENAI_IMAGE_MODEL:'gpt-image-2'}),[{provider:'openai',model:'gpt-image-2',key}]);
  assert.equal(referenceDefaults({COMICTOONS_IMAGE_PROVIDER:'openai',OPENAI_API_KEY:key})[0]!.model,'gpt-image-1.5');
  assert.deepEqual(referenceDefaults({COMICTOONS_IMAGE_PROVIDER:'openai',OPENAI_IMAGE_MODEL:'gpt-image-2'}),[]);
});

test('Pollinations reference pipeline uses authenticated vision and repeated image uploads without fetching result URLs',async()=>{
  const bytes=await image(),key='sk_fake-reference-secret';const c:ProviderConfig={provider:'pollinations',model:'google/gemini-3.1-flash-image',key};
  const frames:FrameInput[]=Array.from({length:4},(_,i)=>({id:`frame-${i}`,capturedAt:i,videoTime:i,url:'private-source',sha256:'controlled',buffer:bytes}));
  const plan:ScenePlan={supported:true,highlight:false,title:'Observed test',reason:'Controlled evidence',panels:frames.map(f=>({frameId:f.id,description:'Observed fact',chatIds:[],narration:''}))};
  const paths:string[]=[];let visions=0;
  const generator=new ReferenceGenerator((async(url,init)=>{
    const path=new URL(String(url)).pathname;paths.push(path);assert.equal(String(url).includes(key),false);
    if(path==='/v1/models')return Response.json({data:[{id:c.model,supported_endpoints:['/v1/images/edits']}]});
    assert.equal(new Headers(init?.headers).get('Authorization'),`Bearer ${key}`);
    if(path==='/account/key')return Response.json({valid:true});
    if(path==='/v1/chat/completions'){
      const body=JSON.parse(init!.body as string);assert.equal(body.model,'openai/gpt-5.4-nano');
      const images=body.messages[1].content.filter((p:{type:string})=>p.type==='image_url');assert.equal(images.length,visions===0?4:5);assert.match(images[0].image_url.url,/^data:image\/webp;base64,/);
      return Response.json({choices:[{message:{content:JSON.stringify(visions++===0?plan:{safe:true,reason:'Controlled visual review'})}}]});
    }
    assert.equal(path,'/v1/images/edits');const form=init?.body as FormData;assert.equal(form.get('model'),c.model);assert.equal(form.get('response_format'),'b64_json');assert.equal(form.getAll('image[]').length,0);assert.equal(form.getAll('image').length,4);assert.match(String(form.get('prompt')),/EVERY face/);
    const file=form.getAll('image')[0] as File;assert.equal(file.type,'image/webp');assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
    return Response.json({data:[{b64_json:bytes.toString('base64')}]});
  }) as typeof fetch);
  await generator.check(c);const analysed=await generator.analyse(c,frames,[]);const output=await generator.draw(c,analysed,frames,[],'sunset');assert.deepEqual(output,bytes);assert.equal((await generator.review(c,output,analysed,undefined,frames)).safe,true);
  assert.deepEqual(paths,['/account/key','/v1/models','/v1/chat/completions','/v1/images/edits','/v1/chat/completions']);
});

test('reference edits reject unusable data and quota errors with no fallback request',async()=>{
  const c:ProviderConfig={provider:'pollinations',model:'google/gemini-3.1-flash-image',key:'sk_fake-reference-secret'};
  const plan:ScenePlan={supported:true,highlight:false,title:'Controlled',reason:'Test',panels:[]};
  for(const mode of ['url-only','quota']){
    let calls=0;const generator=new ReferenceGenerator((async()=>{calls++;return mode==='quota'?new Response(c.key,{status:429}):Response.json({data:[{url:'http://127.0.0.1/private'}]});}) as typeof fetch);
    await assert.rejects(generator.draw(c,plan,[],[],'festival'),error=>error instanceof Error&&!error.message.includes(c.key));assert.equal(calls,1);
  }
});

test('Klein refuses more than four reference images before any paid request',async()=>{
  let calls=0;const api=new ReferenceGenerator((async()=>{calls++;return Response.json({});}) as typeof fetch);const bytes=await image();
  const frames:FrameInput[]=Array.from({length:6},(_,i)=>({id:`f${i}`,capturedAt:i,videoTime:i,url:'controlled',sha256:'controlled',buffer:bytes}));
  const plan:ScenePlan={supported:true,highlight:false,title:'Controlled',reason:'Test',panels:[]};
  await assert.rejects(api.draw({provider:'pollinations',model:'black-forest-labs/flux.2-klein-4b',key:'sk_fake-reference-secret'},plan,frames,[],'festival'),/cannot accept/);assert.equal(calls,0);
});
for(const provider of ['gemini','pollinations','cloudflare'] as const)test(`${provider}: one authenticated fixed-endpoint image request returns real image bytes`,async()=>{
  let calls=0;const bytes=await image();const credential:ImageCredential={provider,slot:1,key:'fake-only-not-a-real-secret',accountId:'a'.repeat(32)};
  const generator=new BasicImageGenerator((async(url,init)=>{
    calls++;assert.equal(String(url).includes(credential.key),false);
    const headers=new Headers(init?.headers);assert.equal(provider==='gemini'?headers.get('x-goog-api-key'):headers.get('Authorization'),provider==='gemini'?credential.key:`Bearer ${credential.key}`);
    if(provider==='gemini'){assert.match(String(url),/^https:\/\/generativelanguage.googleapis.com\//);return Response.json({candidates:[{content:{parts:[{inlineData:{data:bytes.toString('base64')}}]}}]});}
    if(provider==='cloudflare'){assert.match(String(url),/^https:\/\/api.cloudflare.com\/client\/v4\/accounts\/a{32}\/ai\/run\//);return Response.json({result:{image:bytes.toString('base64')}});}
    assert.match(String(url),/^https:\/\/gen.pollinations.ai\/image\//);return new Response(new Uint8Array(bytes));
  }) as typeof fetch);
  assert.deepEqual((await generator.generate(credential)).image,bytes);assert.equal(calls,1);
});
test('quota, transport and non-image failures stop without retries and redact provider data',async()=>{
  const credential:ImageCredential={provider:'pollinations',slot:1,key:'fake-secret-not-in-output'};
  for(const mode of ['quota','transport','not-image']){
    let calls=0;const generator=new BasicImageGenerator((async()=>{calls++;if(mode==='transport')throw new Error(credential.key);return mode==='quota'?new Response(credential.key,{status:429}):new Response('<html>not an image</html>');}) as typeof fetch);
    await assert.rejects(generator.generate(credential),error=>error instanceof Error&&!String(error).includes(credential.key));assert.equal(calls,1);
  }
});
test('app-funded scene jobs rotate Gemini accounts once per job and share one hourly budget',async()=>{
  class ControlledGenerator extends ReferenceGenerator{
    accounts:string[]=[];active='';
    override async analyse(c:ProviderConfig,frames:FrameInput[]):Promise<ScenePlan>{this.active=c.key;this.accounts.push(c.key);return {supported:true,highlight:false,title:'Controlled scene',reason:'Test source frames',panels:frames.slice(0,4).map(f=>({frameId:f.id,description:'Observed scene',chatIds:[],narration:''}))};}
    override async draw(c:ProviderConfig){assert.equal(c.key,this.active);return image();}
    override async review(c:ProviderConfig){assert.equal(c.key,this.active);return {safe:true,reason:'Controlled review'};}
  }
  let count=0;const generator=new ControlledGenerator();
  const manager=new SceneSessions({directory:await mkdtemp(join(tmpdir(),'ct-app-keys-')),env:{GEMINI_API_KEY:keys[0],GEMINI_API_KEY_2:keys[1],GEMINI_API_KEY_3:keys[2],IMAGE_BUDGET_PER_HOUR:'3'},intervalMs:2,analysisIntervalMs:100000,generator,
    captureFactory:()=>({async open(){},async frame(){return {buffer:Buffer.concat([await image(),Buffer.from(String(++count))]),videoTime:count};},async close(){}}),adapterFactory:()=>({start(c){c.status('empty');},stop(){}})});
  const session=manager.get(manager.create('viewer').id)!;
  try{
    manager.configure(session,{useDefault:true,maxPages:5});await manager.start(session,'test_stream',60);
    const deadline=Date.now()+4000;while(!session.snapshot.pages.some(p=>p.status==='ready')){if(Date.now()>deadline)throw Error('Controlled capture timeout');await new Promise(resolve=>setTimeout(resolve,5));}
    await manager.stop(session.snapshot.id);await manager.generate(session);await manager.generate(session);
    assert.deepEqual(generator.accounts,keys);await assert.rejects(manager.generate(session),/budget/);assert.equal(session.snapshot.generator.used,3);
    const other=manager.get(manager.create('viewer').id)!;other.frames=session.frames;other.snapshot.frames=session.snapshot.frames;
    await assert.rejects(manager.generate(other),/budget/);
    manager.configure(session,{provider:'gemini',model:'gemini-3.1-flash-image',key:'fake-user-private-key',maxPages:5});await manager.generate(session);
    assert.equal(generator.accounts.at(-1),'fake-user-private-key');
    const serialized=JSON.stringify(manager.snapshot(session));for(const key of [...keys,'fake-user-private-key'])assert.equal(serialized.includes(key),false);
  }finally{await manager.close();}
});
