import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { createEventStreamSession, createFetchEventSource, defaultBackoffMs, type StreamTransport } from '../apps/web/src/hooks/useEventStream.ts';

type FakeTransport = StreamTransport & { opened: boolean; closed: boolean; emit(name: string, data: string): void; pulse(): void };

/** A fake StreamTransport plus a factory that records every instance createEventStreamSession builds,
 * so a test can drive "the server" (open/pulse/emit/error) without any real network or EventSource. */
function fakeConnectFactory() {
  const transports: FakeTransport[] = [];
  const connect = (_path: string, onActivity: () => void): StreamTransport => {
    const listeners = new Map<string, ((event: MessageEvent) => void)[]>();
    const transport: FakeTransport = {
      onopen: null, onerror: null, opened: false, closed: false,
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      close() { transport.closed = true; },
      emit(name, data) { for (const listener of listeners.get(name) ?? []) listener(new MessageEvent(name, { data })); },
      pulse() { onActivity(); },
    };
    transports.push(transport);
    return transport;
  };
  return { connect, transports };
}

test('WATCHDOG: silence past watchdogMs closes the transport, reports the error state and reconnects with backoff', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { connect, transports } = fakeConnectFactory();
  const errors: boolean[] = [];
  const session = createEventStreamSession('/api/events', () => {}, ['state'], error => errors.push(error), { watchdogMs: 25000, checkEveryMs: 1000 }, connect);
  session.start();
  assert.equal(transports.length, 1, 'start() opens one transport immediately');
  transports[0]!.onopen?.();
  assert.deepEqual(errors, [false], 'onopen clears the error state');

  t.mock.timers.tick(24000);
  assert.deepEqual(errors, [false], 'no drop before watchdogMs has elapsed');
  assert.equal(transports[0]!.closed, false);

  t.mock.timers.tick(2000); // total silence: 26000ms > 25000ms
  assert.deepEqual(errors, [false, true], 'silence past watchdogMs reports the error state');
  assert.equal(transports[0]!.closed, true, 'the stale transport is closed');

  t.mock.timers.tick(defaultBackoffMs(0) + 10);
  assert.equal(transports.length, 2, 'a reconnect is attempted after the first backoff delay');
  session.stop();
});

test('WATCHDOG: a heartbeat pulse with no named event resets the watchdog, so a healthy-but-idle stream never reports an error', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { connect, transports } = fakeConnectFactory();
  const errors: boolean[] = [];
  const session = createEventStreamSession('/api/events', () => {}, ['state'], error => errors.push(error), { watchdogMs: 25000, checkEveryMs: 1000 }, connect);
  session.start();
  transports[0]!.onopen?.();

  // Mirrors the server's ": hb" comment line every 10s: invisible to onMessage, but it is activity.
  for (let i = 0; i < 9; i++) { t.mock.timers.tick(10000); transports[0]!.pulse(); }
  assert.deepEqual(errors, [false], `heartbeats alone must keep the stream healthy for ${9 * 10000}ms, well past watchdogMs`);
  assert.equal(transports.length, 1, 'no reconnect happened');
  session.stop();
});

test('WATCHDOG: a named event also resets the watchdog, and backoff grows across repeated drops', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { connect, transports } = fakeConnectFactory();
  const errors: boolean[] = [];
  const session = createEventStreamSession('/api/events', () => {}, ['state'], error => errors.push(error), { watchdogMs: 1000, checkEveryMs: 100 }, connect);
  session.start();
  transports[0]!.onopen?.();

  transports[0]!.emit('state', '{}');
  t.mock.timers.tick(900);
  assert.deepEqual(errors, [false, false], 'the named event reset the watchdog, so 900ms of further silence is fine');

  t.mock.timers.tick(200); // total silence since the event: 1100ms > 1000ms
  assert.equal(errors.at(-1), true, 'silence past watchdogMs after the event still trips the watchdog');
  const afterFirstDrop = transports.length;

  // Let every subsequent reconnect attempt go stale immediately, to observe backoff growth.
  for (let attempt = 1; attempt < 4; attempt++) {
    t.mock.timers.tick(defaultBackoffMs(attempt - 1) + 10);
    assert.equal(transports.length, afterFirstDrop + attempt, `attempt ${attempt} reconnected`);
    t.mock.timers.tick(1100);
  }
  assert.ok(errors.filter(e => e === true).length >= 4, 'each stale attempt reports the error state again');
  session.stop();
});

test('WATCHDOG: stop() clears the watchdog and reconnect timers, so nothing fires afterwards', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { connect, transports } = fakeConnectFactory();
  const errors: boolean[] = [];
  const session = createEventStreamSession('/api/events', () => {}, ['state'], error => errors.push(error), { watchdogMs: 1000, checkEveryMs: 100 }, connect);
  session.start();
  session.stop();
  assert.equal(transports[0]!.closed, true, 'stop() closes the open transport');
  t.mock.timers.tick(60000);
  assert.equal(transports.length, 1, 'no reconnect after stop()');
  assert.deepEqual(errors, [], 'no error report after stop()');
});

test('WATCHDOG+SERVER: createFetchEventSource against a real /api/events route stays healthy on heartbeats alone, then reports an error once the server actually goes quiet', { timeout: 20_000 }, async () => {
  const recapDirectory = await mkdtemp(resolve('artifacts/tmp/sse-watchdog-'));
  const app = createApp({ recapDirectory, eventsHeartbeatMs: 40 });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const errors: boolean[] = [];
  const session = createEventStreamSession(`${origin}/api/events`, () => {}, ['state'], error => errors.push(error), { watchdogMs: 300, checkEveryMs: 20 }, createFetchEventSource);
  session.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 900)); // 9 heartbeats at 40ms, 3x the 300ms watchdog
    assert.ok(!errors.includes(true), 'heartbeats every 40ms keep a stream with no state changes looking healthy');
    await app.close();
    await new Promise(resolve => setTimeout(resolve, 600)); // past watchdogMs once the server is gone
    assert.ok(errors.includes(true), 'once heartbeats actually stop, the watchdog reports the error state');
  } finally {
    session.stop();
  }
});
