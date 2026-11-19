import { useEffect, useRef } from 'react';
import { useRoute } from '../../router';

/**
 * LANDING-2 (a): the moving Festival background behind the hero. Three strips of paper comic-panel frames drift
 * sideways at different speeds, like pages sliding past. CSS only (landing.css, .ct-drift): each strip animates
 * transform alone on its own compositor layer, so there is no layout or paint per frame and nothing shifts.
 * Paused off screen (IntersectionObserver) and with ?freeze=1; never runs under prefers-reduced-motion.
 */
export function HeroDrift() {
  const host = useRef<HTMLDivElement>(null);
  const frozen = useRoute().params.get('freeze') === '1';
  useEffect(() => {
    const box = host.current;
    if (!box || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => { box.dataset.off = entry && !entry.isIntersecting ? '1' : ''; });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return <div className="ct-drift" ref={host} aria-hidden="true" data-still={frozen ? '1' : undefined}>
    <span className="ct-drift__row ct-drift__row--a"/>
    <span className="ct-drift__row ct-drift__row--b"/>
    <span className="ct-drift__row ct-drift__row--c"/>
  </div>;
}
