import {expect,test} from './app-fixture';
import {mkdir} from 'node:fs/promises';
import {capture} from './screenshot';

test('T20-UI: the chat-source card shows the transport next to Live chat, and nothing for Sample Data',async({page,request})=>{
  await request.post('/api/stop');
  const real=await(await request.get('/api/state')).json() as Record<string,unknown>;
  let source:Record<string,unknown>={requested:'twitch',active:'twitch',connection:'live',channel:'approved_test',simulated:false,received:12,transport:'wss'};
  await page.route('**/api/events**',route=>route.abort());
  await page.route('**/api/state',route=>route.fulfill({json:{...real,source}}));
  await page.goto('/studio');
  await expect(page.getByTestId('source-label')).toHaveText('Live chat');
  await expect(page.getByTestId('source-transport')).toHaveText('· WSS 443');
  await expect(page.getByTestId('source-heading')).toHaveText('Live chat · WSS 443');
  await mkdir('artifacts/transport-label',{recursive:true});
  await capture(page,{path:'artifacts/transport-label/studio-wss.jpg'});
  source={...source,transport:'tls'};
  await expect(page.getByTestId('source-heading')).toHaveText('Live chat · TLS 6697');
  source={requested:'sample',active:'sample',connection:'sample',simulated:false,received:0};
  await expect(page.getByTestId('source-label')).toHaveText('Sample Data');
  await expect(page.getByTestId('source-transport')).toHaveCount(0);
  await expect(page.getByTestId('source-heading')).toHaveText('Sample Data');
});
