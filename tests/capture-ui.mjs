import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

const phase = process.argv[2] ?? 'before';
if (!['before', 'after', 'art'].includes(phase)) throw new Error('Use before, after, or art');
const folder = `artifacts/ui-${phase === 'art' ? 'after' : phase}`;
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
const api = context.request;
const page = await context.newPage();
async function captureArt() {
  const art = await Promise.all(Array.from({ length: 6 }, (_, index) => readFile(`fixtures/art/explorer-${index + 1}.svg`, 'utf8')));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<html lang="en"><title>Original art compositions</title><style>body{margin:0;padding:24px;background:#f8eed5;font:18px sans-serif}main{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}img{width:100%;display:block}figure{margin:0;border:3px solid #171c2c}figcaption{padding:10px}</style><main>${art.map((svg, index) => `<figure><img alt="Original composition ${index + 1}" src="data:image/svg+xml,${encodeURIComponent(svg)}"><figcaption>Composition ${index + 1}</figcaption></figure>`).join('')}</main></html>`);
  await page.screenshot({ path: `${folder}/art-contact-sheet.png`, fullPage: true });
}
if (phase === 'art') {
  await captureArt();
  await browser.close();
  console.log(`Captured six original compositions in ${folder}/art-contact-sheet.png`);
  process.exit(0);
}
await api.post('/api/replay', { data: { fixtureId: 'tabletop-night', speed: 60, style: 'risograph' } });
for (let attempt = 0; attempt < 60; attempt++) {
  const state = await (await api.get('/api/state')).json();
  if (state.pendingPanels.length >= 3) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
await api.post('/api/approve', { data: { all: true } });
const sizes = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }];
async function capture(view, route) {
  for (const viewport of sizes) {
    await page.setViewportSize(viewport);
    await page.goto(route);
    await page.locator('.comic-panel').first().waitFor();
    await page.screenshot({ path: `${folder}/${view}-${viewport.width}x${viewport.height}.png`, fullPage: true, animations: 'disabled', omitBackground: view === 'overlay' });
  }
}
await capture('dashboard', '/dashboard');
await capture('overlay', '/overlay');
const ended = await api.post('/api/end');
if (!ended.ok()) throw new Error(`Export failed: ${await ended.text()}`);
const { recapUrl } = await ended.json();
await capture('recap', recapUrl);
if (phase === 'after') {
  await captureArt();
}
await browser.close();
console.log(`Captured nine populated views in ${folder}`);
