import type { KeyboardEvent } from 'react';
import { LOOKS, resolveLook } from '../data/adapter';
import { useAdapter, useUi } from '../data/store';

/** Compact Look control for readers and the overlay preview. Same Look as the studio picker. */
export function LookSwitch({ label = 'Look', onInk = false }: { label?: string; onInk?: boolean }) {
  const { studio } = useUi();
  const adapter = useAdapter();
  // A stored legacy Look (ink/noir/pop) shows Festival checked, not nothing.
  const current = resolveLook(studio.look);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const ids = LOOKS.map(look => look.id);
    let index = ids.indexOf(current);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = (index + 1) % ids.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') index = (index + ids.length - 1) % ids.length;
    else return;
    event.preventDefault();
    void adapter.setLook(ids[index]!);
    (event.currentTarget.querySelector(`[data-look-id="${ids[index]}"]`) as HTMLButtonElement | null)?.focus();
  };
  return <div className={`ct-lookswitch${onInk ? ' ct-lookswitch--ink' : ''}`}>
    <span className="ct-lookswitch__label" id="ct-lookswitch-label">{label}</span>
    <div className="ct-seg" role="radiogroup" aria-labelledby="ct-lookswitch-label" onKeyDown={onKey}>
      {LOOKS.map(look => <button key={look.id} type="button" role="radio" data-look-id={look.id} aria-checked={current === look.id} tabIndex={current === look.id ? 0 : -1}
        aria-label={`${look.name}, colour`} onClick={() => void adapter.setLook(look.id)}>{look.short}</button>)}
    </div>
  </div>;
}
