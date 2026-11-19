import assert from 'node:assert/strict';
import test from 'node:test';
import { Studio } from '../apps/server/src/studio.ts';
import { eventBus, normalizeTwitchEvent } from '../packages/core/src/index.ts';
import type { StreamEvent } from '../packages/core/src/index.ts';

const panelsOf = (studio: Studio) => [...studio.state.panels, ...studio.state.pendingPanels];
const shown = (studio: Studio) => JSON.stringify(panelsOf(studio));

const chatEnvelope = (notificationId: string, messageId: string, text = 'hello chat') => ({
  metadata: { message_id: notificationId, subscription_type: 'channel.chat.message' },
  payload: { event: { chatter_user_id: 'viewer-1', chatter_user_name: 'Viewer', message: { text }, message_id: messageId } },
});

test('B2-MSGID-01: a channel.chat.message normalises to event.message_id, not the EventSub notification id', () => {
  const normalised = normalizeTwitchEvent(chatEnvelope('notif-aaa', 'chat-line-uuid-1'));
  assert.equal(normalised?.id, 'chat-line-uuid-1', 'the chat line id wins over the notification envelope id');
  assert.notEqual(normalised?.id, 'notif-aaa');
});

test('B2-MSGID-02: a channel.chat.message_delete withdraw targets event.message_id', () => {
  const normalised = normalizeTwitchEvent({
    metadata: { message_id: 'notif-bbb', subscription_type: 'channel.chat.message_delete' },
    payload: { event: { message_id: 'chat-line-uuid-2', target_user_id: 'viewer-1' } },
  });
  assert.equal(normalised?.type, 'chat');
  assert.equal(normalised?.withdraw, 'message');
  assert.equal(normalised?.targetId, 'chat-line-uuid-2', 'the withdrawal targets the chat line id, not the notification id');
  assert.notEqual(normalised?.targetId, 'notif-bbb');
});

test('B2-MSGID-03: the same chat line redelivered under two notification ids dedupes to one line in the studio', () => {
  const studio = new Studio({});
  try {
    eventBus.emit('twitch-connected', { source: 'eventsub', channel: 'msgid_channel' });
    const first = normalizeTwitchEvent(chatEnvelope('notif-aaa', 'chat-line-uuid-3', 'only once please'));
    const resent = normalizeTwitchEvent(chatEnvelope('notif-zzz', 'chat-line-uuid-3', 'only once please'));
    assert.ok(first && resent, 'both notifications normalise');
    assert.equal(first!.id, resent!.id, 'redelivery keeps the same chat line id even though the notification id differs');
    eventBus.emit('stream-event', first!);
    eventBus.emit('stream-event', resent!);
    const quoted = panelsOf(studio).flatMap((panel) => panel.dialogue).filter((text) => text === 'only once please');
    assert.equal(quoted.length, 1, 'the redelivered notification is not quoted a second time');
    assert.ok(shown(studio).includes('only once please'));
  } finally { studio.close(); }
});

test('B2-MSGID-04: busEvent skips a null normalised event instead of throwing', () => {
  const studio = new Studio({});
  try {
    const before = shown(studio);
    const unsupported = normalizeTwitchEvent({ metadata: { message_type: 'session_keepalive' } });
    assert.equal(unsupported, null, 'an unsupported frame normalises to null');
    assert.doesNotThrow(() => eventBus.emit('stream-event', unsupported as unknown as StreamEvent));
    assert.equal(shown(studio), before, 'studio state is untouched by the null event');
  } finally { studio.close(); }
});
