import type { ReactNode } from 'react';

/**
 * UI3: one shape for every loading, empty and error state. The title and text sit in a polite live region, so a screen
 * reader hears "Loading the recap" or "That issue didn't load" once, without interrupting. Errors are polite too: none
 * of them needs the reader to stop what they are doing. Never shows data: the state is the whole message.
 */
export type ScreenKind = 'loading' | 'empty' | 'error';
export function ScreenState({ kind, title, children, actions, level = 2, compact, className }: {
  kind: ScreenKind; title: string; children?: ReactNode; actions?: ReactNode; level?: 1 | 2 | 3; compact?: boolean; className?: string;
}) {
  const Heading = `h${level}` as const;
  return <section className={`ct-state ct-state--${kind}${compact ? ' ct-state--compact' : ''}${className ? ` ${className}` : ''}`} data-state={kind} aria-busy={kind === 'loading' || undefined}>
    <div className="ct-state__top">
      <span className="ct-state__mark" aria-hidden="true">{kind === 'loading' ? '' : kind === 'error' ? '!?' : '…'}</span>
      <div className="ct-state__say" role="status" aria-live="polite" aria-atomic="true">
        <Heading className="ct-state__title">{title}</Heading>
        {children && <div className="ct-state__text">{children}</div>}
      </div>
    </div>
    {actions && <div className="ct-row ct-state__acts">{actions}</div>}
  </section>;
}

/** The Try again button used by every error state. Shows "Trying again…" while the retry is in flight. */
export function RetryButton({ onRetry, busy, label = 'Try again', ink = true }: { onRetry: () => void; busy?: boolean; label?: string; ink?: boolean }) {
  return <button type="button" className={`ct-btn${ink ? ' ct-btn--ink' : ''}`} onClick={onRetry} disabled={busy} aria-disabled={busy || undefined}>{busy ? 'Trying again…' : label}</button>;
}
