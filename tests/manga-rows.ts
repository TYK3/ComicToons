import {expect, type Page} from '@playwright/test';

/** Measure visual rows, independently of the span/pagination implementation. */
export async function assertMangaRows(page:Page, minPages = 2) {
  const grids = await page.locator('.manga-grid').evaluateAll(elements => elements.map(grid => {
    const bounds = grid.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(grid).columnGap);
    const rows:{top:number;bottom:number;left:number;right:number;gaps:number[]}[] = [];
    for (const cell of grid.querySelectorAll('.manga-cell')) {
      const box = cell.getBoundingClientRect();
      let row = rows.find(item => Math.abs(item.top-box.top) < 1);
      if (!row) {row = {top:box.top,bottom:box.bottom,left:box.left,right:box.left,gaps:[]};rows.push(row);}
      else row.gaps.push(box.left-row.right);
      row.right = box.right;row.bottom = Math.max(row.bottom,box.bottom);
    }
    return {left:bounds.left+scrollX,right:bounds.right+scrollX,gap,
      rows:rows.map(row=>({...row,top:row.top+scrollY,bottom:row.bottom+scrollY,left:row.left+scrollX,right:row.right+scrollX}))};
  }));
  expect(grids.length).toBeGreaterThanOrEqual(minPages);
  for (const grid of grids) for (const row of grid.rows) {
    expect(Math.abs(row.left-grid.left),'Each row starts at the page edge').toBeLessThan(1);
    expect(Math.abs(row.right-grid.right),'Each row ends at the page edge; no empty cells').toBeLessThan(1);
    for (const gap of row.gaps) expect(Math.abs(gap-grid.gap),'Only the intended gutter separates frames').toBeLessThan(1);
  }
  return grids;
}
