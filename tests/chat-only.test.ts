import assert from 'node:assert/strict';
import test from 'node:test';
import {Studio} from '../apps/server/src/studio.ts';
import {createApp} from '../apps/server/src/app.ts';
import {createDirectAdapter} from '../scripts/s2-replay-core.ts';

test('chat-only ingestion receives chat without opening generated panels; ordinary ingestion remains available',()=>{
  const direct=createDirectAdapter();
  let clock=0;
  const studio=new Studio({adapterFactory:()=>direct.adapter,now:()=>clock});
  try{
    studio.useSource('twitch','chat_reader',true,true);
    for(let i=0;i<5;i++){clock+=1000;direct.push({id:`read-${i}`,t:i+1,type:'chat',user:`viewer${i}`,text:'KEKW what a moment'});}
    assert.ok((studio.state.source?.received??0)>0);
    assert.equal(studio.state.pendingPanels.length,0);
    assert.equal(studio.state.panels.length,0);
    studio.useSource('twitch','chat_reader',true);
    clock+=1000;direct.push({id:'normal-line',t:10,type:'chat',user:'viewer',text:'A normal observed chat line'});
    assert.ok(studio.state.pendingPanels.length>0);
  }finally{studio.close();}
});

test('chat-only flag passes the ingest API validation and suppresses panel creation',async()=>{
  const direct=createDirectAdapter();const app=createApp({env:{},logger:false,adapterFactory:()=>direct.adapter});
  try{
    const session=await app.inject({method:'POST',url:'/api/watch/session',payload:{role:'streamer'}});
    const cookie=String(session.headers['set-cookie']).split(';')[0]!;
    const denied=await app.inject({method:'POST',url:'/api/ingest',headers:{cookie},payload:{mode:'twitch',channel:'chat_reader',fresh:true}});
    assert.equal(denied.statusCode,403,'ordinary other-channel ingestion remains blocked');
    const response=await app.inject({method:'POST',url:'/api/ingest',headers:{cookie},payload:{mode:'twitch',channel:'chat_reader',fresh:true,chatOnly:true}});
    assert.equal(response.statusCode,200);
    direct.push({id:'line',t:1,type:'chat',user:'guest',text:'A real chat-only line'});
    const state=(await app.inject('/api/state')).json();
    assert.equal(state.pendingPanels.length,0);assert.equal(state.panels.length,0);
    const capture=await app.inject({method:'POST',url:'/api/watch/start',headers:{cookie},payload:{channel:'chat_reader',duration:120}});
    assert.equal(capture.statusCode,403,'other-channel video capture still requires Viewer');
  }finally{await app.close();}
});
