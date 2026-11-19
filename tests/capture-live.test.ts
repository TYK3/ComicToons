import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Browser} from '@playwright/test';
import {TwitchVideoCapture,CaptureError} from '../apps/server/src/scenes/capture.ts';
import {liveSourceCheck} from '../apps/server/src/scenes/live-source.ts';
import {SceneSessions} from '../apps/server/src/scenes/sessions.ts';

const auth={async getAuth(){return {clientId:'controlled-client',accessToken:'controlled-token-not-public',broadcasterId:'1',login:'test_stream'};},async refresh(){}};
test('live status is read-only, source-specific and does not expose provider errors',async()=>{
  for(const data of [[],[{user_login:'test_stream',type:'live'}],[{user_login:'other_stream',type:'live'}]]){
    const check=liveSourceCheck({auth,fetchImpl:async(url,init)=>{assert.equal(new URL(url).pathname,'/helix/streams');assert.equal(init?.method,'GET');assert.equal(String(url).includes('controlled-token-not-public'),false);return new Response(JSON.stringify({data}));}});
    assert.equal(await check('test_stream'),data.length===1&&data[0]!.user_login==='test_stream');
  }
  const check=liveSourceCheck({auth,fetchImpl:async()=>{throw Error('controlled-token-not-public');}});
  await assert.rejects(check('test_stream'),error=>error instanceof CaptureError&&error.code==='status'&&!error.message.includes('controlled-token-not-public'));
});
test('offline channel is rejected before any browser is launched',async()=>{
  let launched=0;const capture=new TwitchVideoCapture({isLive:async()=>false,launch:async()=>{launched++;throw Error('Must not launch');}});
  await assert.rejects(capture.open('test_stream'),error=>error instanceof CaptureError&&error.code==='offline');assert.equal(launched,0);await capture.close();
});
test('stopping during browser launch closes the late browser instead of leaving an orphan',async()=>{
  let finish!:(browser:Browser)=>void,closed=0,pages=0;const pending=new Promise<Browser>(resolve=>{finish=resolve;});
  const capture=new TwitchVideoCapture({isLive:async()=>true,launch:()=>pending});
  const rejected=assert.rejects(capture.open('test_stream'),/stopped/);await new Promise(resolve=>setImmediate(resolve));await capture.close();
  finish({async close(){closed++;},async newPage(){pages++;throw Error('Must not open page');}} as unknown as Browser);
  await rejected;assert.equal(closed,1);assert.equal(pages,0);
});
test('offline error reaches the session with no frames, no pages and no image-provider attempt',async()=>{
  const manager=new SceneSessions({env:{},directory:await mkdtemp(join(tmpdir(),'ct-offline-')),isLive:async()=>false,adapterFactory:()=>({start(c){c.status('empty');},stop(){}})});
  const session=manager.get(manager.create('viewer').id)!;
  try{await manager.start(session,'test_stream',60);const until=Date.now()+3000;while(session.snapshot.state!=='error'){if(Date.now()>until)throw Error('Offline state not reported');await new Promise(resolve=>setTimeout(resolve,5));}
    assert.match(session.snapshot.error??'',/offline/);assert.equal(session.snapshot.frames.length,0);assert.equal(session.snapshot.pages.length,0);assert.equal(session.snapshot.generator.used,0);
  }finally{await manager.close();}
});
