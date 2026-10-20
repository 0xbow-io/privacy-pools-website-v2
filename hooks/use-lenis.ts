import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { RefObject } from 'react';

/**
 * Lenis smooth scrolling (github.com/darkroomengineering/lenis) attached to an
 * RN-Web ScrollView.
 *
 * Web-only and dynamically imported — the chunk loads after the hook decides it
 * is actually wanted, so lenis costs nothing on native, when disabled, or under
 * `prefers-reduced-motion` (where smoothing is exactly what the user asked NOT
 * to have; native scrolling is kept as-is).
 *
 * RN-Web's ScrollView renders a real scrolling <div>; `getScrollableNode()`
 * hands it over, and lenis runs in wrapper mode against it — so the existing
 * onScroll/Animated pipeline keeps firing (lenis animates the same scrollTop),
 * only smoothed. `onScroll` here additionally receives lenis's own
 * per-frame value, which is the one to drive parallax with: it is emitted
 * every rAF during the glide, not just when the browser flushes scroll events.
 */
export function useLenisSmoothScroll({
  scrollRef,
  enabled,
  onScroll,
}: {
  /** Ref to the RN ScrollView (RN-Web instance — exposes getScrollableNode). */
  scrollRef: RefObject<{ getScrollableNode?: () => unknown; getInnerViewNode?: () => unknown } | null>;
  enabled: boolean;
  /** Fired with the smoothed scroll offset every animation frame. */
  onScroll?: (y: number) => void;
}): { scrollTo: (y: number, opts?: { duration?: number }) => void } {
  // Held in refs so the returned scrollTo stays stable while pointing at
  // whatever is live: the lenis instance when running, the raw wrapper (smooth
  // native scroll) when lenis is disabled/reduced-motion, a no-op otherwise.
  const lenisRef = useRef<{ scrollTo: (y: number, o?: { duration?: number }) => void } | null>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let restoreScrollTo: (() => void) | null = null;
    let lenis: { raf: (t: number) => void; destroy: () => void; on: (e: 'scroll', cb: (l: { scroll: number }) => void) => void; scrollTo: (y: number, o?: { duration?: number }) => void } | null = null;
    let raf = 0;
    let cancelled = false;

    (async () => {
      const mod = await import('lenis');
      if (cancelled) return;
      const wrapper = scrollRef.current?.getScrollableNode?.() as HTMLElement | undefined;
      // The CONTENT must be the tall inner node. firstElementChild is NOT it on
      // RN-Web (there is an intermediate full-height div), and getting this
      // wrong is not cosmetic: lenis computes limit = content - wrapper = 0,
      // keeps preventDefault-ing the wheel, and the page freezes. Verified
      // in-browser. RN-Web exposes the real one via getInnerViewNode().
      const content = (scrollRef.current?.getInnerViewNode?.()
        ?? wrapper?.firstElementChild
        ?? undefined) as HTMLElement | undefined;
      // Ref not mounted / not web DOM: silently do nothing — native scroll is
      // a perfectly good fallback and the caller cannot tell the difference.
      if (!wrapper || !content) return;
      wrapperRef.current = wrapper;
      // RN-Web puts its OWN `scrollTo(x, y | {x, y, animated})` on this node,
      // shadowing the DOM Element signature. Lenis writes every frame with
      // `scrollTo({ top, behavior: 'instant' })` — RN-Web reads `y: undefined`
      // and scrolls to 0, so lenis animated internally while the page never
      // moved (and its native-scroll resync then dragged the target back to 0:
      // a fully frozen page). Shim the method to speak BOTH dialects; the
      // original is restored on cleanup.
      const shimTarget = wrapper as HTMLElement & { scrollTo: (...a: unknown[]) => unknown };
      const ownScrollTo = Object.prototype.hasOwnProperty.call(wrapper, 'scrollTo')
        ? shimTarget.scrollTo
        : null;
      if (ownScrollTo) {
        shimTarget.scrollTo = function (this: HTMLElement, a?: unknown, b?: unknown) {
          if (
            typeof a === 'object' && a !== null
            && ('top' in (a as object) || 'left' in (a as object))
            && !('y' in (a as object)) && !('x' in (a as object))
          ) {
            const o = a as { top?: number; left?: number };
            if (o.top !== undefined) this.scrollTop = o.top;
            if (o.left !== undefined) this.scrollLeft = o.left;
            return;
          }
          return ownScrollTo.call(this, a, b);
        };
        restoreScrollTo = () => {
          shimTarget.scrollTo = ownScrollTo;
        };
      }
      lenis = new mod.default({ wrapper, content, smoothWheel: true, lerp: 0.09 });
      lenisRef.current = lenis;
      // Dev-only introspection handle (stripped by the __DEV__ guard in prod).
      if (__DEV__) (window as unknown as { __lenis?: unknown }).__lenis = lenis;
      // Belt AND braces: if lenis still thinks there is nothing to scroll
      // while the wrapper clearly disagrees, it would eat every wheel event
      // and freeze the page. Fall back to native scrolling instead.
      setTimeout(() => {
        const limit = (lenis as unknown as { limit?: number } | null)?.limit ?? 0;
        const scrollable = wrapper.scrollHeight - wrapper.clientHeight;
        if (lenis && limit <= 0 && scrollable > 50) {
          lenis.destroy();
          lenis = null;
          lenisRef.current = null;
        }
      }, 250);
      if (onScroll) lenis.on('scroll', ({ scroll }) => onScroll(scroll));
      const loop = (t: number) => {
        lenis?.raf(t);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      lenis?.destroy();
      lenis = null;
      lenisRef.current = null;
      restoreScrollTo?.();
      restoreScrollTo = null;
    };
  }, [enabled, scrollRef, onScroll]);

  const scrollTo = useCallback((y: number, opts?: { duration?: number }) => {
    if (lenisRef.current) {
      lenisRef.current.scrollTo(y, { duration: opts?.duration ?? 1.1 });
      return;
    }
    // No lenis (native scroll / reduced motion): drive the DOM node directly.
    // Same trap as the shim above — when lenis never booted, RN-Web's own
    // scrollTo(x,y|{x,y,animated}) is still in place and reads a DOM-style
    // {top} object as y: undefined → scrolls to 0. Speak its dialect here.
    const wrapper =
      wrapperRef.current
      ?? ((scrollRef.current?.getScrollableNode?.() ?? null) as HTMLElement | null);
    if (!wrapper) return;
    const reduce = typeof window !== 'undefined'
      && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (Object.prototype.hasOwnProperty.call(wrapper, 'scrollTo')) {
      (wrapper as unknown as { scrollTo: (o: { x: number; y: number; animated: boolean }) => void })
        .scrollTo({ x: 0, y, animated: !reduce });
    } else {
      wrapper.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { scrollTo };
}
