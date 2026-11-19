import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Studio} from '../apps/server/src/studio.ts';
import {RecapStore} from '../apps/server/src/recaps.ts';
import {createApp} from '../apps/server/src/app.ts';

test('RID-STUDIO-NAV: first saved link and caption divergence survive reapproval and cold application reads without rewriting JSON',async()=>{
  const recapDirectory=await mkdtemp(resolve('artifacts/tmp/recap-nav-'));const app=createApp({recapDirectory});let savedUrl='',bytes='';
  try{
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}});await app.inject({method:'POST',url:'/api/approve',payload:{all:true}});
    const first=(await app.inject({method:'POST',url:'/api/recaps',payload:{}})).json();savedUrl=first.recapUrl;
    const file=resolve(recapDirectory,savedUrl.split('/').at(-1)!,'recap.json');bytes=await readFile(file,'utf8');
    assert.equal((await app.inject('/api/state')).json().savedIssueDiffers,false);
    await app.inject({method:'POST',url:'/api/replay',payload:{fixtureId:'tabletop-night',speed:1}});
    const draft=(await app.inject('/api/state')).json();
    await app.inject({method:'POST',url:'/api/caption',payload:{panelId:draft.pendingPanels[0].id,caption:'A different caption on air.'}});
    await app.inject({method:'POST',url:'/api/approve',payload:{all:true}});
    const revised=(await app.inject('/api/state')).json();assert.equal(revised.latestRecapUrl,savedUrl);assert.equal(revised.savedIssueDiffers,true);
    assert.equal(revised.panels[0].caption,'A different caption on air.');
    assert.deepEqual((await app.inject({method:'POST',url:'/api/recaps',payload:{}})).json(),first);
    assert.equal((await app.inject('/api/state')).json().recapUrl,savedUrl);assert.equal(await readFile(file,'utf8'),bytes);
  }finally{await app.close();}
  const cold=createApp({recapDirectory});
  try{
    const restored=(await cold.inject('/api/state')).json();assert.equal(restored.latestRecapUrl,savedUrl);assert.equal(restored.savedIssueDiffers,false);
    const preloaded=(await cold.inject('/api/ingest/sample')).json();assert.equal(preloaded.latestRecapUrl,savedUrl);
    assert.equal(await readFile(resolve(recapDirectory,savedUrl.split('/').at(-1)!,'recap.json'),'utf8'),bytes);
  }finally{await cold.close();}
});

test('RID-STABLE: same approved edition persists once under a stable URL/id, including a cold store',async()=>{
  const directory=await mkdtemp(resolve('artifacts/tmp/recap-id-'));const store=new RecapStore(directory);const studio=new Studio();
  studio.useSource('sample');studio.moderate('approve');
  const [first,concurrent]=await Promise.all([store.save(studio.state),store.save(studio.state)]);
  assert.equal(first.id,concurrent.id);assert.equal(first.snapshot.recapUrl,`/recap/${first.id}`);
  assert.deepEqual(await readdir(first.directory),['recap.json'],'Saving an id must not render a server PNG');
  const disk=JSON.parse(await readFile(resolve(first.directory,'recap.json'),'utf8'));assert.deepEqual(disk.panels,studio.state.panels);assert.deepEqual(disk.pendingPanels,[]);
  const cold=new RecapStore(directory);assert.deepEqual((await cold.read(first.id)).panels,studio.state.panels);
  const again=await cold.save({...studio.state,elapsed:999,status:'replaying',approvalMode:false});assert.equal(again.id,first.id);
  studio.close();
});

test('RID-NAME: canonical generated ids contain no recap prefix and old prefixed links remain readable',async()=>{
  const directory=await mkdtemp(resolve('artifacts/tmp/recap-name-'));const studio=new Studio();
  studio.useSource('sample');studio.moderate('approve');
  const store=new RecapStore(directory);const first=await store.save(studio.state);
  assert.match(first.id,/^[a-f0-9]{32}$/,'Only the filename supplies the recap- prefix');
  const legacyDirectory=await mkdtemp(resolve('artifacts/tmp/recap-name-legacy-'));
  const legacyId=`recap-${first.id}`,legacyPath=resolve(legacyDirectory,legacyId);
  await mkdir(legacyPath);await writeFile(resolve(legacyPath,'recap.json'),JSON.stringify({...first.snapshot,recapUrl:`/recap/${legacyId}`,shareUrl:`/exports/${legacyId}/share.png`}));
  const cold=new RecapStore(legacyDirectory);
  assert.equal((await cold.read(legacyId)).recapUrl,`/recap/${first.id}`);
  assert.equal((await cold.read(first.id)).recapUrl,`/recap/${first.id}`);
  const again=await cold.save({...studio.state,recapUrl:`/recap/${legacyId}`});
  assert.equal(again.id,first.id);assert.equal(again.snapshot.recapUrl,`/recap/${first.id}`);
  assert.equal(again.snapshot.shareUrl,`/exports/${legacyId}/share.png`,'Keep existing server artifacts available');
  assert.ok((await readFile(resolve(legacyPath,'recap.json'),'utf8')).includes(legacyId),'Do not delete or rewrite an older export');
  studio.close();
});

test('RID-URL: saved metadata returns the canonical recap prefix even when loaded from a legacy r URL',async()=>{
  const directory=await mkdtemp(resolve('artifacts/tmp/recap-url-'));const store=new RecapStore(directory);const studio=new Studio();
  studio.useSource('sample');studio.moderate('approve');const first=await store.save(studio.state);
  await writeFile(resolve(first.directory,'recap.json'),JSON.stringify({...first.snapshot,recapUrl:`/r/${first.id}`}));
  const cold=new RecapStore(directory);
  assert.equal((await cold.read(first.id)).recapUrl,`/recap/${first.id}`,'Cold metadata is canonical');
  assert.equal((await cold.read(first.id)).recapUrl,`/recap/${first.id}`,'Cached metadata is canonical');
  const saved=await cold.save({...studio.state,recapUrl:`/r/${first.id}`});
  assert.equal(saved.id,first.id);assert.equal(saved.snapshot.recapUrl,`/recap/${first.id}`);
  studio.close();
});

test('RID-EDITION: editorial revisions retain the story id and a different story cannot reuse it',async()=>{
  const store=new RecapStore(await mkdtemp(resolve('artifacts/tmp/recap-edition-')));const studio=new Studio();studio.useSource('sample');studio.moderate('approve');
  const original=await store.save(studio.state);
  const matching=await store.save({...studio.state,recapUrl:`/r/${original.id}`});assert.equal(matching.id,original.id);
  const edited=structuredClone(studio.state);edited.panels[0]!.caption='A new approved version.';
  const revision=await store.save({...edited,recapUrl:original.snapshot.recapUrl});assert.equal(revision.id,original.id);
  const colour=await store.save({...edited,mangaTheme:'festival',recapUrl:original.snapshot.recapUrl});assert.equal(colour.id,original.id);
  // B2: the Look is not locked at the first save; a save in another Look revises only the Look.
  assert.deepEqual(revision.snapshot,original.snapshot);assert.deepEqual(colour.snapshot,{...original.snapshot,mangaTheme:'festival'});assert.deepEqual(await store.read(original.id),colour.snapshot);
  const other=new Studio();other.replay('speedrun-fail');other.moderate('approve');
  const different=await store.save({...other.state,recapUrl:original.snapshot.recapUrl});assert.notEqual(different.id,original.id);
  studio.close();other.close();
});

test('RID-CAPTION: later captions retain the first saved story and export metadata under the stable id',async()=>{
  const directory=await mkdtemp(resolve('artifacts/tmp/recap-caption-'));const store=new RecapStore(directory);const studio=new Studio();
  studio.useSource('sample');studio.moderate('approve');const first=await store.save(studio.state);
  await store.write(first.id,{...first.snapshot,status:'ended',shareUrl:`/exports/${first.id}/share.png`,pageUrls:[`/exports/${first.id}/page-1.png`]});
  const edited={...structuredClone(studio.state),recapUrl:first.snapshot.recapUrl};edited.panels[0]!.caption='The key belongs to our crew.';
  const cold=new RecapStore(directory);const second=await cold.save(edited);
  assert.equal(second.id,first.id);assert.equal(second.snapshot.recapUrl,first.snapshot.recapUrl);
  assert.equal(second.snapshot.panels[0]!.caption,first.snapshot.panels[0]!.caption);
  assert.equal(second.snapshot.status,'ended');assert.equal(second.snapshot.shareUrl,`/exports/${first.id}/share.png`);assert.deepEqual(second.snapshot.pageUrls,[`/exports/${first.id}/page-1.png`]);
  assert.equal((await new RecapStore(directory).read(first.id)).panels[0]!.caption,first.snapshot.panels[0]!.caption);
  assert.equal((await cold.save({...edited,recapUrl:undefined})).id,first.id,'Editing before the first save also has the same story identity');
  const next=structuredClone(edited);next.panels[0]!.caption='One more revision.';
  const last=structuredClone(edited);last.panels[0]!.caption='The latest approved revision.';
  const [a,b]=await Promise.all([cold.save(next),cold.save(last)]);
  assert.equal(a.id,first.id);assert.equal(b.id,first.id);
  assert.deepEqual(a.snapshot,second.snapshot);assert.deepEqual(b.snapshot,second.snapshot);
  assert.equal((await new RecapStore(directory).read(first.id)).panels[0]!.caption,first.snapshot.panels[0]!.caption);
  const live=structuredClone(edited);live.fixtureId='twitch';
  live.panels.forEach((panel,index)=>{panel.id=`irc-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa-${index}`;});
  const liveFirst=await cold.save({...live,recapUrl:undefined});
  live.panels=live.panels.slice(1);live.panels[0]!.caption='More of the same live session.';
  assert.equal((await cold.save({...live,recapUrl:liveFirst.snapshot.recapUrl})).id,liveFirst.id);
  live.panels.forEach((panel,index)=>{panel.id=`irc-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb-${index}`;});
  assert.notEqual((await cold.save(live)).id,liveFirst.id,'A new live session is a new story');
  studio.close();
});

test('RID-API: saving returns a readable persisted recap before rendering, survives app restart and rejects empty issues',async()=>{
  const recapDirectory=await mkdtemp(resolve('artifacts/tmp/recap-api-'));const app=createApp({recapDirectory});let id='';
  try{
    assert.equal((await app.inject({method:'POST',url:'/api/recaps',payload:{}})).statusCode,409);
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}});await app.inject({method:'POST',url:'/api/approve',payload:{all:true}});
    const saved=(await app.inject({method:'POST',url:'/api/recaps',payload:{}})).json();id=saved.recapUrl.split('/').at(-1);
    assert.equal((await app.inject({method:'POST',url:'/api/recaps',payload:{}})).json().recapUrl,saved.recapUrl);
    assert.deepEqual((await app.inject(`/api/recaps/${id}`)).json().panels,saved.panels);
  }finally{await app.close();}
  const restarted=createApp({recapDirectory});try{assert.equal((await restarted.inject(`/api/recaps/${id}`)).statusCode,200);assert.equal((await restarted.inject('/api/state')).json().panels.length,0);}finally{await restarted.close();}
});


test('RID-FIRST-SAVE: reapproval keeps the first disk bytes and returns the first version after restart and concurrent requests',async()=>{
  const directory=await mkdtemp(resolve('artifacts/tmp/recap-first-'));
  const store=new RecapStore(directory),studio=new Studio();
  try{
    studio.useSource('sample');const approval=studio.moderate('approve');
    const first=await store.save(studio.state);
    const path=resolve(first.directory,'recap.json'),bytes=await readFile(path,'utf8');
    studio.undo(approval.undoToken);studio.caption(studio.state.pendingPanels[0]!.id,'A different caption on reapproval.');studio.moderate('approve');
    const revised=structuredClone(studio.state);
    assert.notEqual(revised.panels[0]!.caption,first.snapshot.panels[0]!.caption);
    const cold=new RecapStore(directory);
    const again=await cold.save({...revised,recapUrl:first.snapshot.recapUrl});
    assert.equal(again.id,first.id);assert.deepEqual(again.snapshot,first.snapshot);
    assert.equal(await readFile(path,'utf8'),bytes);
    const [a,b]=await Promise.all([cold.save(revised),cold.save({...revised,mangaTheme:'festival'})]);
    // B2: concurrent saves apply in order; the festival save revises only the Look, and saving
    // back in the first Look restores the first version byte for byte.
    assert.deepEqual(a.snapshot,first.snapshot);assert.deepEqual(b.snapshot,{...first.snapshot,mangaTheme:'festival'});
    assert.deepEqual((await cold.save(revised)).snapshot,first.snapshot);
    assert.deepEqual(await new RecapStore(directory).read(first.id),first.snapshot);
    assert.equal(await readFile(path,'utf8'),bytes);
  }finally{studio.close();}
});
