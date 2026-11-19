import assert from 'node:assert/strict';
import test from 'node:test';
import {sampleSource,type ChatSourceState} from '@comictoons/core';
import {overlayPanels,overlayState} from '../apps/web/src/lib/overlay-state.ts';
import {initialState,type Panel} from '../apps/web/src/types.ts';

const live:Panel={id:'live',origin:'twitch',caption:'Live',dialogue:[],altText:'Live',imageUrl:'/art/live.png'};
const sample:Panel={...live,id:'sample',origin:'sample'};
const demo:Panel={...live,id:'demo',origin:undefined};
const twitch:ChatSourceState={...sampleSource(),requested:'twitch',active:'twitch',simulated:false,connection:'live'};
test('overlay retains its last stream snapshot over stale outage polls until a reconnect frame arrives',()=>{
  const approved={...initialState,source:twitch,panels:[live]};
  assert.equal(overlayState(approved,initialState),approved);
  assert.deepEqual(overlayPanels(approved.panels),[live]);
  const reconnected={...initialState,status:'stopped'};
  assert.equal(overlayState(reconnected,approved),reconnected);
  assert.equal(overlayState(undefined,approved),approved);
});
test('overlay shows all panels when none has Twitch provenance, even for crafted live state',()=>{
  const crafted={...initialState,status:'live',source:twitch,panels:[sample,demo]};
  assert.deepEqual(overlayPanels(crafted.panels),[sample,demo]);
  assert.deepEqual(overlayPanels([]),[]);
});
test('overlay drops non-Twitch panels from mixed snapshots regardless of source state',()=>{
  assert.deepEqual(overlayPanels([sample,live,demo]),[live]);
  assert.deepEqual(overlayPanels([live]),[live]);
});
test('sample-source and automatic fallback snapshots retain labelled Sample Data panels',()=>{
  for(const source of [sampleSource(),{...sampleSource(),requested:'twitch' as const},{...twitch,simulated:true}]){
    const state={...initialState,status:'live',source,panels:[sample,demo]};
    assert.deepEqual(overlayPanels(state.panels),[sample,demo]);
    assert.deepEqual(overlayPanels([...state.panels,live]),[live]);
  }
});
