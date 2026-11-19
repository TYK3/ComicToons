import test from 'node:test';
import assert from 'node:assert/strict';
import type {StreamEvent} from '../packages/core/src/index.ts';
import {TwitchIrcAdapter,ANON_CHAT_FLAG,anonymousChatEnabled,withAnonymousFallback,type IrcTransportFactory} from '../apps/server/src/ingest/irc.ts';

/** Seam: TwitchIrcAdapter.start callbacks over an injected local transport and manual timers. */
function harness(authenticate:ConstructorParameters<typeof TwitchIrcAdapter>[0]['authenticate']){
  const sockets:{writes:string[];closed:boolean;handlers:Parameters<IrcTransportFactory>[0]}[]=[];
  // The last scheduled job after a drop is the retry; earlier ones are superseded watchdogs.
  const jobs:(()=>void)[]=[];
  const transport:IrcTransportFactory=handlers=>{const socket={writes:[] as string[],closed:false,handlers};sockets.push(socket);
    return {write:frame=>socket.writes.push(frame),close:()=>{socket.closed=true;}};};
  const events:StreamEvent[]=[],statuses:string[]=[];
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate,transport,now:()=>0,schedule:run=>{jobs.push(run);return ()=>{};}});
  adapter.start({event:event=>events.push(event),status:status=>statuses.push(status)});
  const feed=(frame:string)=>sockets.at(-1)!.handlers.data(frame);
  return {adapter,sockets,jobs,events,statuses,feed};
}
const READ_ONLY_ANON=/^(?:NICK justinfan\d{5}|CAP REQ :twitch\.tv\/tags twitch\.tv\/commands|JOIN #approved_test|PONG :[a-zA-Z0-9.:-]+)\r\n$/;

test('IRC-ANON-FLAG: only the exact value 1 enables anonymous chat; it is off by default',()=>{
  assert.equal(ANON_CHAT_FLAG,'COMICTOONS_TWITCH_ANON');
  assert.equal(anonymousChatEnabled({}),false);
  for(const value of ['','0','true','yes','on',' 1','1 ','01'])assert.equal(anonymousChatEnabled({[ANON_CHAT_FLAG]:value}),false,value);
  assert.equal(anonymousChatEnabled({[ANON_CHAT_FLAG]:'1'}),true);
});

test('IRC-ANON-OFF: with the flag off and no token, no socket opens and the status is unauthenticated',()=>{
  const {sockets,statuses}=harness(withAnonymousFallback(()=>undefined,anonymousChatEnabled({})));
  assert.equal(sockets.length,0);assert.deepEqual(statuses,['unauthenticated']);
});

test('IRC-ANON-ON: with the flag on and no token, the adapter logs in as justinfan without PASS and reads chat',()=>{
  const {adapter,sockets,events,statuses,feed}=harness(withAnonymousFallback(()=>undefined,anonymousChatEnabled({[ANON_CHAT_FLAG]:'1'})));
  try{
    assert.equal(sockets.length,1);sockets[0]!.handlers.open();
    assert.match(sockets[0]!.writes[0]!,/^NICK justinfan\d{5}\r\n$/);
    assert.deepEqual(sockets[0]!.writes.slice(1),['CAP REQ :twitch.tv/tags twitch.tv/commands\r\n']);
    const nick=sockets[0]!.writes[0]!.slice(5,-2);
    feed(`:tmi.twitch.tv 001 ${nick} :Welcome, GLHF!\r\n`);
    assert.equal(sockets[0]!.writes.at(-1),'JOIN #approved_test\r\n');assert.deepEqual(statuses,['connecting','empty']);
    feed('@id=anon-1;user-id=42;display-name=Viewer :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #approved_test :Hello from a real-looking line\r\n');
    assert.deepEqual(events.map(event=>[event.id,event.user,event.text]),[['anon-1','42','Hello from a real-looking line']]);
  }finally{adapter.stop();}
});

test('IRC-ANON-TOKEN: a signed-in token always wins over the anonymous flag, and is checked again at each retry',()=>{
  let token:string|undefined='oauth:mock_read_only';
  const {adapter,sockets,jobs,feed}=harness(withAnonymousFallback(()=>token?{username:'sample_bot',token}:undefined,true));
  try{
    sockets[0]!.handlers.open();
    assert.deepEqual(sockets[0]!.writes,['PASS oauth:mock_read_only\r\n','NICK sample_bot\r\n','CAP REQ :twitch.tv/tags twitch.tv/commands\r\n']);
    feed(':tmi.twitch.tv 001 sample_bot :Welcome, GLHF!\r\n');
    // The token is withdrawn (for example after sign-out); the next retry uses the anonymous identity.
    token=undefined;sockets[0]!.handlers.close();jobs.pop()!();
    sockets[1]!.handlers.open();
    assert.match(sockets[1]!.writes[0]!,/^NICK justinfan\d{5}\r\n$/);assert.ok(!sockets[1]!.writes.some(frame=>frame.startsWith('PASS')));
  }finally{adapter.stop();}
});

test('IRC-ANON-READONLY: anonymous mode only ever writes NICK, CAP, JOIN and PONG, never PASS or PRIVMSG',()=>{
  const {adapter,sockets,jobs,feed}=harness(withAnonymousFallback(undefined,true));
  try{
    for(let round=0;round<2;round++){
      const socket=sockets.at(-1)!;socket.handlers.open();const nick=socket.writes[0]!.slice(5,-2);
      feed(`:tmi.twitch.tv 001 ${nick} :Welcome, GLHF!\r\nPING :tmi.twitch.tv\r\n`);
      feed('@id=a;user-id=1 :a!a@a.tmi.twitch.tv PRIVMSG #approved_test :PRIVMSG #approved_test :echo me\r\n');
      feed('@msg-id=raid;msg-param-displayName=Raider;msg-param-viewerCount=5;id=r :tmi.twitch.tv USERNOTICE #approved_test\r\n');
      feed('@room-id=1 :tmi.twitch.tv CLEARCHAT #approved_test\r\n:tmi.twitch.tv RECONNECT\r\n');
      jobs.pop()?.();
    }
    const writes=sockets.flatMap(socket=>socket.writes);
    assert.ok(writes.length>=8);
    for(const frame of writes)assert.match(frame,READ_ONLY_ANON);
    assert.ok(!writes.some(frame=>/^(?:PASS|PRIVMSG|WHISPER)\b/.test(frame)));
    assert.deepEqual(Object.getOwnPropertyNames(TwitchIrcAdapter.prototype).filter(name=>name!=='constructor').sort(),['disconnect','start','stop']);
  }finally{adapter.stop();}
});

test('IRC-ANON-EXPLICIT: a hand-made justinfan identity without the opt-in helper is rejected',()=>{
  for(const identity of [{username:'justinfan12345',token:''},{username:'justinfan12345',token:'SCHMOOPIIE'}]){
    const {sockets,statuses}=harness(()=>identity);
    assert.equal(sockets.length,0);assert.deepEqual(statuses,['unauthenticated']);
  }
});
