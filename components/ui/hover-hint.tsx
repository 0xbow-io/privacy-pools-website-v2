import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, type View } from 'react-native';
import { Fonts, FontWeights } from '@/constants/theme';
import { TooltipPortal } from '@/components/ui/tooltip-portal';

/**
 * A short hint attached to an inline element, shown on hover (web) or press
 * (touch, and web too), without spending row space on it.
 *
 * Built for the hub's Shield card (Pat, 2026-09-02): wallet Balance + Shielded
 * + "+0.5 USDC pending" overloaded one line and the suffix truncated to "p…".
 * The pending figure now lives here, one hover away, and the row keeps its
 * single-line shrink-to-fit contract.
 *
 * Positioning follows components/pools/transactions.tsx's badge tooltip: the
 * bubble is PORTALED to <body> in viewport coordinates, because every
 * react-native-web View is its own stacking context and a nested bubble can
 * never paint above an ancestor's sibling. Scroll and resize dismiss it (a
 * fixed bubble does not follow its anchor). No per-frame follow here: the hub
 * card is static while hovered, and a press-opened bubble on touch closes on
 * the next tap or scroll.
 *
 * On native the portal is a no-op and the hint travels as accessibilityHint,
 * which is where a screen reader looks for it anyway.
 */
export function HoverHint({
  hint,
  children,
  testID,
  wrap = false,
}: {
  /** Null or empty renders the children bare, no wrapper behaviour at all. */
  hint: string | null | undefined;
  children: ReactNode;
  testID?: string;
  /** Long hints wrap at 260px instead of running on one line. */
  wrap?: boolean;
}) {
  const [anchor, setAnchor] = useState<{ x: number; top: number; bottom: number } | null>(null);
  const [shown, setShown] = useState(false);
  const nodeRef = useRef<View | null>(null);

  const measure = useCallback(() => {
    // react-native-web hands the DOM node back through the ref.
    const el = nodeRef.current as unknown as { getBoundingClientRect?: () => DOMRect } | null;
    if (!el?.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom };
  }, []);
  const open = useCallback(() => {
    const a = measure();
    if (a) setAnchor(a);
  }, [measure]);
  const close = useCallback(() => {
    setAnchor(null);
    setShown(false);
  }, []);

  const hovering = anchor !== null;
  useEffect(() => {
    if (!hovering || Platform.OS !== 'web' || typeof window === 'undefined') return;
    // The rAF flip drives the fade: mount at opacity 0, then transition in.
    const raf = requestAnimationFrame(() => setShown(true));
    window.addEventListener('scroll', close, true); // capture: inner scrollers too
    window.addEventListener('resize', close);
    // A tap anywhere outside the trigger dismisses a tapped-open bubble (phone web).
    const outside = (e: PointerEvent) => {
      const el = nodeRef.current as unknown as { contains?: (n: Node) => boolean } | null;
      if (el?.contains && e.target instanceof Node && el.contains(e.target)) return;
      close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [hovering, close]);

  if (!hint) return <>{children}</>;

  // Flip below the anchor when there is no room above, so the bubble never
  // leaves the viewport on a card that sits near the top.
  // A wrapped hint runs several lines (the explorer note is ~5 at 260px), so it
  // needs more headroom than a one-line hint before it may open above.
  const openAbove = anchor === null || anchor.top > (wrap ? 120 : 44);
  // nw-keep(platform-css): web-only tooltip bubble, viewport-fixed off the measured
  // anchor rect, opacity transition, pointer-events; the node lives in <body> where
  // no className path reaches it.
  const bubble: React.CSSProperties = {
    position: 'fixed',
    left: anchor?.x ?? 0,
    top: openAbove ? (anchor?.top ?? 0) - 4 : (anchor?.bottom ?? 0) + 4,
    transform: openAbove ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
    background: '#1A1B1D',
    color: '#fff',
    padding: '6px 10px',
    borderRadius: 4,
    fontFamily: Fonts.medium,
    fontWeight: FontWeights.medium,
    fontSize: 11,
    lineHeight: '14px',
    whiteSpace: wrap ? 'normal' : 'nowrap',
    ...(wrap ? { width: 260, maxWidth: '80vw' } : null),
    pointerEvents: 'none',
    opacity: shown ? 1 : 0,
    transition: 'opacity 120ms ease',
    zIndex: 100000,
    boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
  };
  // nw-keep(platform-css): CSS-triangle arrow (border trick) in the DOM island
  const arrow: React.CSSProperties = {
    position: 'absolute',
    ...(openAbove
      ? { top: '100%', borderTop: '5px solid #1A1B1D' }
      : { bottom: '100%', borderBottom: '5px solid #1A1B1D' }),
    left: '50%',
    transform: 'translateX(-50%)',
    width: 0,
    height: 0,
    borderLeft: '5px solid transparent',
    borderRight: '5px solid transparent',
  };

  return (
    <>
      <Pressable
        ref={nodeRef}
        onHoverIn={open}
        onHoverOut={close}
        onPress={() => (anchor ? close() : open())}
        accessibilityHint={hint}
        testID={testID}
        // Same flex contract as the inline text it wraps: may shrink, never grows the row.
        className="min-w-0 shrink"
      >
        {children}
      </Pressable>
      {Platform.OS === 'web' && anchor ? (
        <TooltipPortal>
          {React.createElement('div', { style: bubble, role: 'tooltip' }, hint, React.createElement('div', { style: arrow }))}
        </TooltipPortal>
      ) : null}
    </>
  );
}
