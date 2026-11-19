import assert from 'node:assert/strict';
import test from 'node:test';
import {eventBus,type StreamEvent} from '@comictoons/core';
import {Studio} from '../apps/server/src/studio.ts';
import {createDirectAdapter} from '../scripts/s2-replay-core.ts';

for(const path of ['irc','bus'] as const)test(`INT-FID-T11: five lines, a later line from another user, then opt-out purges the 120s baseline and every content store (${path})`,()=>{
  const direct=createDirectAdapter();let clock=0;
  const studio=new Studio({adapterFactory:()=>direct.adapter,now:()=>clock});
  const user='privacy-test-user';
  const inner=studio as unknown as {moments:{chatTimes:{user?:string}[];recentChat:StreamEvent[];tokenUses:{user?:string}[];open?:unknown;completed:unknown[]};liveDrafts:Map<string,unknown>;momentDrafts:Map<string,unknown>;recentCaptions:Map<string,string>};
  const send=(event:StreamEvent)=>path==='irc'?direct.push(event):eventBus.emit('stream-event',event);
  try{
    studio.useSource('twitch','approved_test');
    direct.push({id:'anchor',t:0,type:'chat',user:'anchor',text:'anchor stays live'});
    for(let i=0;i<5;i++){clock=(i+1)*1000;send({id:`private-${i}`,t:i+1,type:'chat',user,text:`private-content-${i} KEKW`});}
    assert.equal(inner.moments.chatTimes.filter(row=>row.user===user).length,5);
    // Another user's line more than 10 s later prunes the spike and burst windows, so the
    // opted-out user's lines sit only in the 120 s baseline, which only forgetUser clears.
    clock=20_000;send({id:'later',t:20,type:'chat',user:'bystander',text:'later line KEKW'});
    assert.equal(inner.moments.recentChat.filter(row=>row.user===user).length,0,'spike window pruned');
    assert.equal(inner.moments.tokenUses.filter(row=>row.user===user).length,0,'burst window pruned');
    assert.equal(inner.moments.chatTimes.filter(row=>row.user===user).length,5,'baseline still holds the lines');
    clock=35_000;send({id:'opt-out',t:35,type:'chat',user,text:'!optout'});
    assert.equal(inner.moments.chatTimes.filter(row=>row.user===user).length,0,'120s baseline');
    assert.equal(inner.moments.recentChat.filter(row=>row.user===user).length,0);
    assert.equal(inner.moments.tokenUses.filter(row=>row.user===user).length,0);
    const held={drafts:[...inner.liveDrafts],moments:[...inner.momentDrafts],open:inner.moments.open,completed:inner.moments.completed,captions:[...inner.recentCaptions],pending:studio.state.pendingPanels};
    assert.doesNotMatch(JSON.stringify(held),/privacy-test-user|private-content-/);
  }finally{studio.close();}
});
