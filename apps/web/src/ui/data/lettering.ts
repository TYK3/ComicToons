import type { PercentBox } from '@comictoons/core';
import manifest from '../../../../../fixtures/art/generated/manifest.json';
import type { UiPanel } from './adapter';

const overlaps = (a: PercentBox, b: PercentBox) => a.x < b.x + b.width + 3 && a.x + a.width > b.x - 3
  && a.y < b.y + b.height + 3 && a.y + a.height > b.y - 3;

/** Source-image coordinates: authored pockets first, otherwise avoid the mapped faces. */
export function letteringPocket(panel: UiPanel): PercentBox | undefined {
  if (panel.art.bubble) return panel.art.bubble;
  const map = panel.lettering ?? manifest.find(entry => entry.file === panel.provenance?.asset)?.lettering;
  const approved = map?.bubbleZones[0];
  if (approved) return approved;
  if (!map) return undefined;
  const choices: PercentBox[] = [];
  for (const width of [34, 42, 50, 58]) for (const height of [24, 32, 40]) {
    for (const x of [3, 97 - width]) for (const y of [3, 97 - height]) {
      const box = { x, y, width, height };
      if (!map.faceBoxes.some(face => overlaps(box, face))) choices.push(box);
    }
  }
  // Keep the balloon small; split the dialogue rather than covering extra artwork.
  return choices.sort((a, b) => a.width * a.height - b.width * b.height || a.y - b.y || a.x - b.x)[0];
}

/** Small effects share the same protected face geometry and avoid the speech balloon. */
export function sfxPocket(panel: UiPanel): PercentBox | undefined {
  if (!panel.sfx) return undefined;
  const map = panel.lettering ?? manifest.find(entry => entry.file === panel.provenance?.asset)?.lettering;
  if (!map) return undefined;
  const bubble = letteringPocket(panel);
  const candidates: PercentBox[] = [...map.sfxZones, ...[81, 3].flatMap(y => [77, 3].map(x => ({x,y,width:20,height:16})))];
  return candidates.find(box => !map.faceBoxes.some(face => overlaps(box,face)) && (!bubble || !overlaps(box,bubble)));
}

/** No ellipsis or dropped quotes: long dialogue continues in another illustrated frame. */
export function dialogueScenes(panel: UiPanel): UiPanel[] {
  if(panel.art.lettered)return [panel];
  const pocket = letteringPocket(panel);
  const capacity = pocket ? Math.max(24, Math.floor(pocket.width * pocket.height * .065)) : 80;
  const chunks = panel.dialogue.flatMap(line => {
    const result: string[] = [];
    let chunk = '';
    for (const word of line.split(/\s+/).filter(Boolean)) {
      if (chunk && chunk.length + word.length + 1 > capacity) { result.push(chunk); chunk = ''; }
      // Very long tokens are preserved rather than clipped.
      chunk = chunk ? `${chunk} ${word}` : word;
    }
    if (chunk) result.push(chunk);
    return result;
  });
  if (chunks.length <= 1) return [{ ...panel, art: { ...panel.art, bubble: pocket } }];
  return chunks.map((line, index) => ({ ...panel, id: `${panel.id}-dialogue-${index + 1}`,
    sourceId: panel.sourceId ?? panel.id, dialogue: [line], art: { ...panel.art, bubble: pocket } }));
}

export const comicScenes = (panels: UiPanel[]) => panels.flatMap(dialogueScenes);
