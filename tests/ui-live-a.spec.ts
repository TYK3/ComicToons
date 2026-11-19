import {expect,test} from '@playwright/test';

// UI-LIVE-A (report-ui-r1 UI-HEAD #1 and #3): the shipped ui.html on the server adapter loses the studio
// for 8 s and must come back by itself. The page's network is cut (context offline), so its event stream
// and every fetch fail as they do when the API stops; meanwhile the API moves on to 4 panels on air.
// Sample data only, ports from COMICTOONS_E2E_API_PORT / COMICTOONS_E2E_WEB_PORT, no real Twitch.
test('UI-LIVE-A-PAGE: 8 s without the API shows the lost banner, then 4 panels with no reload',async({page,context,request})=>{
  test.setTimeout(90_000);
  const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));
  let navigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
  await request.post('/api/stop');await request.post('/api/settings',{data:{approvalMode:true}});
  await request.post('/api/replay',{data:{fixtureId:'tabletop-night',speed:60}});
  try{
    await page.goto('/ui.html#/studio');
    await expect(page.getByRole('list',{name:/^[1-9]\d* panels?$/})).toBeVisible({timeout:20_000});
    const loadedNavigations=navigations;

    // LOAD-FLAKE-1: offline emulation leaves the open event stream alone (no error event fires), so the page first
    // notices through its 5 s participation poll: the banner showed 5.4 s after going offline at load 4, which left
    // the old 6 s budget 0.6 s. 12 s is about 2.2x the measured 5.4 s; a page that never notices still fails at 12 s.
    const offlineAt=Date.now();
    await context.setOffline(true);
    await expect(page.getByText(/lost its connection|Connection lost|Reconnecting/).first()).toBeVisible({timeout:12_000});
    test.info().annotations.push({type:'lost-banner',description:`${Date.now()-offlineAt} ms after offline`});
    // While the page is cut off, the studio carries on: approval off and a fresh replay put 4 panels on air.
    await request.post('/api/settings',{data:{approvalMode:false}});
    await request.post('/api/replay',{data:{fixtureId:'tabletop-night',speed:60}});
    await expect.poll(async()=>((await (await request.get('/api/state')).json()) as {panels:unknown[]}).panels.length,{timeout:30_000}).toBe(4);
    await page.waitForTimeout(8_000);
    await expect(page.getByText(/lost its connection|Connection lost|Reconnecting/).first()).toBeVisible();
    await context.setOffline(false);

    await expect(page.getByRole('list',{name:'4 panels'})).toBeVisible({timeout:20_000});
    await expect(page.getByText(/lost its connection|Connection lost|Reconnecting/)).toHaveCount(0);
    expect(navigations,'no reload').toBe(loadedNavigations);
    expect(pageErrors.filter(message=>/The server said|Failed to fetch/.test(message)),'no unhandled errors from polling while offline').toEqual([]);
  }finally{
    await context.setOffline(false);
    await request.post('/api/stop');await request.post('/api/settings',{data:{approvalMode:true}});
  }
});
