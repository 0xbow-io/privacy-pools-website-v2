// Shared configuration for the deterministic visual harness (F-A).
// See scripts/visual/README.md for the protocol.

import * as path from 'node:path';

export const VISUAL_DIR = path.resolve(new URL('.', import.meta.url).pathname);
export const REPO_ROOT = path.resolve(VISUAL_DIR, '..', '..');

/**
 * Pinned browser — the same chromium revision every prior QA session used.
 * Must live INSIDE the repo (`.pw-browsers/`, untracked): the safewrap sandbox
 * only exposes the cwd, so an absolute path outside it is invisible. Copy it
 * from the main checkout if missing:
 *   cp -r /home/pe/newnewrepos/w/0xbow/ppv2/.pw-browsers <repo>/.pw-browsers
 */
export const CHROMIUM_PATH =
  process.env.PPV2_VISUAL_CHROMIUM ??
  path.join(REPO_ROOT, '.pw-browsers', 'chromium-1228', 'chrome-linux64', 'chrome');

// 127.0.0.1, not localhost: inside the safewrap netns, `localhost` resolves
// to ::1 first and pasta only splices IPv4 loopback to the host. Run capture
// commands with SAFEWRAP_WHITELIST_PORTS=8085 so 8081 stays in pasta's
// ns→host forward range (the .env whitelist EXCLUDES 8081/8082 — that
// exclusion is what lets the dev-server sandbox hold the host port).
export const BASE_URL = process.env.PPV2_VISUAL_BASE_URL ?? 'http://127.0.0.1:8081';

export const BASELINE_DIR = path.join(VISUAL_DIR, 'baselines');
export const FIXTURE_DIR = path.join(VISUAL_DIR, 'fixtures');
export const THRESHOLDS_PATH = path.join(VISUAL_DIR, 'thresholds.json');

/** Fixed viewports: desktop + narrow. DPR is always 1. */
export const VIEWPORTS = {
  desktop: { width: 1440, height: 1400 },
  narrow: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

export type ColorName = 'light' | 'dark';
export type Variant = 1 | 2 | 3 | 4;

/** The 8 web sets: design variants 1-4 × light/dark (0 "Classic" retired). */
export const SETS: { variant: Variant; color: ColorName }[] = [];
for (const variant of [1, 2, 3, 4] as Variant[]) {
  for (const color of ['light', 'dark'] as ColorName[]) {
    SETS.push({ variant, color });
  }
}

/**
 * SCREENSHOT SCOPE (Pat, P1 — applies P1→P4). Variants 1-4 are the SAME
 * layout; only color-scheme/background TOKENS differ between them. The
 * NativeWind port is a variant-agnostic `className` swap (all five variants
 * are still PORTED), and F-C already proved every one of the 10 sets resolves
 * its `--pp-*` tokens EXACTLY (scripts/visual/verify-theme-vars.ts).
 * So capturing every variant per surface is redundant: we screenshot only
 * variant 4 (Mono Studio — the vault representative and site default),
 * × light/dark = 2 sets. The other variants' baselines stay on disk and
 * valid but are NOT required by the compare (see `surfaceShotInScope`).
 * Widen by setting PPV2_SCREENSHOT_VARIANTS=1,2,3,4 (or editing the
 * default). Variant 0 (Classic) retired 2026-08-18.
 *
 * Scope governs the per-variant SURFACE matrix only. The modal representative
 * set (v1 vault, capture-modals.ts) and the unprefixed gallery
 * shots are a separate minimal corpus — not the redundant 10 — and stay
 * required as-is.
 */
// Fail-closed parse: an invalid value must NEVER silently widen the
// out-of-scope set — `Number(garbage)` is NaN, `Number('')` is 0, and either
// would make surfaceShotInScope exclude every surface baseline (compare then
// verifies only modal+gallery shots and reports a false clean). Throw instead.
function parseScreenshotVariants(raw: string): Variant[] {
  const variants = raw.split(',').map((token) => {
    const t = token.trim();
    if (!/^[1-4]$/.test(t)) {
      throw new Error(
        `PPV2_SCREENSHOT_VARIANTS: "${raw}" is not a comma-separated list of variant ids 1-4`,
      );
    }
    return Number(t) as Variant;
  });
  return [...new Set(variants)];
}

export const SCREENSHOT_VARIANTS: Variant[] = (process.env.PPV2_SCREENSHOT_VARIANTS
  ? parseScreenshotVariants(process.env.PPV2_SCREENSHOT_VARIANTS)
  : [4]);

/**
 * A baseline/candidate PNG name is "in scope" for the current screenshot
 * variant allowlist. Surface shots (`v{N}-{color}-{surface}-{viewport}.png`)
 * for a variant outside SCREENSHOT_VARIANTS are out of scope; everything else
 * — in-scope surfaces, ALL modal shots (`*-modal-*`, payment-requests widget),
 * and the unprefixed gallery shots — stays in scope.
 */
export function surfaceShotInScope(name: string): boolean {
  const m = /^v(\d)-(?:light|dark)-([a-z-]+?)-(?:desktop|narrow)\.png$/.exec(name);
  if (!m) return true; // gallery / non-variant name
  const surface = m[2];
  const isSurface = SURFACES.some((s) => s.name === surface);
  if (!isSurface) return true; // e.g. modal/* or payment-requests-widget — not the per-variant surface matrix
  return SCREENSHOT_VARIANTS.includes(Number(m[1]) as Variant);
}

export interface SurfaceDef {
  name: string;
  /** Path + query (theme/color params appended by the harness). */
  path: string;
  /** Body text that must be present before capture. */
  marker: string;
  /** Extra settle time after the marker appears (data-heavy tables). */
  settleMs?: number;
  /**
   * Wheel-scroll this many px over the page center before shooting (RN-Web
   * scroll containers scroll internally, so window.scrollTo can't reach
   * below-the-fold widgets).
   */
  scrollY?: number;
}

/**
 * Disconnected public surfaces. Connected modal states live in
 * capture-modals.ts (they need the headless EIP-6963 wallet).
 */
export const SURFACES: SurfaceDef[] = [
  { name: 'home', path: '/', marker: 'Privacy Pools' },
  { name: 'pool-detail', path: '/chains/sepolia/eth', marker: 'ETH' },
  { name: 'portfolio', path: '/portfolio', marker: 'Portfolio' },
  { name: 'ecosystem', path: '/ecosystem', marker: 'Ecosystem' },
  { name: 'payroll', path: '/payroll', marker: 'Payroll' },
  // The three home drawers hang off the home URL (`/?panel=…`).
  { name: 'drawer-balances', path: '/?panel=balances', marker: 'My balances' },
  { name: 'drawer-pools', path: '/?panel=pools', marker: 'Explore pools' },
  { name: 'drawer-activity', path: '/?panel=activity', marker: 'All activity' },
];

export function surfaceUrl(surface: SurfaceDef, variant: Variant, color: ColorName): string {
  const sep = surface.path.includes('?') ? '&' : '?';
  return `${BASE_URL}${surface.path}${sep}theme=${variant}&color=${color}`;
}

export function shotName(surface: string, variant: Variant, color: ColorName, viewport: ViewportName): string {
  return `v${variant}-${color}-${surface}-${viewport}.png`;
}

/** Sets × surfaces × viewports. */
export function enumerateShots(): {
  surface: SurfaceDef;
  variant: Variant;
  color: ColorName;
  viewport: ViewportName;
}[] {
  const out: ReturnType<typeof enumerateShots> = [];
  for (const { variant, color } of SETS) {
    // Screenshot-scope allowlist (see SCREENSHOT_VARIANTS): only capture the
    // in-scope variants' surfaces. All variants remain ported; the rest are
    // just not re-shot.
    if (!SCREENSHOT_VARIANTS.includes(variant)) continue;
    for (const surface of SURFACES) {
      for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
        out.push({ surface, variant, color, viewport });
      }
    }
  }
  return out;
}
