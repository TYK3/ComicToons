import assert from 'node:assert/strict';
import test from 'node:test';
import {ChatSource} from '../apps/server/src/ingest/source.ts';
import type {ChatAdapter} from '../apps/server/src/ingest/irc.ts';
import {chatTransportLabel,sampleSource,type ChatSourceState} from '../packages/core/src/index.ts';

type Callbacks=Parameters<ChatAdapter['start']>[0];
/** A fake adapter whose transport leg the test sets, as TwitchIrcAdapter.transportName does. */
function harness(withTransport=true){
  const adapters:{callbacks:Callbacks;transportName?:'tls'|'wss'}[]=[];
  const source=new ChatSource({change(){},event(){}},()=>{
    const adapter:{callbacks?:Callbacks;transportName?:'tls'|'wss';start:(c:Callbacks)=>void;stop:()=>void}={start(c){adapter.callbacks=c;},stop(){}};
    if(withTransport)adapter.transportName='tls';
    adapters.push(adapter as {callbacks:Callbacks;transportName?:'tls'|'wss'});return adapter;
  },()=>1000);
  source.start('approved_test');
  const live=()=>adapters.at(-1)!.callbacks.event({id:`m${Math.random()}`,type:'chat',t:1,user:'u1',text:'hello'});
  return {source,adapter:()=>adapters.at(-1)!,live};
}

test('T20-SOURCE-WSS: the connection status names the transport the adapter welcomed on',()=>{
  const {source,adapter,live}=harness();
  try{
    adapter().transportName='wss';adapter().callbacks.status('empty');
    assert.equal(source.state.transport,'wss');
    live();assert.equal(source.state.active,'twitch');assert.equal(source.state.transport,'wss');
  }finally{source.close();}
});

test('T20-SOURCE-SWITCH: a fallback from TLS to WSS during retries updates the named transport',()=>{
  const {source,adapter}=harness();
  try{
    adapter().callbacks.status('connecting');adapter().callbacks.status('unreachable',true);
    adapter().transportName='wss';adapter().callbacks.status('connecting');adapter().callbacks.status('empty');
    assert.equal(source.state.transport,'wss');
  }finally{source.close();}
});

test('T20-SOURCE-TLS-AND-RESET: TLS is named, and sample, EventSub and adapters without a transport leave no field',()=>{
  const {source,adapter}=harness();
  try{
    adapter().callbacks.status('empty');assert.equal(source.state.transport,'tls');
    source.setEventSubChat(true);assert.equal('transport' in source.state,false,'EventSub chat is not IRC');
    source.setEventSubChat(false);source.sample();assert.equal('transport' in source.state,false);
  }finally{source.close();}
  const bare=harness(false);
  try{bare.adapter().callbacks.status('empty');assert.equal('transport' in bare.source.state,false);}finally{bare.source.close();}
});

test('T20-LABEL: core names the leg only for real live chat',()=>{
  const live:ChatSourceState={requested:'twitch',active:'twitch',connection:'live',simulated:false,received:3,transport:'wss'};
  assert.equal(chatTransportLabel(live),'WSS 443');
  assert.equal(chatTransportLabel({...live,transport:'tls'}),'TLS 6697');
  assert.equal(chatTransportLabel({...live,transport:undefined}),undefined);
  assert.equal(chatTransportLabel({...live,simulated:true}),undefined);
  assert.equal(chatTransportLabel({...live,active:'sample',connection:'empty'}),undefined);
  assert.equal(chatTransportLabel(sampleSource()),undefined);
  assert.equal(chatTransportLabel(undefined),undefined);
});

test('T20-WELCOME-GUARD: transport is absent while connecting and named only after welcome status empty',()=>{
  for(const leg of ['tls','wss'] as const){
    const {source,adapter,live}=harness();
    try{
      adapter().transportName=leg;
      assert.equal(source.state.transport,undefined);
      assert.equal(chatTransportLabel(source.state),undefined);
      adapter().callbacks.status('connecting');
      assert.equal(source.state.transport,undefined,'a chosen socket leg is not a welcomed connection');
      assert.equal(chatTransportLabel(source.state),undefined);
      adapter().callbacks.status('empty');
      assert.equal(source.state.transport,leg);
      live();
      assert.equal(chatTransportLabel(source.state),leg==='tls'?'TLS 6697':'WSS 443');
    }finally{source.close();}
  }
});
