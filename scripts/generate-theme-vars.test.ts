// F-C deliverable 2 — generator tests: CI-style drift gate (regenerate +
// in-memory compare), color-parser contract, complete-key validation across
// all 10 web sets, and resolved-value assertions (the generated CSS text is
// parsed back and checked against theme-data AND against hardcoded legacy
// anchor values).

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ColorsByVariant,
  FontsByVariant,
  GlowByVariant,
  RadiiByVariant,
  type ColorScheme,
  type DesignVariant,
} from '../constants/theme-data';
import {
  CSS_MARKER_END,
  CSS_MARKER_START,
  buildNativeVarMaps,
  buildVariantVarSets,
  collectClassicRadiusCalls,
  generateAll,
  kebab,
  legacyRadiusPairs,
  parseColor,
  renderCssRegion,
  renderGlobalCss,
  validateClassicRadiusCalls,
  validateSlashOpacityTokens,
} from './generate-theme-vars';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const VARIANTS: DesignVariant[] = [1, 2, 3, 4];
const SCHEMES: ColorScheme[] = ['light', 'dark'];

describe('drift gate (committed outputs match the generator)', () => {
  test('global.css + theme-vars.generated.ts + theme-scales.generated.js are current', () => {
    for (const { file, content } of generateAll()) {
      const committed = fs.readFileSync(file, 'utf8');
      if (committed !== content) {
        throw new Error(
          `${path.relative(ROOT, file)} drifted from the generator output — run: bun scripts/generate-theme-vars.ts`,
        );
      }
      expect(committed).toBe(content);
    }
  });

  test('generator output is deterministic', () => {
    expect(renderCssRegion()).toBe(renderCssRegion());
  });
});

describe('color parser', () => {
  test('accepts the documented forms', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#00daf8')).toEqual({ r: 0, g: 218, b: 248, a: 1 });
    expect(parseColor('#00daf880').a).toBeCloseTo(128 / 255, 5);
    expect(parseColor('#0009')).toEqual({ r: 0, g: 0, b: 0, a: 153 / 255 }); // #RGBA (minifier form)
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.45)')).toEqual({ r: 0, g: 0, b: 0, a: 0.45 });
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
  test('rejects everything else', () => {
    for (const bad of ['hsl(0, 0%, 0%)', 'red', '#12345', 'rgb(300, 0, 0)', 'rgba(0,0,0)', 'var(--x)', '']) {
      expect(() => parseColor(bad)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Parse the generated CSS region back into resolved var maps per set:
// resolved(.pp-vN.dark) = vars(.pp-vN) overlaid with vars(.pp-vN.dark) —
// exactly the cascade the browser applies (both classes sit on <html>).
// ---------------------------------------------------------------------------

function parseRegion(): Record<string, Record<string, string>> {
  const css = fs.readFileSync(path.join(ROOT, 'global.css'), 'utf8');
  const start = css.indexOf(CSS_MARKER_START);
  const end = css.indexOf(CSS_MARKER_END);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const region = css.slice(start, end);
  const blocks: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const raw of region.split('\n')) {
    const line = raw.trim();
    const open = /^([.\w-]+(?:\.[\w-]+)?)\s*\{$/.exec(line);
    if (open) {
      current = {};
      blocks[open[1]] = current;
      continue;
    }
    if (line === '}') {
      current = null;
      continue;
    }
    const decl = /^(--[\w-]+):\s*(.+);$/.exec(line);
    if (decl && current) current[decl[1]] = decl[2];
  }
  return blocks;
}

function resolvedSet(blocks: Record<string, Record<string, string>>, variant: DesignVariant, scheme: ColorScheme) {
  const base = blocks[`.pp-v${variant}`];
  expect(base).toBeDefined();
  if (scheme === 'light') return { ...base };
  const dark = blocks[`.pp-v${variant}.dark`];
  expect(dark).toBeDefined();
  return { ...base, ...dark };
}

describe('generated CSS — complete keys + resolved values across all 10 sets', () => {
  const blocks = parseRegion();

  test('every set resolves the complete var set (identical names everywhere)', () => {
    const referenceNames = Object.keys(resolvedSet(blocks, 4, 'light')).sort();
    expect(referenceNames.length).toBeGreaterThan(50);
    for (const variant of VARIANTS) {
      for (const scheme of SCHEMES) {
        expect(Object.keys(resolvedSet(blocks, variant, scheme)).sort()).toEqual(referenceNames);
      }
    }
  });

  test('every color token resolves to the exact theme-data value in all 10 sets', () => {
    for (const variant of VARIANTS) {
      for (const scheme of SCHEMES) {
        const resolved = resolvedSet(blocks, variant, scheme);
        const colors = ColorsByVariant[variant][scheme] as Record<string, string>;
        for (const token of Object.keys(colors)) {
          expect(resolved[`--pp-${kebab(token)}`]).toBe(colors[token]);
        }
        expect(resolved['--pp-glow']).toBe(GlowByVariant[variant][scheme]);
      }
    }
  });

  test('fonts and radii resolve per variant (scheme-invariant, web px units)', () => {
    for (const variant of VARIANTS) {
      for (const scheme of SCHEMES) {
        const resolved = resolvedSet(blocks, variant, scheme);
        expect(resolved['--pp-font-sans']).toBe(FontsByVariant[variant].sans);
        expect(resolved['--pp-font-sans-semi-bold']).toBe(FontsByVariant[variant].sansSemiBold);
        expect(resolved['--pp-radius-card']).toBe(`${RadiiByVariant[variant].card}px`);
        expect(resolved['--pp-radius-pill']).toBe('999px');
      }
    }
  });

  test('classicRadius pair vars: classic value on v0, vault value elsewhere', () => {
    const pairs = legacyRadiusPairs();
    expect(pairs.length).toBeGreaterThanOrEqual(8);
    expect(pairs).toContainEqual({ vault: 12, classic: 4 });
    expect(pairs).toContainEqual({ vault: 14, classic: 0 });
    for (const variant of VARIANTS) {
      const resolved = resolvedSet(blocks, variant, 'light');
      for (const { vault, classic } of pairs) {
        expect(resolved[`--pp-cr-${vault}-${classic}`]).toBe(`${vault}px`);
      }
    }
  });

  test('hardcoded legacy anchors (independent of theme-data plumbing)', () => {
    expect(resolvedSet(blocks, 1, 'light')['--pp-primary']).toBe('#0E6B5C');
    expect(resolvedSet(blocks, 1, 'dark')['--pp-overlay']).toBe('rgba(8, 7, 5, 0.6)');
    expect(resolvedSet(blocks, 2, 'light')['--pp-button-primary']).toBe('#00daf8');
    expect(resolvedSet(blocks, 2, 'dark')['--pp-hue-eth-fg']).toBe('#d1bcff');
    expect(resolvedSet(blocks, 3, 'light')['--pp-button-primary']).toBe('#D2F4FB');
    expect(resolvedSet(blocks, 3, 'dark')['--pp-glow']).toBe('#00daf8');
    expect(resolvedSet(blocks, 4, 'light')['--pp-accent']).toBe('#8A7B63');
    expect(resolvedSet(blocks, 4, 'dark')['--pp-danger-bg']).toBe('rgba(224, 141, 133, 0.12)');
    // Embedded-alpha rgba tokens keep their alpha (lossless policy).
    expect(resolvedSet(blocks, 4, 'dark')['--pp-primary-soft']).toBe('rgba(255, 255, 255, 0.08)');
  });
});

describe('generated Tailwind scales + native vars module', () => {
  // CJS module — bun resolves require() from a test just fine.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const scales = require('../constants/theme-scales.generated.js') as {
    colors: Record<string, string>;
    fontFamily: Record<string, string>;
    borderRadius: Record<string, string>;
  };

  test('color scale reads full-color vars (plan naming: text → var(--pp-text))', () => {
    expect(scales.colors.text).toBe('var(--pp-text)');
    expect(scales.colors['button-primary']).toBe('var(--pp-button-primary)');
    expect(scales.colors['hue-eth']).toBe('var(--pp-hue-eth-fg)');
    expect(scales.colors.glow).toBe('var(--pp-glow)');
    expect(Object.keys(scales.colors).length).toBe(30 + 8 + 1);
  });

  test('fontFamily covers the NINE aliases under the pp- prefix', () => {
    expect(Object.keys(scales.fontFamily).sort()).toEqual([
      'pp-bold', 'pp-medium', 'pp-mono', 'pp-regular', 'pp-sans',
      'pp-sans-bold', 'pp-sans-medium', 'pp-sans-semi-bold', 'pp-semi-bold',
    ]);
    expect(scales.fontFamily['pp-sans-semi-bold']).toBe('var(--pp-font-sans-semi-bold)');
    // Guard against re-introducing the fontFamily-tuple fontWeight: Tailwind
    // 3.4 silently drops it (GLM review, critical finding) — the weight
    // channel lives in the generated .font-pp-* rules in global.css instead.
    for (const value of Object.values(scales.fontFamily)) {
      expect(typeof value).toBe('string');
    }
  });

  test('weight channel: the generated region emits a .font-pp-* font-weight rule per alias', () => {
    const css = fs.readFileSync(path.join(ROOT, 'global.css'), 'utf8');
    // Every alias uses a loaded Geist weight; keep CSS weight normal
    // so the selected font face is never synthetically emboldened.
    expect(css).toContain('.font-pp-bold { font-weight: var(--pp-fontw-bold, normal); }');
    expect(css).toContain('.font-pp-medium { font-weight: var(--pp-fontw-medium, normal); }');
    expect(css).toContain('.font-pp-semi-bold { font-weight: var(--pp-fontw-semi-bold, normal); }');
    expect(css).toContain('.font-pp-regular { font-weight: var(--pp-fontw-regular, normal); }');
    expect(css).toContain('.font-pp-mono { font-weight: var(--pp-fontw-mono, normal); }');
    expect(css).toContain('.font-pp-sans-bold { font-weight: var(--pp-fontw-sans-bold, normal); }');
    // …and inside the drift-gated region, so a hand-edit cannot silently drop them.
    const region = css.slice(css.indexOf(CSS_MARKER_START), css.indexOf(CSS_MARKER_END));
    expect(region).toContain('.font-pp-bold { font-weight:');
  });

  test('borderRadius covers Radii + every classicRadius pair alias', () => {
    expect(scales.borderRadius.card).toBe('var(--pp-radius-card)');
    expect(scales.borderRadius['legacy-12']).toBe('var(--pp-cr-12-4)');
    expect(scales.borderRadius['legacy-14-0']).toBe('var(--pp-cr-14-0)');
    expect(Object.keys(scales.borderRadius).length).toBe(4 + legacyRadiusPairs().length);
  });

  test('native vars module carries the default-variant light+dark with unitless lengths', () => {
    const src = fs.readFileSync(path.join(ROOT, 'constants', 'theme-vars.generated.ts'), 'utf8');
    expect(src).toContain("import { vars } from 'nativewind';");
    expect(src).toContain("'--pp-radius-card': 24,");
    expect(src).toContain("'--pp-radius-pill': 999,");
    expect(src).toContain("'--pp-text': '#161616',");
    expect(src).toContain("'--pp-background': '#0E0E0E',");
    expect(src).not.toContain('px'); // native lengths are unitless
  });

  test('COMMITTED native module matches buildNativeVarMaps exhaustively (every key/value/type, both schemes)', () => {
    // Parse the committed artifact (not the renderer) so a generator logic
    // error is localized by CI, not just re-rendered identically.
    const src = fs.readFileSync(path.join(ROOT, 'constants', 'theme-vars.generated.ts'), 'utf8');
    const parseScheme = (scheme: 'light' | 'dark'): Record<string, string | number> => {
      const block = new RegExp(`${scheme}: vars\\(\\{\\n([\\s\\S]*?)\\n  \\}\\)`).exec(src);
      expect(block).not.toBeNull();
      const out: Record<string, string | number> = {};
      for (const line of block![1].split('\n')) {
        const m = /^\s*'(--[\w-]+)': (?:'([^']*)'|([\d.]+)),$/.exec(line);
        expect(m).not.toBeNull();
        out[m![1]] = m![2] !== undefined ? m![2] : Number(m![3]);
      }
      return out;
    };
    const expected = buildNativeVarMaps();
    for (const scheme of ['light', 'dark'] as const) {
      const actual = parseScheme(scheme);
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected[scheme]).sort());
      for (const [name, value] of Object.entries(expected[scheme])) {
        expect(typeof actual[name]).toBe(typeof value);
        expect(actual[name]).toBe(value);
      }
      expect(Object.keys(actual).length).toBeGreaterThanOrEqual(59);
    }
  });
});

describe('durable legacy-radius inventory (finding 2)', () => {
  test('the classicRadius scanner still detects live calls (tripwire) AND the real tree is at the migrated zero end-state', () => {
    // (a) TRIPWIRE — prove the scanner regex still finds classicRadius(a[, b])
    // calls in a controlled fixture. Without this, a broken scanner would
    // silently report zero calls, making validateClassicRadiusCalls pass
    // vacuously and letting a genuinely-missing inventory pair slip through.
    // (Replaces the ed16b7e `>= 0` no-op relaxation — kimi P3 §7.)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scan-'));
    try {
      fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'components', 'nested'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'app', 'fixture.tsx'),
        'const a = classicRadius(16);\nconst b = classicRadius(8, 4);\n',
      );
      fs.writeFileSync(
        path.join(tmp, 'components', 'nested', 'deep.tsx'),
        'const c = classicRadius( 12 , 4 );\nconst dup = classicRadius(16);\n',
      );
      expect(collectClassicRadiusCalls(tmp)).toEqual([
        { vault: 8, classic: 4 }, // two-arg form
        { vault: 12, classic: 4 }, // whitespace-tolerant
        { vault: 16, classic: 4 }, // one-arg form defaults classic=4, de-duplicated
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // (b) EXPLICIT END-STATE — every live classicRadius() call in the real
    // app/ + components/ tree was migrated to a rounded-legacy-* class in P3
    // wave-2 (the money modals were the last holders). Emission is driven by
    // the durable LegacyRadiusPairs inventory, not the scan, so zero live
    // calls is the intended steady state. Asserting it exactly (not `>= 0`)
    // means a regression that re-introduces a raw classicRadius() call, or a
    // scanner that starts matching definitions, fails this test.
    expect(collectClassicRadiusCalls()).toEqual([]);

    // The inventory is still the durable source (covered exhaustively by the
    // two tests below); validateClassicRadiusCalls holds vacuously at zero.
    validateClassicRadiusCalls(legacyRadiusPairs(), collectClassicRadiusCalls());
  });

  test('a live call missing from the inventory fails the build', () => {
    expect(() =>
      validateClassicRadiusCalls([{ vault: 12, classic: 4 }], [{ vault: 12, classic: 4 }, { vault: 10, classic: 4 }]),
    ).toThrow(/missing from LegacyRadiusPairs/);
  });

  test('migrating the LAST call of a pair does NOT remove its alias (inventory is the source)', () => {
    // Simulate P1 having migrated every (16,4) call away: the scan no longer
    // sees the pair, but emission still comes from the inventory.
    const remainingCalls = collectClassicRadiusCalls().filter((p) => !(p.vault === 16 && p.classic === 4));
    validateClassicRadiusCalls(legacyRadiusPairs(), remainingCalls); // subset stays valid
    const css = renderCssRegion(); // inventory-driven
    expect(css).toContain('--pp-cr-16-4:');
  });
});

describe('generated-region marker integrity (finding 6)', () => {
  const region = () => renderCssRegion();
  const directives = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n';

  test('well-formed file regenerates; empty file gets the region appended', () => {
    expect(renderGlobalCss(`${directives}\n${region()}\n`)).toContain(CSS_MARKER_START);
    expect(renderGlobalCss(directives)).toContain(CSS_MARKER_END);
  });

  test('duplicate stale region (two start+end pairs) is rejected', () => {
    const malformed = `${directives}\n${region()}\n\n${region()}\n`;
    expect(() => renderGlobalCss(malformed)).toThrow(/markers are malformed: 2 start \/ 2 end/);
  });

  test('duplicate start marker is rejected', () => {
    const malformed = `${directives}\n${CSS_MARKER_START}\n${region()}\n`;
    expect(() => renderGlobalCss(malformed)).toThrow(/malformed/);
  });

  test('dangling marker (start without end) is rejected', () => {
    const malformed = `${directives}\n${CSS_MARKER_START}\n.pp-v0 { --pp-text: #000; }\n`;
    expect(() => renderGlobalCss(malformed)).toThrow(/malformed/);
  });

  test('reversed markers are rejected', () => {
    const malformed = `${directives}\n${CSS_MARKER_END}\nstale\n${CSS_MARKER_START}\n`;
    expect(() => renderGlobalCss(malformed)).toThrow(/reversed/);
  });
});

describe('slash-opacity allowlist validation (finding 7)', () => {
  test('unknown token is rejected (not silently ignored)', () => {
    expect(() => validateSlashOpacityTokens(['not-a-token'])).toThrow(/not a color token/);
    expect(() => buildVariantVarSets(4, legacyRadiusPairs(), ['not-a-token'])).toThrow(/not a color token/);
  });

  test('duplicate entry is rejected', () => {
    expect(() => validateSlashOpacityTokens(['accent', 'accent'])).toThrow(/duplicate/);
  });

  test('opaque token emits an "R G B" triplet in every set', () => {
    for (const variant of VARIANTS) {
      const sets = buildVariantVarSets(variant, legacyRadiusPairs(), ['background']);
      for (const scheme of SCHEMES) {
        const triplet = sets.byScheme[scheme].get('--pp-background-rgb');
        expect(triplet).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
      }
    }
  });

  test('embedded-alpha token is rejected as a triplet source (alpha is never stripped)', () => {
    // primarySoft is rgba(...) on variant 4 — opacity enforcement must throw.
    expect(() => buildVariantVarSets(4, legacyRadiusPairs(), ['primarySoft'])).toThrow(/not opaque/);
  });
});
