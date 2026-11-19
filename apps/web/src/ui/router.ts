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

/** Keep the screenshot/state query (look, twitch, count, freeze…) when moving between screens. */
export function href(path: string): string {
  const query = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?')) : '';
  return `#${path}${query}`;
}
