import {test,expect} from './app-fixture';
import type {APIRequestContext} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {capture} from './screenshot';
import {buildMangaPages} from '../packages/core/src/index.ts';
import AxeBuilder from '@axe-core/playwright';

const revisedCaption='The crew found another way home.';
async function reviseSavedStory(request:APIRequestContext){
  await request.post('/api/ingest',{data:{mode:'sample'}});await request.post('/api/approve', { data: { all: true } });
  const first=await(await request.post('/api/recaps')).json();
  await request.post('/api/replay',{data:{fixtureId:'tabletop-night',speed:1}});
  const state=await(await request.get('/api/state')).json();
  await request.post('/api/caption',{data:{panelId:state.pendingPanels[0].id,caption:revisedCaption}});
  await request.post('/api/approve', { data: { all: true } });
  return first;
}

test('REC-O-A: latest-issue link keeps the first saved recap after revised approval, reload and off-air state',async({page,request})=>{
  const staleSample=await(await request.get('/api/ingest/sample')).json();expect(staleSample.latestRecapUrl).toBeUndefined();
  const first=await reviseSavedStory(request);
  const again=await(await request.post('/api/recaps')).json();expect(again).toEqual(first);
  await page.goto('/studio');
  const link=page.getByRole('link',{name:'Open your latest issue',exact:true});
  await expect(link).toBeVisible();await expect(link).toHaveAttribute('href',first.recapUrl);
  expect((await(await request.get('/api/state')).json()).recapUrl).toBe(first.recapUrl);
  await page.reload();await expect(link).toBeVisible();await expect(link).toHaveAttribute('href',first.recapUrl);
  await request.post('/api/stop');await page.reload();await expect(link).toBeVisible();await expect(link).toHaveAttribute('href',first.recapUrl);
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let completed=false;
  // Simulate a live view whose Sample Data cache predates the first save.
  // All saves and the completed source switch still use the isolated API.
  await page.route('**/api/ingest/sample',route=>route.fulfill({json:staleSample}));
  await page.route('**/api/state',async route=>{
    const current=await(await request.get('/api/state')).json();
    await route.fulfill({json:completed?current:{...current,source:{...current.source,requested:'twitch',active:'twitch',connection:'live',simulated:true}}});
  });
  await page.route('**/api/ingest',async route=>{await held;completed=true;await route.fallback();});
  await page.reload();await expect(link).toHaveAttribute('href',first.recapUrl);
  const fallback=page.getByRole('button',{name:'Use Sample Data now',exact:true});await expect(fallback).toBeEnabled();await fallback.click();
  try{await expect(link).toBeVisible();await expect(link).toHaveAttribute('href',first.recapUrl);expect(completed).toBe(false);}
  finally{release();}
  await expect(fallback).toBeEnabled();
  expect((await(await request.get('/api/state')).json()).pendingPanels).toHaveLength(4);
  await link.click();await expect(page).toHaveURL(new RegExp(`${first.recapUrl}$`));
  const savedLine=buildMangaPages(first.panels)[0]!.panels[0]!.panel.dialogue![0]!;
  await expect(page.locator('.story-balloon').first()).toHaveText(savedLine);
});

test('REC-O-B: visible caption-divergence notice links to the kept issue without automatic saving',async({page,request})=>{
  const first=await reviseSavedStory(request),id=first.recapUrl.split('/').at(-1);
  let saves=0,stateReads=0;
  page.on('request',request=>{
    if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/recaps')saves++;
    if(request.method()==='GET'&&new URL(request.url()).pathname==='/api/state')stateReads++;
  });
  await page.goto('/studio');
  const notice=page.getByRole('status').filter({hasText:'Saved issue differs from on-air caption'});
  await expect(notice).toBeVisible();await expect(notice.getByRole('link',{name:'Open saved issue',exact:true})).toHaveAttribute('href',first.recapUrl);
  await expect(page.locator('.preview-stage .story-balloon').first()).toHaveText(revisedCaption);
  await expect.poll(()=>stateReads).toBeGreaterThanOrEqual(3);expect(saves).toBe(0);
  expect(await(await request.get(`/api/recaps/${id}`)).json()).toEqual(first);
  await mkdir('artifacts/recap-observations',{recursive:true});
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});await notice.scrollIntoViewIfNeeded();await expect(notice).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect((await new AxeBuilder({page}).analyze()).violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
    await capture(page,{path:`artifacts/recap-observations/divergence-${width}.jpg`});
  }
  await notice.getByRole('link',{name:'Open saved issue',exact:true}).click();
  await expect(page.locator('.story-balloon').first()).not.toHaveText(revisedCaption);expect(saves).toBe(0);
});
