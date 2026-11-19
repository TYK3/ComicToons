import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Toast from '@radix-ui/react-toast';
import { Check, LoaderCircle, X } from 'lucide-react';

type Notice = { message: string; action?: { label: string; run: () => void } };
const NotifyContext = createContext<(notice: Notice) => void>(() => {});
export const useNotify = () => useContext(NotifyContext);

export function Providers({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState(false);
  const notify = useCallback((next: Notice) => { setOpen(false); setNotice(next); requestAnimationFrame(() => setOpen(true)); }, []);
  return <NotifyContext.Provider value={notify}>
    <Tooltip.Provider delayDuration={450} skipDelayDuration={500}>
      <Toast.Provider swipeDirection="right" duration={6000}>
        {children}
        <Toast.Root className="toast" open={open} onOpenChange={setOpen}>
          <Check size={18} aria-hidden="true" />
          <Toast.Title>{notice?.message}</Toast.Title>
          {notice?.action && <Toast.Action asChild altText={notice.action.label}><button onClick={notice.action.run}>{notice.action.label}</button></Toast.Action>}
          <Toast.Close className="icon-button toast-close" aria-label="Dismiss notification"><X size={16}/></Toast.Close>
        </Toast.Root>
        <Toast.Viewport className="toast-viewport" />
      </Toast.Provider>
    </Tooltip.Provider>
  </NotifyContext.Provider>;
}

export function Button({ children, loading, variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button {...props} className={`button button-${variant} ${className}`} disabled={props.disabled || loading} aria-busy={loading || undefined}>
    {loading ? <LoaderCircle className="spinner" size={17} aria-hidden="true" /> : null}{children}
  </button>;
}

export function Tip({ text, children }: { text: string; children: ReactNode }) {
  return <Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={8}>{text}<Tooltip.Arrow className="tooltip-arrow"/></Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}

export function Brand({ light = false }: { light?: boolean }) {
  return <a className={`brand ${light ? 'brand-on-paper' : ''}`} href="/" aria-label="ComicToons home">
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M3 5h19v15H12l-6 5v-5H3V5Z" fill="currentColor"/><path d="M9 10h10M9 14h7" stroke="var(--ink)" strokeWidth="2.5"/><path d="m23 2 3 3M25 10h3" stroke="currentColor" strokeWidth="2"/></svg>
    <span>comictoons<span className="brand-dot">.</span></span>
  </a>;
}

export function EmptyArt() {
  return <img className="empty-art" src="/art/generated/panel-01-stream-start.webp" alt="" aria-hidden="true"/>;
}
