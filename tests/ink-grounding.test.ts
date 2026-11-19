import assert from 'node:assert/strict';
import test from 'node:test';
import {createEventBus,type ComicToonsBusEvents} from '../packages/core/src/index.ts';
import {Studio} from '../apps/server/src/studio.ts';
import {InkChatRequests} from '../apps/server/src/participation/ink-chat.ts';
import {OptOutLedger} from '../apps/server/src/participation/commands.ts';
import {PanelBudget} from '../apps/server/src/participation/rewards.ts';

test('live Ink Me library placeholders cannot be released individually, in bulk or automatically',()=>{
  const studio=new Studio();
  try{
    const requests=new InkChatRequests({studio,optOuts:new OptOutLedger(),bus:createEventBus<ComicToonsBusEvents>(),now:()=>1000,budget:new PanelBudget(12,()=>1000),active:()=>true});
    requests.request({type:'chat',user:'viewer-id',name:'qa_viewer',text:'!ink',t:0});
    const draft=studio.state.pendingPanels[0]!;
    assert.equal(draft.provenance?.provider,'library');assert.equal(draft.provenance?.fallback,true);
    assert.match(draft.altText,/placeholder/i);assert.ok(draft.releaseBlocked);
    assert.deepEqual(draft.characters,[],'a request is not proof of a generated likeness');
    assert.throws(()=>studio.moderate('approve',draft.id),/placeholders cannot be released/);
    assert.throws(()=>studio.moderate('approve',undefined,true),/placeholders cannot be released/);
    assert.throws(()=>studio.settings({approvalMode:false}),/placeholders cannot be released/);
    assert.equal(studio.state.panels.length,0);assert.equal(studio.state.approvalMode,true);
    const rejected=studio.moderate('reject',draft.id);studio.undo(rejected.undoToken);
    assert.ok(studio.state.pendingPanels[0]?.releaseBlocked,'undo cannot remove the release gate');
  }finally{studio.close();}
});
