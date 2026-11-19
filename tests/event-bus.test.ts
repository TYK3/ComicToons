import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventBus } from '../packages/core/src/index.ts';

test('a subscriber receives emitted payloads and can unsubscribe itself', () => {
  const bus = createEventBus<{ greeting: string }>();
  const received: string[] = [];
  const unsubscribe = bus.on('greeting', (payload) => received.push(payload));
  bus.emit('greeting', 'hello');
  unsubscribe();
  bus.emit('greeting', 'ignored');
  assert.deepEqual(received, ['hello']);
});

test('off removes a specific handler without affecting other subscribers', () => {
  const bus = createEventBus<{ ping: number }>();
  const first: number[] = [];
  const second: number[] = [];
  const onFirst = (value: number) => first.push(value);
  bus.on('ping', onFirst);
  bus.on('ping', (value) => second.push(value));
  bus.off('ping', onFirst);
  bus.emit('ping', 1);
  assert.deepEqual(first, []);
  assert.deepEqual(second, [1]);
});
