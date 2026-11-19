/**
 * Small motion helpers on the Web Animations API. Only transform and opacity animate.
 * With prefers-reduced-motion nothing is created at all: content is simply there.
 */
import { useEffect, type RefObject } from 'react';

export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const FROM: Record<string, Keyframe> = {
  up: { opacity: 0, transform: 'translateY(28px)' },
  slam: { opacity: 0, transform: 'scale(1.08) rotate(-1.5deg)' },
  left: { opacity: 0, transform: 'translateX(-32px)' },
  fade: { opacity: 0 },
};

/** Reveal `[data-reveal]` children of `root` when they scroll into view. Animations are primed paused, played once, then cancelled. */
export function useReveal(root: RefObject<HTMLElement | null>, deps: readonly unknown[] = []) {
  useEffect(() => {
    const host = root.current;
    if (!host || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const items = [...host.querySelectorAll<HTMLElement>('[data-reveal]')];
    const running = new Map<Element, Animation>();
    for (const item of items) {
      const kind = item.dataset.reveal || 'up';
      const delay = Number(item.dataset.delay ?? 0);
      const animation = item.animate([FROM[kind] ?? FROM.up!, { opacity: 1, transform: 'none' }], { duration: kind === 'slam' ? 460 : 620, delay, easing: kind === 'slam' ? 'cubic-bezier(.2,1.4,.4,1)' : 'cubic-bezier(.23,1,.32,1)', fill: 'backwards' });
      animation.pause();
      animation.onfinish = () => animation.cancel();
      running.set(item, animation);
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        running.get(entry.target)?.play();
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    for (const item of items) observer.observe(item);
    return () => { observer.disconnect(); for (const animation of running.values()) animation.cancel(); };
  }, deps);
}

/** A single slam-in, used for new overlay panels. */
export function slam(element: Element | null) {
  if (!element || reducedMotion()) return;
  const animation = element.animate([{ opacity: 0, transform: 'scale(1.18) rotate(-3deg)' }, { opacity: 1, transform: 'scale(.98) rotate(.6deg)', offset: .7 }, { opacity: 1, transform: 'none' }], { duration: 460, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  animation.onfinish = () => animation.cancel();
}
