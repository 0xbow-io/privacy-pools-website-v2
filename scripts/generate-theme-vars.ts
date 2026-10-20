// Theme-var generator (NativeWind port, phase F-C deliverable 2).
//
//   safewrap bun scripts/generate-theme-vars.ts            # write outputs
//   safewrap bun scripts/generate-theme-vars.ts --check    # in-memory compare, exit 1 on drift
//
// Single input: `constants/theme-data.ts` (the pure token source). Outputs:
//
//   1. global.css            — the 10 web theme blocks (`.pp-v{N}` base =
//                              scheme-invariant vars + light colors;
//                              `.pp-v{N}.dark` = dark overrides, only where
//                              they differ from light) inside a marked
//                              generated region. The tailwind directives and
//                              anything else outside the markers are
//                              hand-owned and never touched.
//   2. constants/theme-vars.generated.ts
//                            — NativeWind `vars()` objects for NATIVE
//                              light/dark (native is locked to the site
//                              default variant; lengths are unitless numbers
//                              there, px on web).
//   3. constants/theme-scales.generated.js
//                            — the Tailwind theme.extend scales
//                              (colors/fontFamily/borderRadius) reading the
//                              vars; required by tailwind.config.js. Includes
//                              one borderRadius alias per entry of the
//                              DURABLE LegacyRadiusPairs inventory in
//                              theme-data.ts. The live-call scan over
//                              `classicRadius(a, b)` is a VALIDATOR only
//                              (remaining calls ⊆ inventory) so P1 migrations
//                              can never delete an alias they just adopted;
//                              inventory entries retire deliberately in P4.
//
// LOSSLESS COLOR POLICY (plan §"Theme architecture" 2): every token gets a
// full-color var `--pp-*` carrying the exact legacy value (embedded-alpha
// rgba tokens keep their alpha — never stripped). Channel triplets
// (`--pp-*-rgb: R G B` + `rgb(var(...) / <alpha-value>)` scale entries) are
// emitted ONLY for tokens in SLASH_OPACITY_TOKENS, which must be opaque —
// the generator throws otherwise. The list starts EMPTY: no migrated surface
// needs slash-opacity yet; P1+ adds tokens here the first time a real call
// site needs `bg-x/50`, keeping the triplet surface intentional instead of
// blanket.
//
// COLOR PARSER: accepts #RGB/#RGBA/#RRGGBB/#RRGGBBAA, rgb(), rgba(), and
// the keyword `transparent`; REJECTS anything else (hsl, named colors, etc.)
// so a typo in theme-data fails the build instead of shipping an invalid
// var. (#RGBA is the short-alpha form CSS minifiers emit — needed by the
// canonical comparisons in verify-theme-vars.ts.)
//
// Determinism: object iteration is over sorted key lists; byte-identical
// output for identical input. `--check` regenerates in memory and compares
// against the committed files (the CI drift gate — see
// scripts/generate-theme-vars.test.ts).

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ColorsByVariant,
  FONT_ALIAS_WEIGHTS,
  FontsByVariant,
  SYSTEM_FONT_STACK,
  GlowByVariant,
  LegacyRadiusPairs,
  RadiiByVariant,
  TokenHuesByVariant,
  type ColorScheme,
  type DesignVariant,
  type LegacyRadiusPair,
  type ThemeColorTokens,
  type ThemeFontAlias,
} from '../constants/theme-data';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const GLOBAL_CSS = path.join(ROOT, 'global.css');
const NATIVE_VARS_OUT = path.join(ROOT, 'constants', 'theme-vars.generated.ts');
const SCALES_OUT = path.join(ROOT, 'constants', 'theme-scales.generated.js');

export const CSS_MARKER_START = '/* @generated theme-vars start — bun scripts/generate-theme-vars.ts; DO NOT EDIT this region by hand */';
export const CSS_MARKER_END = '/* @generated theme-vars end */';

const VARIANTS: DesignVariant[] = [1, 2, 3, 4];
// Shape reference + the variant native renders (variant 0 "Classic" retired
// 2026-08-18; 4 = Mono Studio, the site default in services/theme-precedence).
const REFERENCE_VARIANT: DesignVariant = 4;
const SCHEMES: ColorScheme[] = ['light', 'dark'];

/**
 * Opaque tokens that need Tailwind slash-opacity (`bg-x/50`) get an extra
 * `--pp-*-rgb` channel triplet. EMPTY by design until a migration wave needs
 * one — see the policy note in the header. Typed against the real token set
 * (typos fail typecheck) AND runtime-validated (validateSlashOpacityTokens:
 * unknown/duplicate entries throw; opacity is enforced across all 10 sets).
 */
export const SLASH_OPACITY_TOKENS: readonly (keyof ThemeColorTokens)[] = [];

// ---------------------------------------------------------------------------
// Color parser
// ---------------------------------------------------------------------------

export interface ParsedColor {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

export function parseColor(value: string): ParsedColor {
  const v = value.trim();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-fA-F]{3})([0-9a-fA-F])?$/.exec(v);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    // #RGBA: the short-alpha form browsers/minifiers emit (e.g. #0009).
    return { r, g, b, a: m[2] !== undefined ? parseInt(m[2] + m[2], 16) / 255 : 1 };
  }
  m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return {
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
      a: m[2] !== undefined ? parseInt(m[2], 16) / 255 : 1,
    };
  }
  m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(v);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].some((c) => c > 255)) throw new Error(`channel out of range in ${JSON.stringify(value)}`);
    return { r, g, b, a: 1 };
  }
  m = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+|1\.0+)\s*\)$/.exec(v);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].some((c) => c > 255)) throw new Error(`channel out of range in ${JSON.stringify(value)}`);
    return { r, g, b, a: Number(m[4]) };
  }
  throw new Error(
    `unsupported color ${JSON.stringify(value)} — theme tokens must be #RGB/#RRGGBB/#RRGGBBAA/rgb()/rgba()/'transparent'`,
  );
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

export const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const colorVar = (token: string) => `--pp-${kebab(token)}`;
const hueVar = (symbol: string, part: 'fg' | 'bg') => `--pp-hue-${symbol.toLowerCase()}-${part}`;
const fontVar = (alias: string) => `--pp-font-${kebab(alias)}`;
const fontWeightVar = (alias: string) => `--pp-fontw-${kebab(alias)}`;
const radiusVar = (key: string) => `--pp-radius-${key}`;
const crVar = (vault: number, classic: number) => `--pp-cr-${vault}-${classic}`;
const crAlias = (vault: number, classic: number) => (classic === 4 ? `legacy-${vault}` : `legacy-${vault}-${classic}`);

// ---------------------------------------------------------------------------
// Legacy-radius inventory (DURABLE) + live-call validator
//
// The emission source is theme-data's LegacyRadiusPairs (stable contract,
// retired deliberately in P4). The regex scan below only VALIDATES that the
// classicRadius() calls still present in the styled trees are covered by the
// inventory — so a NEW pair fails the build until it is added, while
// MIGRATING the last call of a pair never deletes the alias.
// ---------------------------------------------------------------------------

/** Inventory accessor: validated (sorted, unique) copy of LegacyRadiusPairs. */
export function legacyRadiusPairs(): readonly LegacyRadiusPair[] {
  for (let i = 0; i < LegacyRadiusPairs.length; i++) {
    const p = LegacyRadiusPairs[i];
    if (!Number.isInteger(p.vault) || !Number.isInteger(p.classic) || p.vault < 0 || p.classic < 0) {
      throw new Error(`LegacyRadiusPairs[${i}] is not a pair of non-negative integers`);
    }
    if (i > 0) {
      const q = LegacyRadiusPairs[i - 1];
      const cmp = p.vault - q.vault || p.classic - q.classic;
      if (cmp === 0) throw new Error(`LegacyRadiusPairs has a duplicate entry (${p.vault}, ${p.classic})`);
      if (cmp < 0) throw new Error('LegacyRadiusPairs must stay sorted by (vault, classic)');
    }
  }
  return LegacyRadiusPairs;
}

/** Scan the styled trees for distinct live classicRadius(a[, b]) pairs. */
export function collectClassicRadiusCalls(root = ROOT): LegacyRadiusPair[] {
  const pairs = new Map<string, LegacyRadiusPair>();
  const scan = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(p);
      else if (/\.tsx?$/.test(entry.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/classicRadius\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/g)) {
          const vault = Number(m[1]);
          const classic = m[2] !== undefined ? Number(m[2]) : 4;
          pairs.set(`${vault}-${classic}`, { vault, classic });
        }
      }
    }
  };
  scan(path.join(root, 'app'));
  scan(path.join(root, 'components'));
  return [...pairs.values()].sort((a, b) => a.vault - b.vault || a.classic - b.classic);
}

/** Validator: every live call pair must be covered by the inventory. */
export function validateClassicRadiusCalls(
  inventory: readonly LegacyRadiusPair[] = legacyRadiusPairs(),
  calls: readonly LegacyRadiusPair[] = collectClassicRadiusCalls(),
): void {
  const known = new Set(inventory.map((p) => `${p.vault}-${p.classic}`));
  const missing = calls.filter((p) => !known.has(`${p.vault}-${p.classic}`));
  if (missing.length > 0) {
    throw new Error(
      `classicRadius() calls use pairs missing from LegacyRadiusPairs (constants/theme-data.ts): ` +
        missing.map((p) => `(${p.vault}, ${p.classic})`).join(', ') +
        ` — add them to the inventory (aliases are emitted from the inventory, never from the scan).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Var-set assembly (shared by web CSS + native vars)
// ---------------------------------------------------------------------------

const sortedKeys = (o: Record<string, unknown>) => Object.keys(o).sort();

interface VarSets {
  /** Scheme-invariant vars (fonts, radii, classicRadius pairs) — web strings. */
  invariant: Map<string, string>;
  /** Scheme-dependent vars (colors, hues, glow) per scheme — web strings. */
  byScheme: Record<ColorScheme, Map<string, string>>;
}

function validateVariantShape(variant: DesignVariant): void {
  const referenceColorKeys = sortedKeys(ColorsByVariant[REFERENCE_VARIANT].light);
  const referenceHueKeys = sortedKeys(TokenHuesByVariant[REFERENCE_VARIANT].light);
  const referenceFontKeys = sortedKeys(FontsByVariant[REFERENCE_VARIANT]);
  for (const scheme of SCHEMES) {
    const colorKeys = sortedKeys(ColorsByVariant[variant][scheme]);
    if (colorKeys.join() !== referenceColorKeys.join()) {
      throw new Error(`variant ${variant}/${scheme}: color keys differ from the reference variant's light set`);
    }
    const hueKeys = sortedKeys(TokenHuesByVariant[variant][scheme]);
    if (hueKeys.join() !== referenceHueKeys.join()) {
      throw new Error(`variant ${variant}/${scheme}: hue keys differ from the reference variant's light set`);
    }
  }
  if (sortedKeys(FontsByVariant[variant]).join() !== referenceFontKeys.join()) {
    throw new Error(`variant ${variant}: font aliases differ from the reference variant`);
  }
}

/**
 * Slash-opacity allowlist validation (codex F-C review, finding 7): every
 * entry must name a real color token (typos are rejected, not silently
 * ignored) and appear only once; opacity is enforced per variant×scheme in
 * buildVariantVarSets (all 10 sets, since every set is built).
 */
export function validateSlashOpacityTokens(
  list: readonly string[] = SLASH_OPACITY_TOKENS,
  colorKeys: readonly string[] = Object.keys(ColorsByVariant[REFERENCE_VARIANT].light),
): void {
  const known = new Set(colorKeys);
  const seen = new Set<string>();
  for (const token of list) {
    if (!known.has(token)) {
      throw new Error(`SLASH_OPACITY_TOKENS entry ${JSON.stringify(token)} is not a color token`);
    }
    if (seen.has(token)) {
      throw new Error(`SLASH_OPACITY_TOKENS has a duplicate entry ${JSON.stringify(token)}`);
    }
    seen.add(token);
  }
}

export function buildVariantVarSets(
  variant: DesignVariant,
  pairs: readonly LegacyRadiusPair[],
  slashTokens: readonly string[] = SLASH_OPACITY_TOKENS,
): VarSets {
  validateVariantShape(variant);
  validateSlashOpacityTokens(slashTokens);
  const slash = new Set(slashTokens);
  const invariant = new Map<string, string>();
  for (const alias of sortedKeys(FontsByVariant[variant]) as ThemeFontAlias[]) {
    const face = FontsByVariant[variant][alias];
    invariant.set(fontVar(alias), face);
    // Weight channel (2026-08-18, IBM Plex Mono removal): the system stack
    // carries no baked weight, so its aliases get the numeric weight the
    // alias MEANS; prebaked faces (Geist_700Bold …) stay 'normal' — a
    // synthetic 700 on top of a bold face would double-bold.
    invariant.set(fontWeightVar(alias), face === SYSTEM_FONT_STACK ? FONT_ALIAS_WEIGHTS[alias] : 'normal');
  }
  const radii = RadiiByVariant[variant];
  for (const key of sortedKeys(radii)) {
    invariant.set(radiusVar(key), `${radii[key as keyof typeof radii]}px`);
  }
  // Classic (variant 0) retired: the cr-{vault}-{classic} vars resolve to the
  // vault value everywhere until the rounded-legacy-* aliases are migrated.
  for (const { vault, classic } of pairs) {
    invariant.set(crVar(vault, classic), `${vault}px`);
  }

  const byScheme = {} as Record<ColorScheme, Map<string, string>>;
  for (const scheme of SCHEMES) {
    const map = new Map<string, string>();
    const colors = ColorsByVariant[variant][scheme] as Record<string, string>;
    for (const token of sortedKeys(colors)) {
      const value = colors[token];
      const parsed = parseColor(value); // validates
      map.set(colorVar(token), value);
      if (slash.has(token)) {
        if (parsed.a !== 1) {
          throw new Error(
            `SLASH_OPACITY_TOKENS entry ${token} (${variant}/${scheme}) is not opaque (${value}) — ` +
              `triplets are for opaque tokens only; embedded-alpha tokens keep their alpha`,
          );
        }
        map.set(`${colorVar(token)}-rgb`, `${parsed.r} ${parsed.g} ${parsed.b}`);
      }
    }
    const hues = TokenHuesByVariant[variant][scheme];
    for (const symbol of sortedKeys(hues)) {
      parseColor(hues[symbol].fg);
      parseColor(hues[symbol].bg);
      map.set(hueVar(symbol, 'fg'), hues[symbol].fg);
      map.set(hueVar(symbol, 'bg'), hues[symbol].bg);
    }
    parseColor(GlowByVariant[variant][scheme]);
    map.set('--pp-glow', GlowByVariant[variant][scheme]);
    byScheme[scheme] = map;
  }
  return { invariant, byScheme };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export function renderCssRegion(pairs: readonly LegacyRadiusPair[] = legacyRadiusPairs()): string {
  const lines: string[] = [CSS_MARKER_START];
  lines.push(
    '/*',
    ' * Per-variant token vars. The scheme authority (components/theme-provider.tsx',
    ' * + the app/+html.tsx pre-paint bootstrap) puts exactly one `pp-v{N}` class',
    ' * (plus `dark` when applicable) on <html>; RN-Web Modals portal to',
    ' * document.body, which is why the classes live on the root element.',
    ' * Base block = scheme-invariant vars + light colors; the .dark block only',
    ' * carries values that differ from light (the base still applies to the',
    ' * same element, so identical values are inherited, not repeated).',
    ' */',
  );
  for (const variant of VARIANTS) {
    const sets = buildVariantVarSets(variant, pairs);
    lines.push(`.pp-v${variant} {`);
    for (const [name, value] of sets.invariant) lines.push(`  ${name}: ${value};`);
    for (const [name, value] of sets.byScheme.light) lines.push(`  ${name}: ${value};`);
    lines.push('}');
    lines.push(`.pp-v${variant}.dark {`);
    for (const [name, value] of sets.byScheme.dark) {
      if (sets.byScheme.light.get(name) !== value) lines.push(`  ${name}: ${value};`);
    }
    lines.push('}');
  }
  lines.push(
    '',
    '/*',
    ' * font-pp-* weight channel (IBM Plex Mono removal): the system stack has',
    ' * no baked weight the way the retired per-weight faces did, so each alias',
    ' * utility also carries its weight var. This CANNOT ride the Tailwind',
    ' * fontFamily tuple: Tailwind 3.4 silently drops every second-element key',
    ' * except fontFeatureSettings/fontVariationSettings (GLM review, critical',
    ' * finding). The var fallback is the reference variant\'s weight, for',
    ' * contexts where the variant vars are not applied (native pre-P1).',
    ' * NOTE: these rules are emitted AFTER the core utilities, so on an',
    ' * element combining font-pp-* with a core weight utility (font-bold)',
    ' * the alias weight wins; no such combination exists in the app today.',
    ' */',
    '@layer utilities {',
  );
  for (const alias of sortedKeys(FontsByVariant[REFERENCE_VARIANT]) as ThemeFontAlias[]) {
    const fallback =
      FontsByVariant[REFERENCE_VARIANT][alias] === SYSTEM_FONT_STACK
        ? FONT_ALIAS_WEIGHTS[alias]
        : 'normal';
    lines.push(`  .font-pp-${kebab(alias)} { font-weight: var(${fontWeightVar(alias)}, ${fallback}); }`);
  }
  lines.push('}');
  lines.push(CSS_MARKER_END);
  return lines.join('\n');
}

export function renderGlobalCss(existing: string, pairs: readonly LegacyRadiusPair[] = legacyRadiusPairs()): string {
  const region = renderCssRegion(pairs);
  // Marker integrity (codex F-C review, finding 6): a duplicate/stale region
  // later in the cascade would regenerate byte-for-byte and pass --check
  // while its declarations win in the browser. Require EXACTLY one start and
  // one end marker, correctly ordered; reject duplicates, reversed pairs,
  // and dangling markers.
  const countOf = (needle: string) => existing.split(needle).length - 1;
  const startCount = countOf(CSS_MARKER_START);
  const endCount = countOf(CSS_MARKER_END);
  if (startCount === 0 && endCount === 0) {
    return existing.replace(/\s*$/, '\n\n') + region + '\n';
  }
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `global.css generated-region markers are malformed: ${startCount} start / ${endCount} end markers ` +
        `(expected exactly one of each) — repair the file by hand before regenerating`,
    );
  }
  const start = existing.indexOf(CSS_MARKER_START);
  const end = existing.indexOf(CSS_MARKER_END);
  if (end < start) {
    throw new Error('global.css generated-region markers are reversed (end marker before start marker)');
  }
  return existing.slice(0, start) + region + existing.slice(end + CSS_MARKER_END.length);
}

/**
 * The plain native var maps behind the generated module — exposed so tests
 * can compare the COMMITTED module exhaustively (every key, value, and
 * number-vs-string type, both schemes) against this in-memory source.
 * Native lengths are unitless numbers (px is a web-only unit here).
 */
export function buildNativeVarMaps(
  pairs: readonly LegacyRadiusPair[] = legacyRadiusPairs(),
): Record<ColorScheme, Record<string, string | number>> {
  const sets = buildVariantVarSets(REFERENCE_VARIANT, pairs);
  const out: Record<ColorScheme, Record<string, string | number>> = { light: {}, dark: {} };
  for (const scheme of SCHEMES) {
    for (const [name, value] of sets.invariant) {
      out[scheme][name] = value.endsWith('px') ? Number(value.slice(0, -2)) : value;
    }
    for (const [name, value] of sets.byScheme[scheme]) out[scheme][name] = value;
  }
  return out;
}

/** Native (single variant — native is locked to the site default, Mono Studio). */
export function renderNativeVarsModule(pairs: readonly LegacyRadiusPair[] = legacyRadiusPairs()): string {
  const maps = buildNativeVarMaps(pairs);
  const emitScheme = (scheme: ColorScheme): string =>
    Object.entries(maps[scheme])
      .map(([name, value]) => `    '${name}': ${typeof value === 'number' ? value : `'${value}'`},`)
      .join('\n');
  return [
    '// AUTO-GENERATED by `bun scripts/generate-theme-vars.ts` — DO NOT EDIT.',
    '// NativeWind runtime vars for NATIVE (locked to the site-default variant,',
    '// Mono Studio; web gets every variant as CSS classes in global.css).',
    '// P1 applies these at the native root; nothing imports them during F-C',
    '// (dual-run: no user-visible change).',
    "import { vars } from 'nativewind';",
    '',
    'export const NativeThemeVars = {',
    '  light: vars({',
    emitScheme('light'),
    '  }),',
    '  dark: vars({',
    emitScheme('dark'),
    '  }),',
    '} as const;',
    '',
  ].join('\n');
}

/** Tailwind theme.extend scales (required by tailwind.config.js). */
export function renderScalesModule(pairs: readonly LegacyRadiusPair[] = legacyRadiusPairs()): string {
  const colorTokens = sortedKeys(ColorsByVariant[REFERENCE_VARIANT].light);
  const slash: ReadonlySet<string> = new Set(SLASH_OPACITY_TOKENS);
  const colorEntries = colorTokens.map((token) => {
    const value = slash.has(token)
      ? `rgb(var(${colorVar(token)}-rgb) / <alpha-value>)`
      : `var(${colorVar(token)})`;
    return `    '${kebab(token)}': '${value}',`;
  });
  const hueEntries = sortedKeys(TokenHuesByVariant[REFERENCE_VARIANT].light).flatMap((symbol) => [
    `    'hue-${symbol.toLowerCase()}': 'var(${hueVar(symbol, 'fg')})',`,
    `    'hue-${symbol.toLowerCase()}-bg': 'var(${hueVar(symbol, 'bg')})',`,
  ]);
  const fontEntries = sortedKeys(FontsByVariant[REFERENCE_VARIANT]).map(
    // `pp-` prefix on purpose: bare alias keys would collide with Tailwind's
    // CORE fontWeight utilities (`font-medium`, `font-bold`) and silently
    // change their meaning.
    //
    // Plain string on purpose: Tailwind 3.4's fontFamily tuple drops every
    // second-element key except fontFeatureSettings/fontVariationSettings,
    // so a { fontWeight } there is a silent no-op. The alias weight is
    // emitted as explicit .font-pp-* rules in the generated global.css
    // region instead (see renderCssRegion).
    (alias) => `    'pp-${kebab(alias)}': 'var(${fontVar(alias)})',`,
  );
  const radiusEntries = [
    ...sortedKeys(RadiiByVariant[REFERENCE_VARIANT]).map((key) => `    '${key}': 'var(${radiusVar(key)})',`),
    ...pairs.map(({ vault, classic }) => `    '${crAlias(vault, classic)}': 'var(${crVar(vault, classic)})',`),
  ];
  return [
    '// AUTO-GENERATED by `bun scripts/generate-theme-vars.ts` — DO NOT EDIT.',
    '// Tailwind theme.extend scales reading the generated `--pp-*` vars',
    '// (see global.css). Consumed by tailwind.config.js. CommonJS on purpose:',
    '// the Tailwind config is a CJS module.',
    'module.exports = {',
    '  colors: {',
    ...colorEntries,
    ...hueEntries,
    "    glow: 'var(--pp-glow)',",
    '  },',
    '  fontFamily: {',
    ...fontEntries,
    '  },',
    '  borderRadius: {',
    '    // card/inner/control/pill mirror Radii; legacy-* aliases cover every',
    '    // entry of the DURABLE LegacyRadiusPairs inventory (theme-data.ts) —',
    '    // classic value omitted from the name when it is the default 4.',
    ...radiusEntries,
    '  },',
    '};',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Output {
  file: string;
  content: string;
}

export function generateAll(): Output[] {
  const pairs = legacyRadiusPairs();
  // Durable-inventory guard: live classicRadius() calls must be covered.
  validateClassicRadiusCalls(pairs);
  const existingCss = fs.readFileSync(GLOBAL_CSS, 'utf8');
  return [
    { file: GLOBAL_CSS, content: renderGlobalCss(existingCss, pairs) },
    { file: NATIVE_VARS_OUT, content: renderNativeVarsModule(pairs) },
    { file: SCALES_OUT, content: renderScalesModule(pairs) },
  ];
}

function main(): void {
  const check = process.argv.includes('--check');
  const outputs = generateAll();
  let drift = 0;
  for (const { file, content } of outputs) {
    const rel = path.relative(ROOT, file);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (check) {
      if (existing !== content) {
        drift++;
        console.error(`DRIFT: ${rel} does not match the generator output — run: bun scripts/generate-theme-vars.ts`);
      } else {
        console.log(`ok ${rel}`);
      }
    } else if (existing === content) {
      console.log(`unchanged ${rel}`);
    } else {
      fs.writeFileSync(file, content);
      console.log(`wrote ${rel} (${content.length} bytes)`);
    }
  }
  if (check && drift > 0) process.exit(1);
}

// Bun sets `import.meta.main`; the field isn't in the ambient ImportMeta type.
if ((import.meta as ImportMeta & { main?: boolean }).main) main();
