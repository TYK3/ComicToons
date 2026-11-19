import test from 'node:test';
import assert from 'node:assert/strict';
import { gridColumns } from '../apps/web/src/ui/gridColumns.ts';

// S6 #10: n<=4 -> n columns; otherwise 4 if n%4 is 0 or 3, else 3.
test('GRID-COLUMNS: follows the n<=4 then 4-if-0-or-3-else-3 rule for 1 to 16 panels (14 gives 3)', () => {
  const expected: Record<number, number> = {
    1: 1, 2: 2, 3: 3, 4: 4,
    5: 3, 6: 3, 7: 4, 8: 4,
    9: 3, 10: 3, 11: 4, 12: 4,
    13: 3, 14: 3, 15: 4, 16: 4,
  };
  for (const [n, cols] of Object.entries(expected)) assert.equal(gridColumns(Number(n)), cols, `gridColumns(${n})`);
});
