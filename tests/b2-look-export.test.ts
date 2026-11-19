import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Studio} from '../apps/server/src/studio.ts';
import {RecapStore} from '../apps/server/src/recaps.ts';
import {renderExport} from '../apps/server/src/export.ts';
import {createApp} from '../apps/server/src/app.ts';
import type {MangaTheme} from '../packages/core/src/index.ts';

type Look=MangaTheme;
type SaveWithLook=(state:Studio['state'],options?:{look?:Look})=>ReturnType<RecapStore['save']>;
type RenderWithLook=(state:Studio['state'],options?:{look?:Look})=>ReturnType<typeof renderExport>;
const themeOf=(html:string)=>/class="manga-pages" data-manga-theme="([a-z]+)"/.exec(html)?.[1];

test('B2-LOOK-01: a saved issue follows the current Look: a fresh save defaults to festival, switch to sunset, recap and export show sunset',async()=>{
  const directory=await mkdtemp(resolve('artifacts/tmp/b2-look-'));const store=new RecapStore(directory);
  const studio=new Studio();studio.useSource('sample');studio.moderate('approve');
  try{
    assert.equal(studio.state.mangaTheme,'festival','the raw Studio default is festival');
    const first=await store.save(studio.state);assert.equal(first.snapshot.mangaTheme,'festival','a fresh save defaults to festival');
    assert.equal(themeOf((await renderExport(first.snapshot)).html),'festival');
    studio.settings({mangaTheme:'sunset'});
    const second=await store.save({...studio.state,recapUrl:first.snapshot.recapUrl});
    assert.equal(second.id,first.id,'the story keeps its id');
    assert.equal(second.snapshot.mangaTheme,'sunset','the saved issue takes the new Look');
    assert.equal((await new RecapStore(directory).read(first.id)).mangaTheme,'sunset','a cold read of the recap shows the new Look');
    assert.equal(JSON.parse(await readFile(resolve(directory,first.id,'recap.json'),'utf8')).mangaTheme,'sunset');
    const {html,shareHtml}=await renderExport(second.snapshot);
    assert.equal(themeOf(html),'sunset');assert.equal(themeOf(shareHtml),'sunset');
    assert.equal(second.snapshot.panels[0]!.caption,first.snapshot.panels[0]!.caption,'only the Look is revised');
    studio.settings({mangaTheme:'festival'});
    assert.equal((await store.save(studio.state)).snapshot.mangaTheme,'festival','switching back is honoured too');
    studio.settings({mangaTheme:'ink'});
    assert.equal((await store.save(studio.state)).snapshot.mangaTheme,'festival','a legacy mangaTheme resolves to festival too');
  }finally{studio.close();}
});

test('B2-LOOK-02: an explicit look parameter overrides the state Look for both save and export',async()=>{
  const store=new RecapStore(await mkdtemp(resolve('artifacts/tmp/b2-look-param-')));
  const studio=new Studio();studio.useSource('sample');studio.moderate('approve');
  try{
    const save=store.save.bind(store) as unknown as SaveWithLook;const render=renderExport as unknown as RenderWithLook;
    const saved=await save(studio.state,{look:'sunset'});
    assert.equal(saved.snapshot.mangaTheme,'sunset','the explicit look wins over the state default');
    const back=await save({...studio.state,mangaTheme:'sunset'},{look:'lagoon'});
    assert.equal(back.id,saved.id);assert.equal(back.snapshot.mangaTheme,'lagoon');
    assert.equal(themeOf((await render(back.snapshot,{look:'blossom'})).html),'blossom','export look parameter overrides the snapshot Look');
    assert.equal(themeOf((await render(back.snapshot)).html),'lagoon','without a parameter the snapshot Look is used');
    const legacy=await save({...studio.state,mangaTheme:'lagoon'},{look:'ink'});
    assert.equal(legacy.id,saved.id);assert.equal(legacy.snapshot.mangaTheme,'festival','an explicit legacy look resolves to festival, not an Unknown Look error');
    await assert.rejects(()=>save(studio.state,{look:'sepia' as Look}),/Unknown Look/);
    await assert.rejects(()=>render(studio.state,{look:'sepia' as Look}),/Unknown Look/);
  }finally{studio.close();}
});

test('B2-LOOK-03: through the API, a legacy Look saved after the first save still reaches the saved recap as festival',async()=>{
  const recapDirectory=await mkdtemp(resolve('artifacts/tmp/b2-look-api-'));const app=createApp({recapDirectory});
  try{
    await app.inject({method:'POST',url:'/api/settings',payload:{mangaTheme:'ink'}});// the Studio default is festival; this test starts in ink
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}});await app.inject({method:'POST',url:'/api/approve',payload:{all:true}});
    const first=(await app.inject({method:'POST',url:'/api/recaps',payload:{}})).json();
    const id=first.recapUrl.split('/').at(-1);
    assert.equal((await app.inject(`/api/recaps/${id}`)).json().mangaTheme,'festival','a fresh save with no explicit Look defaults to festival');
    await app.inject({method:'POST',url:'/api/settings',payload:{mangaTheme:'ink'}});
    const second=(await app.inject({method:'POST',url:'/api/recaps',payload:{}})).json();
    assert.equal(second.recapUrl,first.recapUrl);assert.equal(second.mangaTheme,'festival','the legacy setting still resolves to festival');
    assert.equal((await app.inject(`/api/recaps/${id}`)).json().mangaTheme,'festival');
  }finally{await app.close();}
});

test('B2-LOOK-04: API save honors an explicit Look and rejects unknown Looks without changing the issue',async()=>{
  const recapDirectory=await mkdtemp(resolve('artifacts/tmp/b2-look-explicit-'));
  const app=createApp({env:{},logger:false,recapDirectory});
  try{
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}});
    await app.inject({method:'POST',url:'/api/approve',payload:{all:true}});
    const saved=await app.inject({method:'POST',url:'/api/recaps',payload:{look:'festival'}});
    assert.equal(saved.statusCode,200);
    assert.equal(saved.json().mangaTheme,'festival');
    const id=saved.json().recapUrl.split('/').at(-1);
    assert.equal((await app.inject(`/api/recaps/${id}`)).json().mangaTheme,'festival');
    for(const url of ['/api/end','/api/recaps']){
      assert.equal((await app.inject({method:'POST',url,payload:{look:'sepia'}})).statusCode,400);
    }
    assert.equal((await app.inject('/api/state')).json().panels.length,saved.json().panels.length);
  }finally{await app.close();}
});
