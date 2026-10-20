/**
 * Pure design-token data — the raw variant maps behind `constants/theme.ts`
 * (which stays the app-facing API) and the theme-var generator
 * (`scripts/generate-theme-vars.ts`).
 *
 * HARD CONSTRAINT: this module imports NOTHING from react-native, the DOM,
 * or any storage API — it must be importable from a plain Bun/Node process
 * (the generator, tests) exactly as-is. `scripts/theme-data-probe.test.ts`
 * enforces this.
 *
 * Token values are verbatim moves from the pre-split `constants/theme.ts`
 * (plus the LiquidLight / VaultBackdrop palette literals that previously
 * lived in their components) — the F-C dual-run guarantee is that nothing
 * user-visible changes, so treat any value edit here as a design change, not
 * a refactor.
 */

export type DesignVariant = 1 | 2 | 3 | 4;
export type ColorScheme = 'light' | 'dark';

// ---------------------------------------------------------------------------
// Variant 1 — Warm Vault
// ---------------------------------------------------------------------------

const evergreen = '#0E6B5C';
const evergreenDeep = '#0A5447';
const evergreenBright = '#19B091';
const amber = '#E8A33D';

const warmVaultColors = {
  light: {
    text: '#1C1A16',
    textSecondary: '#57534B',
    textMuted: '#8E887C',
    textLight: '#6E685D',
    background: '#FAF7F1',
    backgroundSecondary: '#F1EDE4',
    tint: evergreen,
    icon: '#6E685D',
    tabIconDefault: '#8E887C',
    tabIconSelected: evergreen,
    border: '#E5DFD2',
    borderLight: '#EEE9DE',
    cardBackground: '#FFFFFF',
    // CTA identical to dark mode so the button reads the same everywhere.
    buttonPrimary: evergreenBright,
    buttonPrimaryText: '#0C1F19',
    buttonPrimaryPressed: '#13937A',
    accent: amber,
    primary: evergreen,
    primaryPressed: evergreenDeep,
    primarySoft: '#E3F0EB',
    accentSoft: '#FAEDD7',
    surfaceRaised: '#FFFDF9',
    menuBackground: '#FFFFFF',
    success: '#1E7F4F',
    successBg: '#E2F2E7',
    warning: '#A8650E',
    warningBg: '#FAEDD7',
    danger: '#B3402F',
    dangerBg: '#F9E7E2',
    overlay: 'rgba(28, 26, 22, 0.45)',
  },
  dark: {
    text: '#F0EDE6',
    textSecondary: '#B5AFA3',
    textMuted: '#857F73',
    textLight: '#A39D90',
    background: '#16140F',
    backgroundSecondary: '#221F18',
    tint: evergreenBright,
    icon: '#B5AFA3',
    tabIconDefault: '#857F73',
    tabIconSelected: evergreenBright,
    border: '#2E2A21',
    borderLight: '#262218',
    cardBackground: '#1E1B14',
    buttonPrimary: evergreenBright,
    buttonPrimaryText: '#0C1F19',
    buttonPrimaryPressed: '#13937A',
    accent: amber,
    primary: evergreenBright,
    primaryPressed: '#13937A',
    primarySoft: '#15302A',
    accentSoft: '#33270F',
    surfaceRaised: '#262218',
    menuBackground: '#28241B',
    success: '#3FBF7F',
    successBg: '#15302A',
    warning: '#E8A33D',
    warningBg: '#33270F',
    danger: '#E06A52',
    dangerBg: '#371E17',
    overlay: 'rgba(8, 7, 5, 0.6)',
  },
};

const warmVaultHues = {
  ETH: { fg: '#4E6FB0', bg: 'rgba(98, 126, 234, 0.12)' },
  USDC: { fg: '#2775CA', bg: 'rgba(39, 117, 202, 0.12)' },
  USDT: { fg: '#26A17B', bg: 'rgba(38, 161, 123, 0.12)' },
  DAI: { fg: '#C8901A', bg: 'rgba(245, 172, 55, 0.14)' },
};

// ---------------------------------------------------------------------------
// Variants 2 + 3 — Electric Blue
// ---------------------------------------------------------------------------

const cyan = '#00daf8'; // primary-fixed-dim / surface-tint
const cyanBright = '#00e0ff'; // primary-container
const cyanInk = '#001f25'; // on-primary-fixed
const cyanDeepLight = '#006877'; // inverse-primary → light-mode primary
const violetDim = '#d1bcff'; // secondary-fixed-dim

const electricDarkBase = {
  text: '#E5E2E1',
  textSecondary: '#BAC9CD',
  textMuted: '#859397',
  textLight: '#A6B2B5',
  background: '#131313',
  backgroundSecondary: '#1C1B1B',
  tint: cyan,
  icon: '#BAC9CD',
  tabIconDefault: '#859397',
  tabIconSelected: cyan,
  border: 'rgba(255, 255, 255, 0.08)',
  borderLight: 'rgba(255, 255, 255, 0.05)',
  cardBackground: '#201F1F',
  accent: violetDim,
  primary: cyan,
  primaryPressed: '#00B7D0',
  primarySoft: 'rgba(0, 218, 248, 0.10)',
  accentSoft: 'rgba(112, 0, 255, 0.15)',
  surfaceRaised: '#2A2A2A',
  menuBackground: '#2A2929',
  success: cyanBright,
  successBg: 'rgba(0, 224, 255, 0.10)',
  warning: '#E8A33D',
  warningBg: 'rgba(232, 163, 61, 0.14)',
  danger: '#FFB4AB',
  dangerBg: 'rgba(147, 0, 10, 0.30)',
  overlay: 'rgba(5, 5, 5, 0.70)',
};

const electricV1Colors = {
  light: {
    text: '#171C1D',
    textSecondary: '#3F484A',
    textMuted: '#6F797B',
    textLight: '#56605F',
    background: '#F4F8F9',
    backgroundSecondary: '#E9EFF0',
    tint: cyanDeepLight,
    icon: '#56605F',
    tabIconDefault: '#6F797B',
    tabIconSelected: cyanDeepLight,
    border: '#DCE4E6',
    borderLight: '#E8EEEF',
    cardBackground: '#FFFFFF',
    // CTA identical to dark mode so the button reads the same everywhere.
    buttonPrimary: cyan,
    buttonPrimaryText: cyanInk,
    buttonPrimaryPressed: '#00B7D0',
    accent: '#5700C9',
    primary: cyanDeepLight,
    primaryPressed: '#00525E',
    primarySoft: '#D6F6FF',
    accentSoft: '#EDE2FF',
    surfaceRaised: '#FDFEFE',
    menuBackground: '#FFFFFF',
    success: '#007D8C',
    successBg: '#D6F6FF',
    warning: '#A8650E',
    warningBg: '#FAEDD7',
    danger: '#BA1A1A',
    dangerBg: '#FFDAD6',
    overlay: 'rgba(13, 17, 18, 0.45)',
  },
  dark: {
    ...electricDarkBase,
    buttonPrimary: cyan,
    buttonPrimaryText: cyanInk,
    buttonPrimaryPressed: '#00B7D0',
  },
};

const electricV2Colors = {
  light: {
    text: '#101718',
    textSecondary: '#3D4A4D',
    textMuted: '#69787C',
    textLight: '#526164',
    background: '#F2F8FA',
    backgroundSecondary: '#E4EEF1',
    tint: '#006E80',
    icon: '#526164',
    tabIconDefault: '#69787C',
    tabIconSelected: '#006E80',
    border: '#D8E5E8',
    borderLight: '#E6EFF1',
    cardBackground: '#FFFFFF',
    // CTA identical to dark mode — pale ice cyan with dark ink — so the
    // button reads the same everywhere.
    buttonPrimary: '#D2F4FB',
    buttonPrimaryText: cyanInk,
    buttonPrimaryPressed: '#A5EEFF',
    accent: '#5700C9',
    // Electric Blue extensions. `primary` is the TEXT-grade cyan (links,
    // eyebrows, active nav) — deep enough to read on the light canvas;
    // `buttonPrimary` above is the FILL-grade cyan.
    primary: '#006E80',
    primaryPressed: '#005662',
    // Tint of the light primary (#D2F4FB is reserved for the CTA fill).
    primarySoft: 'rgba(0, 110, 128, 0.12)',
    accentSoft: '#EFE6FF',
    surfaceRaised: '#FBFEFF',
    menuBackground: '#FFFFFF',
    // Deep enough to clear 4.5:1 on successBg at the 10.5px chip size.
    success: '#006B78',
    successBg: 'rgba(0, 125, 140, 0.10)',
    warning: '#A8650E',
    warningBg: '#FAEDD7',
    danger: '#BA1A1A',
    dangerBg: '#FFDAD6',
    overlay: 'rgba(9, 14, 15, 0.45)',
  },
  dark: {
    ...electricDarkBase,
    // Pale ice cyan (rgb 210,244,251) — the CTA reads as a soft pill with
    // dark ink, not a neon block; pressed dips to primary-fixed (#a5eeff).
    buttonPrimary: '#D2F4FB',
    buttonPrimaryText: cyanInk,
    buttonPrimaryPressed: '#A5EEFF',
  },
};

// Per-token identity hues. ETH wears the violet secondary (per the design
// spec's token pills); stables keep their brand blues/greens. Theme-keyed:
// the dark fgs are pastel (legible on glass), the light fgs are deep
// (legible on white).
const electricHuesDark = {
  ETH: { fg: violetDim, bg: 'rgba(112, 0, 255, 0.18)' },
  USDC: { fg: '#6FB3F2', bg: 'rgba(39, 117, 202, 0.18)' },
  USDT: { fg: '#4FD1A5', bg: 'rgba(38, 161, 123, 0.18)' },
  DAI: { fg: '#F5C36B', bg: 'rgba(245, 172, 55, 0.18)' },
};

const electricHuesLight = {
  ETH: { fg: '#5700C9', bg: 'rgba(112, 0, 255, 0.10)' },
  USDC: { fg: '#2775CA', bg: 'rgba(39, 117, 202, 0.10)' },
  USDT: { fg: '#1B7A5E', bg: 'rgba(38, 161, 123, 0.12)' },
  DAI: { fg: '#9A6A0B', bg: 'rgba(245, 172, 55, 0.16)' },
};

// ---------------------------------------------------------------------------
// Variant 4 — Mono Studio
// ---------------------------------------------------------------------------

const monoStudioColors = {
  light: {
    text: '#161616',
    textSecondary: '#4A4A4A',
    textMuted: '#8A8A8A',
    textLight: '#6E6E6E',
    background: '#FAFAF9',
    backgroundSecondary: '#F0F0EF',
    tint: '#161616',
    icon: '#6E6E6E',
    tabIconDefault: '#8A8A8A',
    tabIconSelected: '#161616',
    border: '#E4E4E2',
    borderLight: '#EEEEEC',
    cardBackground: '#FFFFFF',
    // Ink-inverted CTA — the one place the theme goes full contrast.
    buttonPrimary: '#161616',
    buttonPrimaryText: '#FFFFFF',
    buttonPrimaryPressed: '#383838',
    accent: '#8A7B63',
    primary: '#161616',
    primaryPressed: '#000000',
    primarySoft: 'rgba(0, 0, 0, 0.05)',
    accentSoft: 'rgba(138, 123, 99, 0.10)',
    surfaceRaised: '#FCFCFB',
    menuBackground: '#FFFFFF',
    success: '#006877',
    successBg: 'rgba(0, 218, 248, 0.12)',
    warning: '#9A6A0B',
    warningBg: '#F7EFDD',
    danger: '#B3402F',
    dangerBg: '#F9E7E2',
    overlay: 'rgba(20, 20, 20, 0.40)',
  },
  dark: {
    text: '#F2F2F2',
    textSecondary: '#B3B3B3',
    textMuted: '#7A7A7A',
    textLight: '#999999',
    background: '#0E0E0E',
    backgroundSecondary: '#161616',
    tint: '#EDEDED',
    icon: '#B3B3B3',
    tabIconDefault: '#7A7A7A',
    tabIconSelected: '#EDEDED',
    border: 'rgba(255, 255, 255, 0.07)',
    borderLight: 'rgba(255, 255, 255, 0.04)',
    cardBackground: '#202020',
    buttonPrimary: '#F2F2F2',
    buttonPrimaryText: '#111111',
    buttonPrimaryPressed: '#D9D9D9',
    accent: '#D8CFC0',
    primary: '#EDEDED',
    primaryPressed: '#CFCFCF',
    primarySoft: 'rgba(255, 255, 255, 0.08)',
    accentSoft: 'rgba(216, 207, 192, 0.12)',
    surfaceRaised: '#222222',
    menuBackground: '#2A2A2A',
    success: '#7BE8FA',
    successBg: 'rgba(0, 218, 248, 0.16)',
    warning: '#D9B36A',
    warningBg: 'rgba(217, 179, 106, 0.12)',
    danger: '#E08D85',
    dangerBg: 'rgba(224, 141, 133, 0.12)',
    overlay: 'rgba(0, 0, 0, 0.70)',
  },
};

// Token identity survives, but desaturated to sit on the neutral canvas.
const monoHuesDark = {
  ETH: { fg: '#A9B4C9', bg: 'rgba(140, 160, 200, 0.12)' },
  USDC: { fg: '#9FBEDD', bg: 'rgba(100, 150, 200, 0.10)' },
  USDT: { fg: '#9CCDB9', bg: 'rgba(80, 170, 140, 0.10)' },
  DAI: { fg: '#D5BE93', bg: 'rgba(220, 180, 110, 0.10)' },
};

const monoHuesLight = {
  ETH: { fg: '#5A6B8C', bg: 'rgba(90, 107, 140, 0.08)' },
  USDC: { fg: '#3A6EA5', bg: 'rgba(58, 110, 165, 0.08)' },
  USDT: { fg: '#2E7D5B', bg: 'rgba(46, 125, 91, 0.08)' },
  DAI: { fg: '#8A6D2F', bg: 'rgba(138, 109, 47, 0.10)' },
};

// ---------------------------------------------------------------------------
// Variant-keyed maps (the app-facing selections live in constants/theme.ts)
// ---------------------------------------------------------------------------

export type ThemeColorSet = typeof electricV2Colors;
export type ThemeColorTokens = ThemeColorSet['light'];
export type TokenHue = { fg: string; bg: string };

export const ColorsByVariant: Record<DesignVariant, ThemeColorSet> = {
  1: warmVaultColors,
  2: electricV1Colors,
  3: electricV2Colors,
  4: monoStudioColors,
};

export const TokenHuesByVariant: Record<
  DesignVariant,
  Record<ColorScheme, Record<string, TokenHue>>
> = {
  // Warm Vault and Electric v1 were scheme-agnostic — same hues both ways.
  1: { light: warmVaultHues, dark: warmVaultHues },
  2: { light: electricHuesDark, dark: electricHuesDark },
  3: { light: electricHuesLight, dark: electricHuesDark },
  4: { light: monoHuesLight, dark: monoHuesDark },
};

/**
 * The NINE font aliases — the exact face-selection contract (never
 * family+weight emulation). Typed so `ThemeAccess.font('semibold')` (typo)
 * fails typecheck instead of returning undefined at runtime.
 */
export type ThemeFontAlias =
  | 'regular'
  | 'medium'
  | 'semiBold'
  | 'bold'
  | 'sans'
  | 'sansMedium'
  | 'sansSemiBold'
  | 'sansBold'
  | 'mono';

/**
 * Manager directive (2026-08-18): IBM Plex Mono is REMOVED — every alias
 * that carried it resolves to the modern system stack instead. A stack has
 * no baked weight (the old faces did: IBMPlexMono_700Bold WAS the weight),
 * so the generator emits a companion `--pp-fontw-<alias>` weight var:
 * numeric weights for system-stack aliases, 'normal' for prebaked faces
 * (a synthetic 700 on top of Geist_700Bold would double-bold).
 */
export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** A weight value valid for RN TextStyle, SVG props, and CSS alike. */
export type ThemeFontWeight = 'normal' | '400' | '500' | '600' | '700';

/** The weight each alias MEANS, applied only when its face is the stack. */
export const FONT_ALIAS_WEIGHTS: Record<ThemeFontAlias, ThemeFontWeight> = {
  regular: '400',
  medium: '500',
  semiBold: '600',
  bold: '700',
  sans: '400',
  sansMedium: '500',
  sansSemiBold: '600',
  sansBold: '700',
  mono: '500',
};

// One type family across themes, including legacy UI and numeric aliases.
const geistFonts: Record<ThemeFontAlias, string> = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semiBold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',
  sans: 'Geist_400Regular',
  sansMedium: 'Geist_500Medium',
  sansSemiBold: 'Geist_600SemiBold',
  sansBold: 'Geist_700Bold',
  mono: 'Geist_500Medium',
};

export const FontsByVariant: Record<DesignVariant, Record<ThemeFontAlias, string>> = {
  1: { ...geistFonts },
  2: { ...geistFonts },
  3: { ...geistFonts },
  4: { ...geistFonts },
};

/** Shared geometry across themes: shells, inset panels, controls, and pills. */
export const RadiiByVariant: Record<
  DesignVariant,
  { card: number; inner: number; control: number; pill: number }
> = {
  1: { card: 24, inner: 16, control: 12, pill: 999 },
  2: { card: 24, inner: 16, control: 12, pill: 999 },
  3: { card: 24, inner: 16, control: 12, pill: 999 },
  4: { card: 24, inner: 16, control: 12, pill: 999 },
};

/**
 * DURABLE legacy-radius inventory (codex F-C review, finding 2) — the
 * contract behind every `--pp-cr-{vault}-{classic}` var and
 * `rounded-legacy-*` Tailwind alias. The generator emits FROM this list;
 * the live-call scan over `classicRadius(a, b)` is only a VALIDATOR
 * (remaining calls must be a subset of this inventory). That way P1 can
 * migrate the last `classicRadius(16)` call to `rounded-legacy-16` without
 * the next regeneration deleting the very alias it just adopted. Entries
 * are retired DELIBERATELY in P4 (when both the calls and the migrated
 * class consumers are gone), never as a regeneration side effect.
 *
 * Keep sorted by (vault, classic); the generator rejects duplicates and
 * unsorted entries to stay deterministic.
 */
export interface LegacyRadiusPair {
  vault: number;
  classic: number;
}

export const LegacyRadiusPairs: readonly LegacyRadiusPair[] = [
  { vault: 6, classic: 4 },
  { vault: 8, classic: 4 },
  { vault: 12, classic: 4 },
  { vault: 14, classic: 0 },
  { vault: 14, classic: 4 },
  { vault: 16, classic: 4 },
  { vault: 20, classic: 4 },
  { vault: 999, classic: 4 },
];

// Ambient glow color for shadows/backdrops (cyan on Electric, evergreen on
// Warm Vault) — the one accent that components hardcoded per design.
export const GlowByVariant: Record<DesignVariant, { light: string; dark: string }> = {
  1: { light: evergreen, dark: evergreenBright },
  2: { light: cyanDeepLight, dark: cyan },
  3: { light: cyanDeepLight, dark: cyan },
  // Neutral studio light: white bloom on dark, soft grey vignette on light.
  4: { light: '#9A9A96', dark: '#FFFFFF' },
};

// ---------------------------------------------------------------------------
// Backdrop palettes — previously component-local literals (drifting from
// theme.ts); folded into the token source per the port plan. Their SVG /
// Animated CONSUMPTION stays in the components.
// ---------------------------------------------------------------------------

/**
 * LiquidLight (signed-out home blooms) — per-variant [protagonist, magic,
 * tide]. Unknown variants fall back to variant 3's palette, matching the
 * original component behavior.
 */
export const LiquidLightPalettes: Record<number, [string, string, string]> = {
  1: ['#19B091', '#E8A33D', '#0E6B5C'], // Warm Vault: evergreen + amber
  2: ['#00daf8', '#7000ff', '#00e0ff'], // Electric: cyan + violet + aqua
  3: ['#00daf8', '#7000ff', '#00e0ff'],
  4: ['#FFFFFF', '#D8CFC0', '#8C8C8C'], // Mono Studio: pearl + champagne + smoke
};

/**
 * VaultBackdrop (atmosphere layer) — palette/grid/glow literals for both
 * renderings. Opacities ride along: they are part of the palette's identity
 * (light mode blooms via saturation, not darkness).
 */
export const VaultBackdropPalette = {
  warmVault: {
    evergreenGlow: evergreenBright,
    amberGlow: amber,
    dot: { light: 'rgba(28, 26, 22, 0.05)', dark: 'rgba(240, 237, 230, 0.05)' },
    evergreenOpacity: { light: 0.16, dark: 0.14 },
    amberOpacity: { light: 0.18, dark: 0.12 },
  },
  electric: {
    grid: { light: 'rgba(13, 17, 18, 0.04)', dark: 'rgba(255, 255, 255, 0.025)' },
    glowAOpacity: { light: 0.2, dark: 0.08 },
    glowBOpacity: { light: 0.13, dark: 0.05 },
    violet: '#7000ff',
    violetOpacity: 0.05,
  },
} as const;
