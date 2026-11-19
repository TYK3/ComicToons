import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import * as irc from '../apps/server/src/ingest/irc.ts';

/** Loopback IRC fake: counts NICK lines and welcomes them. */
function fakeIrc():Promise<{port:number;nicks:string[];close():Promise<void>}> {
  return new Promise((resolvePromise,reject)=>{
    const nicks:string[]=[],sockets=new Set<import('node:net').Socket>();
    const server=createServer(socket=>{
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
      let buffered='';
      socket.on('data',chunk=>{
        buffered+=chunk.toString('utf8');let end:number;
        while((end=buffered.indexOf('\r\n'))>=0){
          const line=buffered.slice(0,end);buffered=buffered.slice(end+2);
          if(line.startsWith('NICK ')){nicks.push(line.slice(5));socket.write(`:tmi.twitch.tv 001 ${line.slice(5)} :Welcome\r\n`);}
        }
      });
      socket.on('error',()=>{});
    });
    server.on('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const address=server.address();
      if(!address||typeof address==='string'){reject(new Error('no port'));return;}
      resolvePromise({port:address.port,nicks,close:()=>new Promise(done=>{for(const socket of sockets)socket.destroy();server.close(()=>done());})});
    });
  });
}
const withProcessUrl=async<T>(value:string|undefined,run:()=>Promise<T>)=>{
  const previous=process.env[irc.IRC_URL_ENV];
  if(value===undefined)delete process.env[irc.IRC_URL_ENV];else process.env[irc.IRC_URL_ENV]=value;
  try{return await run();}finally{if(previous===undefined)delete process.env[irc.IRC_URL_ENV];else process.env[irc.IRC_URL_ENV]=previous;}
};
type EnvApi={ircTransportFor?:(env:Record<string,string|undefined>)=>irc.IrcTransportFactory;ircFallbackFor?:(transport:irc.IrcTransportFactory)=>irc.IrcTransportFactory|undefined};
const api=irc as unknown as EnvApi;

test('IRC-ENV-1: an injected env endpoint wins over process.env (the decoy is never dialled)',async()=>{
  assert.equal(typeof api.ircTransportFor,'function','irc.ts must export ircTransportFor(env)');
  const injected=await fakeIrc(),decoy=await fakeIrc();
  try{await withProcessUrl(`irc://127.0.0.1:${decoy.port}`,async()=>{
    const adapter=new irc.TwitchIrcAdapter({channel:'env_test',authenticate:irc.withAnonymousFallback(undefined,true),
      transport:api.ircTransportFor!({[irc.IRC_URL_ENV]:`irc://127.0.0.1:${injected.port}`})});
    adapter.start({event:()=>{},status:()=>{}});
    try{
      for(let attempt=0;attempt<60&&injected.nicks.length===0;attempt++)await delay(25);
      assert.equal(injected.nicks.length,1,'the injected fake must receive the anonymous NICK');
      assert.match(injected.nicks[0]!,/^justinfan\d+$/);
      assert.equal(decoy.nicks.length,0,'process.env must not be consulted when an env is injected');
    }finally{adapter.stop();}
  });}finally{await Promise.all([injected.close(),decoy.close()]);}
});

test('IRC-ENV-1: a refused injected override fails closed even when process.env holds a valid fake',async()=>{
  assert.equal(typeof api.ircTransportFor,'function','irc.ts must export ircTransportFor(env)');
  const decoy=await fakeIrc();
  try{await withProcessUrl(`irc://127.0.0.1:${decoy.port}`,async()=>{
    const transport=api.ircTransportFor!({[irc.IRC_URL_ENV]:'ircs://irc.example.invalid:6697'});
    const warn=console.warn;console.warn=()=>{};
    try{assert.throws(()=>transport({open(){},data(){},close(){},error(){}}),/refused/);}finally{console.warn=warn;}
    await delay(50);assert.equal(decoy.nicks.length,0);
  });}finally{await decoy.close();}
});

test('IRC-ENV-1: the env-bound transport carries the fallback that env implies (WSS only when no override)',()=>{
  assert.equal(typeof api.ircFallbackFor,'function','irc.ts must export ircFallbackFor(transport)');
  return withProcessUrl('irc://127.0.0.1:1',async()=>{
    assert.equal(api.ircFallbackFor!(api.ircTransportFor!({})),irc.twitchWssTransport,'no override in the injected env: WSS fallback, regardless of process.env');
    assert.equal(api.ircFallbackFor!(api.ircTransportFor!({[irc.IRC_URL_ENV]:'irc://127.0.0.1:2'})),undefined,'an injected override replaces both legs');
    assert.equal(api.ircFallbackFor!(()=>({write(){},close(){}})),undefined,'a hand-made transport has no implied fallback');
  });
});

test('IRC-ENV-1: twitchTlsTransport still reads process.env (production path unchanged)',async()=>{
  const fake=await fakeIrc();
  try{await withProcessUrl(`irc://127.0.0.1:${fake.port}`,async()=>{
    const adapter=new irc.TwitchIrcAdapter({channel:'env_test',authenticate:irc.withAnonymousFallback(undefined,true)});
    adapter.start({event:()=>{},status:()=>{}});
    try{for(let attempt=0;attempt<60&&fake.nicks.length===0;attempt++)await delay(25);assert.equal(fake.nicks.length,1);}finally{adapter.stop();}
  });}finally{await fake.close();}
});
