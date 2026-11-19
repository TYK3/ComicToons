import {expect,test} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import {capture} from './screenshot';
import {createEventBus,type ComicPanel,type ComicToonsBusEvents,type StreamEvent} from '../packages/core/src/index.ts';
import type {StudioLike} from '../apps/server/src/participation/commands.ts';
import {Participation,createMockHelix} from '../apps/server/src/participation/routes.ts';

// T12: what the streamer sees when Twitch refuses the Ink me reward (not an Affiliate or Partner).
// The participation engine runs in the test with the in-memory Helix; no network, no real Twitch.
function nonAffiliate(){
  const bus=createEventBus<ComicToonsBusEvents>();
  const studio:StudioLike={state:{panels:[] as ComicPanel[],pendingPanels:[] as ComicPanel[],elapsed:0,approvalMode:true},
    moderate(kind,panelId){const chosen=studio.state.pendingPanels.find(entry=>entry.id===panelId)!;studio.state.pendingPanels=studio.state.pendingPanels.filter(entry=>entry!==chosen);if(kind==='approve')studio.state.panels.push(chosen);},caption(){}};
  const engine=new Participation({studio,bus,helix:createMockHelix({affiliate:false}),budgetPerHour:12,
    flags:{polls:false,twitchPolls:false,inkMe:true,catchup:false,hype:false,director:true,noink:true,botReplies:false}});
  let n=0;
  const chat=(name:string,text:string,moderator=false)=>bus.emit('stream-event',{id:`spec-${++n}`,t:0,type:'chat',user:`${name}-id`,name,text,moderator} as StreamEvent);
  return {bus,engine,chat};
}

for(const width of [1440,390])test(`INK-FB-8: Studio shows the !ink fallback, the chat request and the mod answer (${width}px)`,async({page})=>{
  const {bus,engine,chat}=nonAffiliate();
  bus.emit('twitch-connected',{});await new Promise(resolve=>setImmediate(resolve));
  await page.setViewportSize({width,height:width>800?1000:844});
  await page.route('**/api/participation/status',route=>route.fulfill({json:engine.status()}));
  await page.goto('/studio');
  const card=page.locator('article',{has:page.locator('#pc-ink-title')});
  await expect(card.getByText('Reward not created')).toContainText('Channel points need Affiliate or Partner.');
  await expect(card.getByText('Not an Affiliate or Partner? Viewers type !ink in chat instead. You or a mod answer with !ink yes or !ink no.')).toBeVisible();
  chat('Juniper','!ink');await new Promise(resolve=>setImmediate(resolve));
  const requests=card.getByRole('list',{name:'!ink requests from chat'});
  await expect(requests).toContainText('Juniper');
  await expect(requests).toContainText('Cameo drafted; waiting for !ink yes or !ink no.');
  await mkdir('artifacts/ink-fallback',{recursive:true});
  await card.scrollIntoViewIfNeeded();
  expect((await new AxeBuilder({page}).include('#pc-ink-title').analyze()).violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
  await capture(page,{path:`artifacts/ink-fallback/requested-${width}.jpg`});
  chat('Moss','!ink yes',true);await new Promise(resolve=>setImmediate(resolve));
  await expect(requests).toContainText('Approved by Moss.');
  await card.scrollIntoViewIfNeeded();
  await capture(page,{path:`artifacts/ink-fallback/approved-${width}.jpg`});
  engine.close();
});
