import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTwitchEvent } from '../packages/core/src/index.ts';

test('recorded EventSub chat envelope normalizes identifiers and treats chat as text', () => {
  assert.deepEqual(normalizeTwitchEvent({
    metadata: { message_id: 'fixture-chat-1', subscription_type: 'channel.chat.message' },
    payload: { event: { chatter_user_id: 'viewer-1', chatter_user_name: 'OriginalViewer', message: { text: '<b>What a roll!</b>' } } },
  }), { id: 'fixture-chat-1', t: 0, type: 'chat', user: 'viewer-1', name: 'OriginalViewer', text: 'What a roll!' });
});

test('recorded raid envelope preserves audience count; unsupported frames are ignored', () => {
  assert.deepEqual(normalizeTwitchEvent({ metadata: { message_id: 'raid-1', subscription_type: 'channel.raid' }, payload: { event: { from_broadcaster_user_name: 'MoonlightCrew', viewers: 42 } } }), { id: 'raid-1', t: 0, type: 'raid', from: 'MoonlightCrew', viewers: 42 });
  for (const payload of [null, {}, { metadata: { message_type: 'session_keepalive' } }]) assert.equal(normalizeTwitchEvent(payload), null);
});
