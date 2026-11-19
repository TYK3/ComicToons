import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import type {StreamEvent} from '../packages/core/src/index.ts';
import {Studio} from '../apps/server/src/studio.ts';
import {chaosSource} from './ingest-chaos-fixture.ts';
import {eventBus} from '../packages/core/src/index.ts';

/** Seam: TwitchIrcAdapter.start callbacks over an injected local transport and virtual clock. */
function started(){
  const source=chaosSource(),events:StreamEvent[]=[],statuses:{status:string;retrying?:boolean}[]=[];
  source.adapter.start({event:event=>events.push(event),status:(status,retrying)=>statuses.push({status,retrying})});source.welcome();
  return {source,events,statuses};
}

test('IRC-NOTICE: an ordinary NOTICE logs one redacted line and keeps the chat socket open',()=>{
  const warn=mock.method(console,'warn',()=>{});
  const {source,events,statuses}=started();
  try{
    source.feed('@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #approved_test :This channel does not exist or has been suspended.\r\n');
    source.feed('@msg-id=delete_message_success :tmi.twitch.tv NOTICE #approved_test :The message from authnick is now deleted.\r\n');
    assert.equal(source.sockets.length,1);assert.equal(source.sockets[0]!.closed,false);
    assert.deepEqual(statuses,[{status:'connecting',retrying:undefined},{status:'empty',retrying:undefined}]);
    assert.equal(warn.mock.callCount(),2);
    const lines=warn.mock.calls.map(call=>call.arguments.join(' '));
    assert.deepEqual(lines,['[irc] NOTICE msg-id=msg_channel_suspended; staying connected','[irc] NOTICE msg-id=delete_message_success; staying connected']);
    source.chat('after-notice','Chat continues after a notice.');
    assert.deepEqual(events.map(event=>event.text),['Chat continues after a notice.']);
  }finally{source.adapter.stop();warn.mock.restore();}
});

test('IRC-NOTICE-AUTH: documented login-failure notices end the session without a retry',()=>{
  const warn=mock.method(console,'warn',()=>{});
  try{
    for(const text of ['Login authentication failed','Improperly formatted auth']){
      const source=chaosSource(),statuses:string[]=[];
      source.adapter.start({event:()=>{},status:status=>statuses.push(status)});source.sockets[0]!.handlers.open();
      source.feed(`:tmi.twitch.tv NOTICE * :${text}\r\n`);
      assert.equal(statuses.at(-1),'unauthenticated');assert.equal(source.sockets[0]!.closed,true);assert.equal(source.jobs,0);
      source.advance(600_000);assert.equal(source.sockets.length,1);
    }
    assert.equal(warn.mock.callCount(),2);
    assert.ok(warn.mock.calls.every(call=>call.arguments.join(' ')==='[irc] NOTICE msg-id=none; login failed, disconnecting'));
  }finally{warn.mock.restore();}
});

test('IRC-CLEARCHAT-ROOM: a whole-room clear withdraws every earlier unpublished line, keeps the approved panel, and is not an opt-out',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    source.chat('r1','First cleared line.','u');source.chat('r2','Second cleared line.','v');
    const approval=studio.moderate('approve');assert.equal(studio.state.panels.length,1);
    const published=structuredClone(studio.state.panels);
    source.drop();source.advance(1000);source.welcome();source.chat('r3','Third cleared line, new socket.','w');
    source.feed('@room-id=12345678;tmi-sent-ts=1642715695392 :tmi.twitch.tv CLEARCHAT #approved_test\r\n');
    // Young's ruling: published panels are never wiped by a room-wide clear.
    assert.deepEqual(studio.state.panels,published);
    assert.ok(!JSON.stringify(studio.state.pendingPanels).includes('Third cleared line'));
    assert.throws(()=>studio.undo(approval.undoToken),/expired/);
    source.advance(1000);source.chat('r4','After the clear.','u');
    assert.equal(studio.state.pendingPanels.length,1);assert.deepEqual(studio.state.pendingPanels[0]!.dialogue,['After the clear.']);
  }finally{studio.close();}
});

test('IRC-CLEARCHAT-SCOPE: only a room-wide clear marks its withdrawals with scope room',()=>{
  const source=chaosSource(),events:StreamEvent[]=[];
  source.adapter.start({event:event=>events.push(event),status:()=>{}});source.welcome();
  try{
    source.chat('a1','Line one.','u');source.chat('b1','Line two.','v');
    source.feed('@ban-duration=60;room-id=1;target-user-id=u;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test :sample\r\n');
    source.feed('@login=v;room-id=1;target-msg-id=b1;tmi-sent-ts=1 :tmi.twitch.tv CLEARMSG #approved_test :Line two.\r\n');
    source.chat('c1','Line three.','w');
    source.feed('@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test\r\n');
    assert.deepEqual(events.filter(event=>event.withdraw).map(event=>[event.targetId,event.scope]),[['a1',undefined],['b1',undefined],['c1','room']]);
  }finally{source.adapter.stop();}
});

test('IRC-CLEARCHAT-USER: a ban or timeout removes only that user\'s lines and other channels are ignored',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    source.chat('t1','Line from the timed-out viewer.','87654321');source.chat('t2','Line from a bystander.','v');
    source.feed('@room-id=1;target-user-id=87654321;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #another :ronni\r\n');
    source.feed('@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #another\r\n');
    assert.ok(JSON.stringify(studio.state).includes('Line from the timed-out viewer.'));
    source.feed('@ban-duration=350;room-id=1;target-user-id=87654321;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test :ronni\r\n');
    const json=JSON.stringify(studio.state);
    assert.ok(!json.includes('Line from the timed-out viewer.'));assert.ok(json.includes('Line from a bystander.'));
  }finally{studio.close();}
});

test('IRC-CLEARCHAT-SURVIVOR-BAN: a ban after an earlier room-wide clear still removes the line from the published panel it spared',()=>{
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  try{
    studio.useSource('twitch','approved_test');source.welcome();
    source.chat('p1','Line from banned user.','badguy');
    studio.moderate('approve');
    assert.ok(JSON.stringify(studio.state.panels).includes('Line from banned user.'));
    source.feed('@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test\r\n');
    // Young's ruling: the room-wide clear spares the published panel.
    assert.ok(JSON.stringify(studio.state.panels).includes('Line from banned user.'));
    source.feed('@ban-duration=600;room-id=1;target-user-id=badguy;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test :badguy\r\n');
    assert.ok(!JSON.stringify(studio.state.panels).includes('Line from banned user.'),
      'a targeted ban must still remove the line, even from a panel that an earlier room clear spared');
  }finally{studio.close();}
});

const RAID_FRAME='@badge-info=;badges=turbo/1;color=#9ACD32;display-name=TestChannel;emotes=;id=3d830f12-795c-447d-af3c-ea05e40fbddb;login=testchannel;mod=0;msg-id=raid;msg-param-displayName=TestChannel;msg-param-login=testchannel;msg-param-viewerCount=15;room-id=33332222;subscriber=0;system-msg=15\\sraiders\\sfrom\\sTestChannel\\shave\\sjoined\\n!;tmi-sent-ts=1507246572675;turbo=1;user-id=123456;user-type= :tmi.twitch.tv USERNOTICE #approved_test\r\n';

test('IRC-RAID: USERNOTICE msg-id=raid becomes the same raid StreamEvent shape as the EventSub normaliser',()=>{
  const {source,events}=started();
  try{
    source.advance(2500);
    source.feed(RAID_FRAME.replace('#approved_test','#another'));
    source.feed(RAID_FRAME.replace('msg-id=raid','msg-id=resub'));
    source.feed(RAID_FRAME.replace('msg-param-viewerCount=15','msg-param-viewerCount=lots'));
    source.feed(RAID_FRAME);
    assert.deepEqual(events,[{id:'3d830f12-795c-447d-af3c-ea05e40fbddb',t:2.5,type:'raid',from:'TestChannel',viewers:15}]);
    source.feed(RAID_FRAME.replace('msg-param-displayName=TestChannel','msg-param-displayName=<b>Evil</b>').replace('id=3d830f12','id=4d830f12'));
    assert.equal(events[1]!.from,'Evil');
  }finally{source.adapter.stop();}
});

test('IRC-RAID-AUTH: a raid notice before the welcome is ignored',()=>{
  const source=chaosSource(),events:StreamEvent[]=[];
  source.adapter.start({event:event=>events.push(event),status:()=>{}});source.sockets[0]!.handlers.open();
  source.feed(RAID_FRAME);assert.deepEqual(events,[]);source.adapter.stop();
});

/** Drives a KEKW burst moment through chat only, with virtual time. */
function burstStudio(){
  const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
  studio.useSource('twitch','approved_test');source.welcome();
  for(let s=0;s<40;s++){source.chat(`base-${s}`,`baseline line ${s}`,`viewer-${s%8}`);source.advance(1000);}
  for(let i=0;i<4;i++){source.chat(`kekw-${i}`,'KEKW',`fan-${i}`);source.advance(500);}
  const all=()=>[...studio.state.panels,...studio.state.pendingPanels];
  return {source,studio,all};
}

test('IRC-CLEARCHAT-MOMENT: a whole-room clear drops the cleared lines from moment panels',()=>{
  const {source,studio,all}=burstStudio();
  try{
    assert.ok(all().some(panel=>panel.sfx==='SURGE!'),'a burst moment panel exists before the clear');
    source.feed('@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test\r\n');
    assert.equal(all().filter(panel=>panel.sfx==='SURGE!').length,0);
    assert.ok(all().every(panel=>!(panel.sources??[]).some(id=>/^(?:kekw|base)-/.test(id))),'no panel cites a cleared line');
    const json=JSON.stringify(studio.state);assert.ok(!json.includes('KEKW'));assert.ok(!json.includes('baseline line'));
  }finally{studio.close();}
});

test('IRC-CLEARCHAT-MOMENT-USER: a timeout removes only that user\'s line from a moment panel',()=>{
  const {source,studio,all}=burstStudio();
  try{
    const before=all().find(panel=>panel.sfx==='SURGE!')!;
    assert.ok(before.sources!.includes('kekw-0')&&before.sources!.includes('kekw-3'));
    source.feed('@ban-duration=60;room-id=1;target-user-id=fan-0;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test :fan0\r\n');
    const sources=all().flatMap(panel=>panel.sources??[]);
    assert.ok(!sources.includes('kekw-0'));
    for(const id of ['kekw-1','kekw-2','kekw-3'])assert.ok(sources.includes(id),id);
  }finally{studio.close();}
});

test('IRC-CLEARCHAT-OPTIN: a timed-out or banned user is never opted out; only their earlier lines are dropped',()=>{
  for(const frame of ['@ban-duration=600;room-id=1;target-user-id=87654321;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test :ronni\r\n',
    '@room-id=1;target-user-id=87654321;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test :ronni\r\n']){
    const {source,events}=started();
    try{
      source.chat('before','Line before the clear.','87654321');events.length=0;
      source.feed(frame);
      assert.deepEqual(events.map(event=>[event.withdraw,event.targetId,event.text]),[['message','before','']]);
      assert.ok(!events.some(event=>event.text==='!optout'));
    }finally{source.adapter.stop();}
    const chaos=chaosSource(),studio=new Studio({adapterFactory:()=>chaos.adapter,now:chaos.now});
    try{
      studio.useSource('twitch','approved_test');chaos.welcome();
      chaos.chat('before','Line before the clear.','87654321');chaos.chat('bystander','Bystander line.','v');
      chaos.feed(frame);
      assert.ok(!JSON.stringify(studio.state).includes('Line before the clear.'));
      chaos.chat('after','Line after the timeout or ban.','87654321');
      assert.ok(JSON.stringify(studio.state).includes('Line after the timeout or ban.'));
      assert.ok(JSON.stringify(studio.state).includes('Bystander line.'));
    }finally{studio.close();}
  }
});

test('IRC-MOMENT-FORGET: lines withdrawn by CLEARMSG, a room-wide CLEARCHAT or an opt-out stop counting towards a burst',()=>{
  const withdrawals:Record<string,(source:ReturnType<typeof chaosSource>)=>void>={
    clearmsg:source=>{for(const id of ['kekw-0','kekw-1'])source.feed(`@login=u;room-id=1;target-msg-id=${id};tmi-sent-ts=1 :tmi.twitch.tv CLEARMSG #approved_test :deleted\r\n`);},
    room:source=>source.feed('@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #approved_test\r\n'),
    optout:source=>{source.chat('out-0','!optout','fan-0');source.chat('out-1','!optout','fan-1');},
  };
  for(const [name,withdraw] of Object.entries(withdrawals)){
    const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
    try{
      studio.useSource('twitch','approved_test');source.welcome();
      for(let s=0;s<40;s++){source.chat(`base-${s}`,`baseline line ${s}`,`viewer-${s%8}`);source.advance(1000);}
      for(let i=0;i<2;i++){source.chat(`kekw-${i}`,'KEKW',`fan-${i}`);source.advance(500);}
      withdraw(source);source.advance(500);
      source.chat('kekw-2','KEKW','fan-2');
      const all=[...studio.state.panels,...studio.state.pendingPanels];
      assert.equal(all.filter(panel=>panel.sfx==='SURGE!').length,0,`${name}: no burst from withdrawn lines`);
      // Two more live voices still make a real burst.
      source.advance(500);source.chat('kekw-3','KEKW','fan-3');source.advance(500);source.chat('kekw-4','KEKW','fan-4');
      const surge=[...studio.state.panels,...studio.state.pendingPanels].filter(panel=>panel.sfx==='SURGE!');
      assert.equal(surge.length,1,`${name}: live lines still burst`);
      assert.ok(!(surge[0]!.sources??[]).some(id=>id==='kekw-0'||id==='kekw-1'),`${name}: no withdrawn citation`);
    }finally{studio.close();}
  }
});

test('IRC-MOMENT-FORGET-BUS: an opt-out arriving on the event bus also stops that user\'s lines counting towards a burst',()=>{
  for(const optOut of [false,true]){
    const source=chaosSource(),studio=new Studio({adapterFactory:()=>source.adapter,now:source.now});
    try{
      studio.useSource('twitch','approved_test');source.welcome();
      for(let s=0;s<40;s++){source.chat(`base-${s}`,`baseline line ${s}`,`viewer-${s%8}`);source.advance(1000);}
      for(let i=0;i<2;i++)eventBus.emit('stream-event',{id:`bus-kekw-${i}`,t:41+i/2,type:'chat',user:`bus-fan-${i}`,text:'KEKW'});
      if(optOut)for(let i=0;i<2;i++)eventBus.emit('stream-event',{id:`bus-out-${i}`,t:42,type:'chat',user:`bus-fan-${i}`,text:'!optout'});
      eventBus.emit('stream-event',{id:'bus-kekw-2',t:42.5,type:'chat',user:'bus-fan-2',text:'KEKW'});
      const surges=[...studio.state.panels,...studio.state.pendingPanels].filter(panel=>panel.sfx==='SURGE!').length;
      assert.equal(surges,optOut?0:1,optOut?'opted-out lines no longer burst':'control: three bus voices burst');
    }finally{studio.close();}
  }
});
