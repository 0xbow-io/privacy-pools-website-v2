/**
 * Theme precedence — the ONE definition of how the design variant and color
 * scheme are resolved, extracted verbatim from the legacy implementations:
 *
 *   variant: `constants/theme.ts` (URL `?theme` → storage → default 4, Mono Studio)
 *   scheme:  `components/theme-provider.tsx` (URL `?color` → storage → system)
 *
 * Pure module: no react-native, no DOM — callers inject the environment.
 * Consumed by constants/theme.ts (variant), components/theme-provider.tsx
 * (scheme), and mirrored by the inline pre-paint bootstrap in
 * services/theme-bootstrap.ts. `services/__tests__/theme-precedence.test.ts`
 * runs the SAME fixture set against these resolvers and the bootstrap script
 * — any drift between the two implementations fails the suite.
 *
 * Two deliberate legacy quirks are part of the contract (do not "fix" them
 * here without changing every implementation + the fixtures):
 *
 *  1. VARIANT: the `?theme` persistence write happens INSIDE the resolution
 *     try-block — if `setItem` throws (private mode), resolution falls
 *     through to the DEFAULT (4, Mono Studio), not to the URL value.
 *  2. SCHEME: the `?color` persistence failure is swallowed SEPARATELY — the
 *     URL value still wins even when storage is broken. Asymmetric with (1),
 *     but it is what the app has always done.
 */

import type { ColorScheme, DesignVariant } from '@/constants/theme-data';

export const DESIGN_VARIANT_STORAGE_KEY = 'ppv2_design_variant';

/** Site default: Mono Studio. Explicit `?theme=`/stored choices still win. */
export const DEFAULT_DESIGN_VARIANT: DesignVariant = 4;
export const THEME_PREFERENCE_KEY = 'ppv2_theme_preference';

// '0' (Classic) was retired 2026-08-18 — stale stored/URL values fall to the default.
const VALID_VARIANTS = new Set(['1', '2', '3', '4']);

export interface ThemePrecedenceEnv {
  /**
   * Reads `window.location.search` on web; returns '' on native (URL
   * overrides are web-only). MAY THROW (hostile/test Location getters) — the
   * resolvers call it INSIDE their guarded blocks, exactly where the legacy
   * implementations read it, so a throwing getter degrades identically
   * (variant falls to the default; the scheme URL override becomes null).
   */
  getSearch(): string;
  /** Storage read — MAY THROW (private mode etc.); quirk semantics apply. */
  getItem(key: string): string | null;
  /** Storage write — MAY THROW; quirk semantics apply. */
  setItem(key: string, value: string): void;
  /** OS-level scheme at resolution time. */
  systemDark: boolean;
}

export function resolveDesignVariant(env: ThemePrecedenceEnv): DesignVariant {
  try {
    const param = new URLSearchParams(env.getSearch()).get('theme');
    if (param !== null && VALID_VARIANTS.has(param)) {
      env.setItem(DESIGN_VARIANT_STORAGE_KEY, param);
      return Number(param) as DesignVariant;
    }
    const stored = env.getItem(DESIGN_VARIANT_STORAGE_KEY);
    if (stored !== null && VALID_VARIANTS.has(stored)) {
      return Number(stored) as DesignVariant;
    }
  } catch {
    // Storage unavailable (private mode, etc.) — fall through to default.
  }
  return DEFAULT_DESIGN_VARIANT;
}

export function resolveColorScheme(env: ThemePrecedenceEnv): ColorScheme {
  let urlOverride: ColorScheme | null = null;
  try {
    const value = new URLSearchParams(env.getSearch()).get('color');
    urlOverride = value === 'light' || value === 'dark' ? value : null;
  } catch {
    urlOverride = null;
  }
  if (urlOverride) {
    try {
      env.setItem(THEME_PREFERENCE_KEY, urlOverride);
    } catch {
      // Non-fatal: the forced scheme still applies for the current session.
    }
    return urlOverride;
  }
  let stored: ColorScheme | null = null;
  try {
    const value = env.getItem(THEME_PREFERENCE_KEY);
    stored = value === 'light' || value === 'dark' ? value : null;
  } catch {
    stored = null;
  }
  if (stored) return stored;
  return env.systemDark ? 'dark' : 'light';
}

export function resolveTheme(env: ThemePrecedenceEnv): { variant: DesignVariant; scheme: ColorScheme } {
  return { variant: resolveDesignVariant(env), scheme: resolveColorScheme(env) };
}
