import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../apps/server/src/app.ts';
import {IRC_URL_ENV} from '../apps/server/src/ingest/irc.ts';

/** IRC-ENV-1 app.ts hook: createApp's injected env chooses the IRC endpoint, not process.env. */
function fakeIrc():Promise<{port:number;nicks:string[];close():Promise<void>}> {
  return new Promise((resolvePromise,reject)=>{
    const nicks:string[]=[],sockets=new Set<Socket>();
    const server=createServer(socket=>{
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
      let buffered='';
      socket.on('data',chunk=>{
        buffered+=chunk.toString('utf8');let end:number;
        while((end=buffered.indexOf('\r\n'))>=0){
          const line=buffered.slice(0,end);buffered=buffered.slice(end+2);
          if(line.startsWith('NICK ')){nicks.push(line.slice(5));socket.write(`:tmi.twitch.tv 001 ${line.slice(5)} :Welcome\r\n`);}
        }
      });
    });
    server.on('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const address=server.address();
      if(!address||typeof address==='string'){reject(new Error('no port'));return;}
      resolvePromise({port:address.port,nicks,close:()=>new Promise(done=>{for(const socket of sockets)socket.destroy();server.close(()=>done());})});
    });
  });
}

test('APP-IRC-ENV: createApp({env}) dials the injected IRC endpoint even when process.env names another',async()=>{
  const injected=await fakeIrc(),decoy=await fakeIrc();
  const previous=process.env[IRC_URL_ENV];process.env[IRC_URL_ENV]=`irc://127.0.0.1:${decoy.port}`;
  const app=createApp({env:{COMICTOONS_TWITCH_ANON:'1',[IRC_URL_ENV]:`irc://127.0.0.1:${injected.port}`},logger:false});
  try{
    const started=await app.inject({method:'POST',url:'/api/ingest',payload:{mode:'twitch',channel:'approved_test'}});
    assert.equal(started.statusCode,200);
    for(let attempt=0;attempt<80&&injected.nicks.length===0;attempt++)await delay(25);
    assert.equal(injected.nicks.length,1,'the injected endpoint receives the anonymous NICK');
    assert.equal(decoy.nicks.length,0,'process.env is not consulted for an app built with env');
  }finally{
    await app.close();await Promise.all([injected.close(),decoy.close()]);
    if(previous===undefined)delete process.env[IRC_URL_ENV];else process.env[IRC_URL_ENV]=previous;
  }
});
