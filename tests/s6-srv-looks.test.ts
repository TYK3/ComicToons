import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {mangaThemes,resolveMangaTheme} from '../packages/core/src/index.ts';
import {createApp} from '../apps/server/src/app.ts';
import {Studio} from '../apps/server/src/studio.ts';
import {renderExport} from '../apps/server/src/export.ts';

/**
 * S6-srv (THEMES-4 edition): the server only ever kept 2 Looks (ink and festival). This port
 * carries the fix across to the 4 current theme ids (festival, sunset, lagoon, blossom); the
 * legacy ids ink, noir and pop are never offered Looks, they only ever resolve to festival.
 */
const REAL_LOOKS=['festival','sunset','lagoon','blossom'] as const;
const LEGACY_LOOKS=['ink','noir','pop'] as const;
const EDITION_LABEL:Record<typeof REAL_LOOKS[number],string>={festival:'FESTIVAL COLOUR',sunset:'SUNSET GLOW',lagoon:'LAGOON',blossom:'BLOSSOM'};
const themeOf=(html:string)=>/class="manga-pages" data-manga-theme="([a-z]+)"/.exec(html)?.[1];

// (a) the settings enum is festival|sunset|lagoon|blossom (plus legacy ink|noir|pop), and the
// server stores and returns each real value; a legacy value is stored as festival; junk is still refused.
test('S6-SRV-A: /api/settings accepts the 4 Looks and the 3 legacy ids (resolved to festival); an unknown Look is still refused',async()=>{
  const app=createApp({env:{},logger:false});
  try{
    for(const look of REAL_LOOKS){
      const response=await app.inject({method:'POST',url:'/api/settings',payload:{mangaTheme:look}});
      assert.equal(response.statusCode,200,`mangaTheme:${look} should be accepted`);
      assert.equal(response.json().mangaTheme,look);
      assert.equal((await app.inject('/api/state')).json().mangaTheme,look,`the stored state keeps ${look}`);
    }
    for(const legacy of LEGACY_LOOKS){
      const response=await app.inject({method:'POST',url:'/api/settings',payload:{mangaTheme:legacy}});
      assert.equal(response.statusCode,200,`mangaTheme:${legacy} should be accepted on input`);
      assert.equal(response.json().mangaTheme,'festival',`legacy ${legacy} is never an offered Look; it resolves to festival`);
    }
    assert.equal((await app.inject({method:'POST',url:'/api/settings',payload:{mangaTheme:'sepia'}})).statusCode,400);
  }finally{await app.close();}
});

// (b) theme.ts and its resolver have all 4 themes, and the export has sunset, lagoon and blossom
// CSS (not only festival); legacy ids resolve rather than render their own styling.
test('S6-SRV-B: theme.ts has exactly the 4 current themes, the resolver accepts each and maps legacy to festival, and the export CSS covers sunset, lagoon and blossom',async()=>{
  assert.equal(mangaThemes.length,4,'exactly the 4 current Looks, not 2');
  assert.deepEqual(mangaThemes.map(theme=>theme.id).sort(),[...REAL_LOOKS].sort());
  for(const look of REAL_LOOKS)assert.equal(resolveMangaTheme(look),look);
  for(const legacy of LEGACY_LOOKS)assert.equal(resolveMangaTheme(legacy),'festival');
  const studio=new Studio();studio.useSource('sample');studio.moderate('approve');
  try{
    for(const look of REAL_LOOKS){
      studio.settings({mangaTheme:look});
      const {html}=await renderExport(studio.state);
      assert.equal(themeOf(html),look);
      assert.ok(html.includes(`data-manga-theme="${look}"`),`the export CSS must style the ${look} Look`);
    }
  }finally{studio.close();}
});

// (c) /api/end and /api/recaps must read `look` from the body for every real Look, mapping legacy
// ids to festival, while the RID-EDITION rule (a Look change revises the saved story, it never
// creates a new one) keeps holding for all 4.
test('S6-SRV-C: /api/recaps reads `look` from the body for every Look, maps legacy ids to festival, and only ever revises the saved story',async()=>{
  const recapDirectory=await mkdtemp(resolve('artifacts/tmp/s6-srv-recap-'));
  const app=createApp({env:{},logger:false,recapDirectory});
  try{
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}});
    await app.inject({method:'POST',url:'/api/approve',payload:{all:true}});
    const first=(await app.inject({method:'POST',url:'/api/recaps',payload:{look:'festival'}})).json();
    const id=first.recapUrl.split('/').at(-1);
    assert.equal(first.mangaTheme,'festival');
    for(const look of REAL_LOOKS){
      const saved=(await app.inject({method:'POST',url:'/api/recaps',payload:{look}})).json();
      assert.equal(saved.recapUrl,first.recapUrl,`RID-EDITION: a Look change keeps the same story id (${look})`);
      assert.equal(saved.mangaTheme,look);
      assert.equal((await app.inject(`/api/recaps/${id}`)).json().mangaTheme,look,'the saved recap reads back in the new Look');
    }
    for(const legacy of LEGACY_LOOKS){
      const saved=(await app.inject({method:'POST',url:'/api/recaps',payload:{look:legacy}})).json();
      assert.equal(saved.recapUrl,first.recapUrl);
      assert.equal(saved.mangaTheme,'festival',`legacy ${legacy} is never saved as its own Look`);
    }
    assert.equal((await app.inject({method:'POST',url:'/api/recaps',payload:{look:'sepia'}})).statusCode,400);
    assert.equal((await app.inject('/api/state')).json().panels.length,first.panels.length,'a rejected Look never changes the approved panels');
  }finally{await app.close();}
});

// (c) /api/end must also publish the full export (share.png and page PNGs) in a Look the server
// used to drop (lagoon), carrying the RID-EDITION rule through the real chromium render.
test('S6-SRV-C2: /api/end renders the full export in lagoon, a Look the server used to drop',async()=>{
  const recapDirectory=await mkdtemp(resolve('artifacts/tmp/s6-srv-end-'));
  const app=createApp({env:{},logger:false,recapDirectory});
  try{
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}});
    await app.inject({method:'POST',url:'/api/approve',payload:{all:true}});
    const ended=await app.inject({method:'POST',url:'/api/end',payload:{look:'lagoon'}});
    assert.equal(ended.statusCode,200,ended.body);
    const links=ended.json();
    const id=links.recapUrl.split('/').at(-1);
    const saved=(await app.inject(`/api/recaps/${id}`)).json();
    assert.equal(saved.mangaTheme,'lagoon');
    assert.equal(saved.status,'ended');
    const html=(await app.inject(`/exports/${id}/index.html`)).body;
    assert.ok(html.includes('data-manga-theme="lagoon"'));
    assert.ok(html.includes(`APPROVED MOMENTS &middot; ${EDITION_LABEL.lagoon}`)||html.includes(`APPROVED MOMENTS · ${EDITION_LABEL.lagoon}`));
    const share=await app.inject(`/exports/${id}/share.png`);
    assert.equal(share.statusCode,200);assert.ok(share.rawPayload.length>1000);
    const revised=await app.inject({method:'POST',url:'/api/recaps',payload:{look:'blossom'}});
    assert.equal(revised.json().recapUrl,links.recapUrl,'RID-EDITION: revising the Look after /api/end keeps the same story id');
  }finally{await app.close();}
});

// (d) the export edition label must come from the Look name, not state.style (the art direction).
test('S6-SRV-D: the export edition label follows the Look, never state.style',async()=>{
  const studio=new Studio();studio.useSource('sample');studio.moderate('approve');
  try{
    studio.state.style='noir';
    for(const [look,label] of Object.entries(EDITION_LABEL) as [typeof REAL_LOOKS[number],string][]){
      const {html}=await renderExport(studio.state,{look});
      assert.ok(html.includes(`APPROVED MOMENTS &middot; ${label}`)||html.includes(`APPROVED MOMENTS · ${label}`),`edition label for ${look} must read ${label}, from the Look, not state.style ('noir')`);
    }
  }finally{studio.close();}
});

// (e) the reader must honour ?look= from the server: GET /api/recaps/:id?look= returns the
// snapshot resolved to the requested Look (legacy -> festival; unknown -> 400), and the override
// never writes back to the saved recap.
test('S6-SRV-E: GET /api/recaps/:id honours an explicit ?look= query (4 Looks and legacy ids), and rejects an unknown one',async()=>{
  const recapDirectory=await mkdtemp(resolve('artifacts/tmp/s6-srv-reader-'));
  const app=createApp({env:{},logger:false,recapDirectory});
  try{
    await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}});
    await app.inject({method:'POST',url:'/api/approve',payload:{all:true}});
    const saved=(await app.inject({method:'POST',url:'/api/recaps',payload:{look:'festival'}})).json();
    const id=saved.recapUrl.split('/').at(-1);
    assert.equal((await app.inject(`/api/recaps/${id}`)).json().mangaTheme,'festival','without a query the saved Look is used');
    for(const look of REAL_LOOKS){
      const response=await app.inject(`/api/recaps/${id}?look=${look}`);
      assert.equal(response.statusCode,200);
      assert.equal(response.json().mangaTheme,look,`?look=${look} must be honoured`);
    }
    for(const legacy of LEGACY_LOOKS){
      const response=await app.inject(`/api/recaps/${id}?look=${legacy}`);
      assert.equal(response.statusCode,200);
      assert.equal(response.json().mangaTheme,'festival',`?look=${legacy} resolves to festival`);
    }
    assert.equal((await app.inject(`/api/recaps/${id}?look=sepia`)).statusCode,400,'an unknown Look in the query is refused');
    assert.equal((await app.inject(`/api/recaps/${id}`)).json().mangaTheme,'festival','the override never writes back to storage');
  }finally{await app.close();}
});
