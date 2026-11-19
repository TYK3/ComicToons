import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { eventBus } from '@comictoons/core';
import { createApp } from '../apps/server/src/app.ts';
import type { UiEvent } from '../apps/web/src/ui/data/adapter.ts';

// HYPE-SPLASH (queue line 26). predictions.ts:58 emits bus 'hype-splash' { level, at } when a hype train
// begins. /api/events forwards it, the ServerAdapter turns it into a UI event, and ui.html#/overlay shows a
// short splash from that level only. A stub fetch and EventSource stand in for the server in the UI tests.
const assetLoader = `export async function load(url, context, next) {
  if (/\\.(webp|png|jpe?g|svg|css|woff2)(\\?.*)?$/.test(url)) return { format: 'module', source: 'export default ' + JSON.stringify(url), shortCircuit: true };
  return next(url, context);
}`;
register('data:text/javascript,' + encodeURIComponent(assetLoader));
const read = (path: string) => readFileSync(new URL(`../apps/web/src/ui/${path}`, import.meta.url), 'utf8');

test('/api/events forwards the hype-splash bus event with its real level and time', async () => {
  const app = createApp({ recapDirectory: await mkdtemp(join(tmpdir(), 'sse-hype-')) });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    // Without the forward no frame ever comes: give up after 3 s so the test fails instead of hanging.
    const giveUp = setTimeout(() => controller.abort(), 3000);
    eventBus.emit('hype-splash', { level: 'loud', at: 1 });
    eventBus.emit('hype-splash', { level: 3, at: 4200 });
    let text = '';
    try {
      while (!text.includes('event: hype-splash')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value!).toString('utf8');
      }
    } catch { /* aborted by giveUp */ }
    clearTimeout(giveUp);
    const frames = text.split('\n\n').filter(frame => frame.startsWith('event: hype-splash'));
    assert.equal(frames.length, 1, 'a malformed payload is not forwarded');
    assert.deepEqual(JSON.parse(frames[0]!.split('\ndata: ')[1]!), { level: 3, at: 4200 });
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally { await app.close(); }
});

type Listener = (event: { data: string }) => void;
class FakeEventSource {
  static CLOSED = 2; static last?: FakeEventSource;
  readyState = 1; listeners = new Map<string, Listener>();
  onerror?: () => void; onopen?: () => void;
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, listener); }
  fire(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  close() { this.readyState = 2; }
}

test('the ServerAdapter turns hype-splash frames into UI events and drops malformed ones', async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { EventSource: g.EventSource, fetch: g.fetch };
  g.EventSource = FakeEventSource;
  g.fetch = async (path: string) => ({ ok: true, status: 200, json: async () => path === '/api/fixtures' ? [] : path === '/api/state' ? { panels: [], pendingPanels: [] } : {} }) as unknown as Response;
  const { ServerAdapter } = await import('../apps/web/src/ui/data/server.ts');
  const adapter = new ServerAdapter();
  await new Promise(resolve => setTimeout(resolve, 20));
  try {
    const seen: UiEvent[] = [];
    adapter.onEvent(['hype-splash'], event => seen.push(event));
    const source = FakeEventSource.last!;
    source.fire('hype-splash', { level: 'x', at: 1 });
    source.fire('hype-splash', { level: 0, at: 1 });
    source.fire('hype-splash', { level: 2, at: 900, extra: 'ignored' });
    assert.deepEqual(seen, [{ name: 'hype-splash', data: { level: 2, at: 900 } }]);
  } finally { adapter.dispose(); g.EventSource = saved.EventSource; g.fetch = saved.fetch; }
});

test('the splash letters only the event level, in a polite status', async () => {
  const { HypeSplash, HYPE_SPLASH_MS } = await import('../apps/web/src/ui/components/HypeSplash.tsx');
  const html = renderToStaticMarkup(createElement(HypeSplash, { level: 4 }));
  assert.match(html, /^<div class="ct-ov-hype" role="status" data-level="4">/);
  assert.match(html, /Hype train!/);
  assert.match(html, /Level 4/);
  assert.doesNotMatch(html, /@|viewers|raid/i, 'no names or counts the event does not carry');
  assert.ok(HYPE_SPLASH_MS >= 2500 && HYPE_SPLASH_MS <= 5000, 'short-lived');
});

test('the overlay shows the splash from the event, steps aside for the catch-up and honours Panic', () => {
  const overlay = read('screens/Overlay.tsx');
  assert.match(overlay, /useUiEvents\(\['catchup', 'hype-splash'\]/);
  assert.match(overlay, /\{splash && !catchup && <HypeSplash level=\{splash\.level\}\/>\}/);
  assert.match(overlay, /if \(event\.name === 'catchup'\) \{ setCatchup\(event\.data\); setSplash\(null\); \}/);
  // Inside the !studio.hidden block, so Panic hides it with everything else.
  const hiddenBlock = overlay.slice(overlay.indexOf('{!studio.hidden && <>'), overlay.indexOf('</>}', overlay.indexOf('{!studio.hidden && <>')));
  assert.match(hiddenBlock, /<HypeSplash/);
});

test('the splash is Bangers in Festival colours, stream-scale, click-through and still under reduced motion', () => {
  const css = read('styles/overlay.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const title = css.match(/\.ct-ov-hype__title\{([^}]*)\}/)?.[1] ?? '';
  assert.match(title, /var\(--f-display\)/);
  assert.ok(Number(title.match(/(\d+)px/)?.[1] ?? 0) >= 120, 'at least 80 px on a 720p source');
  assert.match(title, /color:var\(--hi\)/);
  assert.match(css, /\.ct-ov-hype\{[^}]*pointer-events:none/);
  assert.match(css, /\.ct-ov-hype\{[^}]*animation:ct-ov-hype/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.ct-ov-hype\{animation:none[;}]/);
});

test('the splash and catch-up timers survive re-renders (route.params is a new object on every render)', () => {
  const overlay = read('screens/Overlay.tsx');
  assert.match(overlay, /const frozen = route\.params\.get\('freeze'\) === '1';/);
  assert.match(overlay, /\}, \[splash, frozen\]\);/);
  assert.match(overlay, /\}, \[catchup, frozen\]\);/);
  assert.doesNotMatch(overlay, /\[(catchup|splash), route\.params\]/);
});
