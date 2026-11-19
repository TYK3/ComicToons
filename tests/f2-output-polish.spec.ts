import {test, expect, type APIRequestContext} from '@playwright/test';

async function approvedState(request: APIRequestContext) {
  await request.post('/api/stop');
  await request.post('/api/replay', {data: {fixtureId: 'tabletop-night', speed: 60}});
  await expect.poll(async () => { await request.post('/api/approve', {data: {all:true}}); return (await (await request.get('/api/state')).json()).panels.length; }, {timeout: 40000}).toBeGreaterThanOrEqual(3);
  return (await request.get('/api/state')).json();
}

test('series Watch link clears the text above and Save PNG beside it', async ({page, request}) => {
  await approvedState(request);
  const id = (await (await request.post('/api/recaps')).json()).recapUrl.split('/').at(-1);
  const series = await (await request.get(`/api/series/${id}`)).json();
  series.episodes[0].highlight.clipUrl = 'https://clips.twitch.tv/ExampleMockedForQA';
  await page.route(`**/api/series/${id}`, route => route.fulfill({json: series}));
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 1000});
    await page.goto(`/series/${id}`);
    const watch = page.getByRole('link', {name: 'Watch the clip on Twitch ↗'});
    await expect(watch).toHaveCSS('margin-top', '12px');
    await watch.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    const box = await watch.evaluate(el => {
      const style = getComputedStyle(el), ring = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      const r = el.getBoundingClientRect(), above = el.previousElementSibling!.getBoundingClientRect(), save = el.nextElementSibling!.getBoundingClientRect();
      const sameRow = save.top < r.bottom && save.bottom > r.top;
      return {ring, above: r.top - above.bottom, beside: sameRow ? save.left - r.right : save.top - r.bottom};
    });
    expect(box.above, `${width}: gap above`).toBeGreaterThan(box.ring);
    expect(box.beside, `${width}: gap before Save PNG`).toBeGreaterThan(box.ring);
  }
});

test('390 overlay catch-up keeps the caption and art-source labels inside each panel', async ({page, request}) => {
  await approvedState(request);
  await page.setViewportSize({width: 390, height: 1000});
  await page.goto('/overlay'); await page.waitForTimeout(600);
  await request.post('/api/catchup', {data: {minutes: 60}});
  await expect(page.getByRole('heading', {name: 'PREVIOUSLY ON…'})).toBeVisible({timeout: 2000});
  const panels = page.locator('.s3-overlay-panels .s3-panel');
  await expect(panels).toHaveCount(3); await page.waitForTimeout(2800);
  for (const panel of await panels.all()) {
    await expect(panel.locator('.s3-balloon small')).toHaveText('Generated caption');
    await expect(panel.locator('.s3-balloon small')).toBeVisible();
    await expect(panel.locator('.s3-source')).toBeVisible();
    await expect(panel.locator('.s3-source')).toContainText('Generated art');
    const fits = await panel.evaluate(el => {
      const p = el.getBoundingClientRect();
      return [...el.querySelectorAll('.s3-balloon,.s3-source')].every(node => { const r = node.getBoundingClientRect(); return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom; });
    });
    expect(fits).toBe(true);
  }
});

test('manga page shows a silent panel and crops each split frame differently', async ({page, request}) => {
  const state = await approvedState(request);
  const [a, b] = state.panels;
  const four = ['We made it. Where is the key?', 'CHAT: This place is HUGE.', 'CHAT: the fox has it', 'CHAT: run run run'];
  const crafted = {...state, status: 'live', panels: [
    {...a, id: 'f2-four', at: 10, dialogue: four, storyCaption: a.caption, storyBeats: [{...a.storyBeats[0], dialogue: four}]},
    {...b, id: 'f2-silent', at: 20, dialogue: [], sfx: undefined, storyCaption: b.caption, storyBeats: [{...b.storyBeats[0], dialogue: [], sfx: ''}]},
  ]};
  await page.route('**/api/state', route => route.fulfill({json: crafted}));
  await page.route('**/api/events', route => route.abort());
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 1000});
    await page.goto('/overlay');
    await expect(page.locator('.manga-cell')).toHaveCount(3);
    await expect(page.locator('.manga-cell[data-source-id="f2-silent"] .story-balloon')).toHaveText(b.caption);
    await expect(page.locator('.manga-cell[data-source-id="f2-silent"] img')).toBeVisible();
    const four = page.locator('.manga-cell[data-source-id="f2-four"]');
    await expect(four).toHaveCount(2);
    const framing = await four.evaluateAll(cells => cells.map(cell => { const img = cell.querySelector('img')!, s = getComputedStyle(img); return `${img.getAttribute('src')}|${s.transform}|${s.transformOrigin}`; }));
    expect(new Set(framing).size).toBe(2);
    await expect(four.nth(1)).toHaveAttribute('data-shot', '1');
  }
});
