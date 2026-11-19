import {expect,test} from './app-fixture';
import AxeBuilder from '@axe-core/playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import type {StudioState} from '../apps/server/src/studio.ts';
import {capture} from './screenshot';

test('IN-FALLBACK-UI: unauthenticated read-only channel immediately supplies labelled, approval-gated samples',async({page,request})=>{
  await request.post('/api/stop');await request.post('/api/settings',{data:{approvalMode:true}});
  await page.goto('/studio');await page.getByLabel('Twitch channel',{exact:true}).fill('approved_test');
  await page.getByRole('button',{name:'Try read-only Twitch',exact:true}).click();
  await expect(page.getByTestId('source-label')).toHaveText('Sample Data');
  await expect(page.getByRole('status').filter({hasText:'Live chat access is not configured.'})).toBeVisible();
  await expect(page.getByTestId('approval-queue').getByRole('button',{name:/^Review panel/})).toHaveCount(4);
  const state=(await(await request.get('/api/state')).json()) as StudioState;
  expect(state.source).toMatchObject({requested:'twitch',active:'sample',reason:'unauthenticated'});
  expect(state.panels).toHaveLength(0);expect(state.pendingPanels).toHaveLength(4);
  await mkdir('artifacts/live-ingest',{recursive:true});
  const findings:Record<string,unknown>={};
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    await expect(page.getByTestId('source-label')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const violations=(await new AxeBuilder({page}).analyze()).violations.filter(item=>item.impact==='serious'||item.impact==='critical');
    expect(violations).toEqual([]);findings[width]=violations;
    await capture(page,{path:`artifacts/live-ingest/fallback-${width}.jpg`});
  }
  await writeFile('artifacts/live-ingest/axe.json',JSON.stringify(findings,null,2));
});

test('IN-CACHED-SWITCH: simulated live view changes to cached Sample Data before the held POST completes',async({page,request})=>{
  await request.post('/api/stop');await request.post('/api/settings',{data:{approvalMode:true}});
  const sample=(await(await request.get('/api/ingest/sample')).json()) as StudioState;
  const livePanel=structuredClone(sample.pendingPanels[0]!);livePanel.origin='twitch';livePanel.dialogue=['SIMULATED LIVE CHAT'];
  let current:StudioState={...sample,status:'live',panels:[livePanel],pendingPanels:[],source:{requested:'twitch',active:'twitch',connection:'live',channel:'approved_test',simulated:false,received:1}};
  await page.route('**/api/state',route=>route.fulfill({json:current}));
  await page.route('**/api/ingest/sample',route=>route.fulfill({json:sample}));
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let completed=false;
  await page.route('**/api/ingest',async route=>{await held;current=sample;completed=true;await route.fulfill({json:sample});});
  await page.goto('/studio');await expect(page.getByTestId('source-label')).toHaveText('Live chat');
  await expect(page.locator('.preview-stage')).toContainText('SIMULATED LIVE CHAT');
  const fallback=page.getByRole('button',{name:'Use Sample Data now',exact:true});await expect(fallback).toBeEnabled();
  await fallback.click();
  await expect(page.getByTestId('source-label')).toHaveText('Sample Data');
  await expect(page.locator('.preview-stage')).not.toContainText('SIMULATED LIVE CHAT');
  await expect(page.getByTestId('approval-queue').getByRole('button',{name:/^Review panel/})).toHaveCount(4);
  expect(completed,'The sample UI must render without waiting for the source POST').toBe(false);
  release();await expect(fallback).toBeEnabled();expect(completed).toBe(true);
});

test('IN-PROVENANCE: automatic fallback stays labelled on overlay, saved recap, standalone and PNG export',async({page,request})=>{
  await request.post('/api/stop');await request.post('/api/settings',{data:{approvalMode:true}});
  const response=await request.post('/api/ingest',{data:{mode:'twitch',channel:'approved_test'}});expect(response.ok()).toBe(true);
  expect((await response.json()).source.reason).toBe('unauthenticated');
  expect((await request.post('/api/approve', { data: { all: true } })).ok()).toBe(true);
  await page.goto('/overlay');await expect(page.locator('.manga-sample')).toContainText('Sample Data');
  const ended=await request.post('/api/end');expect(ended.ok(),await ended.text()).toBe(true);const links=await ended.json();
  await page.goto(links.recapUrl);await expect(page.locator('.manga-sample')).toContainText('Sample Data');
  const standalone=await request.get(links.shareUrl.replace('share.png','index.html'));
  await page.setContent(await standalone.text());await expect(page.locator('.manga-sample')).toContainText('Sample Data');
  const saved=(await(await request.get(`/api/recaps/${links.recapUrl.split('/').at(-1)}`)).json()) as StudioState;
  expect(saved.source?.active).toBe('sample');expect(saved.source?.reason).toBe('unauthenticated');
  const image=await request.get(links.pageUrls[0]);expect(image.ok()).toBe(true);expect((await image.body()).length).toBeGreaterThan(50_000);
});
