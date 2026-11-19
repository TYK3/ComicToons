import assert from 'node:assert/strict';
import test from 'node:test';
import {eventBus,type StreamEvent} from '@comictoons/core';
import {chaosSource} from './ingest-chaos-fixture.ts';
import {notification} from './eventsub-fakes.ts';
import {liveAppFixture} from './twitch-live-app-fixture.ts';

const raidFrame=(id='irc-raid-1',from='TestChannel',viewers=15)=>`@id=${id};msg-id=raid;msg-param-displayName=${from};msg-param-login=testchannel;msg-param-viewerCount=${viewers} :tmi.twitch.tv USERNOTICE #approved_test\r\n`;

for(const first of ['irc','eventsub'] as const)test(`raw IRC USERNOTICE reaches Studio and participation once with a cross-transport duplicate (${first} first)`,async()=>{
  const irc=chaosSource();
  const f=await liveAppFixture({adapterFactory:()=>irc.adapter,env:{COMICTOONS_FLAG_CATCHUP:'1'}});
  const raids:StreamEvent[]=[],catchups:unknown[]=[];
  const offRaid=eventBus.on('stream-event',event=>{if(event.type==='raid')raids.push(event);});
  const offCatchup=eventBus.on('catchup',event=>{if((event as {reason?:string}).reason==='raid')catchups.push(event);});
  try{
    await f.startIRC();irc.welcome();irc.chat('warm','Chat establishes liveness.','viewer');
    await f.signIn();await f.welcome();irc.advance(2500);
    const eventsub=()=>f.sockets.at(-1)!.send(notification('channel.raid',{
      from_broadcaster_user_name:'TestChannel',viewers:15,
    },'1','eventsub-raid-1'));
    if(first==='irc'){irc.feed(raidFrame());eventsub();}else{eventsub();irc.feed(raidFrame());}
    irc.feed(raidFrame());eventsub();
    assert.equal(raids.length,1,'only one raid reaches the Studio/participation bus');
    if(first==='irc')assert.deepEqual(raids[0],{id:'irc-raid-1',t:2.5,type:'raid',from:'TestChannel',viewers:15});
    else assert.equal(raids[0].id,'eventsub-raid-1');
    const state=await f.state();
    assert.equal(state.source.received,1,'a raid never increments ordinary chat received');
    assert.equal(state.pendingPanels.filter((panel:{sfx?:string})=>panel.sfx==='RAID!').length,1,'the admitted bus raid opens one Studio moment');
    assert.equal(catchups.length,1,'participation catch-up sees the raid once');
    f.chat('live-proof');
    irc.feed(raidFrame('irc-raid-2','AnotherCrew',20));
    assert.equal(raids.length,1,'IRC raid is suppressed while EventSub chat owns delivery');
    f.sockets.at(-1)!.send(notification('channel.raid',{from_broadcaster_user_name:'AnotherCrew',viewers:20},'1','eventsub-raid-2'));
    assert.equal(raids.length,2);
    assert.equal(catchups.length,2);
  }finally{offRaid();offCatchup();await f.close();}
});
