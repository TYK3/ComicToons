import assert from 'node:assert/strict';
import test from 'node:test';
import {clearDirectorKey, DIRECTOR_KEY_HEADER, getDirectorKey, installDirectorKeyTransport,
  listenForDirectorKeyRequired, needsDirectorKey, setDirectorKey, withDirectorKey} from '../apps/web/src/lib/director-key.ts';

type TransportWindow = NonNullable<Parameters<typeof installDirectorKeyTransport>[0]>;
const key = 'test-only-tab-director-key';
const storageKey = 'comictoons.directorKey';
class FakeCustomEvent extends Event {
  readonly detail: unknown;
  constructor(name: string, init?: CustomEventInit) {super(name); this.detail = init?.detail;}
}
function fakeWindow() {
  const values = new Map<string, string>();
  const events: FakeCustomEvent[] = [];
  const calls: {input: RequestInfo | URL; init?: RequestInit}[] = [];
  const controls = {blocked: false, localReads: 0, status: 200, contentType: 'application/json'};
  const win: TransportWindow = {
    location: {href: 'http://localhost:4173/studio'},
    sessionStorage: {
      getItem(name) {if (controls.blocked) throw new Error('Storage unavailable'); return values.get(name) ?? null;},
      setItem(name, value) {if (controls.blocked) throw new Error('Storage unavailable'); values.set(name, value);},
      removeItem(name) {if (controls.blocked) throw new Error('Storage unavailable'); values.delete(name);},
    },
    fetch: (async (input, init) => {
      calls.push({input, init});
      return new Response(controls.contentType === 'text/plain' ? 'Denied' : '{"error":"Enter the director key to use this page."}',
        {status: controls.status, headers: {'content-type': controls.contentType}});
    }) as typeof fetch,
    dispatchEvent(event) {events.push(event as FakeCustomEvent); return true;},
    CustomEvent: FakeCustomEvent as unknown as typeof CustomEvent,
  };
  Object.defineProperty(win, 'localStorage', {get() {controls.localReads++; throw new Error('Never use persistent storage');}});
  return {win, values, events, calls, controls};
}
const header = (init?: RequestInit) => new Headers(init?.headers).get(DIRECTOR_KEY_HEADER);

test('director key uses session storage only, trims input, and forget removes it', () => {
  const {win, values, controls} = fakeWindow();
  assert.equal(getDirectorKey(win), '');
  setDirectorKey(` ${key} `, win);
  assert.deepEqual([...values], [[storageKey, key]]);
  assert.equal(getDirectorKey(win), key);
  clearDirectorKey(win);
  assert.equal(values.has(storageKey), false);
  assert.equal(getDirectorKey(win), '');
  setDirectorKey('  ', win);
  assert.equal(values.has(storageKey), false);
  assert.equal(controls.localReads, 0);
});

test('blocked session storage falls back to memory and Forget clears it without touching local storage', () => {
  const {win, controls} = fakeWindow();
  controls.blocked = true;
  setDirectorKey(key, win);
  assert.equal(getDirectorKey(win), key);
  assert.equal(header(withDirectorKey('/api/stop', {method: 'POST'}, win)), key);
  clearDirectorKey(win);
  assert.equal(getDirectorKey(win), '');
  assert.equal(header(withDirectorKey('/api/stop', {method: 'POST'}, win)), null);
  assert.equal(controls.localReads, 0);
});

test('only same-origin API writes and director desk reads need a key', () => {
  const base = 'http://localhost:4173/studio';
  for (const [method, url] of [
    ['POST', '/api/stop'], ['POST', '/api/replay'], ['POST', '/api/settings'], ['POST', '/api/approve'], ['POST', '/api/participation/director/approve'],
    ['GET', '/api/participation/director'], ['HEAD', '/api/participation/director?view=phone'],
    ['PATCH', '/api/settings'], ['DELETE', '/api/example'],
  ]) assert.equal(needsDirectorKey(method, url, base), true, `${method} ${url}`);
  for (const [method, url] of [
    ['GET', '/api/state'], ['HEAD', '/api/state'], ['OPTIONS', '/api/stop'], ['POST', '/auth/twitch/login'],
    ['POST', 'https://other.invalid/api/stop'], ['GET', '//other.invalid/api/participation/director'],
    ['POST', 'http://localhost:3001/api/stop'],
  ]) assert.equal(needsDirectorKey(method, url, base), false, `${method} ${url}`);
});

test('header attaches to all requested guarded routes but never public reads, cross-origin requests or an empty key', () => {
  const {win, controls} = fakeWindow();
  assert.equal(header(withDirectorKey('/api/stop', {method: 'POST'}, win)), null);
  setDirectorKey(key, win);
  for (const [method, url] of [
    ['POST', '/api/stop'], ['POST', '/api/replay'], ['POST', '/api/settings'], ['POST', '/api/approve'], ['POST', '/api/participation/director/approve'],
    ['GET', '/api/participation/director'], ['HEAD', '/api/participation/director'],
  ]) assert.equal(header(withDirectorKey(url, {method}, win)), key);
  for (const [method, url] of [['GET', '/api/state'], ['POST', 'https://other.invalid/api/stop'], ['POST', '//other.invalid/api/stop']]) {
    assert.equal(header(withDirectorKey(url, {method}, win)), null);
  }
  assert.equal(controls.localReads, 0);
});

test('explicit headers and request options are preserved without mutating the caller', () => {
  const {win} = fakeWindow();
  setDirectorKey(key, win);
  const init = {method: 'POST', body: '{}', headers: {'Content-Type': 'application/json', 'X-ComicToons-Director-Key': 'explicit-test-key'}};
  assert.equal(header(withDirectorKey('/api/stop', init, win)), 'explicit-test-key');
  const original = {method: 'POST', body: '{}', headers: {'Content-Type': 'application/json'}};
  const result = withDirectorKey('/api/stop', original, win);
  assert.equal(result.body, original.body);
  assert.equal(new Headers(result.headers).get('content-type'), 'application/json');
  assert.equal(header(result), key);
  assert.deepEqual(original.headers, {'Content-Type': 'application/json'});
  const request = new Request('http://localhost:4173/api/stop', {method: 'POST', headers: {'x-extra': 'kept'}});
  const fromRequest = withDirectorKey(request, undefined, win);
  assert.equal(header(fromRequest), key);
  assert.equal(new Headers(fromRequest.headers).get('x-extra'), 'kept');
  const explicit = new Request('http://localhost:4173/api/stop', {method: 'POST', headers: {[DIRECTOR_KEY_HEADER]: 'request-test-key'}});
  assert.equal(withDirectorKey(explicit, undefined, win).headers, undefined, 'original Request carries its explicit header');
});

test('transport installs once, reads the latest tab key, and preserves fetch results', async () => {
  const {win, calls} = fakeWindow();
  installDirectorKeyTransport(win);
  const wrapped = win.fetch;
  installDirectorKeyTransport(win);
  assert.equal(win.fetch, wrapped);
  setDirectorKey(key, win);
  const response = await win.fetch('/api/replay', {method: 'POST', body: '{}'});
  assert.equal(calls.length, 1);
  assert.equal(header(calls[0].init), key);
  assert.equal(response.status, 200);
  clearDirectorKey(win);
  await win.fetch('/api/stop', {method: 'POST'});
  assert.equal(header(calls[1].init), null);
});

test('guarded JSON 401 dispatches a key-free event with only status and path, leaving the response readable', async () => {
  const {win, controls, events, calls} = fakeWindow();
  controls.status = 401;
  installDirectorKeyTransport(win);
  installDirectorKeyTransport(win);
  setDirectorKey(key, win);
  const response = await win.fetch('/api/stop?reason=manual', {method: 'POST'});
  assert.equal(calls.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'comictoons:director-key-required');
  assert.deepEqual(events[0].detail, {status: 401, url: '/api/stop'});
  assert.equal(JSON.stringify(events[0].detail).includes(key), false);
  assert.deepEqual(await response.json(), {error: 'Enter the director key to use this page.'});
  clearDirectorKey(win);
  await win.fetch('/api/participation/director');
  assert.equal(events.length, 2, 'missing keys also prompt the UI');
});

test('public or cross-origin 401s and non-JSON responses do not dispatch a director-key event', async () => {
  const {win, controls, events, calls} = fakeWindow();
  controls.status = 401;
  setDirectorKey(key, win);
  installDirectorKeyTransport(win);
  await win.fetch('/api/state');
  await win.fetch('https://other.invalid/api/stop', {method: 'POST'});
  assert.equal(header(calls[1].init), null);
  controls.contentType = 'text/plain';
  await win.fetch('/api/stop', {method: 'POST'});
  assert.equal(events.length, 0);
});


test('director-key-required listener shows fixed guidance, focuses the field and removes itself cleanly',()=>{
  const target=new EventTarget();let message='',focused=0;
  const off=listenForDirectorKeyRequired(value=>{message=value;},()=>{focused++;},target);
  target.dispatchEvent(new FakeCustomEvent('comictoons:director-key-required',{detail:{status:401,url:'/api/replay'}}));
  assert.equal(message,'The studio needs the director key. Enter it below.');assert.equal(focused,1);
  message='';off();target.dispatchEvent(new FakeCustomEvent('comictoons:director-key-required',{detail:{status:401}}));
  assert.equal(message,'');assert.equal(focused,1);
});
