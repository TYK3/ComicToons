import assert from 'node:assert/strict';
import test from 'node:test';
import {createEventBus,type ComicPanel} from '@comictoons/core';
import {Studio} from '../apps/server/src/studio.ts';
import {approvedPages} from '../apps/server/src/scenes/approved.ts';
import {CaptionPolls} from '../apps/server/src/participation/polls.ts';
import {OptOutLedger} from '../apps/server/src/participation/commands.ts';
import {PanelBudget} from '../apps/server/src/participation/rewards.ts';
const panel=(id:string):ComicPanel=>({id,origin:'twitch',caption:'Observed race',dialogue:[],scene:'Race',altText:'Race',imageUrl:'/art/scenes/real-page',characters:[],mood:'calm',at:1});
test('Viewer projection contains only matching channel released live pages and refreshes revisions',()=>{
  const studio=new Studio();studio.state.source={requested:'twitch',active:'twitch',channel:'qa_owner',connection:'live',simulated:false,received:2};
  studio.state.panels=[panel('accepted'),{...panel('blocked'),releaseBlocked:'Not generated'},{...panel('sample'),origin:'sample'}];studio.state.pendingPanels=[panel('pending')];
  assert.deepEqual(approvedPages(studio.state,'other'),[]);
  const visible=approvedPages(studio.state,'qa_owner');assert.deepEqual(visible.map(p=>p.id),['accepted']);
  assert.equal('dialogue' in visible[0]!,false);assert.equal('sourceChatIds' in visible[0]!,false);
  studio.state.panels[0]!.imageUrl='/art/scenes/real-page?v=reviewed';assert.match(approvedPages(studio.state,'qa_owner')[0]!.imageUrl,/reviewed/);
});
test('chat votes can revise a released panel and blocked placeholders cannot enter a vote',async()=>{
  const studio=new Studio();studio.state.panels=[{...panel('accepted'),provenance:{provider:'scene-cloudflare',style:'comic',fallback:false}}];const now=()=>1000;
  studio.setSceneEditor(async(id,lettering)=>{const target=studio.state.panels.find(p=>p.id===id)!;target.caption=lettering.text;target.imageUrl='/art/scenes/real-page?v=vote';});
  const polls=new CaptionPolls({studio,optOuts:new OptOutLedger(),bus:createEventBus(),now,budget:new PanelBudget(12,now),useHelix:false});
  polls.noteChat({type:'chat',t:1,user:'owner',text:'The kart reaches the bend'});polls.noteChat({type:'chat',t:1,user:'owner',text:'Keep racing'});
  const vote=await polls.start({panelId:'accepted'});assert.equal(vote.mode,'chat');
  assert.equal(polls.vote({type:'chat',t:1,user:'owner',text:'!1'},1),true);
  const result=polls.finish()!;assert.equal(result.outcome,'rendering');await new Promise(resolve=>setImmediate(resolve));assert.equal(result.outcome,'applied');assert.equal(studio.state.panels[0]!.caption,vote.choices[0]!.caption);assert.match(studio.state.panels[0]!.imageUrl,/vote/);
  studio.state.pendingPanels=[{...panel('blocked'),releaseBlocked:'No generated image'}];await assert.rejects(()=>polls.start({panelId:'blocked'}),/eligible panel/);
});
