import { test, expect } from '@playwright/test';
import type { StudioState } from '../apps/server/src/studio.ts';

// DOCS-1: the classic /overlay live region counts manga frames on the newest
// page (buildMangaPages(...).at(-1).panels.length), not approved panels. One
// approved panel with two story beats draws two frames, so the label must say
// "frames on screen" and must not call them approved panels.
const beat = (frame: number, line: string) => ({ frame, imageUrl: '/favicon.svg', scene: `Beat ${frame}`, dialogue: [line] });
const state: StudioState = {
  status: 'live', fixtureId: 'tabletop-night', speed: 1, style: 'risograph', approvalMode: true,
  streamTitle: 'Count label', issueTitle: 'Count label', elapsed: 60, duration: 1440, pendingPanels: [],
  panels: [{
    id: 'count-label-1', caption: 'The dice had other plans', dialogue: [], scene: 'A table', characters: [], mood: 'tense',
    altText: 'A table', imageUrl: '/favicon.svg', at: 60,
    storyBeats: [beat(0, 'Roll it.'), beat(1, 'Natural one!')],
  }],
} as unknown as StudioState;

test('DOCS-1 OVERLAY-COUNT-LABEL: the classic overlay live region names frames on screen, not approved panels', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/events', route => route.abort('connectionrefused'));
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.goto('/overlay');
  const cells = page.locator('main.overlay .manga-cell');
  await expect(cells).toHaveCount(2);
  const status = page.locator('main.overlay [role="status"]');
  await expect(status).toHaveText('2 comic frames on screen.');
  await expect(status).not.toContainText('approved');
});
