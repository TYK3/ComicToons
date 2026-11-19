import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { mangaThemes } from '@comictoons/core';
import { LOOKS, resolveLook, type LookId } from '../../data/adapter';
import { useAdapter, useUi } from '../../data/store';

/** A Look's own palette, from the shared theme definitions (read only, the same source as the studio Look picker). */
const paletteOf = (id: LookId) => (mangaThemes.find(theme => theme.id === resolveLook(id)) ?? mangaThemes[0]!).palette;

/**
 * LANDING-3 MF3: the picked Look's palette as custom properties for the What it makes chrome (selected tab, tab and
 * frame shadows, part rules, the back page). Text stays landing ink: it reads ≥6.2:1 on every Look's middle accent
 * and ≥12:1 on every tint, so only fills, shadows and rules change.
 */
export function lookChrome(id: LookId): CSSProperties {
  const { accent: [a1, a2, a3], tint, wash } = paletteOf(id);
  return {
    '--set-a1': a1, '--set-a2': a2, '--set-a3': a3, '--set-tint': tint.start,
    '--set-wash': `linear-gradient(90deg,${wash.start},${wash.mid},${wash.end})`,
  } as CSSProperties;
}

/**
 * LANDING-3 MF3: four Look swatches beside the Sample stream tabs, so the themes can be picked where the samples are.
 * The same shared Look as the studio picker and the reader switch (adapter.setLook): picking one here changes them too.
 * Arrow keys, Home and End move and apply at once, like the studio picker.
 */
export function LookSwatches() {
  const ui = useUi();
  const adapter = useAdapter();
  const current = resolveLook(ui.studio.look);
  const group = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState('');
  const apply = (id: LookId) => {
    void adapter.setLook(id);
    setSaid(`Look: ${LOOKS.find(look => look.id === id)!.name}. The Sample set below uses it now.`);
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
  return <div className="ct-swatches">
    <p className="ct-swatches__label" id="ct-swatches-label">Palette</p>
    <div ref={group} className="ct-swatches__row" role="radiogroup" aria-labelledby="ct-swatches-label" onKeyDown={onKey}>
      {LOOKS.map(look => {
        const on = look.id === current;
        const { accent } = paletteOf(look.id);
        return <button key={look.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-look-id={look.id}
          className="ct-swatch" aria-label={`${look.name}, colour`} onClick={() => apply(look.id)}>
          <span className="ct-swatch__chip" aria-hidden="true" >
            {accent.map(colour => <span key={colour} className="ct-swatch__dot" style={{ backgroundColor: colour }}/>)}
          </span>
          <span className="ct-swatch__name">{look.short}</span>
        </button>;
      })}
    </div>
    <p className="ct-sr" role="status" aria-live="polite">{said}</p>
  </div>;
}
