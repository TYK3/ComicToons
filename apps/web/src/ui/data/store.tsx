import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ComicToonsAdapter, UiEvent, UiEventName, UiSnapshot } from './adapter';

const AdapterContext = createContext<ComicToonsAdapter | null>(null);

export function AdapterProvider({ adapter, children }: { adapter: ComicToonsAdapter; children: ReactNode }) {
  return <AdapterContext.Provider value={adapter}>{children}</AdapterContext.Provider>;
}

export function useAdapter(): ComicToonsAdapter {
  const adapter = useContext(AdapterContext);
  if (!adapter) throw new Error('AdapterProvider is missing');
  return adapter;
}

/** The useStudio() equivalent: one snapshot for every screen. */
export function useUi(): UiSnapshot {
  const adapter = useAdapter();
  return useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot);
}

/** The useEventStream() equivalent. */
export function useUiEvents(names: readonly UiEventName[], onEvent: (event: UiEvent) => void) {
  const adapter = useAdapter();
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const key = names.join('|');
  useEffect(() => adapter.onEvent(key.split('|') as UiEventName[], event => handler.current(event)), [adapter, key]);
}

/** Countdown clock, derived client-side by the adapter (no 'now' in the snapshot). Re-reads on every snapshot change. */
export function useNow(): number {
  const adapter = useAdapter();
  useUi();
  return adapter.now();
}

/**
 * Small promise loader for reader screens. Keeps the last data while reloading (a Look change), so pages don't flash.
 * `retry()` runs the load again (after an error); `retrying` is true while that second try is in flight.
 */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): { data?: T; error?: string; retrying: boolean; retry: () => void } {
  const [state, setState] = useState<{ data?: T; error?: string; retrying?: boolean }>({});
  const [attempt, setAttempt] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let live = true;
    setState(previous => (previous.error ? { retrying: true } : previous));
    loader.current().then(data => { if (live) setState({ data }); }, (cause: unknown) => { if (live) setState({ error: cause instanceof Error ? cause.message : 'That page could not load.' }); });
    return () => { live = false; };
  }, [...deps, attempt]);
  return { data: state.data, error: state.error, retrying: !!state.retrying, retry: () => setAttempt(value => value + 1) };
}

/**
 * UI3: which state the studio-backed screens are in. 'error' means the studio never answered (no data at all); a drop
 * mid-stream keeps the last panels and is shown as a banner instead. 'empty' is a studio with no panels yet.
 */
export type StudioPhase = 'loading' | 'error' | 'empty' | 'ready';
export function studioPhase(ui: UiSnapshot): StudioPhase {
  if (ui.loading) return 'loading';
  if ((ui.error || ui.offline) && !ui.sampleReady) return 'error';
  return ui.studio.panels.length + ui.studio.pendingPanels.length ? 'ready' : 'empty';
}
