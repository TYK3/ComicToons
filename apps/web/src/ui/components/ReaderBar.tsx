import type { ReactNode } from 'react';
import { href } from '../router';
import { Logo, Sample } from './Brand';
import { LookSwitch } from './LookSwitch';
import { Arrow } from './Icons';

/** Slim bar for viewer-facing pages (recap, book, series, reader, catch-up). */
export function ReaderBar({ back = '/studio', backLabel = 'Studio', sample = true, look = true, children }: { back?: string; backLabel?: string; sample?: boolean; look?: boolean; children?: ReactNode }) {
  return <header className="ct-readerbar ct-on-ink">
    <Logo/>
    {sample && <Sample ink/>}
    <div className="ct-readerbar__mid">{children}</div>
    <div className="ct-readerbar__right">
      {look && <LookSwitch onInk label="View in"/>}
      <a className="ct-btn ct-btn--back ct-btn--sm" href={href(back)}><Arrow dir="left"/>{backLabel}</a>
    </div>
  </header>;
}
