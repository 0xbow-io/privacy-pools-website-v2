// F-C deliverable 1 — the pure-token-source import probe.
//
// `constants/theme-data.ts` must stay importable from a PLAIN Bun process:
// no react-native, no DOM, no storage. The import at the top of this file IS
// the probe — bun has no react-native resolution or Flow parser, so a stray
// `import { Platform } from 'react-native'` (or anything transitively
// touching RN) fails this suite at load time. The source-level assertions
// below catch the subtler leaks an import alone would miss (lazy
// `window.` / `require()` access).

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ColorsByVariant,
  FontsByVariant,
  GlowByVariant,
  LegacyRadiusPairs,
  LiquidLightPalettes,
  RadiiByVariant,
  TokenHuesByVariant,
  VaultBackdropPalette,
  type DesignVariant,
  type ThemeFontAlias,
} from '../constants/theme-data';
import { bindThemeAccess } from '../constants/theme-access';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'constants', 'theme-data.ts'), 'utf8');

const VARIANTS: DesignVariant[] = [1, 2, 3, 4];
const SCHEMES = ['light', 'dark'] as const;

describe('theme-data purity', () => {
  test('no react-native / expo / DOM / storage references in the source', () => {
    expect(SOURCE).not.toMatch(/from\s+['"](react-native|expo|@expo|@react-native)/);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
    expect(SOURCE).not.toMatch(/\bwindow\b|\bdocument\b|\blocalStorage\b|\bSecureStore\b|\bAsyncStorage\b/);
  });

  test('module has no runtime imports at all (pure data)', () => {
    // `import type`/`export type` are fine; any VALUE import would drag a
    // dependency into the Bun/Node generator context.
    const valueImports = SOURCE.match(/^import\s+(?!type\b)/gm) ?? [];
    expect(valueImports).toEqual([]);
  });
});

describe('theme-data shape (complete key sets across all variants)', () => {
  const colorKeys = Object.keys(ColorsByVariant[4].light).sort();
  const fontKeys = ['regular', 'medium', 'semiBold', 'bold', 'sans', 'sansMedium', 'sansSemiBold', 'sansBold', 'mono'];

  test('every variant × scheme exports the full color token set', () => {
    expect(colorKeys.length).toBe(30);
    for (const v of VARIANTS) {
      for (const scheme of SCHEMES) {
        expect(Object.keys(ColorsByVariant[v][scheme]).sort()).toEqual(colorKeys);
      }
    }
  });

  test('every variant carries all NINE font aliases', () => {
    for (const v of VARIANTS) {
      expect(Object.keys(FontsByVariant[v]).sort()).toEqual([...fontKeys].sort());
    }
  });

  test('token hues cover ETH/USDC/USDT/DAI with fg+bg per scheme', () => {
    for (const v of VARIANTS) {
      for (const scheme of SCHEMES) {
        const hues = TokenHuesByVariant[v][scheme];
        expect(Object.keys(hues).sort()).toEqual(['DAI', 'ETH', 'USDC', 'USDT']);
        for (const hue of Object.values(hues)) {
          expect(typeof hue.fg).toBe('string');
          expect(typeof hue.bg).toBe('string');
        }
      }
    }
  });

  test('radii, glow, and backdrop palettes are present for every variant', () => {
    for (const v of VARIANTS) {
      expect(Object.keys(RadiiByVariant[v]).sort()).toEqual(['card', 'control', 'inner', 'pill']);
      expect(typeof GlowByVariant[v].light).toBe('string');
      expect(typeof GlowByVariant[v].dark).toBe('string');
    }
    expect(Object.keys(LiquidLightPalettes).sort()).toEqual(['1', '2', '3', '4']);
    expect(VaultBackdropPalette.warmVault.dot.light).toBeTruthy();
    expect(VaultBackdropPalette.electric.grid.dark).toBeTruthy();
  });
});

describe('ThemeAccess.font typing + exhaustive coverage (finding 8)', () => {
  const aliases = Object.keys(FontsByVariant[4]) as ThemeFontAlias[];

  test('all nine aliases resolve to a non-empty face on every variant', () => {
    expect(aliases.length).toBe(9);
    for (const v of VARIANTS) {
      const access = bindThemeAccess(v);
      for (const alias of aliases) {
        const face = access.font(alias);
        expect(typeof face).toBe('string');
        expect(face.length).toBeGreaterThan(0);
      }
    }
  });

  test('a typo alias is rejected at COMPILE time (and yields undefined if forced)', () => {
    const access = bindThemeAccess(4);
    // @ts-expect-error — 'semibold' is not a ThemeFontAlias ('semiBold' is);
    // without the ThemeFontAlias key type this typo type-checked and
    // silently returned undefined (codex F-C review, finding 8).
    const face = access.font('semibold');
    expect(face).toBeUndefined();
  });
});

describe('legacy-radius inventory shape (finding 2)', () => {
  test('inventory entries are sorted, unique, non-negative integer pairs', () => {
    expect(LegacyRadiusPairs.length).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < LegacyRadiusPairs.length; i++) {
      const p = LegacyRadiusPairs[i];
      expect(Number.isInteger(p.vault)).toBe(true);
      expect(Number.isInteger(p.classic)).toBe(true);
      if (i > 0) {
        const q = LegacyRadiusPairs[i - 1];
        expect(p.vault - q.vault || p.classic - q.classic).toBeGreaterThan(0);
      }
    }
  });
});

describe('theme-data spot values (verbatim moves from constants/theme.ts)', () => {
  test('variant-specific anchors', () => {
    expect(ColorsByVariant[1].light.background).toBe('#FAF7F1');
    expect(ColorsByVariant[2].dark.primary).toBe('#00daf8');
    expect(ColorsByVariant[3].dark.buttonPrimary).toBe('#D2F4FB');
    expect(ColorsByVariant[4].light.accent).toBe('#8A7B63');
    expect(FontsByVariant[2].sans).toBe('Geist_400Regular');
    expect(FontsByVariant[2].sansSemiBold).toBe('Geist_600SemiBold');
    expect(RadiiByVariant[4]).toEqual({ card: 24, inner: 16, control: 12, pill: 999 });
    expect(GlowByVariant[3].dark).toBe('#00daf8');
    expect(LiquidLightPalettes[4]).toEqual(['#FFFFFF', '#D8CFC0', '#8C8C8C']);
    expect(VaultBackdropPalette.warmVault.evergreenGlow).toBe('#19B091');
    expect(VaultBackdropPalette.electric.violet).toBe('#7000ff');
  });
});
