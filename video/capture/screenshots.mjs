// Captures the README screenshots from the static Sample demo. Run from the repo root with dist-demo served on :5190.
import {chromium} from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.DEMO_BASE ?? 'http://localhost:5190/demo.html';
const OUT = 'docs/media';
fs.mkdirSync(OUT, {recursive: true});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({channel: 'chrome', args: ['--no-sandbox']});
const ctx = await browser.newContext({viewport: {width: 1600, height: 900}});
const p = await ctx.newPage();
const shot = async (name, hash, wait = 2500, fn) => {
  await p.goto(BASE + hash); await sleep(wait);
  if (fn) await fn();
  await p.screenshot({path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 88});
  console.log('shot', name);
};

await shot('landing', '#/', 3000);
await shot('connect', '#/connect?workspace=live');
// Studio, mid-run
await p.goto(BASE + '#/studio?workspace=sample'); await sleep(2000);
await p.locator('button:has-text("Run demo")').first().click(); await sleep(9000);
await p.screenshot({path: `${OUT}/studio-running.jpg`, type: 'jpeg', quality: 88}); console.log('shot studio-running');
await sleep(24000);
await p.screenshot({path: `${OUT}/studio-finished.jpg`, type: 'jpeg', quality: 88}); console.log('shot studio-finished');
await shot('studio-viewers', '#/studio?workspace=sample', 2500, async () => {
  await p.locator('button:has-text("Simulate viewers")').first().click(); await sleep(600);
  await p.locator('button:has-text("Simulate viewer joining")').first().click(); await sleep(1500);
});
await shot('audience', '#/audience?workspace=sample', 3000, async () => {
  await p.locator('button:has-text("Show chat & votes")').first().click(); await sleep(1500);
});
await shot('catchup', '#/catchup?workspace=sample', 3000);
await shot('library', '#/issues?workspace=sample');
await shot('export', '#/output?workspace=sample');
await shot('recap', '#/recap/sample-tabletop-night?workspace=sample', 3000);
await shot('book', '#/book/sample-tabletop-night?workspace=sample', 3000, async () => {
  await p.locator('button:has-text("Next")').first().click(); await sleep(1500);
});
await shot('manga', '#/series/sample-tabletop-night?workspace=sample', 3000);
// Overlay on a dark canvas (the overlay itself is transparent for OBS)
const studio = await ctx.newPage();
await studio.goto(BASE + '#/studio?workspace=sample'); await sleep(1500);
await p.goto(BASE + '#/overlay?workspace=sample&obs=1'); await sleep(1200);
await p.addStyleTag({content: 'html,body,#root{background:linear-gradient(135deg,#111827,#1f2a44 55%,#3b2f4f) !important;min-height:100vh}'});
await studio.locator('button:has-text("Run demo")').first().click(); await sleep(14000);
await p.screenshot({path: `${OUT}/overlay.jpg`, type: 'jpeg', quality: 88}); console.log('shot overlay');
await studio.close();
// Phone audience view
const phone = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true});
const m = await phone.newPage();
await m.goto(BASE + '#/audience?workspace=sample'); await sleep(2500);
await m.locator('button:has-text("Join as a new viewer")').first().click().catch(() => {}); await sleep(1500);
await m.screenshot({path: `${OUT}/audience-phone.jpg`, type: 'jpeg', quality: 88}); console.log('shot audience-phone');
await browser.close();
