import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHttpServer,type IncomingMessage} from 'node:http';
import {createServer as createTcpServer,connect as connectPlain,type Socket,type AddressInfo} from 'node:net';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {TwitchIrcAdapter,withAnonymousFallback,bindIrcSocket,wsIrcTransport,
  type IrcSchedule,type IrcStatus,type IrcTransportFactory} from '../apps/server/src/ingest/irc.ts';

// Written out independently of the exports, so a change to a constant cannot also change the expectation.
const IDLE_MS=60_000,DEADLINE_MS=15_000,FIFTEEN_MINUTES_MS=15*60_000,BOOTSTRAP_MS=600_000;
const OWN_PING='PING :tmi.twitch.tv';
const WELCOME=':tmi.twitch.tv 001 justinfan12345 :Welcome, GLHF!\r\n';
const PONG_REPLY=':tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv\r\n';
const CHAT='@id=live-1;user-id=42;mod=0 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #approved_test :still here\r\n';
/** Everything this read-only anonymous client may ever send, the liveness PING included. */
const READ_ONLY_ANON=/^(?:NICK justinfan\d{5}|CAP REQ :twitch\.tv\/tags twitch\.tv\/commands|JOIN #approved_test|PONG :[a-zA-Z0-9.:-]+|PING :tmi\.twitch\.tv)$/;

type Mode='silent'|'answer';
type Link={lines:string[];send:(text:string)=>void;alive:boolean};
/** Fake timers: virtual time drives every adapter timer, while real loopback sockets carry the bytes. */
function virtualClock(){
  let time=0,sequence=0;const jobs=new Map<number,{at:number;run:()=>void}>();const delays:number[]=[];
  const schedule:IrcSchedule=(run,delay)=>{delays.push(delay);const id=++sequence;jobs.set(id,{at:time+delay,run});return ()=>{jobs.delete(id);};};
  // Long enough to cover a delayed ACK on loopback, so a frame written by a job has landed before the next step.
  const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,12));};
  return {now:()=>time,schedule,delays,
    /** Advances in steps, firing due jobs at their exact virtual time and letting socket I/O settle after each job or fake-side send. */
    async advance(ms:number,step=1000,each?:()=>boolean){
      const end=time+ms;
      while(time<end){
        const target=Math.min(end,time+step);
        for(;;){
          const next=[...jobs].filter(([,job])=>job.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
          if(!next)break;jobs.delete(next[0]);time=next[1].at;next[1].run();await settle();
        }
        time=target;if(each?.())await settle();
      }
    }};
}
/** Plain TCP stand-in for the 6697 leg. 'silent' welcomes and then never sends another byte (a half-open link). */
async function fakeTcpIrc(mode:Mode){
  const links:Link[]=[];const sockets=new Set<Socket>();
  const server=createTcpServer(socket=>{socket.setNoDelay(true);sockets.add(socket);socket.on('error',()=>{});
    const link:Link={lines:[],send:text=>{if(link.alive)socket.write(text);},alive:true};links.push(link);
    socket.on('close',()=>{link.alive=false;});socket.on('end',()=>{link.alive=false;});
    socket.on('data',chunk=>{for(const line of chunk.toString('utf8').split('\r\n').filter(Boolean)){link.lines.push(line);
      if(line.startsWith('NICK '))socket.write(WELCOME);
      if(line===OWN_PING&&mode==='answer')socket.write(PONG_REPLY);}});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as AddressInfo).port;
  return {port,links,close:async()=>{for(const s of sockets)s.destroy();server.close();await once(server,'close');}};
}
/** Minimal local RFC 6455 server for the WSS leg, with the same two modes. */
async function fakeWsIrc(mode:Mode){
  const links:Link[]=[];const sockets=new Set<Socket>();
  const server=createHttpServer((_req,res)=>{res.statusCode=426;res.end();});
  server.on('upgrade',(req:IncomingMessage,socket:Socket)=>{
    socket.setNoDelay(true);sockets.add(socket);socket.on('error',()=>{});
    const accept=createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frame=(text:string)=>{const body=Buffer.from(text,'utf8');
      const head=body.length<126?Buffer.from([0x81,body.length]):Buffer.from([0x81,126,body.length>>8,body.length&255]);socket.write(Buffer.concat([head,body]));};
    const link:Link={lines:[],send:text=>{if(link.alive)frame(text);},alive:true};links.push(link);
    socket.on('close',()=>{link.alive=false;});socket.on('end',()=>{link.alive=false;});
    let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=6){
        let len=buffer[1]!&0x7f,off=2;if(len===126){len=buffer.readUInt16BE(2);off=4;}
        if(buffer.length<off+4+len)return;
        const mask=buffer.subarray(off,off+4),body=Buffer.from(buffer.subarray(off+4,off+4+len));for(let i=0;i<body.length;i++)body[i]!^=mask[i%4]!;
        const op=buffer[0]!&0x0f;buffer=buffer.subarray(off+4+len);if(op!==1)continue;
        for(const line of body.toString('utf8').split('\r\n').filter(Boolean)){link.lines.push(line);
          if(line.startsWith('NICK '))frame(WELCOME);
          if(line===OWN_PING&&mode==='answer')frame(PONG_REPLY);}
      }});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as AddressInfo).port;
  return {port,links,close:async()=>{for(const s of sockets)s.destroy();server.close();await once(server,'close');}};
}
async function closedPort(){const server=createTcpServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as AddressInfo).port;server.close();await once(server,'close');return port;}
const tcpTransport=(port:number):IrcTransportFactory=>handlers=>bindIrcSocket(connectPlain({host:'127.0.0.1',port,noDelay:true},handlers.open),handlers);

/** One adapter on either leg. For 'wss' the 6697 leg is a refused port, so the sticky fallback carries the session. */
async function rig(leg:'tls'|'wss',mode:Mode){
  const clock=virtualClock();
  const fake=leg==='tls'?await fakeTcpIrc(mode):await fakeWsIrc(mode);
  const primary=leg==='tls'?tcpTransport(fake.port):tcpTransport(await closedPort());
  const statuses:{status:IrcStatus;retrying:boolean;at:number}[]=[];
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:withAnonymousFallback(undefined,true),transport:primary,
    fallbackTransport:wsIrcTransport({host:'127.0.0.1',port:fake.port,path:'/',tls:false}),now:clock.now,schedule:clock.schedule});
  adapter.start({event:()=>{},status:(status,retrying)=>statuses.push({status,retrying:retrying===true,at:clock.now()})});
  // Let the connection (and, for wss, the refused primary plus its one-second retry) reach the welcome.
  for(let i=0;i<100&&!(fake.links.at(-1)?.lines.some(line=>line.startsWith('JOIN ')));i++){
    await new Promise(r=>setTimeout(r,10));if(leg==='wss'&&fake.links.length===0)await clock.advance(250,250);
  }
  assert.ok(fake.links.at(-1)?.lines.some(line=>line.startsWith('JOIN ')),'the session joined');
  assert.equal(adapter.transportName,leg);
  const welcomedAt=clock.now(),base=statuses.length;
  // Only what happens after this welcome counts; a refused primary leg before it is setup.
  const drops=()=>statuses.slice(base).filter(s=>s.status!=='connecting'&&s.status!=='empty');
  return {clock,fake,adapter,statuses,welcomedAt,drops,done:async()=>{adapter.stop();await fake.close();}};
}

for(const leg of ['tls','wss'] as const){
  test(`IRC-LIVENESS-STALL-${leg.toUpperCase()}: a silent half-open ${leg} link sends one PING at 60 s, drops at 75 s and reconnects on the same leg`,async()=>{
    const r=await rig(leg,'silent');
    try{
      const first=r.fake.links.at(-1)!,before=r.fake.links.length;
      await r.clock.advance(IDLE_MS-1000);
      assert.equal(first.lines.filter(line=>line===OWN_PING).length,0,'no PING before a minute of silence');
      await r.clock.advance(1000);
      assert.equal(first.lines.filter(line=>line===OWN_PING).length,1,'exactly one PING at a minute of silence');
      await r.clock.advance(DEADLINE_MS-1000);
      assert.equal(r.drops().length,0,'still connected just before the deadline');
      await r.clock.advance(1000);
      const drop=r.drops()[0];
      assert.ok(drop,'the link is declared dead at the deadline');
      assert.equal(drop.status,'unreachable');assert.equal(drop.retrying,true);
      assert.equal(drop.at-r.welcomedAt,IDLE_MS+DEADLINE_MS,'dead at exactly idle + deadline after the last inbound line');
      // The backoff is the existing one: 1 s on TLS, 2 s on WSS (the refused primary already spent one retry).
      await r.clock.advance(leg==='tls'?1000:2000);
      assert.equal(r.fake.links.length,before+1,`reconnected through the backoff by ${(r.clock.now()-r.welcomedAt)/1000} s`);
      assert.ok(r.fake.links.at(-1)!.lines.some(line=>line.startsWith('JOIN ')),'the new link joined');
      assert.equal(r.adapter.transportName,leg,'same leg: transport order unchanged');
      assert.equal(first.alive,false,'the dead socket was closed');
      for(const link of r.fake.links)for(const line of link.lines)assert.match(line,READ_ONLY_ANON);
    }finally{await r.done();}
  });

  test(`IRC-LIVENESS-HEALTHY-${leg.toUpperCase()}: a quiet ${leg} link that answers PONG stays up for 30 minutes with one PING per minute`,async()=>{
    const r=await rig(leg,'answer');
    try{
      const link=r.fake.links.at(-1)!,count=r.fake.links.length,delaysFrom=r.clock.delays.length;
      await r.clock.advance(30*60_000);
      assert.equal(r.drops().length,0,'never declared dead');
      assert.equal(r.fake.links.length,count,'no reconnect');
      assert.equal(link.alive,true);
      const pings=link.lines.filter(line=>line===OWN_PING).length;
      assert.ok(pings>=29&&pings<=30,`one PING per idle minute, got ${pings}`);
      // A PONG to our own PING is not a server keepalive: the watchdog keeps its bootstrap gap.
      const extra=r.clock.delays.slice(delaysFrom).filter(d=>d!==IDLE_MS&&d!==DEADLINE_MS&&d!==BOOTSTRAP_MS);
      assert.deepEqual(extra,[],'only idle, deadline and bootstrap-watchdog delays are scheduled');
      for(const line of link.lines)assert.match(line,READ_ONLY_ANON);
    }finally{await r.done();}
  });
}

test('IRC-LIVENESS-SERVER-PING: Twitch PINGs every 50 s and chat keep the idle clock reset, so the client never sends its own PING',async()=>{
  const r=await rig('tls','silent');
  try{
    const link=r.fake.links.at(-1)!;let tick=0;
    await r.clock.advance(10*60_000,1000,()=>{tick++;if(tick%50===0)link.send('PING :tmi.twitch.tv\r\n');else if(tick%50===25&&tick<200)link.send(CHAT);else return false;return true;});
    assert.equal(link.lines.filter(line=>line===OWN_PING).length,0,'no own PING while Twitch keeps the link busy');
    assert.ok(link.lines.filter(line=>line==='PONG :tmi.twitch.tv').length>=11,'every Twitch PING is answered');
    assert.equal(r.drops().length,0);assert.equal(r.fake.links.length,1);
  }finally{await r.done();}
});

test('IRC-LIVENESS-BUDGET: a link that always welcomes and then stalls gives up within the fifteen-minute episode, with no endless loop',async()=>{
  const r=await rig('tls','silent');
  try{
    await r.clock.advance(FIFTEEN_MINUTES_MS+60_000,1000);
    const terminal=r.statuses.find(s=>!s.retrying&&s.status!=='connecting'&&s.status!=='empty');
    assert.ok(terminal,'the adapter gave up');
    const firstDrop=r.drops()[0]!;
    assert.ok(terminal.at-firstDrop.at<=FIFTEEN_MINUTES_MS,`episode ${terminal.at-firstDrop.at} ms within the cap`);
    assert.equal(terminal.status,'unreachable');
    assert.ok(r.fake.links.length<=5,`bounded reconnects, got ${r.fake.links.length}`);
    const count=r.fake.links.length;await r.clock.advance(30*60_000,5000);
    assert.equal(r.fake.links.length,count,'nothing dials after giving up');
  }finally{await r.done();}
});

test('IRC-LIVENESS-REFILL-CAP: a link that chats for a minute and then stalls, every time, still ends paused by the refill cap',async()=>{
  const r=await rig('tls','silent');
  try{
    const chatted=new Set<Link>(),joinedAt=new Map<Link,number>([[r.fake.links.at(-1)!,r.clock.now()]]);
    await r.clock.advance(4*3_600_000,1000,()=>{
      const link=r.fake.links.at(-1)!;
      if(!joinedAt.has(link)&&link.lines.some(line=>line.startsWith('JOIN ')))joinedAt.set(link,r.clock.now());
      const at=joinedAt.get(link);
      if(at===undefined||chatted.has(link)||r.clock.now()-at<61_000)return false;
      chatted.add(link);link.send(CHAT);return true;
    });
    const terminal=r.statuses.find(s=>!s.retrying&&s.status!=='connecting'&&s.status!=='empty');
    assert.ok(terminal,'the reconnect cycle is bounded');
    assert.equal(terminal.status,'paused');
    assert.ok(r.fake.links.length<=12,`bounded reconnects, got ${r.fake.links.length}`);
  }finally{await r.done();}
});
