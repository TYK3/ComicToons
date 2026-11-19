import assert from 'node:assert/strict';
import test from 'node:test';
import * as adapter from '../apps/web/src/ui/data/adapter.ts';
import {comicToonsSubscriptions} from '../apps/server/src/eventsub/subscriptions.ts';

// LIVE-FIX-1 (5): the server subscribes to 16 types (stream.offline is not in the Studio's list of 15),
// so the chip read "16 of 15 subscriptions". Only the listed types may be counted.
test('LIVE-FIX-1 (5): the EventSub count covers only the listed types, never "16 of 15"',()=>{
  const all=comicToonsSubscriptions('1337').map(entry=>entry.type);
  assert.equal(all.length,16,'the server subscribes to 16 types');
  const listed=(adapter as Record<string,unknown>).listedEventSubStatus as ((status:adapter.EventSubStatus)=>adapter.EventSubStatus)|undefined;
  assert.equal(typeof listed,'function','adapter.ts exports listedEventSubStatus()');
  const status:adapter.EventSubStatus={state:'subscribed',signedIn:true,subscribed:all,failed:[{type:'stream.offline',error:'x'}],revoked:[],reconnects:0,notifications:3};
  const shown=listed!(status);
  assert.equal(shown.subscribed.length,adapter.EVENTSUB_TYPES.length,`${shown.subscribed.length} of ${adapter.EVENTSUB_TYPES.length}`);
  assert.ok(shown.subscribed.length<=adapter.EVENTSUB_TYPES.length);
  assert.deepEqual(shown.failed,[],'an unlisted failure does not count either');
  assert.equal(adapter.eventSubHealth(shown),'connected');
  // Unchanged for everything else.
  assert.equal(shown.state,'subscribed');assert.equal(shown.notifications,3);
  assert.equal(status.subscribed.length,16,'the input is not mutated');
});
