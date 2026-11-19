import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { LibraryEntry } from '../apps/server/src/pipeline/library.ts';
const manifest = JSON.parse(readFileSync(new URL('../fixtures/art/generated/manifest.json', import.meta.url), 'utf8')) as LibraryEntry[];

/** Native 16:9 art -> rendered percent boxes; no guessed pixel offsets. */
export async function assertLettering(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Snapshot the terminal layout; waiting on animation.finished can stall for
    // offscreen/throttled overlay animations even under reduced motion.
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch { animation.cancel(); }
    }
  });
  const results = await page.locator('[data-lettering-placement]').evaluateAll((panels, entries) => panels.map(panel => {
    const asset = panel.getAttribute('data-asset') || '';
    const entry = entries.find(item => item.file === asset);
    const art = panel.querySelector<HTMLElement>('.panel-art, .art');
    const errors: string[] = [];
    if (!art) return { asset, errors: ['missing art frame'] };
    const image = art.querySelector('img');
    const bounds = art.getBoundingClientRect();
    const intersects = (a: {left:number;right:number;top:number;bottom:number}, b: {left:number;right:number;top:number;bottom:number}) => Math.min(a.right, b.right) > Math.max(a.left, b.left) + .5 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + .5;
    const inside = (a: DOMRect, b: DOMRect) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    if (panel.getAttribute('data-lettering-placement') === 'in-art') {
      if (!image?.complete || !image.naturalWidth) errors.push('story art missing');
      const lettering = [...panel.querySelectorAll<HTMLElement>('[data-lettering-kind]')];
      for (const element of lettering) {
        const rect = element.getBoundingClientRect();
        if (!inside(rect, bounds)) errors.push('story lettering escapes panel');
        const range = document.createRange(); range.selectNodeContents(element);
        if ([...range.getClientRects()].some(line => !inside(line, rect))) errors.push(`story ${element.dataset.letteringKind} text clipped: ${element.textContent}`);
        if (Number.parseFloat(getComputedStyle(element).fontSize) < 14) errors.push('story lettering too small');
      }
      for (let a = 0; a < lettering.length; a++) for (let b = a + 1; b < lettering.length; b++) {
        if (intersects(lettering[a]!.getBoundingClientRect(), lettering[b]!.getBoundingClientRect())) errors.push(`story balloons/SFX overlap: ${lettering[a]!.textContent} / ${lettering[b]!.textContent}; frame ${bounds.width}x${bounds.height}`);
      }
      if (panel.querySelector('.lettering-rail, .panel-meta, .art-provenance')) errors.push('outboard card in story');
      return {asset, errors};
    }
    if (asset && !entry) errors.push('unknown manifest asset');
    if (entry && (!image?.complete || image.naturalWidth !== 1280 || image.naturalHeight !== 720)) errors.push('art missing or not original 16:9 image');
    if (entry && Math.abs(bounds.width / bounds.height - 16 / 9) > .01) errors.push('art frame crops or distorts source');
    const boxes = entry ? [entry.lettering.faceBox, ...entry.lettering.faceBoxes, entry.lettering.subjectBox].map(box => ({
      left: bounds.left + box.x / 100 * bounds.width,
      top: bounds.top + box.y / 100 * bounds.height,
      right: bounds.left + (box.x + box.width) / 100 * bounds.width,
      bottom: bounds.top + (box.y + box.height) / 100 * bounds.height,
    })) : [];
    const lettering = Array.from(panel.querySelectorAll<HTMLElement>('[data-lettering-kind]'));
    if (!lettering.length) errors.push('missing lettering assertions');
    for (const element of lettering) {
      const kind = element.dataset.letteringKind;
      const rect = element.getBoundingClientRect();
      if (boxes.some(box => intersects(rect, box))) errors.push(`${kind} overlaps manifest face/subject`);
      // Stronger protection: no lettering covers ANY image region, even unannotated faces.
      if (intersects(rect, bounds)) errors.push(`${kind} covers protected art`);
      const range = document.createRange(); range.selectNodeContents(element);
      const lines = Array.from(range.getClientRects());
      if (lines.some(line => !inside(line, rect))) errors.push(`${kind} text escapes its rail box`);
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor), clip = ancestor.getBoundingClientRect();
        if (['hidden', 'clip', 'auto', 'scroll'].includes(css.overflowX) && lines.some(line => line.left < clip.left - 1 || line.right > clip.right + 1)) errors.push(`${kind} horizontally clipped`);
        if (['hidden', 'clip', 'auto', 'scroll'].includes(css.overflowY) && lines.some(line => line.top < clip.top - 1 || line.bottom > clip.bottom + 1)) errors.push(`${kind} vertically clipped`);
        if (ancestor === document.body) break;
      }
      if (getComputedStyle(element).textOverflow === 'ellipsis') errors.push(`${kind} truncated`);
    }
    for (let a = 0; a < lettering.length; a++) for (let b = a + 1; b < lettering.length; b++) {
      if (intersects(lettering[a]!.getBoundingClientRect(), lettering[b]!.getBoundingClientRect())) errors.push('lettering boxes overlap');
    }
    return { asset, errors };
  }), manifest);
  expect(results.flatMap(result => result.errors.map(error => ({ asset: result.asset, error }))), 'Manifest face/subject bounds, full-image visibility, and full-text rails must be protected.').toEqual([]);
  return results.map(result => result.asset);
}
