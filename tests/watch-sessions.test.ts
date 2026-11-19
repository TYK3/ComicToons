import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';
import {ReferenceGenerator,ProviderError,validatePlan} from '../apps/server/src/scenes/providers.ts';
import {SceneSessions} from '../apps/server/src/scenes/sessions.ts';
import type {StreamEvent} from '@comictoons/core';
import {liveAppFixture} from './twitch-live-app-fixture.ts';
import {buildBook,buildMangaPages} from '../packages/core/src/manga.ts';
import {comicPageGroups} from '../apps/web/src/ui/data/pagination.ts';
import {renderExport} from '../apps/server/src/export.ts';
import {Studio} from '../apps/server/src/studio.ts';

const image=()=>readFile(new URL('../fixtures/art/generated/panel-01-stream-start.webp',import.meta.url));
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){const deadline=Date.now()+4000;while(!check()){if(Date.now()>deadline)throw Error('Timed out waiting for scene result');await sleep(10);}}
function generator(options:{safe?:boolean;quota?:boolean}={}){
  const requests:{url:string;init:RequestInit}[]=[];
  return {requests,api:new ReferenceGenerator((async(url,init)=>{
    requests.push({url:String(url),init:init??{}});
    if(options.quota)return Response.json({error:'ignored provider body'},{status:429});
    if(String(url).includes('/models/'))return Response.json({id:'model'});
    if(String(url).includes('/images/edits'))return Response.json({data:[{b64_json:(await image()).toString('base64')}]});
    const body=JSON.parse(String(init?.body));const prompt=body.messages[1].content[0].text as string;
    if(prompt.startsWith('Review this generated comic.'))return Response.json({choices:[{message:{content:JSON.stringify({safe:options.safe!==false,reason:'Faces clear; test review.'})}}]});
    const data=JSON.parse(prompt.slice(prompt.indexOf('{"frames"'))) as {frames:{id:string}[];chat:{id:string}[]};
    return Response.json({choices:[{message:{content:JSON.stringify({supported:true,highlight:false,title:'Observed scene',reason:'Four observed frames, ordinary recap.',panels:data.frames.slice(0,4).map(f=>({frameId:f.id,description:'Observed action',narration:'On the screen.',chatIds:data.chat.slice(0,1).map(q=>q.id)}))})}}]});
  }) as typeof fetch)};
}
async function fixture(safe=true){
  let receive:((event:StreamEvent)=>void)|undefined,counter=0;const generated=generator({safe});
  const manager=new SceneSessions({env:{},directory:await mkdtemp(join(tmpdir(),'ct-scenes-')),intervalMs:5,analysisIntervalMs:100000,generator:generated.api,
    captureFactory:()=>({async open(){},async frame(){counter++;return {buffer:Buffer.concat([await image(),Buffer.from(String(counter))]),videoTime:counter};},async close(){}}),
    adapterFactory:()=>({start(callbacks){receive=callbacks.event;callbacks.status('empty');},stop(){}})});
  const snapshot=manager.create('viewer'),session=manager.get(snapshot.id)!;
  manager.configure(session,{provider:'openai',model:'gpt-image-1.5',key:'test-secret-never-return-this',maxPages:1});
  return {manager,session,generated,receive:(event:StreamEvent)=>receive?.(event)};
}

test('viewer APIs deny broadcaster controls and keep provider keys out of responses',async()=>{
  const app=createApp({logger:false,env:{}});await app.ready();
  try{
    const opened=await app.inject({method:'POST',url:'/api/watch/session',payload:{role:'viewer'}});assert.equal(opened.statusCode,200);
    const cookie=String(opened.headers['set-cookie']).split(';')[0]!;
    const privateId=cookie.split('=')[1]!;assert.equal(opened.body.includes(privateId),false);
    for(const url of ['/api/approve','/api/hide','/api/ingest','/api/participation/polls','/api/end'])assert.equal((await app.inject({method:'POST',url,headers:{cookie},payload:{}})).statusCode,403,url);
    assert.equal((await app.inject({url:'/api/state',headers:{cookie}})).statusCode,403);
    const saved=await app.inject({method:'POST',url:'/api/watch/generator',headers:{cookie},payload:{provider:'openai',model:'gpt-image-1.5',key:'test-secret-never-return-this'}});
    assert.equal(saved.statusCode,200);assert.equal(saved.body.includes('test-secret'),false);assert.equal(saved.json().generator.ownKey,true);
    assert.equal((await app.inject({url:'/api/watch/report',headers:{cookie}})).body.includes(privateId),false);
    assert.equal((await app.inject({method:'POST',url:'/api/watch/start',headers:{cookie},payload:{channel:'https://evil.test'}})).statusCode,400);
    const other=await app.inject({method:'POST',url:'/api/watch/session',payload:{role:'viewer'}});
    const cookie2=String(other.headers['set-cookie']).split(';')[0]!;
    assert.equal((await app.inject({url:'/api/watch',headers:{cookie:cookie2}})).json().generator.configured,false);
  }finally{await app.close();}
});

test('real-reference path requires four frames, includes matching chat, reviews art and obeys page budget',async()=>{
  const f=await fixture();try{
    await assert.rejects(()=>f.manager.generate(f.session),/four actual/);
    await f.manager.start(f.session,'test_stream',60);f.receive({id:'quote-1',user:'person',t:1,type:'chat',text:'That was close!'});
    await until(()=>f.session.snapshot.pages.some(p=>p.status==='ready'));
    const p=f.session.snapshot.pages[0]!;assert.equal(p.sourceFrameIds.length,4);assert.deepEqual(p.sourceChatIds,['quote-1']);assert.equal(p.plan?.highlight,false);
    const draw=f.generated.requests.find(r=>r.url.endsWith('/images/edits'))!;assert.ok(draw.init.body instanceof FormData);assert.equal(draw.init.body.getAll('image[]').length,4);
    assert.match(String(draw.init.body.get('prompt')),/That was close/);assert.match(String(draw.init.body.get('prompt')),/EVERY face/);
    await assert.rejects(()=>f.manager.generate(f.session),/page limit/);
    f.receive({type:'chat',t:2,withdraw:'message',targetId:'quote-1',text:''});assert.equal(p.status,'withdrawn');assert.equal(p.imageUrl,undefined);
    await assert.rejects(()=>f.manager.file(f.session,`${p.id}.image`),/not found/);
  }finally{await f.manager.close();}
});

test('failed face review holds the page and never exposes its image',async()=>{
  const f=await fixture(false);try{await f.manager.start(f.session,'test_stream',60);await until(()=>f.session.snapshot.pages.some(p=>p.status==='held'));assert.equal(f.session.snapshot.pages[0]!.imageUrl,undefined);}finally{await f.manager.close();}
});

test('moderator Ink Me rejection preserves scene quotes; actual opt-out still withdraws them',async()=>{
  const f=await fixture();try{
    await f.manager.start(f.session,'test_stream',60);
    f.receive({id:'scene-quote',type:'chat',t:1,user:'owner',text:'Around the lighthouse!'});
    await until(()=>f.session.snapshot.pages.some(p=>p.status==='ready'));
    const page=f.session.snapshot.pages[0]!;
    f.receive({id:'reject-command',type:'chat',t:2,user:'owner',moderator:true,text:'!ink no'});
    assert.equal(page.status,'ready');assert.equal(f.session.snapshot.chat.length,1);
    f.receive({id:'later-quote',type:'chat',t:3,user:'owner',text:'Still racing!'});
    assert.equal(f.session.snapshot.chat.length,2,'rejection must not silently deny later chat');
    f.receive({id:'optout-command',type:'chat',t:4,user:'owner',moderator:true,text:'!noink'});
    assert.equal(page.status,'withdrawn');assert.equal(f.session.snapshot.chat.length,0);
  }finally{await f.manager.close();}
});

test('quota errors do not silently choose another provider',async()=>{
  const f=generator({quota:true});await assert.rejects(()=>f.api.check({provider:'openai',model:'gpt-image-1.5',key:'test-secret-never-return-this'}),/quota/);assert.equal(f.requests.length,1);
});

test('Gemini evidence analysis uses the working Flash Lite model without exposing its key',async()=>{
  const urls:string[]=[];
  const api=new ReferenceGenerator((async(url)=>{
    urls.push(String(url));
    return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({supported:false,highlight:false,title:'Quiet scene',reason:'No distinct event',panels:[]})}]}}]});
  }) as typeof fetch);
  const bytes=await image();
  const frames=[0,1,2,3].map(n=>({id:`frame-${n}`,capturedAt:n,videoTime:n,url:'/source.jpg',sha256:'hash',buffer:bytes}));
  const plan=await api.analyse({provider:'gemini',model:'gemini-2.5-flash-image',key:'private-test-key'},frames,[]);
  assert.equal(plan.supported,false);
  assert.deepEqual(urls,['https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent']);
  assert.equal(urls[0]!.includes('private-test-key'),false);
});

test('storyboard refuses invented frame and chat references',()=>{
  assert.throws(()=>validatePlan({supported:true,highlight:true,title:'fake',reason:'fake',panels:Array(4).fill({frameId:'not-captured',description:'fake',narration:'fake',chatIds:[]})},[],[]),/missing evidence/);
});

test('Streamer capture is owner-only and completed scene pages wait for release without library drafts',async()=>{
  const generated=generator();let count=0;
  const f=await liveAppFixture({scene:{directory:await mkdtemp(join(tmpdir(),'ct-owner-')),intervalMs:5,analysisIntervalMs:100000,generator:generated.api,captureFactory:()=>({async open(){},async frame(){return {buffer:Buffer.concat([await image(),Buffer.from(String(++count))]),videoTime:count};},async close(){}}),adapterFactory:()=>({start(){},stop(){}})}});
  try{
    const opened=await f.app.inject({method:'POST',url:'/api/watch/session',payload:{role:'streamer'}});const cookie=String(opened.headers['set-cookie']).split(';')[0]!;
    assert.equal((await f.app.inject({method:'POST',url:'/api/watch/start',headers:{cookie},payload:{channel:'streamer'}})).statusCode,403,'signed-out capture refused');
    await f.startIRC();await f.signIn();await f.welcome();f.chat('before-scene');
    assert.equal((await f.app.inject({method:'POST',url:'/api/watch/start',headers:{cookie},payload:{channel:'other_streamer'}})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:'/api/ingest',headers:{cookie},payload:{mode:'twitch',channel:'other_streamer'}})).statusCode,403);
    await f.app.inject({method:'POST',url:'/api/watch/generator',headers:{cookie},payload:{provider:'openai',model:'gpt-image-1.5',key:'test-secret-never-return-this',maxPages:1}});
    const started=await f.app.inject({method:'POST',url:'/api/watch/start',headers:{cookie},payload:{channel:'streamer',duration:60}});assert.equal(started.statusCode,200);
    f.chat('after-scene');
    let state=await f.state();const end=Date.now()+4000;
    while(!state.pendingPanels.some((p:{provenance?:{provider:string}})=>p.provenance?.provider==='scene-openai')){if(Date.now()>end)throw Error('Scene not queued');await sleep(15);state=await f.state();}
    assert.equal(state.pendingPanels.length,1,'only the source-grounded page reaches review');assert.equal(state.panels.length,0);
    const released=await f.app.inject({method:'POST',url:'/api/approve',headers:{cookie},payload:{panelId:state.pendingPanels[0].id}});assert.equal(released.statusCode,200);assert.equal(released.json().panels.length,1);
  }finally{await f.close();}
});

test('expired keys never fall back to a configured app key',async()=>{
  let now=1000;const manager=new SceneSessions({directory:await mkdtemp(join(tmpdir(),'ct-expiry-')),env:{OPENAI_API_KEY:'default-secret-present'},now:()=>now});
  const state=manager.create('viewer'),session=manager.get(state.id)!;
  manager.configure(session,{provider:'openai',model:'gpt-image-1.5',key:'own-secret-expiring'});now+=3600001;
  assert.equal(manager.config(session),undefined);assert.equal(manager.snapshot(session).generator.configured,false);await manager.close();
});

test('captured evidence survives restart, keys do not, and a stopped session can generate a preview',async()=>{
  const f=await fixture();let manager2:SceneSessions|undefined;
  try{
    await f.manager.start(f.session,'test_stream',60);await until(()=>f.session.snapshot.pages.some(p=>p.status==='ready'));await f.manager.stop(f.session.snapshot.id);
    const directory=f.manager.directory,id=f.session.snapshot.id;await f.manager.close();
    assert.equal((await readFile(join(directory,id,'session.json'),'utf8')).includes('test-secret-never-return-this'),false);
    manager2=new SceneSessions({env:{},directory,generator:f.generated.api});const restored=manager2.get(id)!;
    assert.ok(restored.snapshot.frames.length>=4);assert.equal(restored.snapshot.state,'stopped');assert.equal(manager2.config(restored),undefined);
    manager2.configure(restored,{provider:'openai',model:'gpt-image-1.5',key:'new-secret-after-restart',maxPages:2});await manager2.generate(restored);
    assert.equal(restored.snapshot.pages.filter(p=>p.status==='ready').length,2);
  }finally{await manager2?.close();await f.manager.close();}
});

test('whole generated comic pages retain one page per leaf in reader, book and manga layouts',()=>{
  const pages=[1,2,3].map(n=>({id:`page-${n}`,caption:'Source-grounded page',at:n,provenance:{provider:'scene-gemini'}}));
  assert.deepEqual(comicPageGroups(pages).map(p=>p.length),[1,1,1]);assert.deepEqual(buildMangaPages(pages).map(p=>p.panels.length),[1,1,1]);
  assert.deepEqual(buildBook(pages).pages.filter(p=>p.kind==='story').map(p=>p.panels.length),[1,1,1]);
});

test('image lettering revisions keep original evidence, count attempts and replace artwork only after review',async()=>{
  const f=await fixture();const studio=new Studio();
  try{
    f.session.snapshot.role='streamer';await f.manager.start(f.session,'test_stream',60);await until(()=>f.session.snapshot.pages.some(p=>p.status==='ready'));await f.manager.stop(f.session.snapshot.id);
    const page=f.session.snapshot.pages[0]!,originalUrl=page.imageUrl,source=JSON.stringify(page.plan);
    studio.queueScenePage(page,'test_stream','/art/scenes/original');
    studio.setSceneEditor(async(id,lettering)=>{await f.manager.revisePage(id,lettering);studio.queueScenePage(page,'test_stream',`/art/scenes/${id}?v=${page.imageFile}`);});
    f.manager.configure(f.session,{provider:'openai',model:'gpt-image-1.5',key:'test-secret-never-return-this',maxPages:3});
    const work=studio.caption(page.id,'What a finish!','Chat chose');assert.ok(work instanceof Promise);
    assert.equal(studio.state.pendingPanels[0]!.caption,page.title);assert.equal(studio.state.pendingPanels[0]!.imageRevision?.status,'rendering');
    assert.throws(()=>studio.moderate('approve',page.id),/revision/);await work;
    assert.equal(studio.state.pendingPanels[0]!.caption,'What a finish!');assert.match(studio.state.pendingPanels[0]!.imageUrl,/\?v=/);assert.notEqual(page.imageUrl,originalUrl);assert.equal(JSON.stringify(page.plan),source);assert.equal(f.session.snapshot.generator.used,2);
    const draw=f.generated.requests.filter(r=>r.url.endsWith('/images/edits')).at(-1)!;assert.match(String((draw.init.body as FormData).get('prompt')),/Chat chose/);assert.match(String((draw.init.body as FormData).get('prompt')),/What a finish!/);
    const previous=page.imageUrl;f.generated.api.review=async()=>({safe:false,reason:'Balloon covers a face'});
    await assert.rejects(studio.caption(page.id,'Try another line') as Promise<unknown>,/quality/);assert.equal(page.imageUrl,previous);assert.equal(studio.state.pendingPanels[0]!.caption,'What a finish!');assert.equal(studio.state.pendingPanels[0]!.imageRevision?.status,'failed');assert.throws(()=>studio.moderate('approve',page.id),/revision/);
    assert.equal(f.session.snapshot.generator.used,3);studio.discardImageRevision(page.id);studio.moderate('approve',page.id);assert.equal(studio.state.panels[0]!.caption,'What a finish!');
  }finally{studio.close();await f.manager.close();}
});

test('withdrawal during image revision cannot republish the page',async()=>{
  const f=await fixture();try{
    f.session.snapshot.role='streamer';await f.manager.start(f.session,'test_stream',60);f.receive({id:'withdraw-during-revision',user:'person',t:1,type:'chat',text:'What a scene!'});await until(()=>f.session.snapshot.pages.some(p=>p.status==='ready'));
    const page=f.session.snapshot.pages[0]!;f.manager.configure(f.session,{provider:'openai',model:'gpt-image-1.5',key:'test-secret-never-return-this',maxPages:2});
    let release!:(v:{safe:boolean;reason:string})=>void;f.generated.api.review=async()=>new Promise(resolve=>{release=resolve;});
    const revision=f.manager.revisePage(page.id,{text:'Author note',attribution:'Author'});const rejected=assert.rejects(revision,/withdrawn/);await until(()=>!!release);
    f.receive({type:'chat',t:2,withdraw:'message',targetId:'withdraw-during-revision',text:''});release({safe:true,reason:'Controlled completion'});await rejected;
    assert.equal(page.status,'withdrawn');assert.equal(page.imageUrl,undefined);assert.equal(page.authoredLettering,undefined);
  }finally{await f.manager.close();}
});

test('drawing quota failure pauses automatic jobs while capture continues, until explicit reconfiguration',async()=>{
  const f=await fixture();try{
    f.manager.configure(f.session,{provider:'openai',model:'gpt-image-1.5',key:'test-secret-never-return-this',maxPages:3});
    f.generated.api.draw=async()=>{throw new ProviderError('402','Provider quota, credits or rate limit prevented generation.');};
    await f.manager.start(f.session,'test_stream',60);await until(()=>!!f.session.snapshot.generator.blocked);await until(()=>f.session.snapshot.frames.length>=9);
    assert.equal(f.session.snapshot.state,'running');assert.equal(f.session.snapshot.pages.length,1);assert.equal(f.session.snapshot.pages[0]!.failureStage,'drawing');assert.equal(f.session.snapshot.pages[0]!.failureCode,'402');
    await assert.rejects(f.manager.generate(f.session),/paused/);
    f.manager.configure(f.session,{provider:'openai',model:'gpt-image-1.5',key:'test-secret-never-return-this',maxPages:3});assert.equal(f.session.snapshot.generator.blocked,undefined);
  }finally{await f.manager.close();}
});

test('standalone export embeds complete comic art without adding a second dialogue rail',async()=>{
  const studio=new Studio();const state=studio.state;studio.close();
  const imageUrl=`data:image/webp;base64,${(await image()).toString('base64')}`;
  state.panels=[{id:'complete-page',imageUrl,altText:'Four observed restaurant scenes',caption:'Observed recap',dialogue:['Already drawn inside the artwork'],at:0,provenance:{provider:'scene-gemini'}} as typeof state.panels[number]];
  const {html,shareHtml}=await renderExport(state);
  for(const output of [html,shareHtml]){
    assert.ok(output.includes(`src="${imageUrl}"`));
    assert.match(output,/class="comic-panel complete-scene-page"/);
    assert.equal(output.includes('Already drawn inside the artwork'),false);
    assert.equal(output.includes('class="lettering-rail"'),false);
    assert.match(output,/object-fit:contain/);
  }
});
