/**
 * Shared precedence fixtures — the single case list both theme-resolution
 * implementations must satisfy:
 *
 *   1. the pure resolvers (services/theme-precedence.ts) that theme.ts and
 *      theme-provider.tsx consume, and
 *   2. the inline pre-paint bootstrap (services/theme-bootstrap.ts) that
 *      app/+html.tsx renders.
 *
 * services/__tests__/theme-precedence.test.ts runs every fixture against
 * BOTH; a behavioral drift between them is a test failure, not a runtime
 * surprise. Pure data module — no react-native.
 */

import type { ColorScheme, DesignVariant } from '@/constants/theme-data';

export interface ThemePrecedenceFixture {
  name: string;
  search: string;
  /** Simulated hostile Location: the search getter THROWS. */
  searchThrows?: boolean;
  /** Storage contents before resolution. */
  stored?: Record<string, string>;
  /** Simulated storage failure: reads throw, writes throw, or both. */
  storageThrows?: 'get' | 'set' | 'all';
  systemDark: boolean;
  expected: { variant: DesignVariant; scheme: ColorScheme };
  /** Expected storage contents AFTER resolution (persistence side-effects). */
  expectedStored?: Record<string, string>;
}

export const THEME_PRECEDENCE_FIXTURES: ThemePrecedenceFixture[] = [
  {
    name: 'defaults: nothing stored, system light',
    search: '',
    systemDark: false,
    expected: { variant: 4, scheme: 'light' },
    expectedStored: {},
  },
  {
    name: 'defaults: nothing stored, system dark',
    search: '',
    systemDark: true,
    expected: { variant: 4, scheme: 'dark' },
    expectedStored: {},
  },
  {
    name: '?theme=3 wins and persists',
    search: '?theme=3',
    stored: { ppv2_design_variant: '1' },
    systemDark: false,
    expected: { variant: 3, scheme: 'light' },
    expectedStored: { ppv2_design_variant: '3' },
  },
  {
    name: '?theme=0 (retired Classic) is invalid — falls through to the stored variant',
    search: '?theme=0',
    stored: { ppv2_design_variant: '4' },
    systemDark: false,
    expected: { variant: 4, scheme: 'light' },
    expectedStored: { ppv2_design_variant: '4' },
  },
  {
    name: 'invalid ?theme falls through to the stored variant',
    search: '?theme=9',
    stored: { ppv2_design_variant: '2' },
    systemDark: false,
    expected: { variant: 2, scheme: 'light' },
    expectedStored: { ppv2_design_variant: '2' },
  },
  {
    name: 'stored variant applies without URL param',
    search: '',
    stored: { ppv2_design_variant: '4' },
    systemDark: false,
    expected: { variant: 4, scheme: 'light' },
    expectedStored: { ppv2_design_variant: '4' },
  },
  {
    name: 'garbage stored variant falls back to the default (4)',
    search: '',
    stored: { ppv2_design_variant: 'vault' },
    systemDark: false,
    expected: { variant: 4, scheme: 'light' },
    expectedStored: { ppv2_design_variant: 'vault' },
  },
  {
    name: '?color=dark forces dark over system light and persists',
    search: '?color=dark',
    systemDark: false,
    expected: { variant: 4, scheme: 'dark' },
    expectedStored: { ppv2_theme_preference: 'dark' },
  },
  {
    name: '?color=light forces light over stored dark',
    search: '?color=light',
    stored: { ppv2_theme_preference: 'dark' },
    systemDark: true,
    expected: { variant: 4, scheme: 'light' },
    expectedStored: { ppv2_theme_preference: 'light' },
  },
  {
    name: 'invalid ?color is ignored (stored preference wins)',
    search: '?color=blue',
    stored: { ppv2_theme_preference: 'dark' },
    systemDark: false,
    expected: { variant: 4, scheme: 'dark' },
    expectedStored: { ppv2_theme_preference: 'dark' },
  },
  {
    name: 'stored-vs-OS conflict: stored light beats system dark',
    search: '',
    stored: { ppv2_theme_preference: 'light' },
    systemDark: true,
    expected: { variant: 4, scheme: 'light' },
    expectedStored: { ppv2_theme_preference: 'light' },
  },
  {
    name: 'both params together',
    search: '?theme=2&color=dark',
    systemDark: false,
    expected: { variant: 2, scheme: 'dark' },
    expectedStored: { ppv2_design_variant: '2', ppv2_theme_preference: 'dark' },
  },
  {
    name: 'storage reads throw: URL still wins for scheme, variant falls to the default (4)',
    search: '?color=dark',
    stored: { ppv2_design_variant: '3' },
    storageThrows: 'get',
    systemDark: false,
    // variant: getItem throws inside the variant try-block → default 4.
    // scheme: URL override never reads storage → dark.
    expected: { variant: 4, scheme: 'dark' },
  },
  {
    name: 'storage fully broken: system scheme, default variant',
    search: '',
    storageThrows: 'all',
    systemDark: true,
    expected: { variant: 4, scheme: 'dark' },
  },
  {
    name: 'LEGACY QUIRK: ?theme=2 with a throwing setItem resolves to the default 4 (persist sits inside the try)',
    search: '?theme=2',
    storageThrows: 'set',
    systemDark: false,
    expected: { variant: 4, scheme: 'light' },
  },
  {
    name: 'LEGACY ASYMMETRY: ?color=dark with a throwing setItem STILL forces dark',
    search: '?color=dark',
    storageThrows: 'set',
    systemDark: false,
    expected: { variant: 4, scheme: 'dark' },
  },
  {
    name: 'HOSTILE ENV: throwing location.search getter. Variant falls to the default 4 (legacy try scope), stored scheme still wins',
    search: '?theme=2&color=dark',
    searchThrows: true,
    stored: { ppv2_design_variant: '3', ppv2_theme_preference: 'dark' },
    systemDark: false,
    // Legacy scope semantics: the variant read sat inside the ONE try (throw
    // → default 4, stored never consulted); the color URL read sat in its
    // own try (throw → null → stored preference wins).
    expected: { variant: 4, scheme: 'dark' },
    expectedStored: { ppv2_design_variant: '3', ppv2_theme_preference: 'dark' },
  },
];
