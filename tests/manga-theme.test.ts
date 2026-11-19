import test from 'node:test';
import assert from 'node:assert/strict';
import {mangaThemes,resolveMangaTheme} from '../packages/core/src/index.ts';
import {createApp} from '../apps/server/src/app.ts';
import {Studio} from '../apps/server/src/studio.ts';
import {renderExport} from '../apps/server/src/export.ts';

test('MT-STATE: festival Studio default (raw state and /api/state) and validated palette settings survive replay and sample fallback without changing panels',async()=>{
  assert.equal(resolveMangaTheme(undefined),'festival');assert.equal(resolveMangaTheme('unknown'),'festival');assert.equal(resolveMangaTheme('ink'),'festival');assert.equal(mangaThemes.length,4);
  const app=createApp();
  try{
    assert.equal((await app.inject('/api/state')).json().mangaTheme,'festival');
    {const fresh=new Studio();try{assert.equal(fresh.state.mangaTheme,'festival','the raw Studio default is festival, not a resolved legacy id');}finally{fresh.close();}}
    assert.equal((await app.inject({method:'POST',url:'/api/settings',payload:{mangaTheme:'unknown'}})).statusCode,400);
    await app.inject({method:'POST',url:'/api/settings',payload:{mangaTheme:'festival'}});
    const sample=(await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'sample'}})).json();
    const original=structuredClone(sample.pendingPanels);
    const changed=(await app.inject({method:'POST',url:'/api/settings',payload:{mangaTheme:'ink'}})).json();assert.deepEqual(changed.pendingPanels,original);
    await app.inject({method:'POST',url:'/api/settings',payload:{mangaTheme:'festival'}});
    assert.equal((await app.inject({method:'POST',url:'/api/replay',payload:{fixtureId:'tabletop-night'}})).json().mangaTheme,'festival');
    assert.equal((await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test'}})).json().mangaTheme,'festival');
  }finally{await app.close();}
});

test('MT-HTML: a legacy mangaTheme renders as festival, and all four saved palettes use the shared manga CSS and preserve Sample Data in both export documents',async()=>{
  const studio=new Studio();studio.useSource('sample');studio.moderate('approve');
  studio.settings({mangaTheme:'ink'});
  const legacy=await renderExport(studio.state);
  for(const html of [legacy.html,legacy.shareHtml])assert.ok(html.includes('data-manga-theme="festival"'),'a legacy mangaTheme renders as festival');
  for(const mangaTheme of ['festival','sunset','lagoon','blossom'] as const){
    studio.settings({mangaTheme});const result=await renderExport(studio.state);
    for(const html of [result.html,result.shareHtml]){
      assert.ok(html.includes(`data-manga-theme="${mangaTheme}"`));assert.ok(html.includes('Sample Data'));assert.ok(html.includes('story-balloon'));assert.ok(html.includes('story-sfx'));
    }
  }
  studio.close();
});
