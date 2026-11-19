/** Percent coordinates on the original, uncropped 16:9 image. */
export interface PercentBox { x: number; y: number; width: number; height: number }
export interface LetteringMap {
  faceBox: PercentBox;
  faceBoxes: PercentBox[];
  subjectBox: PercentBox;
  bubbleZones: PercentBox[];
  sfxZones: PercentBox[];
  captionZone: { x: number; y: number; width: number; height: 'auto' };
  derivation: { source: string; cell: number; method: string; observations: string };
}

export function validateLetteringMap(value: unknown): value is LetteringMap {
  if (!value || typeof value !== 'object') return false;
  const map = value as Record<string, unknown>;
  const box = (item: unknown): item is PercentBox => {
    if (!item || typeof item !== 'object') return false;
    const b = item as Record<string, unknown>;
    return ['x', 'y', 'width', 'height'].every(key => typeof b[key] === 'number' && Number.isFinite(b[key]))
      && (b.x as number) >= 0 && (b.y as number) >= 0 && (b.width as number) > 0 && (b.height as number) > 0
      && (b.x as number) + (b.width as number) <= 100 && (b.y as number) + (b.height as number) <= 100;
  };
  const rail = map.captionZone as Record<string, unknown> | undefined;
  const derivation = map.derivation as Record<string, unknown> | undefined;
  return box(map.faceBox) && box(map.subjectBox)
    && Array.isArray(map.faceBoxes) && map.faceBoxes.length > 0 && map.faceBoxes.every(box)
    && Array.isArray(map.bubbleZones) && map.bubbleZones.every(box)
    && Array.isArray(map.sfxZones) && map.sfxZones.every(box)
    && !!rail && rail.x === 0 && rail.y === 100 && rail.width === 100 && rail.height === 'auto'
    && !!derivation && typeof derivation.source === 'string' && typeof derivation.method === 'string'
    && typeof derivation.observations === 'string' && Number.isInteger(derivation.cell);
}
