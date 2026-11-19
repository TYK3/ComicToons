// Records the ComicToons Sample demo as separate 1920x1080 clips with Playwright.
// Usage: serve apps/web/dist-demo on :5190, then `node video/capture/record.mjs` (run from the repo root).
import {chromium} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const BASE = process.env.DEMO_BASE ?? 'http://localhost:5190/demo.html';
const OUT = process.env.CLIP_DIR ?? 'video/public/clips';
const STATE = path.resolve('video/capture/.state.json');
fs.mkdirSync(OUT, {recursive: true});

const cursorScript = () => {
  const make = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div');
    c.id = '__cur';
    c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;margin:-4px 0 0 -4px;z-index:2147483647;pointer-events:none;transition:none;';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2l17 9-7 2-3 7z" fill="#fff" stroke="#142b36" stroke-width="2" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    window.addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', e => {
      const r = document.createElement('div');
      r.style.cssText = `position:fixed;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;border:4px solid #ee6471;z-index:2147483646;pointer-events:none;`;
      document.documentElement.appendChild(r);
      r.animate([{transform: 'scale(.3)', opacity: 1}, {transform: 'scale(1.6)', opacity: 0}], {duration: 600}).onfinish = () => r.remove();
    }, true);
  };
  if (document.readyState !== 'loading') make(); else document.addEventListener('DOMContentLoaded', make);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
let cx = 960, cy = 540;
async function move(p, x, y, steps = 28) {
  const sx = cx, sy = cy;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await p.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
    await sleep(14);
  }
  cx = x; cy = y;
}
async function hover(p, loc) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  await move(p, b.x + b.width / 2, b.y + b.height / 2);
}
async function click(p, loc, after = 700) {
  await hover(p, loc);
  await sleep(250);
  await p.mouse.down(); await sleep(60); await p.mouse.up();
  await sleep(after);
}
async function scrollBy(p, dy, ms = 2400) {
  const steps = Math.round(ms / 40);
  for (let i = 0; i < steps; i++) { await p.mouse.wheel(0, dy / steps); await sleep(40); }
}

const browser = await chromium.launch({channel: 'chrome', args: ['--no-sandbox', '--force-device-scale-factor=1']});
const results = {};

async function scene(name, fn, {extra} = {}) {
  const dir = path.resolve(OUT, '_tmp_' + name);
  fs.rmSync(dir, {recursive: true, force: true});
  const ctx = await browser.newContext({
    viewport: {width: 1920, height: 1080},
    recordVideo: {dir, size: {width: 1920, height: 1080}},
    storageState: fs.existsSync(STATE) ? STATE : undefined,
  });
  await ctx.addInitScript(cursorScript);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(name, 'pageerror', e.message));
  cx = 960; cy = 540;
  const t0 = Date.now();
  await fn(page, ctx);
  await sleep(600);
  await ctx.storageState({path: STATE});
  const vids = (await Promise.all(ctx.pages().map(async pg => ({pg, v: pg.video()})))).filter(x => x.v);
  await ctx.close();
  const picked = vids[extra?.pickPage ?? 0];
  const src = await picked.v.path();
  const dest = path.resolve(OUT, name + '.webm');
  fs.copyFileSync(src, dest);
  fs.rmSync(dir, {recursive: true, force: true});
  results[name] = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('scene', name, results[name], 's');
}

const go = (p, hash) => p.goto(BASE + hash);
const only = process.argv[2];
const run = (name, fn, o) => (!only || only === name) ? scene(name, fn, o) : null;

// Fresh state for the first scene
if (!only && fs.existsSync(STATE)) fs.rmSync(STATE);

await run('landing', async p => {
  await go(p, '#/');
  await sleep(3200);
  await scrollBy(p, 760, 3000); await sleep(1800);
  await scrollBy(p, 900, 3000); await sleep(1800);
  await scrollBy(p, 900, 3000); await sleep(1500);
  await scrollBy(p, -2600, 1800); await sleep(800);
  for (const t of ['Sunset', 'Lagoon', 'Blossom', 'Festival']) {
    const btn = p.locator(`button:has-text("${t}")`).first();
    await click(p, btn, 1500);
  }
});

await run('connect', async p => {
  await go(p, '#/connect?workspace=live');
  await sleep(2500);
  await hover(p, p.locator('button:has-text("Connect with Twitch")').first());
  await sleep(1800);
  await scrollBy(p, 500, 2200);
  await sleep(2500);
  await scrollBy(p, -500, 1500);
  await sleep(1000);
});

await run('studio', async p => {
  await go(p, '#/studio?workspace=sample');
  await sleep(2800);
  await click(p, p.locator('button:has-text("Run demo")').first(), 500);
  await move(p, 1000, 700);
  await sleep(26000);
  await scrollBy(p, 700, 2500); await sleep(1800);
  await scrollBy(p, -700, 1500); await sleep(800);
  await click(p, p.locator('button:has-text("Simulate viewers")').first(), 900);
  await click(p, p.locator('button:has-text("Simulate viewer joining")').first(), 2800);
  await click(p, p.locator('button:has-text("Simulate viewers")').first(), 700);
  await click(p, p.locator('button:has-text("Simulate a raid")').first(), 2800);
  await click(p, p.locator('button:has-text("Simulate viewers")').first(), 700);
  await click(p, p.locator('button:has-text("Try voting")').first(), 3200);
});

await run('audience', async p => {
  await go(p, '#/audience?workspace=sample');
  await sleep(3000);
  await click(p, p.locator('button:has-text("Catch-up")').first(), 3500);
  await click(p, p.locator('button:has-text("On air")').first(), 2500);
  await click(p, p.locator('button:has-text("Show chat & votes")').first(), 3500);
  await scrollBy(p, 400, 1500); await sleep(1500);
});

await run('catchup', async p => {
  await go(p, '#/catchup?workspace=sample');
  await sleep(3000);
  await scrollBy(p, 500, 2500); await sleep(1800);
  await scrollBy(p, -500, 1500);
  await click(p, p.locator('button:has-text("15 min")').first(), 2200);
  await click(p, p.locator('button:has-text("30 min")').first(), 2200);
});

await run('output', async p => {
  await go(p, '#/issues?workspace=sample');
  await sleep(2800);
  await scrollBy(p, 600, 2200); await sleep(1500);
  await go(p, '#/output?workspace=sample');
  await sleep(3000);
  await hover(p, p.locator('a:has-text("RECAP")').first()); await sleep(1500);
  await hover(p, p.locator('a:has-text("COMIC BOOK")').first()); await sleep(1500);
  await hover(p, p.locator('a:has-text("MANGA SERIES")').first()); await sleep(1500);
  await hover(p, p.locator('a:has-text("CATCH-UP")').first()); await sleep(1500);
});

await run('recap', async p => {
  await go(p, '#/recap/sample-tabletop-night?workspace=sample');
  await sleep(3000);
  await scrollBy(p, 900, 3500); await sleep(1500);
  await scrollBy(p, 900, 3500); await sleep(1500);
  await scrollBy(p, 900, 3500); await sleep(1200);
});

await run('book', async p => {
  await go(p, '#/book/sample-tabletop-night?workspace=sample');
  await sleep(3000);
  for (let i = 0; i < 4; i++) { await click(p, p.locator('button:has-text("Next")').first(), 2400); }
});

await run('manga', async p => {
  await go(p, '#/series/sample-tabletop-night?workspace=sample');
  await sleep(3000);
  await scrollBy(p, 900, 3500); await sleep(1500);
  await scrollBy(p, 900, 3500); await sleep(1500);
  await scrollBy(p, 900, 3500); await sleep(1200);
});

await run('overlay', async (p, ctx) => {
  // Page 0 = overlay (recorded). Page 1 = hidden Studio tab driving the Sample run.
  const studio = await ctx.newPage();
  await go(studio, '#/studio?workspace=sample');
  await sleep(1500);
  await go(p, '#/overlay?workspace=sample&obs=1');
  await p.addStyleTag({content: 'html,body,#root{background:linear-gradient(135deg,#111827,#1f2a44 55%,#3b2f4f) !important;min-height:100vh}'});
  await sleep(1500);
  await studio.locator('button:has-text("Run demo")').first().click();
  await sleep(34000);
}, {extra: {pickPage: 0}});

if (!only || only === 'hero') {
  const ctx = await browser.newContext({viewport: {width: 1920, height: 1080}});
  const page = await ctx.newPage();
  await go(page, '#/');
  await sleep(3500);
  await page.screenshot({path: path.join(OUT, 'hero.png')});
  await ctx.close();
}
await browser.close();

// Remotion reads 30 fps H.264, so convert every recorded WebM.
for (const f of fs.readdirSync(OUT).filter(n => n.endsWith('.webm'))) {
  const src = path.join(OUT, f);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', 'fps=30,scale=1920:1080:flags=lanczos', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '15', '-an', src.replace(/\.webm$/, '.mp4')]);
}
console.log(JSON.stringify(results));
