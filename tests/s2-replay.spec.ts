import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runReplay } from '../scripts/s2-replay-core.ts';

test('S2-REPLAY: a synthetic ten-minute chat with spikes, bursts and strong signals yields panels with no shared image (by bytes), prompt or caption', async () => {
  const cacheDir = await mkdtemp(resolve('artifacts/tmp/s2-replay-spec-'));
  try {
    const report = await runReplay(cacheDir);
    expect(report.panelCount).toBeGreaterThanOrEqual(4);
    expect(report.noSharedImageUrl).toBe(true);
    expect(report.noSharedCaption).toBe(true);
    expect(report.everyPanelHasSources).toBe(true);
    expect(report.uniqueImageUrlCount).toBe(report.panelCount);
    expect(report.uniqueCaptionCount).toBe(report.panelCount);
    // Distinct URLs are not enough: hash the bytes each panel actually shows (generated cache
    // file or library asset), and check every art prompt sent was different and chat-free.
    expect(report.missingImageFileCount).toBe(0);
    expect(report.distinctImageSha256Count).toBe(report.panelCount);
    expect(report.noSharedImageBytes).toBe(true);
    expect(report.promptCount).toBe(report.panelCount);
    expect(report.distinctPromptCount).toBe(report.promptCount);
    expect(report.noSharedPrompt).toBe(true);
    expect(report.promptsQuoteChatOrNames).toBe(false);
    expect(new Set(report.panels.map((panel) => panel.scene)).size).toBe(report.panelCount);
    // The replay's two velocity spikes and two emote bursts arrive only through the chat
    // ingest adapter, so these prove the ingest path itself opens kind-specific panels.
    expect(report.spikePanelCount).toBe(2);
    expect(report.burstPanelCount).toBe(2);
    for (const panel of report.panels.filter((item) => item.sfx === 'SPIKE!')) {
      expect(panel.caption).toMatch(/^Chat erupts all at once: /);
      expect(panel.mood).toBe('energetic');
    }
    for (const panel of report.panels.filter((item) => item.sfx === 'SURGE!')) {
      expect(panel.caption).toMatch(/^The same reaction floods chat: .*KEKW/);
      expect(panel.mood).toBe('electric');
    }
    for (const panel of report.panels) {
      expect(panel.caption).not.toMatch(/\(#?\d+\)/);
      expect(panel.caption).not.toBe('A selected chat moment.');
      expect(panel.sources.length).toBeGreaterThanOrEqual(1);
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
