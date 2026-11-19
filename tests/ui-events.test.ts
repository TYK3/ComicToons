import assert from 'node:assert/strict';
import test from 'node:test';
import {eventBus} from '@comictoons/core';
import {createApp} from '../apps/server/src/app.ts';

test('state SSE forwards EventSub revocations and removes its listener on shutdown without a socket',async()=>{
  const app=createApp({env:{},logger:false});
  await app.ready();
  const original=eventBus.on;
  let subscribed!:()=>void;
  const ready=new Promise<void>(resolve=>{subscribed=resolve;});
  let disposed=false;
  eventBus.on=((channel,handler)=>{
    const off=original(channel,handler);
    if(channel!=='eventsub-revoked')return off;
    subscribed();
    return ()=>{disposed=true;off();};
  }) as typeof original;
  try{
    const pending=app.inject('/api/events').then(response=>response);
    await ready;
    const payload={type:'channel.chat.message',version:'1',status:'authorization_revoked',at:123};
    eventBus.emit('eventsub-revoked',payload);
    await app.close();
    const response=await pending;
    assert.match(response.body,/event: state\ndata: /);
    assert.ok(response.body.includes(`event: eventsub-revoked\ndata: ${JSON.stringify(payload)}\n\n`));
    assert.equal(disposed,true);
  }finally{eventBus.on=original;await app.close();}
});
