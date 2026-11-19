import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {mkdir} from 'node:fs/promises';

test('guided demo pauses and resumes without resetting scenes; Library groups saved issues and exports',async({page})=>{
  const writes:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/'))writes.push(request.url());});
  await page.goto('/ui.html#/studio?workspace=sample');
  await expect(page.locator('nav[aria-label=Main]>a')).toHaveText(['Studio','Library']);
  await page.getByRole('button',{name:'Run the stream demo',exact:true}).click();
  await expect.poll(()=>page.locator('.ct-grid .ct-cell').count()).toBeGreaterThanOrEqual(2);
  await page.getByRole('button',{name:'Pause demo',exact:true}).click();
  const count=await page.locator('.ct-grid .ct-cell').count();
  await page.getByRole('button',{name:'Resume demo',exact:true}).click();
  await expect.poll(()=>page.locator('.ct-grid .ct-cell').count()).toBeGreaterThan(count);
  await page.getByRole('button',{name:'Pause demo',exact:true}).click();
  await page.getByRole('link',{name:'Library',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Sample library',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Create & export',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'Library'}).getByRole('link',{name:'Create & export'})).toHaveAttribute('aria-current','page');
  expect(writes).toEqual([]);
});

for(const width of [1242,390])test(`audience view switches catch-up and interactions with keyboard at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/ui.html#/studio?workspace=sample');
  await page.getByRole('button',{name:'Run the stream demo',exact:true}).click();
  await expect.poll(()=>page.locator('.ct-grid .ct-cell').count(),{timeout:15000}).toBeGreaterThanOrEqual(4);
  await page.getByRole('button',{name:'Pause demo',exact:true}).click();
  await page.goto('/ui.html#/audience?workspace=sample');
  await expect(page.getByRole('complementary',{name:'Audience interactions'})).toBeHidden();
  await page.getByRole('button',{name:'Show chat & votes',exact:true}).click();
  await page.getByRole('button',{name:'Vote !2',exact:true}).click();
  await expect(page.getByRole('region',{name:'Audience vote'})).toContainText('4 votes');
  await page.getByLabel('Sample chat',{exact:true}).fill('Hello from the audience');
  await page.getByRole('button',{name:'Send sample chat',exact:true}).click();
  await expect(page.getByRole('list',{name:'Audience chat'})).toContainText('Hello from the audience');
  await page.getByRole('tab',{name:'On air',exact:true}).press('ArrowRight');
  await expect(page.getByRole('tab',{name:'Catch-up',exact:true})).toBeFocused();
  await expect(page.getByRole('tabpanel',{name:'Catch-up',exact:true})).toBeVisible();
  await expect(page.locator('.ct-newcomer__panels .ct-panel')).toHaveCount(4);
  await page.getByLabel('Catch-up window',{exact:true}).selectOption('5');
  await expect(page.getByLabel('Catch-up window',{exact:true})).toHaveValue('5');
  await page.getByLabel('Catch-up window',{exact:true}).selectOption('30');
  await expect(page.getByLabel('Catch-up window',{exact:true})).toHaveValue('30');
  await page.getByRole('button',{name:'Hide interactions',exact:true}).click();
  await page.getByRole('button',{name:'Join as a new viewer',exact:true}).click();
  await expect(page.locator('.ct-newcomer h2')).toContainText('Welcome, SampleGuest');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const serious=(await new AxeBuilder({page}).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical');expect(serious).toEqual([]);
  await mkdir('artifacts/qa/ux-refinement',{recursive:true});
  await page.screenshot({path:`artifacts/qa/ux-refinement/audience-${width}.jpg`,type:'jpeg',quality:85});
  await page.getByRole('link',{name:'Sample Studio',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'Main'}).getByRole('link',{name:'Library',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`artifacts/qa/ux-refinement/studio-${width}.jpg`,type:'jpeg',quality:85});
});

test('reading another channel posts only ingest and never starts video capture or changes role',async({page,request})=>{
  let state=await (await request.get('/api/state')).json();const posts:{path:string;body:unknown}[]=[];
  await page.addInitScript(()=>{class Events{static CLOSED=2;readyState=1;addEventListener(){}close(){}}window.EventSource=Events as unknown as typeof EventSource;});
  await page.route('**/api/twitch/status',route=>route.fulfill({json:{configured:true,connected:true,login:'owner',scopes:[],missingScopes:[],broadcaster_type:'affiliate'}}));
  await page.route('**/api/state',route=>route.fulfill({json:state}));
  await page.route('**/api/ingest',async route=>{const body=route.request().postDataJSON();posts.push({path:'/api/ingest',body});state={...state,source:{requested:'twitch',active:'twitch',connection:'live',channel:body.channel,simulated:false,received:1}};await route.fulfill({json:state});});
  await page.route('**/api/watch/**',route=>{if(route.request().method()==='POST')posts.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});return route.fulfill({status:404,json:{error:'No viewing session'}});});
  await page.goto('/ui.html#/studio?workspace=live');
  await page.getByText('Read public chat only',{exact:true}).click();
  await page.getByRole('textbox',{name:'Read another channel',exact:true}).fill('another_streamer');
  await page.getByRole('button',{name:'Read chat',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Reading #another_streamer'})).toBeVisible();
  expect(posts).toEqual([{path:'/api/ingest',body:{mode:'twitch',channel:'another_streamer',fresh:true,chatOnly:true}}]);
  await expect(page.locator('.ct-studio')).toBeVisible();
});

test('approved history reports unavailable then retries to a genuine empty state',async({page})=>{
  await page.addInitScript(()=>sessionStorage.setItem('comictoons-role','viewer'));
  const snapshot={id:'viewer',role:'viewer',channel:'qa_owner',state:'idle',elapsed:0,frames:[],chat:[],pages:[],events:[],received:0,chatConnection:'stopped',generator:{provider:'openai',model:'gpt-image-1.5',configured:false,used:0,maxPages:3}};
  await page.route('**/api/watch',route=>route.fulfill({json:snapshot}));
  let failed=true;
  await page.route('**/api/watch/approved?*',route=>route.fulfill(failed?{status:503,json:{error:'Unavailable'}}:{json:{panels:[]}}));
  await page.goto('/ui.html#/viewer');
  const feed=page.getByRole('region',{name:'Broadcaster approved catch-up'});
  await expect(feed.getByRole('alert')).toContainText('Could not load');
  await expect(feed).not.toContainText('No approved images have been released');
  failed=false;await feed.getByRole('button',{name:'Retry approved history'}).click();
  await expect(feed).toContainText('No approved images have been released');
  await expect(feed.getByRole('alert')).toHaveCount(0);
});
