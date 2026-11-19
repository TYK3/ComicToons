import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {eventBus,type StreamEvent} from '@comictoons/core';
import {createApp} from '../apps/server/src/app.ts';
import {budgetPerHour} from '../apps/server/src/participation/routes.ts';
import {Studio} from '../apps/server/src/studio.ts';
import {TwitchOAuthError} from '../apps/server/src/twitch/oauth.ts';
import {createDirectAdapter} from '../scripts/s2-replay-core.ts';
import {flush,revocation} from './eventsub-fakes.ts';
import {liveAppFixture} from './twitch-live-app-fixture.ts';

// LIVE-FIX-1 (from report-token-expiry.md REQUESTS 1, 2 and 5, and guided-plan.md findings 1 and 2).

test('LIVE-FIX-1 (1): a blank IMAGE_BUDGET_PER_HOUR reads as unset, not 0',()=>{
  assert.equal(budgetPerHour({IMAGE_BUDGET_PER_HOUR:''}),12,'IMAGE_BUDGET_PER_HOUR= (as copied from .env.example) must not switch the panel budget off');
  assert.equal(budgetPerHour({IMAGE_BUDGET_PER_HOUR:'   '}),12,'whitespace only is blank too');
  assert.equal(budgetPerHour({COMICTOONS_PANEL_BUDGET_PER_HOUR:'',IMAGE_BUDGET_PER_HOUR:'5'}),5,'a blank primary name falls through to IMAGE_BUDGET_PER_HOUR');
  assert.equal(budgetPerHour({IMAGE_BUDGET_PER_HOUR:'0'}),0,'an explicit 0 still means no panel budget');
  assert.equal(budgetPerHour({IMAGE_BUDGET_PER_HOUR:'7'}),7);
  assert.equal(budgetPerHour({}),12);
});

test('LIVE-FIX-1 (1): .env.example copied as is gives a working panel budget',async()=>{
  const env:Record<string,string>={};
  for(const line of readFileSync(new URL('../.env.example',import.meta.url),'utf8').split('\n')){
    const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(match)env[match[1]!]=match[2]!;
  }
  assert.ok('IMAGE_BUDGET_PER_HOUR' in env,'.env.example still lists IMAGE_BUDGET_PER_HOUR');
  assert.match(env.IMAGE_BUDGET_PER_HOUR!,/^\d+$/,'.env.example gives IMAGE_BUDGET_PER_HOUR a working default');
  assert.ok(budgetPerHour(env)>0,'the copied file must not give a panel budget of 0');
  const app=createApp({env,logger:false});
  try{
    await app.ready();
    const status=(await app.inject('/api/participation/status')).json() as {budget:{perHour:number}};
    assert.ok(status.budget.perHour>0,`panel budget from the copied .env.example is ${status.budget.perHour}`);
  }finally{await app.close();}
});

// Every command commands.ts parseCommand handles, in the forms a viewer types them.
const COMMANDS=['!previously','!PREVIOUSLY','!1','!2','!3','!4','!5','!ink','!ink yes','!ink no','!INK\tyes'];
for(const path of ['irc','bus'] as const){
  test(`LIVE-FIX-1 (2): chat commands never become panel dialogue or moment chat (${path})`,()=>{
    const direct=createDirectAdapter();let clock=0;
    const studio=new Studio({adapterFactory:()=>direct.adapter,now:()=>clock,momentConfig:{spikeMinCount:1,spikeMinUsers:1,spikeWarmupSeconds:0,cooldownSeconds:0}});
    try{
      studio.useSource('twitch','approved_test');direct.push({id:'anchor',t:0,type:'chat',user:'anchor',text:'anchor stays'});
      const inner=studio as unknown as {moments:{recentChat:StreamEvent[]}};
      const before=inner.moments.recentChat.length;
      for(const [i,text] of COMMANDS.entries()){
        clock=(i+1)*1000;const event:StreamEvent={id:`command-${i}`,t:i+1,type:'chat',user:`viewer${i%3}`,text};
        if(path==='irc')direct.push(event);else eventBus.emit('stream-event',event);
      }
      // A non-command line from the same viewers still reaches the comic, so the check is not vacuous.
      clock=20_000;const plain:StreamEvent={id:'plain',t:20,type:'chat',user:'viewer1',text:'that dragon never stood a chance'};
      if(path==='irc')direct.push(plain);else eventBus.emit('stream-event',plain);
      const panels=[...studio.state.panels,...studio.state.pendingPanels];
      const dialogue=panels.flatMap(panel=>[...panel.dialogue,...(panel.storyBeats??[]).flatMap(beat=>beat.dialogue),panel.caption,panel.storyCaption??'',panel.altText]);
      const quoted=dialogue.filter(line=>/![1-5]\b|!previously|!ink/i.test(line));
      assert.deepEqual(quoted,[],'no command text in any panel dialogue, caption or alt text');
      assert.ok(dialogue.some(line=>line.includes('that dragon never stood a chance')),'plain chat is still quoted');
      const momentChat=inner.moments.recentChat.slice(before).map(event=>event.text);
      assert.deepEqual(momentChat.filter(text=>/^!/.test(text??'')),[],'commands never enter the moment windows');
    }finally{studio.close();}
  });
}

test('LIVE-FIX-1 (3): a lost sign-in stops EventSub and leaves Live at once, not after the 60 s idle tick',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();
    f.chat('live-1');await flush();
    let state=await f.state();
    assert.equal(state.source.active,'twitch');assert.equal(state.source.connection,'live');
    assert.equal((await f.app.inject('/api/participation/eventsub')).json().state,'subscribed');
    // C3: a 401 mid-stream and the refresh is refused; the store drops the sign-in with a reason.
    f.store.disconnect('Twitch authorization expired. Reconnect Twitch.');await flush();
    f.clock.advance(1000);
    state=await f.state();
    assert.notEqual(state.source.connection,'live',`source still says ${state.source.active}/${state.source.connection} one second after the sign-in was lost`);
    assert.equal(state.source.active,'sample');
    const eventsub=(await f.app.inject('/api/participation/eventsub')).json() as {state:string;signedIn:boolean;subscribed:string[]};
    assert.equal(eventsub.signedIn,false,'EventSub reports signed-out');
    assert.notEqual(eventsub.state,'subscribed','EventSub no longer claims Connected');
    assert.deepEqual(eventsub.subscribed,[]);
    // Signing in again restarts the bridge.
    await f.signIn();await f.welcome();f.chat('live-2');await flush();
    assert.equal((await f.app.inject('/api/participation/eventsub')).json().signedIn,true);
    assert.equal((await f.state()).source.connection,'live');
  }finally{await f.close();}
});

test('LIVE-FIX-1 (4): an authorization_revoked revocation validates the token straight away',async()=>{
  const f=await liveAppFixture();
  try{
    await f.startIRC();await f.signIn();await f.welcome();f.chat('live-1');await flush();
    let validations=0;const validate=f.store.validate.bind(f.store);
    f.store.validate=()=>{validations++;return validate();};
    // Other revocation reasons are not a sign-in problem.
    f.sockets.at(-1)!.send(revocation('channel.cheer','version_removed'));await flush();
    assert.equal(validations,0,'version_removed does not validate');
    // Twitch now refuses the token and its refresh (the fake's revokeAuthorisation()).
    const oauth=f.store.oauth as unknown as {validate:()=>Promise<undefined>;refresh:()=>Promise<never>};
    oauth.validate=async()=>undefined;oauth.refresh=async()=>{throw new TwitchOAuthError(400);};
    f.sockets.at(-1)!.send(revocation('channel.chat.message','authorization_revoked'));await flush(20);
    assert.equal(validations,1,'authorization_revoked triggers auth.validate() at once');
    const status=(await f.app.inject('/api/twitch/status')).json() as {connected:boolean;reason?:string};
    assert.equal(status.connected,false,'the store notices the withdrawn sign-in without waiting for a Helix call or the hourly validate');
    assert.equal(status.reason,'Twitch authorization expired. Reconnect Twitch.');
    assert.equal((await f.state()).source.active,'sample');
  }finally{await f.close();}
});
