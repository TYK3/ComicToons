import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import type {AddressInfo,Socket} from 'node:net';
import {createEventBus,type ComicToonsBusEvents,type StreamEvent} from '../packages/core/src/index.ts';
import {EventSubClient,EVENTSUB_URL} from '../apps/server/src/eventsub/client.ts';
import {comicToonsSubscriptions} from '../apps/server/src/eventsub/subscriptions.ts';
import {mapNotification} from '../apps/server/src/eventsub/map.ts';
import {createSubscriptionCreator,EventSubSubscribeError} from '../apps/server/src/eventsub/subscribe.ts';
import {connectWebSocket,decodeFrames,encodeFrame} from '../apps/server/src/eventsub/socket.ts';
import {startEventSubBridge} from '../apps/server/src/eventsub/bridge.ts';
import type {ParticipationEvent} from '../apps/server/src/participation/commands.ts';
import {FAKE_TOKEN,FakeClock,fakeAuth,flush,keepalive,notification,reconnect,recordingCreator,revocation,socketFactory,welcome} from './eventsub-fakes.ts';

// Hermetic: fake sockets, fake clock, fake fetch, and one loopback WebSocket server. No Twitch calls.
function client(options:{keepaliveGraceMs?:number}={}){
  const clock=new FakeClock();const {sockets,factory}=socketFactory();const creator=recordingCreator();
  const notes:{type:string;event:unknown;id:string}[]=[];const revoked:unknown[]=[];const subscribed:{sessionId:string;first:boolean}[]=[];
  const subject=new EventSubClient({socketFactory:factory,timers:clock,now:()=>clock.now,creator,subscriptions:()=>comicToonsSubscriptions('1337'),
    onNotification:(type,event,id)=>notes.push({type,event,id}),onRevocation:entry=>revoked.push(entry),onSubscribed:info=>subscribed.push(info),
    keepaliveGraceMs:options.keepaliveGraceMs??1000,backoffMs:()=>1000});
  return {clock,sockets,creator,notes,revoked,subscribed,subject};
}

test('eventsub P0-4 welcome: connects to the default URL and subscribes on session_welcome before 10 s pass', async () => {
  const c=client();c.subject.start();
  assert.equal(c.sockets.length,1);assert.equal(c.sockets[0]!.url,EVENTSUB_URL);assert.equal(EVENTSUB_URL,'wss://eventsub.wss.twitch.tv/ws');
  c.sockets[0]!.send(welcome('session-a',10));await flush();
  assert.equal(c.clock.now,1_000_000,'no simulated time passed: subscriptions go out at once, well inside the 10 s window');
  assert.equal(c.creator.calls.length,comicToonsSubscriptions('1337').length);
  assert.ok(c.creator.calls.every(call=>call.sessionId==='session-a'));
  const status=c.subject.status();
  assert.equal(status.state,'subscribed');assert.equal(status.keepaliveSeconds,10);
  assert.ok(status.subscribed.includes('channel.raid')&&status.subscribed.includes('stream.online'));
  assert.deepEqual(c.subscribed,[{sessionId:'session-a',first:true}]);
  c.subject.stop();
});

test('eventsub P0-4 injectable URL: a test server address is used as given', () => {
  const {sockets,factory}=socketFactory();
  const subject=new EventSubClient({url:'ws://127.0.0.1:8080/ws',socketFactory:factory,creator:recordingCreator(),subscriptions:()=>[],onNotification:()=>{},timers:new FakeClock()});
  subject.start();assert.equal(sockets[0]!.url,'ws://127.0.0.1:8080/ws');subject.stop();
});

test('eventsub P0-4 keepalive timeout: silence past keepalive_timeout_seconds reconnects and resubscribes', async () => {
  const c=client();c.subject.start();
  c.sockets[0]!.send(welcome('session-a',10));await flush();
  c.clock.advance(8000);c.sockets[0]!.send(keepalive());
  c.clock.advance(8000);assert.equal(c.sockets.length,1,'a keepalive resets the timer');
  c.sockets[0]!.send(notification('channel.raid',{from_broadcaster_user_name:'Moon',viewers:3}));
  c.clock.advance(10_500);assert.equal(c.sockets.length,1,'a notification resets the timer too');
  c.clock.advance(600);// 11.1 s of silence > 10 s + 1 s grace
  assert.equal(c.sockets[0]!.closedWith,1000,'the lost socket is closed');
  assert.equal(c.subject.status().state,'reconnecting');
  c.clock.advance(1000);assert.equal(c.sockets.length,2);assert.equal(c.sockets[1]!.url,EVENTSUB_URL);
  c.sockets[1]!.send(welcome('session-b',10));await flush();
  const perSession=comicToonsSubscriptions('1337').length;
  assert.equal(c.creator.calls.length,perSession*2,'every subscription is created again on the new session');
  assert.ok(c.creator.calls.slice(perSession).every(call=>call.sessionId==='session-b'));
  assert.equal(c.subject.status().reconnects,1);
  assert.deepEqual(c.subscribed.map(entry=>entry.first),[true,false]);
  c.subject.stop();
});

test('eventsub P0-4 session_reconnect: opens reconnect_url as is, keeps the old socket until the new welcome, no resubscribe', async () => {
  const c=client();c.subject.start();
  c.sockets[0]!.send(welcome('session-a',10));await flush();
  const before=c.creator.calls.length;
  const url='wss://eventsub.wss.twitch.tv/ws?challenge=Abc%2Bdef&x=1';
  c.sockets[0]!.send(reconnect('session-a',url));
  assert.equal(c.sockets.length,2);assert.equal(c.sockets[1]!.url,url,'URL used unmodified');
  assert.equal(c.sockets[0]!.closedWith,undefined,'old socket stays open');
  c.sockets[0]!.send(notification('channel.cheer',{is_anonymous:false,user_id:'1',user_name:'A',message:'hi',bits:100}));
  assert.equal(c.notes.length,1,'old socket still delivers until the swap');
  c.sockets[1]!.send(welcome('session-b',10));await flush();
  assert.equal(c.sockets[0]!.closedWith,1000,'old socket closed after the new welcome');
  assert.equal(c.creator.calls.length,before,'subscriptions carry over; none created again');
  assert.equal(c.subject.status().sessionId,'session-b');
  c.sockets[0]!.send(notification('channel.raid',{from_broadcaster_user_name:'Late',viewers:1}));
  assert.equal(c.notes.length,1,'nothing is read from the old socket after the swap');
  c.sockets[1]!.send(notification('channel.raid',{from_broadcaster_user_name:'New',viewers:1}));
  assert.equal(c.notes.length,2);
  c.subject.stop();
});

test('eventsub P0-4 session_reconnect failure: a 4007 on the new socket falls back to a fresh connection', async () => {
  const c=client();c.subject.start();c.sockets[0]!.send(welcome('session-a'));await flush();
  c.sockets[0]!.send(reconnect('session-a','wss://bad.example/ws'));
  c.sockets[1]!.serverClose(4007,'Invalid reconnect');
  assert.equal(c.sockets.length,2,'old socket still healthy, nothing else opened yet');
  c.sockets[0]!.serverClose(4004,'Reconnect grace time expired');
  c.clock.advance(1000);
  assert.equal(c.sockets.length,3);assert.equal(c.sockets[2]!.url,EVENTSUB_URL);
  c.subject.stop();
});

test('eventsub P0-4 revocation: recorded with its reason and dropped from the subscribed list', async () => {
  const c=client();c.subject.start();c.sockets[0]!.send(welcome('session-a'));await flush();
  c.sockets[0]!.send(revocation('channel.cheer','authorization_revoked'));
  assert.equal(c.revoked.length,1);
  const status=c.subject.status();
  assert.equal(status.revoked[0]!.type,'channel.cheer');assert.equal(status.revoked[0]!.status,'authorization_revoked');
  assert.ok(!status.subscribed.includes('channel.cheer'));
  assert.match(status.lastError!,/sign in to Twitch again/);
  c.subject.stop();
});

test('eventsub P0-4 welcome timeout and 4003 close both lead to a reconnect; duplicate message ids are processed once', async () => {
  const c=client();c.subject.start();
  c.clock.advance(10_000);assert.equal(c.sockets[0]!.closedWith,1000,'no welcome in 10 s');
  c.clock.advance(1000);assert.equal(c.sockets.length,2);
  c.sockets[1]!.send(welcome('session-b'));await flush();
  const twice=notification('channel.raid',{from_broadcaster_user_name:'Dup',viewers:2},'1','same-id');
  c.sockets[1]!.send(twice);c.sockets[1]!.send(twice);
  assert.equal(c.notes.length,1);
  c.sockets[1]!.serverClose(4003,'Connection unused');c.clock.advance(1000);
  assert.equal(c.sockets.length,3);
  c.subject.stop();
  assert.equal(c.subject.status().state,'stopped');
});

test('eventsub P0-4 subscriptions: types, versions, conditions and scopes match the live subscription-types page', () => {
  const list=comicToonsSubscriptions('1337','1337');
  const byType=Object.fromEntries(list.map(entry=>[entry.type,entry]));
  assert.deepEqual(byType['channel.raid']!.condition,{to_broadcaster_user_id:'1337'});
  assert.equal(byType['channel.raid']!.version,'1');
  assert.equal(byType['channel.hype_train.begin']!.version,'2');assert.equal(byType['channel.hype_train.end']!.version,'2');
  assert.deepEqual(byType['channel.chat.message']!.condition,{broadcaster_user_id:'1337',user_id:'1337'});
  assert.deepEqual(byType['stream.online']!,{type:'stream.online',version:'1',condition:{broadcaster_user_id:'1337'},scopes:[]});
  for(const type of ['channel.cheer','channel.channel_points_custom_reward_redemption.add','channel.poll.begin','channel.poll.progress','channel.poll.end','channel.prediction.begin','channel.prediction.progress','channel.prediction.lock','channel.prediction.end','channel.chat.message_delete'])assert.ok(byType[type],type);
  assert.ok(list.length<=300,'per-connection limit');
});

// ---- P0-5 mapping: one test per notification type ----
const map=(type:string,event:Record<string,unknown>)=>{const mapped=mapNotification(type,event,'m-1',12);assert.ok(mapped&&mapped.kind==='stream-event',type);return mapped.event as ParticipationEvent;};
test('eventsub P0-5 map channel.chat.message: chat StreamEvent with the chat message id, badges and moderator flag', () => {
  const event=map('channel.chat.message',{chatter_user_id:'4145994',chatter_user_login:'viewer32',chatter_user_name:'viewer32',message_id:'cc106a89',message:{text:'!1'},badges:[{set_id:'moderator',id:'1',info:''}]});
  assert.deepEqual(event,{id:'cc106a89',t:12,type:'chat',user:'4145994',name:'viewer32',text:'!1',badges:['moderator'],moderator:true,broadcaster:undefined});
});
test('eventsub P0-5 map channel.chat.message_delete: withdraws that message', () => {
  const event=map('channel.chat.message_delete',{target_user_id:'7734',message_id:'ab24e0b0'});
  assert.equal(event.withdraw,'message');assert.equal(event.targetId,'ab24e0b0');
});
test('eventsub P0-5 map channel.raid: raid with raider name and viewers', () => {
  const event=map('channel.raid',{from_broadcaster_user_id:'1234',from_broadcaster_user_name:'Cool_User',to_broadcaster_user_id:'1337',viewers:9001});
  assert.deepEqual(event,{id:'m-1',t:12,type:'raid',from:'Cool_User',viewers:9001});
});
test('eventsub P0-5 map channel.cheer: cheer with bits as level; anonymous cheers carry no user', () => {
  assert.deepEqual(map('channel.cheer',{is_anonymous:false,user_id:'1234',user_name:'Cool_User',message:'pogchamp',bits:1000}),{id:'m-1',t:12,type:'cheer',user:'1234',name:'Cool_User',text:'pogchamp',level:1000});
  const anonymous=map('channel.cheer',{is_anonymous:true,user_id:null,user_name:null,message:'',bits:5});
  assert.equal(anonymous.user,undefined);assert.equal(anonymous.name,'Anonymous');
});
test('eventsub P0-5 map channel.channel_points_custom_reward_redemption.add: redemption with reward id', () => {
  const event=map('channel.channel_points_custom_reward_redemption.add',{id:'17fa',user_id:'9001',user_login:'cooler_user',user_name:'Cooler_User',user_input:'pogchamp',status:'unfulfilled',reward:{id:'92af',title:'Ink me',cost:500}});
  assert.equal(event.type,'redemption');assert.deepEqual(event.redemption,{id:'17fa',rewardId:'92af',userLogin:'cooler_user'});assert.equal(event.user,'9001');
});
test('eventsub P0-5 map channel.poll.begin/progress/end: poll with votes; end status upper-cased', () => {
  const choices=[{id:'123',title:'Blue',votes:120},{id:'124',title:'Yellow',votes:140}];
  assert.equal(map('channel.poll.begin',{id:'p1',title:'Q',choices}).poll!.status,'ACTIVE');
  const progress=map('channel.poll.progress',{id:'p1',title:'Q',choices});
  assert.deepEqual(progress.poll,{id:'p1',status:'ACTIVE',choices:[{id:'123',title:'Blue',votes:120},{id:'124',title:'Yellow',votes:140}]});
  for(const [raw,expected] of [['completed','COMPLETED'],['terminated','TERMINATED'],['archived','ARCHIVED']] as const)assert.equal(map('channel.poll.end',{id:'p1',title:'Q',choices,status:raw}).poll!.status,expected);
});
test('eventsub P0-5 map channel.prediction.begin/progress/lock/end: prediction on the StreamEvent path', () => {
  const outcomes=[{id:'o1',title:'Yes',users:2},{id:'o2',title:'No',users:3}];
  const begin=map('channel.prediction.begin',{id:'pr',title:'Will they make it?',outcomes});
  assert.equal(begin.type,'hype');assert.equal(begin.prediction!.status,'ACTIVE');
  const progress=map('channel.prediction.progress',{id:'pr',title:'T',outcomes});
  assert.equal(progress.type,'moment','progress does not open a moment');assert.equal(progress.prediction!.outcomes[1]!.users,3);
  assert.equal(map('channel.prediction.lock',{id:'pr',title:'T',outcomes}).prediction!.status,'LOCKED');
  const end=map('channel.prediction.end',{id:'pr',title:'T',outcomes,winning_outcome_id:'o1',status:'resolved'});
  assert.equal(end.type,'hype');assert.equal(end.prediction!.status,'RESOLVED');assert.equal(end.prediction!.winningOutcomeId,'o1');
  assert.equal(map('channel.prediction.end',{id:'pr',title:'T',outcomes,status:'canceled'}).prediction!.status,'CANCELED');
});
test('eventsub P0-5 map channel.hype_train.begin/end v2: hype_train_begin and hype_train_end with level', () => {
  assert.deepEqual(map('channel.hype_train.begin',{id:'h',level:2,total:137}),{id:'m-1',t:12,type:'hype_train_begin',level:2});
  assert.equal(map('channel.hype_train.end',{id:'h',level:3}).type,'hype_train_end');
});
test('eventsub N8 map stream.online: becomes a stream-online signal, not a StreamEvent', () => {
  assert.deepEqual(mapNotification('stream.online',{id:'9001',broadcaster_user_id:'1337',type:'live',started_at:'2020-10-11T10:11:12.123Z'},'m-1',0),{kind:'stream-online',payload:{id:'9001',startedAt:'2020-10-11T10:11:12.123Z',broadcasterId:'1337'}});
  assert.equal(mapNotification('channel.follow',{},'m',0),null,'unknown types are ignored');
});

test('eventsub P0-5 bridge: notifications reach the bus as stream-event, stream.online as stream-online, twitch-connected once', async () => {
  const clock=new FakeClock();const {sockets,factory}=socketFactory();const bus=createEventBus<ComicToonsBusEvents>();
  const events:StreamEvent[]=[];const online:unknown[]=[];const connected:unknown[]=[];
  bus.on('stream-event',event=>events.push(event));bus.on('stream-online',payload=>online.push(payload));bus.on('twitch-connected',payload=>connected.push(payload));
  const bridge=startEventSubBridge({auth:fakeAuth(),bus,socketFactory:factory,timers:clock,now:()=>clock.now,creator:recordingCreator(),backoffMs:()=>1000});
  await flush();
  sockets[0]!.send(welcome('s1'));await flush();
  clock.advance(5000);
  sockets[0]!.send(notification('channel.raid',{from_broadcaster_user_name:'Moon',viewers:42}));
  sockets[0]!.send(notification('stream.online',{id:'1',broadcaster_user_id:'1337',type:'live',started_at:'2026-10-31T02:00:00Z'}));
  assert.equal(events.length,1);assert.equal(events[0]!.type,'raid');assert.equal(events[0]!.t,5,'t is seconds since the bridge started');
  assert.equal(online.length,1);assert.deepEqual(connected,[{source:'eventsub'}]);
  sockets[0]!.serverClose(4000);clock.advance(1000);sockets[1]!.send(welcome('s2'));await flush();
  assert.equal(connected.length,1,'a reconnect does not announce a second connection');
  assert.equal(JSON.stringify(bridge.status()).includes(FAKE_TOKEN),false,'status never carries the token');
  bridge.stop();
});

test('eventsub bridge: not signed in means no socket is opened', async () => {
  const {sockets,factory}=socketFactory();
  const bridge=startEventSubBridge({auth:fakeAuth({signedIn:false}),bus:createEventBus<ComicToonsBusEvents>(),socketFactory:factory,timers:new FakeClock(),creator:recordingCreator()});
  await flush();assert.equal(sockets.length,0);assert.equal(bridge.status().signedIn,false);bridge.stop();
});

// ---- Create EventSub Subscription over Helix (fake fetch) ----
function fakeFetch(responses:{status:number;body?:unknown;headers?:Record<string,string>}[]){
  const calls:{url:string;init:RequestInit}[]=[];
  const fn=(async(url:string,init:RequestInit)=>{calls.push({url,init});const next=responses.shift()!;return new Response(next.body===undefined?null:JSON.stringify(next.body),{status:next.status,headers:next.headers});}) as unknown as typeof fetch;
  return {fn,calls};
}
const input={type:'channel.raid',version:'1',condition:{to_broadcaster_user_id:'1337'},sessionId:'session-a'};
test('eventsub subscribe: POSTs a websocket transport with the user token and returns the id (202)', async () => {
  const f=fakeFetch([{status:202,body:{data:[{id:'sub-1'}]}}]);
  const creator=createSubscriptionCreator({auth:fakeAuth(),fetch:f.fn});
  assert.deepEqual(await creator.createEventSubSubscription(input),{id:'sub-1'});
  assert.equal(f.calls[0]!.url,'https://api.twitch.tv/helix/eventsub/subscriptions');
  const headers=f.calls[0]!.init.headers as Record<string,string>;
  assert.equal(headers.Authorization,`Bearer ${FAKE_TOKEN}`);assert.equal(headers['Client-Id'],'client-fake');
  assert.deepEqual(JSON.parse(String(f.calls[0]!.init.body)),{type:'channel.raid',version:'1',condition:{to_broadcaster_user_id:'1337'},transport:{method:'websocket',session_id:'session-a'}});
});
test('eventsub subscribe 401: refreshes once and retries once with the new token; a second 401 fails without the token in the message', async () => {
  const auth=fakeAuth();const f=fakeFetch([{status:401},{status:202,body:{data:[{id:'sub-2'}]}}]);
  assert.deepEqual(await createSubscriptionCreator({auth,fetch:f.fn}).createEventSubSubscription(input),{id:'sub-2'});
  assert.equal(auth.refreshes,1);assert.match((f.calls[1]!.init.headers as Record<string,string>).Authorization,/refreshed$/);
  const auth2=fakeAuth();const g=fakeFetch([{status:401},{status:401,body:{message:'Invalid OAuth token'}}]);
  await assert.rejects(createSubscriptionCreator({auth:auth2,fetch:g.fn}).createEventSubSubscription(input),(error:Error)=>error instanceof EventSubSubscribeError&&error.status===401&&!error.message.includes(FAKE_TOKEN));
  assert.equal(auth2.refreshes,1,'only one refresh');assert.equal(g.calls.length,2,'only one retry');
});
test('eventsub subscribe 403: a missing scope is reported, not retried', async () => {
  const f=fakeFetch([{status:403,body:{message:'subscription missing proper authorization'}}]);
  await assert.rejects(createSubscriptionCreator({auth:fakeAuth(),fetch:f.fn}).createEventSubSubscription(input),/missing a permission/);
  assert.equal(f.calls.length,1);
});
test('eventsub subscribe 429: waits until Ratelimit-Reset, then retries once', async () => {
  const waits:number[]=[];const now=1_700_000_000_000;
  const f=fakeFetch([{status:429,headers:{'Ratelimit-Reset':String(now/1000+3)}},{status:202,body:{data:[{id:'sub-3'}]}}]);
  const creator=createSubscriptionCreator({auth:fakeAuth(),fetch:f.fn,now:()=>now,sleep:async ms=>{waits.push(ms);}});
  assert.deepEqual(await creator.createEventSubSubscription(input),{id:'sub-3'});
  assert.deepEqual(waits,[3000]);
  const g=fakeFetch([{status:429,headers:{'Ratelimit-Reset':String(now/1000+3600)}}]);
  await assert.rejects(createSubscriptionCreator({auth:fakeAuth(),fetch:g.fn,now:()=>now,sleep:async()=>{}}).createEventSubSubscription(input),/rate limiting/);
});
test('eventsub subscribe 409: an existing subscription counts as done', async () => {
  const f=fakeFetch([{status:409,body:{error:'Conflict',status:409,message:'subscription already exists'}}]);
  assert.deepEqual(await createSubscriptionCreator({auth:fakeAuth(),fetch:f.fn}).createEventSubSubscription(input),{id:'existing'});
});

// ---- The real socket against a loopback RFC 6455 server ----
test('eventsub socket: frames round-trip, large payloads use extended lengths', () => {
  const text=Buffer.from('x'.repeat(70_000));
  const {frames,rest}=decodeFrames(Buffer.concat([encodeFrame(0x1,Buffer.from('hi'),false),encodeFrame(0x1,text,true)]));
  assert.equal(rest.length,0);assert.equal(frames[0]!.payload.toString(),'hi');assert.equal(frames[1]!.payload.length,70_000);
  const partial=decodeFrames(encodeFrame(0x1,Buffer.from('hello'),false).subarray(0,4));
  assert.equal(partial.frames.length,0);assert.equal(partial.rest.length,4);
});
test('eventsub socket: handshake, text frames, Ping answered with a Pong, server close code reported', async () => {
  const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const received:{opcode:number;payload:string}[]=[];
  const server=createServer((_req,res)=>{res.writeHead(426);res.end();});
  server.on('upgrade',(req,socket:Socket)=>{
    const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(encodeFrame(0x1,Buffer.from(JSON.stringify(welcome('loop-1'))),false));
    socket.write(encodeFrame(0x9,Buffer.from('ping!'),false));
    let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);const decoded=decodeFrames(buffer);buffer=Buffer.from(decoded.rest);
      for(const frame of decoded.frames){
        received.push({opcode:frame.opcode,payload:frame.payload.toString()});
        if(frame.opcode===0xA){const body=Buffer.alloc(2);body.writeUInt16BE(4003);socket.write(encodeFrame(0x8,Buffer.concat([body,Buffer.from('Connection unused')]),false));}
      }
    });
    socket.on('error',()=>{});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address() as AddressInfo;
  const messages:string[]=[];
  const closed=await new Promise<{code:number;reason:string}>((resolve,reject)=>{
    const socket=connectWebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.onmessage=text=>messages.push(text);
    socket.onerror=reject;
    socket.onclose=(code,reason)=>resolve({code,reason});
  });
  server.close();server.closeAllConnections?.();
  assert.equal(JSON.parse(messages[0]!).payload.session.id,'loop-1');
  assert.deepEqual(received[0],{opcode:0xA,payload:'ping!'},'the only thing the client sent first was a Pong');
  assert.equal(closed.code,4003);assert.equal(closed.reason,'Connection unused');
  assert.ok(received.slice(1).every(frame=>frame.opcode===0x8),'after that only a Close reply');
});
test('eventsub socket: a refused handshake is reported as a close, not a crash', async () => {
  const server=createServer((_req,res)=>{res.writeHead(404);res.end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address() as AddressInfo;
  const code=await new Promise<number>(resolve=>{const socket=connectWebSocket(`ws://127.0.0.1:${port}/ws`);socket.onerror=()=>{};socket.onclose=c=>resolve(c);});
  server.close();assert.equal(code,1006);
  assert.throws(()=>connectWebSocket('https://example.invalid/ws'),/ws:\/\/ or wss:\/\//);
});
