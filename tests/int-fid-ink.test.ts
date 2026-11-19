import assert from 'node:assert/strict';
import test from 'node:test';
import {eventBus,type StreamEvent} from '@comictoons/core';
import {Studio} from '../apps/server/src/studio.ts';
import {createDirectAdapter} from '../scripts/s2-replay-core.ts';

for(const path of ['irc','bus'] as const){
  test(`INT-FID-T12-OPTED-OUT: !ink never re-admits an opted-out viewer (${path})`,()=>{
    const direct=createDirectAdapter();let clock=0;
    const studio=new Studio({adapterFactory:()=>direct.adapter,now:()=>clock});
    const send=(event:StreamEvent)=>{clock=event.t*1000;if(path==='irc')direct.push(event);else eventBus.emit('stream-event',event);};
    try{
      studio.useSource('twitch','approved_test');direct.push({id:'anchor',t:0,type:'chat',user:'anchor',text:'anchor stays'});
      send({id:'out',t:61,type:'chat',user:'private-user',text:'!optout'});
      send({id:'ink',t:62,type:'chat',user:'private-user',text:'!ink'});
      send({id:'after',t:63,type:'chat',user:'private-user',text:'must remain private'});
      const inner=studio as unknown as {deniedUsers:Set<string>};
      assert.equal(inner.deniedUsers.has('private-user'),true);
      assert.doesNotMatch(JSON.stringify(studio.state),/must remain private|!ink/);
    }finally{studio.close();}
  });
  test(`INT-FID-T12-COMMANDS: ink command lines never enter moment windows or panels (${path})`,()=>{
    const direct=createDirectAdapter();let clock=0;
    const studio=new Studio({adapterFactory:()=>direct.adapter,now:()=>clock,momentConfig:{spikeMinCount:1,spikeMinUsers:1,spikeWarmupSeconds:0,cooldownSeconds:0}});
    try{
      studio.useSource('twitch','approved_test');direct.push({id:'anchor',t:0,type:'chat',user:'anchor',text:'anchor stays'});
      const inner=studio as unknown as {moments:{chatTimes:{id?:string}[];recentChat:StreamEvent[];tokenUses:unknown[];open?:unknown;completed:unknown[]}};
      const before=JSON.stringify(inner.moments);
      for(const [i,text]of ['!ink','!ink yes','!ink no','!INK\tyes','!INK\tno'].entries()){
        clock=(i+1)*1000;const event:StreamEvent={id:`ink-command-${i}`,t:i+1,type:'chat',user:'moderator-user',moderator:true,text};
        if(path==='irc')direct.push(event);else eventBus.emit('stream-event',event);
      }
      assert.equal(JSON.stringify(inner.moments),before,'even a one-message spike threshold never counts an ink command');
      assert.doesNotMatch(JSON.stringify(studio.state),/ink-command-|!ink/i);
    }finally{studio.close();}
  });
}
