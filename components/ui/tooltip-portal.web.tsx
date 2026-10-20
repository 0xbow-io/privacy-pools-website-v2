import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Web-only escape hatch for hover bubbles: renders `children` directly into
 * <body>, outside every ancestor stacking context and overflow box.
 *
 * Why a portal and not a z-index. React-Native-Web gives EVERY <View> a base
 * style of `position: relative; z-index: 0`, so every row, cell and card is
 * its own stacking context. A bubble nested inside one can never paint above
 * a sibling of an ancestor, no matter how large its own z-index: `z-index:
 * 9999` only orders it against its siblings inside that little box. The
 * transactions table proved it — the filter header carries `z-[99999]` so its
 * dropdowns can escape the card, which meant the header's background and
 * bottom border painted straight over the first row's status tooltip.
 *
 * Callers position the child themselves, in VIEWPORT coordinates (`position:
 * fixed` off a `getBoundingClientRect()` reading), because <body> is no longer
 * near the anchor. They are also responsible for dismissing it on scroll and
 * resize, since a fixed bubble does not follow the element it describes.
 */
export function TooltipPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null; // SSR/static export pass
  return createPortal(children, document.body);
}
