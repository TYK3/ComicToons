import type { PercentBox } from '../../../../../../packages/core/src/lettering';

export type { PercentBox };
export type BubbleSpot = { zone: 'rail' } | { zone: 'art'; box: PercentBox };

/**
 * Where an imported panel's chat bubbles go. Young's rule (00:20): no caption, text box or bubble covers a face.
 * Reuses the repo's existing face-safe policy, docs/LETTERING_MAPS.md "Placement policy" (lettering lives in an
 * expanding rail outside the art, captionZone {x:0,y:100}), checked by tests/lettering.ts:45-58. Imported art
 * (a clip thumbnail or generated art) has no reviewed face map, so the rail is the default. Only when a layout
 * has no room for a rail do lines go inside the art, and then only into the top band and the corners, never the
 * centre, skipping any slot that touches a known face box. Percent coordinates of the art, as LetteringMap.
 */
export const IN_ART_SLOTS: readonly PercentBox[] = [
  { x: 3, y: 3, width: 40, height: 20 }, // top left
  { x: 57, y: 3, width: 40, height: 20 }, // top right
  { x: 3, y: 77, width: 26, height: 20 }, // bottom-left corner
  { x: 71, y: 77, width: 26, height: 20 }, // bottom-right corner
];

const overlaps = (a: PercentBox, b: PercentBox) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export function placeImportBubbles(count: number, { rail, faces = [] }: { rail: boolean; faces?: readonly PercentBox[] }): BubbleSpot[] {
  if (rail) return Array.from({ length: count }, () => ({ zone: 'rail' as const }));
  const free = IN_ART_SLOTS.filter(slot => !faces.some(face => overlaps(slot, face)));
  return Array.from({ length: count }, (_, index): BubbleSpot => {
    const box = free[index];
    return box ? { zone: 'art', box } : { zone: 'rail' };
  });
}
