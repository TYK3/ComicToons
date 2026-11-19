import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {obsPorts} from './obs/ports.ts';
import mainConfig from './playwright.config.ts';
import obsConfig from './obs/playwright.config.ts';

test('OBS uses its dedicated lane with explicit overrides ahead of gate lane settings',()=>{
  assert.deepEqual(obsPorts({}),{api:3102,web:4102});
  const gate={COMICTOONS_TWITCH_TEST_APP_PORT:'3102',COMICTOONS_TWITCH_TEST_FAKE_PORT:'4102'};
  assert.deepEqual(obsPorts(gate),{api:3102,web:4102});
  assert.deepEqual(obsPorts({...gate,COMICTOONS_OBS_API_PORT:'3101',COMICTOONS_OBS_WEB_PORT:'4101'}),{api:3101,web:4101});
  for(const value of ['','NaN','1023','65536','3102.5'])assert.throws(()=>obsPorts({COMICTOONS_OBS_API_PORT:value}),/Invalid COMICTOONS_OBS_API_PORT/);
  assert.throws(()=>obsPorts({COMICTOONS_OBS_WEB_PORT:'3102'}),/must differ/);
});
test('OBS is excluded from main e2e and runs separately after it in the gate',()=>{
  assert.equal(mainConfig.testIgnore,'**/obs/**');
  assert.equal(obsConfig.testMatch,'overlay-obs.spec.ts');
  assert.equal(obsConfig.webServer,undefined);
  assert.equal(obsConfig.workers,1);
  const {scripts}=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.match(scripts['test:obs'],/tests\/obs\/playwright.config.ts/);
  assert.match(scripts.gate,/npm run e2e && npm run test:obs &&/);
});
