import { useEffect, useState } from 'react';

/** Hash routes keep the standalone entry (ui.html) working from any static host and from file shots. */
export interface Route { name: string; id?: string; params: URLSearchParams }

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#/, '') || '/';
  const [path = '/', query = ''] = clean.split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] ?? 'landing', id: parts[1] ? decodeURIComponent(parts[1]) : undefined, params: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const update = () => { setHash(location.hash); window.scrollTo(0, 0); };
    // In-page anchors (#ct-main, #ct-how) must not be read as routes: scroll and focus instead.
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href^="#"]');
      const target = link?.getAttribute('href') ?? '';
      if (!link || target.startsWith('#/') || target === '#') return;
      const element = document.getElementById(target.slice(1));
      if (!element) return;
      event.preventDefault();
      if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
      element.scrollIntoView({ block: 'start' });
      element.focus({ preventScroll: true });
    };
    window.addEventListener('hashchange', update);
    document.addEventListener('click', onClick);
    return () => { window.removeEventListener('hashchange', update); document.removeEventListener('click', onClick); };
  }, []);
  return parseRoute(hash);
}

export type Workspace = 'sample' | 'live';
const WORKSPACE_PAGES = ['studio','director','overlay','audience','catchup','output','flow','issues','recap','book','series','read'];
export function routeWorkspace(route: Route, fallback: Workspace = 'sample'): Workspace {
  const explicit = route.params.get('workspace');
  if (explicit === 'sample' || explicit === 'live') return explicit;
  if (route.name === 'connect' || route.name === 'viewer') return 'live';
  if (['recap','book','series','read'].includes(route.name) && route.id) return route.id.startsWith('sample-') ? 'sample' : 'live';
  return fallback;
}

/** Merge query parameters once; workspace is pinned into every workspace link. */
export function href(path: string, options: {workspace?: Workspace | null} = {}): string {
  const [target, query = ''] = path.split('?');
  const current = parseRoute(location.hash);
  const params = new URLSearchParams(current.params);
  for (const [key,value] of new URLSearchParams(query)) params.set(key,value);
  const name = target.split('/').filter(Boolean)[0] ?? 'landing';
  const id = target.split('/').filter(Boolean)[1];
  if (options.workspace === null || name === 'landing') params.delete('workspace');
  else if (name === 'connect') params.set('workspace','live');
  else if (WORKSPACE_PAGES.includes(name)) {
    let fallback: Workspace = 'sample';
    try { if (localStorage.getItem('comictoons-studio-mode-v1') === 'live') fallback='live'; } catch { /* this window */ }
    const workspace = options.workspace ?? (['book','recap','series','read'].includes(name) && id ? (id.startsWith('sample-')?'sample':'live') : routeWorkspace(current,fallback));
    params.set('workspace',workspace);
  }
  const suffix=params.toString();
  return `#${target}${suffix?`?${suffix}`:''}`;
}
