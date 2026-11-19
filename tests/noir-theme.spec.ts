import { expect, test, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { sampleStory } from '../packages/core/src/index.ts';
import type { StudioState } from '../apps/web/src/types';
import { capture } from './screenshot';

const evidence = 'artifacts/noir-theme';
const manifest: { file: string; style: string }[] = JSON.parse(readFileSync(new URL('../fixtures/art/generated/manifest.json', import.meta.url), 'utf8'));
const state = async (request: APIRequestContext): Promise<StudioState> => (await request.get('/api/state')).json();
// A Sample replay is drawn from that sample's own story frames only (SAMPLE-ART-2): they are not in the shared
// manifest and must never be another sample's frames or library art. Their label is the requested direction (TH-ART).
function assertStyle(current: StudioState, style: string) {
  const panels = [...current.panels, ...current.pendingPanels];
  expect(panels).toHaveLength(4);
  expect(new Set(panels.map(panel => panel.imageUrl)).size).toBe(4);
  const own = sampleStory(current.fixtureId)?.asset;
  for (const panel of panels) {
    if (own) {
      expect(panel.provenance).toMatchObject({ provider: 'library', style, fallback: false });
      expect(panel.provenance?.asset).toMatch(new RegExp(`^panel-story-${own}-\\d+\\.png$`));
      expect(manifest.find(entry => entry.file === panel.provenance?.asset)).toBeUndefined();
      expect(panel.imageUrl).toBe(`/art/generated/${panel.provenance!.asset}`);
      continue;
    }
    expect(panel.provenance).toMatchObject({ provider: 'library', style, fallback: false });
    const asset = manifest.find(entry => entry.file === panel.provenance?.asset);
    expect(asset?.style).toBe(style);
    expect(panel.imageUrl).toBe(`/art/generated/${asset!.file}`);
  }
}
async function reset(request: APIRequestContext) {
  expect((await request.post('/api/stop')).ok()).toBeTruthy();
  expect((await request.post('/api/settings', { data: { approvalMode: true } })).ok()).toBeTruthy();
}
// TH-FLAKE-1: a replay is wall-clock time on the server (duration / speed: 1440 s at 60x is 24 s), so the wait
// for 'ready' starts only once this replay is seen running and is budgeted from the server's own remaining clock
// plus fixed slack. A late start under load no longer eats the margin, a stale 'ready' from the previous replay
// cannot pass, and a stalled or slowed replay still fails here, with its progress in the message.
const replayStartMs = 15_000;
// Slack: 'ready' was seen up to 6.5 s after the replay clock ran out at load 42-52; 15 s is about 2.3x that.
const replaySlackMs = 15_000;
async function replayFinished(request: APIRequestContext) {
  const asked = Date.now();
  await expect.poll(async () => (await state(request)).status, { message: 'replay started', timeout: replayStartMs, intervals: [100, 250] }).toBe('replaying');
  const { duration = 0, elapsed = 0, speed } = await state(request);
  expect(speed).toBe(60);
  expect(duration).toBeGreaterThan(0);
  const clockMs = (duration - elapsed) / speed * 1000;
  const seen = Date.now();
  const startMs = seen - asked;
  await expect.poll(async () => { const now = await state(request); return now.status === 'ready' ? 'ready' : `${now.status} at ${now.elapsed}/${now.duration}`; }, { message: 'replay finished', timeout: clockMs + replaySlackMs, intervals: [250] }).toBe('ready');
  test.info().annotations.push({ type: 'replay-ready', description: `start seen after ${startMs} ms, clock ${Math.round(clockMs)} ms, ready seen after ${Date.now() - seen} ms` });
}
// Without these an action or navigation is bounded only by the whole-test timeout. Clicks, page loads and evaluations
// here took at most 0.6 s at load 8-15 (traced, report-th-flake-1); a stuck one now fails within 15 s / 30 s.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test('TH-1: keyboard Noir selection generates matching art and Pop can be restored on the next replay', async ({ page, request, context }) => {
  // Two replays are 48 s of server clock under any load. The whole test measured 51-54 s at load 10-45 and 60 s at
  // load 42-52; 120 s is twice that worst case. The per-step budgets above fail a hang well before it.
  test.setTimeout(120_000);
  await mkdir(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await reset(request);
  await page.goto('/studio');
  await page.getByRole('tab', { name: /Festival colour/ }).focus();
  await page.keyboard.press('ArrowRight');
  const noir = page.getByRole('tab', { name: /Midnight noir/ });
  await expect(noir).toBeFocused();
  await expect(noir).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('After-hours ink');
  const replay = page.waitForResponse(response => response.url().endsWith('/api/replay') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start replay', exact: true }).click();
  expect((await replay).request().postDataJSON()).toMatchObject({ style: 'noir', speed: 60 });
  await replayFinished(request);
  assertStyle(await state(request), 'midnight-noir');
  await expect(page.getByTestId('approval-queue').locator('.queue-card img')).toBeVisible();
  expect((await request.post('/api/approve', { data: { all: true } })).ok()).toBeTruthy();
  // The approval reaches the page over the event stream (pushed every 500 ms): 0.4 s measured at load 10; 15 s
  // covers a saturated box, where the 5 s default failed with 0 panels.
  await expect(page.locator('.preview-stage .comic-panel')).toHaveCount(6, { timeout: 15_000 });
  for (const image of await page.locator('.preview-stage .panel-art img').all()) {
    await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  const overlay = await context.newPage();
  await overlay.goto('/overlay');
  await expect(overlay.locator('.comic-panel')).toHaveCount(6, { timeout: 15_000 });
  await expect(overlay.locator('.story-panel').first()).toHaveAttribute('data-story-style', 'midnight-noir');
  const approved = await state(request);
  for (const image of await overlay.locator('.panel-art img').all()) {
    expect(approved.panels.flatMap(panel => panel.storyBeats?.map(beat => beat.imageUrl) ?? [panel.imageUrl])).toContain(await image.getAttribute('src'));
  }
  await overlay.close();
  await page.locator('.art-direction').scrollIntoViewIfNeeded();
  await capture(page, { path: `${evidence}/noir-studio-1280.jpg` });
  const violations = (await new AxeBuilder({ page }).analyze()).violations.filter(item => item.impact === 'serious' || item.impact === 'critical');
  expect(violations).toEqual([]);
  await writeFile(`${evidence}/noir-desktop-axe.json`, JSON.stringify(violations, null, 2));
  // Selecting a new direction leaves the already generated issue alone until replay.
  await noir.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: /Festival colour/ })).toHaveAttribute('aria-selected', 'true');
  expect((await state(request)).panels).toEqual(approved.panels);
  expect((await state(request)).style).toBe('noir');
  const popReplay = page.waitForResponse(response => response.url().endsWith('/api/replay') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start replay', exact: true }).click();
  expect((await popReplay).request().postDataJSON()).toMatchObject({ style: 'risograph', speed: 60 });
  await replayFinished(request);
  assertStyle(await state(request), 'pop-ink');
  expect((await state(request)).style).toBe('risograph');
  expect(errors).toEqual([]);
  await writeFile(`${evidence}/noir-desktop-console.json`, JSON.stringify(errors));
});

test('TH-2: mobile landing Noir demo preserves the selected direction through replay', async ({ page, request }) => {
  await mkdir(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await reset(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/classic');
  await page.getByRole('button', { name: 'Midnight noir', exact: true }).click();
  const demo = page.getByRole('link', { name: 'Watch the demo', exact: true }).first();
  await expect(demo).toHaveAttribute('href', '/studio?demo=1&style=noir');
  await demo.click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole('tab', { name: /Midnight noir/ })).toHaveAttribute('aria-selected', 'true');
  await replayFinished(request);
  assertStyle(await state(request), 'midnight-noir');
  const queue = page.getByTestId('approval-queue');
  await queue.getByRole('button', { name: /^Review panel 4:/ }).click();
  const image = queue.locator('.queue-card img');
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect((await state(request)).pendingPanels.map(panel => panel.storyBeats?.[0]?.imageUrl ?? panel.imageUrl)).toContain(await image.getAttribute('src'));
  await queue.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture(page, { path: `${evidence}/noir-studio-390.jpg` });
  expect(errors).toEqual([]);
  await writeFile(`${evidence}/noir-mobile-console.json`, JSON.stringify(errors));
});
