import {existsSync,readFileSync} from 'node:fs';
import {expect,test} from './app-fixture';
import type {StudioState} from '../apps/server/src/studio.ts';

/** IRC-ENV-1 / TEST-ENV-1: an operator shell that exports anonymous chat and client credentials
 * must not turn the e2e suite into a live Twitch client. The ambient values are planted in this
 * worker before the fixture app is created; the fixture's injected env must win. */
const AMBIENT={COMICTOONS_TWITCH_ANON:'1',TWITCH_CLIENT_ID:'no-live-dial-dummy-id',TWITCH_CLIENT_SECRET:'no-live-dial-dummy-value'};
const saved:Record<string,string|undefined>={};
const loopback=(host:string)=>host==='localhost'||host==='[::1]'||host==='::1'||/^127\./.test(host);
const guardEntries=()=>{
  const log=process.env.COMICTOONS_NET_GUARD_LOG;
  if(!log||!existsSync(log))throw new Error('tests/net-guard.mjs is not active: COMICTOONS_NET_GUARD_LOG is missing');
  return readFileSync(log,'utf8').split('\n').filter(Boolean).map(line=>{const {host,port,via,at}=JSON.parse(line) as Record<string,unknown>;return {host,port,via,at};});
};

test.beforeAll(()=>{for(const [name,value] of Object.entries(AMBIENT)){saved[name]=process.env[name];process.env[name]=value;}});
test.afterAll(()=>{for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}});

test('NO-LIVE-DIAL: ambient ANON=1 and client credentials do not dial Twitch from "Try read-only Twitch"',async({page,request,context})=>{
  expect(process.env.NODE_OPTIONS??'','the worker runs under tests/net-guard.mjs').toContain('net-guard.mjs');
  const before=guardEntries().length;
  const foreign:string[]=[];
  await context.route('**',async route=>{
    const host=new URL(route.request().url()).hostname;
    if(loopback(host)){await route.fallback();return;}
    foreign.push(host);await route.abort('blockedbyclient');
  });
  await request.post('/api/stop');
  await page.goto('/studio');await page.getByLabel('Twitch channel',{exact:true}).fill('approved_test');
  await page.getByRole('button',{name:'Try read-only Twitch',exact:true}).click();
  await expect(page.getByTestId('source-label')).toHaveText('Sample Data');
  const state=(await(await request.get('/api/state')).json()) as StudioState;
  expect(state.source).toMatchObject({requested:'twitch',active:'sample',reason:'unauthenticated'});
  await page.waitForTimeout(1_000);
  expect(guardEntries().slice(before),'no Node process may look up or connect to a non-loopback host').toEqual([]);
  expect(foreign,'the browser may not request a non-loopback URL').toEqual([]);
});
