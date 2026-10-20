/**
 * Typed runtime accessor for NON-CLASS styling sinks — Ionicons `color`
 * props, SVG fill/stroke, `placeholderTextColor`, QR-code colors, TokenHues
 * lookups, navigation options. `className` can't feed those, so they read
 * tokens at runtime — from the SAME `constants/theme-data.ts` the CSS-var
 * generator consumes, which is what keeps class-styled and prop-styled
 * colors provably in sync.
 *
 * This module is PURE (imports theme-data only — no react-native), so it is
 * Bun-testable and usable from the generator/harness. App code should not
 * pass variants around: `constants/theme.ts` exports `ThemeAccess`, a
 * binding of this accessor to the session's `ActiveDesignVariant`.
 */

import {
  ColorsByVariant,
  FontsByVariant,
  GlowByVariant,
  RadiiByVariant,
  TokenHuesByVariant,
  type ColorScheme,
  type DesignVariant,
  type ThemeColorTokens,
  type ThemeFontAlias,
  type TokenHue,
} from './theme-data';

export interface ThemeAccessor {
  readonly variant: DesignVariant;
  /** A single color token, e.g. `color('danger', scheme)` for an icon prop. */
  color(token: keyof ThemeColorTokens, scheme: ColorScheme): string;
  /** The full token object for one scheme (drop-in for `Colors[scheme]`). */
  colors(scheme: ColorScheme): ThemeColorTokens;
  /** Per-asset identity hue; falls back to ETH like every existing call site. */
  tokenHue(symbol: string, scheme: ColorScheme): TokenHue;
  /**
   * Exact font face for one of the nine aliases — never family+weight
   * emulation. WEB-ONLY as returned: system-stack aliases yield the raw CSS
   * fallback list, which native cannot parse. A native consumer must mirror
   * constants/theme.ts's remap (stack → undefined fontFamily) and pair the
   * alias weight — see `Fonts`/`FontWeights` there. No native consumer
   * exists today (P1).
   */
  font(alias: ThemeFontAlias): string;
  radius(key: keyof (typeof RadiiByVariant)[4]): number;
  glow(scheme: ColorScheme): string;
}

export function bindThemeAccess(variant: DesignVariant): ThemeAccessor {
  return {
    variant,
    color: (token, scheme) => ColorsByVariant[variant][scheme][token],
    colors: (scheme) => ColorsByVariant[variant][scheme],
    tokenHue: (symbol, scheme) => {
      const hues = TokenHuesByVariant[variant][scheme];
      return hues[symbol.toUpperCase()] ?? hues.ETH;
    },
    font: (alias) => FontsByVariant[variant][alias],
    radius: (key) => RadiiByVariant[variant][key],
    glow: (scheme) => GlowByVariant[variant][scheme],
  };
}
