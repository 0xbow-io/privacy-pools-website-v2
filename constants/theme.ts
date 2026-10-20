/**
 * Design-system tokens — the app's single source of color + type truth.
 *
 * The RAW variant maps live in `constants/theme-data.ts` (pure data, no
 * react-native import — also consumed by scripts/generate-theme-vars.ts).
 * This module stays the app-facing API: it resolves the active design
 * variant (platform/URL/storage — the impure part) and exports the same
 * `Colors` / `TokenHues` / `Fonts` / `Glow` selections it always
 * did.
 *
 * Switchable design variants, comparable live with `?theme=1|2|3|4`
 * (web only; the choice persists in localStorage so it survives in-app
 * navigation, and the header's Theme menu switches it too):
 *
 *   1 — "Warm Vault" (commit 35718ea): warm paper canvas, evergreen primary,
 *       amber highlights.
 *   2 — "Electric Blue v1" (commit a88bda4): near-black glass, saturated
 *       #00daf8 CTAs, violet secondary.
 *   3 — "Electric Blue v2": same system with the adapted light theme and
 *       the pale ice (#D2F4FB) CTA fill.
 *   4 — "Mono Studio" (default): color-neutral canvas (true greys, no tinted
 *       backgrounds), ink-inverted CTAs, muted statuses.
 *
 * Every variant uses Geist through the shared font aliases in theme-data.ts.
 *
 * Variant 0 ("Classic", the pre-redesign design) was retired 2026-08-18;
 * stale `?theme=0`/stored choices fall back to the default. Native gets the
 * default variant. Every variant exports the full token set, so components
 * never branch — they keep consuming `Colors[colorScheme].<key>`.
 */

import { Platform } from 'react-native';

import {
  ColorsByVariant,
  FONT_ALIAS_WEIGHTS,
  FontsByVariant,
  GlowByVariant,
  SYSTEM_FONT_STACK,
  TokenHuesByVariant,
  type DesignVariant,
  type ThemeFontAlias,
  type ThemeFontWeight,
} from './theme-data';
import { bindThemeAccess } from './theme-access';
import {
  DEFAULT_DESIGN_VARIANT,
  DESIGN_VARIANT_STORAGE_KEY,
  resolveDesignVariant,
} from '@/services/theme-precedence';
import { INTERNAL_TOOLS_ENABLED } from '@/config/internal-tools';

export type { DesignVariant } from './theme-data';

/**
 * Resolved once at module load; switching requires a reload (by design).
 * Precedence (URL `?theme` → storage → default 4) lives in
 * services/theme-precedence.ts — the SAME rules the +html.tsx pre-paint
 * bootstrap applies, fixture-tested against each other.
 *
 * Variant 4 ("Mono Studio") is the web production default (resolved in
 * services/theme-precedence.ts); explicit `?theme=`/stored choices win.
 * Native gets the same default — variant switching is a web surface.
 */
// A variant persisted while the tools were ON must not outlive them, and
// `?theme=` must stop being a public entrance to them (codex, Medium): the row
// was hidden but the URL still switched AND persisted a variant. Cleared here
// rather than inside resolveDesignVariant so the pure resolver and the
// pre-paint bootstrap keep their byte-for-byte drift guard.
if (Platform.OS === 'web' && typeof window !== 'undefined' && !INTERNAL_TOOLS_ENABLED) {
  try {
    window.localStorage.removeItem(DESIGN_VARIANT_STORAGE_KEY);
  } catch {
    // Storage unavailable — the default below applies regardless.
  }
}

export const ActiveDesignVariant: DesignVariant =
  Platform.OS !== 'web' || typeof window === 'undefined' || !INTERNAL_TOOLS_ENABLED
    ? DEFAULT_DESIGN_VARIANT
    : resolveDesignVariant({
        getSearch: () => window.location.search,
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
        systemDark: false, // unused by variant resolution
      });

export const DesignVariantNames: Record<DesignVariant, string> = {
  1: 'Warm Vault',
  2: 'Electric Blue v1',
  3: 'Electric Blue v2',
  4: 'Mono Studio',
};

/**
 * Persist a design variant and reload — tokens are baked at module load, so
 * a reload is the switch. Drops any `?theme=` param first; it would override
 * the stored choice on the reload.
 */
export function applyDesignVariant(variant: DesignVariant) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  // Inert while the tools are off: the flag has to gate the mechanism, not just
  // the menu row that calls it.
  if (!INTERNAL_TOOLS_ENABLED) return;
  try {
    window.localStorage.setItem(DESIGN_VARIANT_STORAGE_KEY, String(variant));
  } catch {
    // Storage unavailable — the reload will just keep the current variant.
  }
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('theme')) {
      url.searchParams.delete('theme');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    // Best effort; worst case the param re-applies the old variant.
  }
  window.location.reload();
}

export const Colors = ColorsByVariant[ActiveDesignVariant];
export const TokenHues = TokenHuesByVariant[ActiveDesignVariant];

const ActiveFontFaces = FontsByVariant[ActiveDesignVariant];

/**
 * Aliases resolving to the system stack are only meaningful as a CSS
 * fallback list — native has no parser for it (iOS warns "Unrecognized font
 * family" and falls back). On native the system font is expressed by leaving
 * fontFamily unset, so those aliases resolve to undefined there.
 */
export const Fonts = (
  Platform.OS === 'web'
    ? ActiveFontFaces
    : Object.fromEntries(
        Object.entries(ActiveFontFaces).map(([alias, face]) => [
          alias,
          face === SYSTEM_FONT_STACK ? undefined : face,
        ]),
      )
) as Record<ThemeFontAlias, string | undefined>;

export const Glow = GlowByVariant[ActiveDesignVariant];

/**
 * Companion weights for inline `fontFamily: Fonts.x` sinks (SVG text, tab
 * labels, StyleSheet blocks) — the system stack carries no baked weight, so
 * those call sites pair the family with `fontWeight: FontWeights.x`.
 * 'normal' for prebaked faces, same rule as the generated --pp-fontw-* vars.
 * Keyed off the RAW face map: on native the system stack resolves to an
 * unset fontFamily above, but its numeric weight must still apply.
 */
export const FontWeights = Object.fromEntries(
  (Object.keys(FONT_ALIAS_WEIGHTS) as ThemeFontAlias[]).map((alias) => [
    alias,
    ActiveFontFaces[alias] === SYSTEM_FONT_STACK ? FONT_ALIAS_WEIGHTS[alias] : 'normal',
  ]),
) as Record<ThemeFontAlias, ThemeFontWeight>;

/**
 * Runtime token accessor bound to the session's active variant — the
 * sanctioned source for NON-CLASS sinks (Ionicons/SVG/placeholder/QR/
 * TokenHues) during and after the NativeWind port. Reads the same
 * theme-data the CSS-var generator emits from.
 */
export const ThemeAccess = bindThemeAccess(ActiveDesignVariant);
