import type { ReactNode } from 'react';

/**
 * Native no-op. Hover tooltips are a pointer-device affordance; on native the
 * same information is carried by the badge's accessibilityLabel, so there is
 * nothing to re-parent. Keeping the module resolvable also keeps `react-dom`
 * (imported by the .web variant) out of the native bundle.
 */
export function TooltipPortal(_props: { children: ReactNode }) {
  return null;
}
