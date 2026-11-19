import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eventBus } from '@comictoons/core';
import { createApp } from '../apps/server/src/app.ts';

test('/api/events streams a first state frame and closes cleanly on abort', async () => {
  const recapDirectory = await mkdtemp(resolve('artifacts/tmp/sse-scenario-'));
  const app = createApp({ recapDirectory });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = response.body!.getReader();
    const { value, done } = await reader.read();
    assert.equal(done, false);
    const chunk = Buffer.from(value!).toString('utf8');
    assert.match(chunk, /^event: state\ndata: /);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    await app.close();
  }
});

test('/api/events forwards catch-up bus events with the same summary as /api/catchup', async () => {
  const recapDirectory = await mkdtemp(resolve('artifacts/tmp/sse-catchup-'));
  const app = createApp({ recapDirectory });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    eventBus.emit('catchup', { reason: 'raid', raider: 'quietkoi', viewers: 48 });
    let text = '';
    while (!text.includes('event: catchup')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value!).toString('utf8');
    }
    const frame = text.slice(text.indexOf('event: catchup')).split('\n\n')[0]!;
    const data = JSON.parse(frame.split('\ndata: ')[1]!);
    const expected = (await app.inject('/api/catchup')).json();
    assert.equal(data.raidLine, 'quietkoi raided with 48 viewers! Here’s what you missed.');
    assert.equal(data.minutes, expected.minutes);
    assert.equal(data.panelCount, expected.panelCount);
    eventBus.emit('catchup', { minutes: 0 });
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    await app.close();
  }
});
