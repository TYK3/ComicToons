import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import type {ComicToonsAdapter,UiSnapshot,UiEvent} from '../apps/web/src/ui/data/adapter';
import {liveWorkspace} from '../apps/web/src/ui/data/workspace';

register('data:text/javascript,'+encodeURIComponent(`export async function load(url,context,next){if(/\\.(webp|png|jpe?g|css)$/.test(url))return {format:'module',source:'export default '+JSON.stringify(url),shortCircuit:true};return next(url,context);}`),import.meta.url);

test('Live filters sample state, readers and events but keeps actual Twitch content',async()=>{
  const {MockAdapter}=await import('../apps/web/src/ui/data/mock');
  const mock=new MockAdapter({freeze:true});
  try{
    const sample=mock.getSnapshot();
    const samplePanel=sample.studio.panels[0]!;
    const twitchPanel={...samplePanel,id:'live-panel',origin:'twitch' as const};
    let raw=sample;
    let handler:((event:UiEvent)=>void)|undefined;
    const sampleIssue=await mock.getIssue('sample-tabletop-night','festival');
    const base={getSnapshot:()=>raw,
      listIssues:async()=>['sample-tabletop-night','sample-disguised','live-issue','wrong-origin'],
      getIssue:async(id:string)=>id==='live-issue'?{...sampleIssue,id,sample:false,panels:[twitchPanel]}:id==='wrong-origin'?{...sampleIssue,id,sample:false,panels:[samplePanel]}:sampleIssue,
      getSeries:async()=>({id:'live-issue',sample:false,episodes:[]}),
      getCatchup:async()=>({sample:raw.studio.source.active==='sample',panels:raw.studio.panels,channel:'owner',minutes:15}),
      onEvent:(_names:unknown,callback:(event:UiEvent)=>void)=>{handler=callback;return()=>{};},
    } as unknown as ComicToonsAdapter;
    const live=liveWorkspace(base,true);
    assert.deepEqual(live.getSnapshot().studio.panels,[]);
    assert.deepEqual(live.getSnapshot().chat,[]);
    assert.equal(live.getSnapshot().sampleReplay,undefined);
    assert.equal(live.getSnapshot(),live.getSnapshot(),'stable snapshot for React');
    assert.deepEqual((await live.getCatchup(15)).panels,[]);
    assert.deepEqual(await live.listIssues(),['live-issue']);
    await assert.rejects(live.getIssue('sample-tabletop-night','festival'),/Sample/);
    await assert.rejects(live.getIssue('wrong-origin','festival'),/Sample/);
    const events:UiEvent[]=[];live.onEvent(['catchup'],event=>events.push(event));
    const event={name:'catchup',data:{panelIds:['sample-panel']}} as UiEvent;
    handler!(event);assert.equal(events.length,0);
    raw={...sample,studio:{...sample.studio,panels:[twitchPanel,samplePanel],source:{requested:'twitch',active:'twitch',connection:'live',simulated:false,channel:'owner',received:1}}} as UiSnapshot;
    assert.deepEqual(live.getSnapshot().studio.panels.map(p=>p.id),['live-panel']);
    assert.deepEqual((await live.getCatchup(15)).panels.map(p=>p.id),['live-panel']);
    handler!({...event,data:{panelIds:['live-panel']}} as UiEvent);assert.equal(events.length,1);
    assert.equal((await live.getSeries('live-issue','festival')).sample,false);
  }finally{mock.dispose();}
});

test('saved Sample issues keep their own panels when another replay starts',async()=>{
  const {SampleStudioAdapter}=await import('../apps/web/src/ui/data/sampleStudio');
  const sample=new SampleStudioAdapter({restore:false});
  try{
    await assert.rejects(sample.endStream('Empty',['book'],'festival'),/Release at least one/);
    assert.notEqual(sample.getSnapshot().studio.status,'ended');
    await sample.replay('tabletop-night');await sample.revealNext();sample.pauseReplay();
    await sample.approve();const first=await sample.saveRecap('festival');
    const before=await sample.getIssue(first.recapId,'festival');
    assert.equal(before.panels.length,1);
    await sample.replay('irl-cooking');await sample.revealNext();sample.pauseReplay();
    await sample.approve();sample.pauseReplay();await sample.revealNext();sample.pauseReplay();
    assert.equal(sample.getSnapshot().studio.pendingPanels.length,1);
    const second=await sample.endStream('Cooking issue',['book'],'festival');
    assert.equal(sample.getSnapshot().studio.pendingPanels.length,0);
    assert.equal(sample.getSnapshot().broadcast?.kind,'stream-end');
    assert.notEqual(first.recapId,second.recapId);
    assert.deepEqual(await sample.getIssue(first.recapId,'festival'),before);
    assert.equal((await sample.listIssues()).length,2);
    await assert.rejects(sample.getIssue('live-issue','festival'),/Live/);
  }finally{sample.dispose();}
});

test('Sample catch-up respects the simulated time window and pause resumes the same run',async()=>{
  const {SampleStudioAdapter}=await import('../apps/web/src/ui/data/sampleStudio');
  const sample=new SampleStudioAdapter({restore:false});
  try{
    await sample.startSampleDemo('irl-cooking');
    for(let i=0;i<18;i++)await sample.revealNext();
    sample.stopSampleDemo();
    const before=sample.getSnapshot(),run=before.sampleReplay!.runId;
    assert.equal(before.sampleSimulation?.paused,true);
    assert.equal((await sample.getCatchup(5)).panels.length,6);
    assert.equal((await sample.getCatchup(15)).panels.length,17);
    assert.equal((await sample.getCatchup(30)).panels.length,19);
    sample.resumeSampleDemo();
    assert.equal(sample.getSnapshot().sampleReplay!.runId,run);
    assert.equal(sample.getSnapshot().sampleReplay!.revealed,18);
    assert.equal(sample.getSnapshot().sampleSimulation?.guided,true);
    assert.equal(sample.getSnapshot().studio.approvalMode,false);
  }finally{sample.dispose();}
});

test('Live Library surfaces failed issue reads instead of reporting a false empty collection',async()=>{
  const {MockAdapter}=await import('../apps/web/src/ui/data/mock');
  const mock=new MockAdapter({freeze:true});
  const base={getSnapshot:mock.getSnapshot,listIssues:async()=>['real-issue'],getIssue:async()=>{throw new Error('Issue server unavailable');}} as unknown as ComicToonsAdapter;
  try{await assert.rejects(liveWorkspace(base).listIssues(),/Issue server unavailable/);}finally{mock.dispose();}
});
