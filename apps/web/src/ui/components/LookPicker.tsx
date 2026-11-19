import { sampleStoryIssue } from '../data/sampleStories';
import { useRef, useState, type KeyboardEvent } from 'react';
import { mangaThemes } from '@comictoons/core';
import { LOOKS, resolveLook, type LookId, type UiPanel } from '../data/adapter';
import { useAdapter, useUi } from '../data/store';
import { LookArt } from './Panel';
import '../styles/lookpicker.css';

/** The theme's three accent stops, left to right, for the palette bar under each card's thumbnail (critique M2):
 * the card shows its palette even when every thumbnail shows the same art. */
const paletteBar = (id: LookId) => {
  const [a1, a2, a3] = (mangaThemes.find(theme => theme.id === id) ?? mangaThemes[0]!).palette.accent;
  return `linear-gradient(90deg,${a1} 0% 33.33%,${a2} 33.33% 66.66%,${a3} 66.66% 100%)`;
};

/** One Look picker for every view (D1a). Arrow keys, Home and End move and apply at once. */
export function LookPicker({ compact = false }: { compact?: boolean }) {
  const ui = useUi();
  const adapter = useAdapter();
  const [said, setSaid] = useState('');
  const group = useRef<HTMLDivElement>(null);
  // A stored legacy Look (ink/noir/pop) shows Festival checked, not nothing.
  const current = resolveLook(ui.studio.look);
  // Compare painted versions of one complete scene. Legacy/live stills without
  // variants cannot demonstrate a palette by repeating the same thumbnail.
  const candidate = ui.studio.panels[0] ?? ui.studio.pendingPanels[0];
  const sample: UiPanel | undefined = candidate && LOOKS.every(look => candidate.art.themes?.[look.id])
    ? candidate : sampleStoryIssue('sample-tabletop-night', current).panels[0];
  const apply = (id: LookId, announce = true) => {
    void adapter.setLook(id);
    const look = LOOKS.find(entry => entry.id === id)!;
    if (announce) setSaid(`Look: ${look.name}. Applied to the grid, the overlay, the recap and PNG exports.`);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const ids = LOOKS.map(look => look.id);
    let index = ids.indexOf(current);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = (index + 1) % ids.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') index = (index - 1 + ids.length) % ids.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = ids.length - 1;
    else return;
    event.preventDefault();
    apply(ids[index]!);
    group.current?.querySelector<HTMLButtonElement>(`[data-look-id="${ids[index]}"]`)?.focus();
  };
  return <div className={`ct-looks${compact ? ' ct-looks--compact' : ''}`}>
    <p className="ct-tool__label"><span id="ct-look-label">Colour palette</span> <span id="ct-look-hint" className="ct-tool__hint">Painted scenery. Natural character colours.</span></p>
    <div ref={group} className="ct-looks__cards" role="radiogroup" aria-labelledby="ct-look-label" aria-describedby="ct-look-hint" onKeyDown={onKey}>
      {LOOKS.map(look => {
        const on = look.id === current;
        return <button key={look.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-look-id={look.id}
          className="ct-look" aria-label={`${look.name}, colour. ${look.blurb}`} onClick={() => apply(look.id)}>
          <span className="ct-look__thumb">{sample ? <LookArt panel={sample} look={look.id} eager/> : <span className="ct-look__blank" data-look={look.id}/>}</span>
          <span className="ct-look__bar" style={{ backgroundImage: paletteBar(look.id) }} data-look={look.id} aria-hidden="true"/>
          <span className="ct-look__name">{look.short}</span>
          <span className="ct-look__tick" aria-hidden="true">✓</span>
        </button>;
      })}
    </div>
    <p className="ct-sr" role="status" aria-live="polite">{said}</p>
  </div>;
}
