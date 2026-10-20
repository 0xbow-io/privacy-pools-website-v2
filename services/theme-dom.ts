/**
 * Root theme-class management (web): exactly ONE `pp-v{N}` class plus an
 * optional `dark` class on `document.documentElement`, every other class
 * preserved, stale `pp-v*`/`dark` removed. The classes live on <html> —
 * NOT the app-root div — because RN-Web `Modal` portals its subtree to
 * `document.body`, which sits outside any app container but still inherits
 * the CSS vars from the root element.
 *
 * Pure string algorithm (operates on a `className`-bearing element shape) so
 * it is Bun-testable and byte-mirrors what the inline pre-paint bootstrap
 * (services/theme-bootstrap.ts) does before hydration; the theme provider
 * calls it to reconcile after hydration and on every toggle.
 */

import type { ColorScheme, DesignVariant } from '@/constants/theme-data';

export interface ClassNameElement {
  className: string;
}

export function applyRootThemeClasses(el: ClassNameElement, variant: DesignVariant, scheme: ColorScheme): void {
  const kept = el.className
    .split(/\s+/)
    .filter((c) => c !== '' && !/^pp-v\d+$/.test(c) && c !== 'dark');
  kept.push(`pp-v${variant}`);
  if (scheme === 'dark') kept.push('dark');
  el.className = kept.join(' ');
}
