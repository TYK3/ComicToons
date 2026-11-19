import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';

/** Reads from the stream until `ms` of wall time pass, without blocking past that budget. */
async function readFor(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const end = Date.now() + ms;
  for (;;) {
    const remaining = end - Date.now();
    if (remaining <= 0) break;
    const timedOut = Symbol('timeout');
    const timer = new Promise(resolve => setTimeout(() => resolve(timedOut), remaining));
    const result = await Promise.race([reader.read(), timer]);
    if (result === timedOut) break;
    const { done, value } = result as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('/api/events sends an ": hb" comment line on the configured heartbeat interval', async () => {
  const recapDirectory = await mkdtemp(resolve('artifacts/tmp/sse-heartbeat-'));
  const app = createApp({ recapDirectory, eventsHeartbeatMs: 20 });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const text = await readFor(reader, 1000);
    const count = text.split(': hb\n\n').length - 1;
    assert.ok(count >= 3, `expected at least 3 heartbeats within 1s at a 20ms interval, saw ${count}`);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    await app.close();
  }
});

test('/api/events keeps its default 10s heartbeat cadence, so a quick read sees none', async () => {
  const recapDirectory = await mkdtemp(resolve('artifacts/tmp/sse-heartbeat-default-'));
  const app = createApp({ recapDirectory });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const text = await readFor(reader, 300);
    assert.ok(!text.includes(': hb'), 'the default heartbeat (10s) must not fire within 300ms');
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    await app.close();
  }
});
