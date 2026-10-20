import { createPortal } from 'react-dom';
import { useLayoutEffect, useState, type ReactNode } from 'react';

export const INLINE_OP_HOST_ID = 'pp-inline-op-host';

/**
 * Web-only re-parenting: renders the children into the action hub's inline
 * host <View nativeID={INLINE_OP_HOST_ID}> (a plain div under RN-Web). Lets
 * the operation providers keep ALL their state, inputs and step logic while
 * the desktop widget — not a modal overlay — is the surface they draw in.
 *
 * The host is tracked CONTINUOUSLY, not found once: the hub (and its host
 * div) unmounts when the user navigates to another route while the flow
 * stays open, and remounts a NEW div on back-navigation. A one-shot lookup
 * kept portaling into the detached old div — the form silently vanished,
 * leaving the hub's reserved area blank (the "half form" after browser
 * back). Per-frame getElementById is cheap and only runs while a flow is
 * open inline.
 */
export function InlineOpPortal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<Element | null>(null);
  // LAYOUT effect, not a passive one: the hub has already swapped its CTA for
  // the (empty) host in the same commit, so a passive first lookup leaves one
  // painted frame with neither the button nor the form. Running before paint
  // closes that gap; the rAF loop below still tracks a host that is replaced
  // by a later navigation (codex, 2026-09-04).
  useLayoutEffect(() => {
    let raf = 0;
    const track = () => {
      const el = document.getElementById(INLINE_OP_HOST_ID);
      setHost((prev) => (prev === el ? prev : el));
      raf = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(raf);
  }, []);
  if (!host) return null;
  return createPortal(children, host);
}
