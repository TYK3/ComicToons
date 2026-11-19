import assert from 'node:assert/strict';
import test,{mock} from 'node:test';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {APP_PORT,FAKE_PORT} from './helpers.ts';
test('mock ports use configured loopback test ports',()=>{
  assert.equal(APP_PORT,Number(process.env.COMICTOONS_TWITCH_TEST_APP_PORT??3120));
  assert.equal(FAKE_PORT,Number(process.env.COMICTOONS_TWITCH_TEST_FAKE_PORT??4120));
});
test('mock child egress guard fails before an external fetch or socket can connect',async()=>{
  const originalFetch=globalThis.fetch,originalConnect=net.Socket.prototype.connect;
  const exit=mock.method(process,'exit',()=>{throw new Error('mock-egress-denied');});
  const warn=mock.method(console,'error',()=>{});
  try{
    await import(new URL('./egress-guard.mjs',import.meta.url).href);
    assert.throws(()=>globalThis.fetch('https://id.twitch.tv/oauth2/validate'),/mock-egress-denied/);
    assert.throws(()=>net.connect(443,'api.twitch.tv'),/mock-egress-denied/);
    assert.equal(exit.mock.callCount(),2);
  }finally{globalThis.fetch=originalFetch;net.Socket.prototype.connect=originalConnect;exit.mock.restore();warn.mock.restore();syncBuiltinESMExports();}
});
