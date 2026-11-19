import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHttpServer,type IncomingMessage} from 'node:http';
import {createServer as createTcpServer,connect as connectPlain,type Socket,type AddressInfo} from 'node:net';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {TwitchIrcAdapter,withAnonymousFallback,bindIrcSocket,wsIrcTransport,defaultIrcFallback,WSS_IRC_ENDPOINT,IRC_URL_ENV,MAX_WAIT_MS,
  type IrcTransportFactory} from '../apps/server/src/ingest/irc.ts';

const WELCOME=':tmi.twitch.tv 001 justinfan12345 :Welcome, GLHF!\r\n';
const CHAT='@id=wss-1;user-id=42;mod=0 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #approved_test :hello over websocket\r\n';
const READ_ONLY_ANON=/^(?:NICK justinfan\d{5}|CAP REQ :twitch\.tv\/tags twitch\.tv\/commands|JOIN #approved_test|PONG :[a-zA-Z0-9.:-]+)\r\n$/;

/** Minimal local RFC 6455 server: decodes masked client text frames, sends unmasked text frames. */
async function fakeWsServer(onFrame:(text:string,send:(text:string)=>void)=>void){
  const frames:string[]=[];let upgrades=0;const sockets=new Set<Socket>();
  const server=createHttpServer((_req,res)=>{res.statusCode=426;res.end();});
  server.on('upgrade',(req:IncomingMessage,socket:Socket)=>{
    upgrades++;sockets.add(socket);
    const accept=createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send=(text:string)=>{const body=Buffer.from(text,'utf8');
      const head=body.length<126?Buffer.from([0x81,body.length]):Buffer.from([0x81,126,body.length>>8,body.length&255]);socket.write(Buffer.concat([head,body]));};
    let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=6){
        assert.ok(buffer[1]!&0x80,'client frames must be masked');
        let len=buffer[1]!&0x7f,off=2;if(len===126){len=buffer.readUInt16BE(2);off=4;}
        if(buffer.length<off+4+len)return;
        const mask=buffer.subarray(off,off+4),body=Buffer.from(buffer.subarray(off+4,off+4+len));for(let i=0;i<body.length;i++)body[i]!^=mask[i%4]!;
        const op=buffer[0]!&0x0f;buffer=buffer.subarray(off+4+len);
        if(op===1){const text=body.toString('utf8');frames.push(text);onFrame(text,send);}
      }});
    socket.on('error',()=>{});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as AddressInfo).port;
  return {port,frames,get upgrades(){return upgrades;},close:async()=>{for(const s of sockets)s.destroy();server.close();await once(server,'close');}};
}
/** Plain TCP stand-in for the 6697 leg: either accepts and welcomes, or is a closed port. */
async function fakeTcpIrc(){
  const lines:string[]=[];let connections=0;const sockets=new Set<Socket>();
  const server=createTcpServer(socket=>{connections++;sockets.add(socket);socket.on('error',()=>{});
    socket.on('data',chunk=>{for(const line of chunk.toString('utf8').split('\r\n').filter(Boolean)){lines.push(line);if(line.startsWith('NICK '))socket.write(WELCOME);}});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as AddressInfo).port;
  return {port,lines,get connections(){return connections;},close:async()=>{for(const s of sockets)s.destroy();server.close();await once(server,'close');}};
}
async function closedPort(){const server=createTcpServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as AddressInfo).port;server.close();await once(server,'close');return port;}
const tcpTransport=(port:number):IrcTransportFactory=>handlers=>bindIrcSocket(connectPlain({host:'127.0.0.1',port},handlers.open),handlers);
const until=async(check:()=>boolean,ms=3000)=>{for(const end=Date.now()+ms;Date.now()<end;){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('timed out waiting');};

test('IRC-WSS-ENDPOINT: the fallback is the documented Twitch WebSocket chat endpoint, and an IRC URL override disables it',()=>{
  assert.deepEqual(WSS_IRC_ENDPOINT,{host:'irc-ws.chat.twitch.tv',port:443,path:'/'});
  assert.ok(defaultIrcFallback({}),'no override: WSS fallback is on');
  assert.equal(defaultIrcFallback({[IRC_URL_ENV]:'irc://127.0.0.1:6667'}),undefined,'an override replaces both legs');
  assert.equal(defaultIrcFallback({[IRC_URL_ENV]:'wss://evil.example:443'}),undefined,'a refused override never falls back to Twitch');
});

test('IRC-WSS-FALLBACK: a refused 6697 leg forces WebSocket; chat parses, the session stays anonymous and read-only',async()=>{
  const ws=await fakeWsServer((text,send)=>{if(text.startsWith('NICK '))send(WELCOME);if(text.startsWith('JOIN '))send(CHAT);});
  const refused=await closedPort();const events:{text?:string}[]=[],statuses:string[]=[];
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:withAnonymousFallback(undefined,true),
    transport:tcpTransport(refused),fallbackTransport:wsIrcTransport({host:'127.0.0.1',port:ws.port,path:'/',tls:false}),schedule:(run,ms)=>{const t=setTimeout(run,ms<=8000?20:ms);return ()=>clearTimeout(t);}});
  try{
    adapter.start({event:event=>events.push(event as {text?:string}),status:status=>statuses.push(status)});
    await until(()=>events.length>0);
    assert.equal(adapter.transportName,'wss');
    assert.equal(events[0]!.text,'hello over websocket');
    assert.equal(ws.upgrades,1);
    for(const frame of ws.frames)assert.match(frame,READ_ONLY_ANON);
    assert.ok(ws.frames.some(frame=>frame.startsWith('JOIN #approved_test')));
    assert.ok(statuses.includes('empty'));
  }finally{adapter.stop();await ws.close();}
});

test('IRC-WSS-KEEP-TLS: when the 6697 leg welcomes, the session stays on it and never dials WebSocket',async()=>{
  const ws=await fakeWsServer(()=>{});const tcp=await fakeTcpIrc();const statuses:string[]=[];
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:withAnonymousFallback(undefined,true),
    transport:tcpTransport(tcp.port),fallbackTransport:wsIrcTransport({host:'127.0.0.1',port:ws.port,path:'/',tls:false})});
  try{
    adapter.start({event:()=>{},status:status=>statuses.push(status)});
    await until(()=>tcp.lines.some(line=>line.startsWith('JOIN ')));
    assert.equal(adapter.transportName,'tls');
    assert.equal(ws.upgrades,0);assert.equal(tcp.connections,1);
    assert.ok(statuses.includes('empty'));
  }finally{adapter.stop();await ws.close();await tcp.close();}
});

/** Virtual-time harness: injected transports that never touch a socket. */
function virtual(primary:'error'|'silent',fallback:'error'|'silent'){
  let clock=0;const jobs:{at:number;run:()=>void;live:boolean}[]=[];const opened:string[]=[];const statuses:{status:string;at:number}[]=[];
  const leg=(name:string,mode:'error'|'silent'):IrcTransportFactory=>handlers=>{opened.push(name);
    if(mode==='error')queueMicrotask(()=>handlers.error());else queueMicrotask(()=>handlers.open());
    return {write:()=>{},close:()=>{}};};
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:withAnonymousFallback(undefined,true),transport:leg('tls',primary),fallbackTransport:leg('wss',fallback),
    now:()=>clock,schedule:(run,ms)=>{const job={at:clock+ms,run,live:true};jobs.push(job);return ()=>{job.live=false;};}});
  adapter.start({event:()=>{},status:status=>statuses.push({status,at:clock})});
  const drain=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
  const advanceAll=async()=>{await drain();for(;;){const next=jobs.filter(j=>j.live).sort((a,b)=>a.at-b.at)[0];if(!next)break;next.live=false;clock=Math.max(clock,next.at);next.run();await drain();}};
  return {adapter,opened,statuses,advanceAll,now:()=>clock};
}

test('IRC-WSS-WELCOME-TIMEOUT: a 6697 leg that connects but never welcomes switches to WebSocket within 15 s',async()=>{
  const v=virtual('silent','silent');
  await v.advanceAll();
  assert.deepEqual(v.opened.slice(0,2),['tls','wss']);
  const second=v.statuses.filter(s=>s.status==='connecting')[1]!;
  assert.ok(second.at<=16_000,`WSS dialled at ${second.at} ms`);
  v.adapter.stop();
});

test('IRC-WSS-BUDGET: with both legs failing the S1b fifteen-minute episode budget and retry count still decide the give-up',async()=>{
  const failing=virtual('error','error');
  await failing.advanceAll();
  assert.deepEqual(failing.opened,['tls','wss','wss','wss'],'one TLS attempt, then the usual three retries over WSS');
  assert.equal(failing.statuses.at(-1)!.status,'unreachable');
  assert.ok(failing.now()<=MAX_WAIT_MS);
  const stalled=virtual('silent','silent');
  await stalled.advanceAll();
  assert.equal(stalled.statuses.at(-1)!.status,'unreachable');
  // The S1b episode clock opens at the first failure: here the 15 s welcome timeout on 6697.
  const firstFailure=stalled.statuses.find(s=>s.status==='unreachable')!.at;
  assert.equal(firstFailure,15_000);
  assert.ok(stalled.now()-firstFailure<=MAX_WAIT_MS,`gave up ${stalled.now()-firstFailure} ms into the episode, beyond the ${MAX_WAIT_MS} ms budget`);
});

/** Raw upgrade server that answers with exactly the bytes a test hands it. */
async function rawWs(reply:(accept:string)=>Buffer[]){
  const received:Buffer[]=[];const sockets=new Set<Socket>();
  const server=createHttpServer();
  server.on('upgrade',(req:IncomingMessage,socket:Socket)=>{sockets.add(socket);socket.on('error',()=>{});socket.on('data',chunk=>received.push(chunk));
    const accept=createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    for(const part of reply(accept))socket.write(part);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {port:(server.address() as AddressInfo).port,received,close:async()=>{for(const s of sockets)s.destroy();server.close();await once(server,'close');}};
}
const UPGRADED=(accept:string)=>Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

test('IRC-WSS-FRAMES: several lines per message, fragments, 16-bit lengths and ping are decoded; a bad accept key fails closed',async()=>{
  const long=`:a PRIVMSG #approved_test :${'x'.repeat(200)}`;
  const server=await rawWs(accept=>[UPGRADED(accept),
    Buffer.concat([Buffer.from([0x81,12]),Buffer.from('A one\r\nB two')]),            // two lines, last without CRLF
    Buffer.concat([Buffer.from([0x01,4]),Buffer.from('C th'),Buffer.from([0x80,7]),Buffer.from('ree\r\n\r\n')]), // fragmented
    Buffer.concat([Buffer.from([0x89,2]),Buffer.from('hi')]),                          // ping
    Buffer.concat([Buffer.from([0x81,126,0,long.length]),Buffer.from(long)]),           // 16-bit length
  ]);
  const chunks:string[]=[];let opened=false,errors=0;
  const transport=wsIrcTransport({host:'127.0.0.1',port:server.port,path:'/',tls:false})({open:()=>{opened=true;},data:chunk=>chunks.push(String(chunk)),close:()=>{},error:()=>{errors++;}});
  try{
    await until(()=>chunks.length===3);
    assert.ok(opened);assert.equal(errors,0);
    assert.deepEqual(chunks,['A one\r\nB two\r\n','C three\r\n\r\n',`${long}\r\n`]);
    await until(()=>Buffer.concat(server.received).includes(Buffer.from([0x8a])));
    const pong=Buffer.concat(server.received);const at=pong.indexOf(0x8a);
    assert.equal(pong[at+1],0x82,'pong is masked and carries the ping payload length');
    const mask=pong.subarray(at+2,at+6),body=Buffer.from(pong.subarray(at+6,at+8));for(let i=0;i<2;i++)body[i]!^=mask[i]!;
    assert.equal(body.toString(),'hi');
  }finally{transport.close();await server.close();}
  const bad=await rawWs(()=>[UPGRADED('not-the-right-key')]);let badErrors=0,badOpened=false;
  const t2=wsIrcTransport({host:'127.0.0.1',port:bad.port,path:'/',tls:false})({open:()=>{badOpened=true;},data:()=>{},close:()=>{},error:()=>{badErrors++;}});
  try{await until(()=>badErrors===1);assert.equal(badOpened,false);}finally{t2.close();await bad.close();}
});

test('IRC-WSS-MASKED-SERVER: a masked server frame fails closed without delivering IRC data',async()=>{
  const mask=Buffer.from([1,2,3,4]),body=Buffer.from('PING');
  for(let i=0;i<body.length;i++)body[i]!^=mask[i%4]!;
  const server=await rawWs(accept=>[UPGRADED(accept),Buffer.concat([Buffer.from([0x81,0x84]),mask,body])]);
  let errors=0;const chunks:string[]=[];
  const transport=wsIrcTransport({host:'127.0.0.1',port:server.port,path:'/',tls:false})({
    open(){},data:chunk=>chunks.push(String(chunk)),close(){},error(){errors++;},
  });
  try{await until(()=>errors===1);assert.deepEqual(chunks,[]);}
  finally{transport.close();await server.close();}
});
