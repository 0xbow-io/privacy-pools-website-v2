// F-C deliverable 5 — the 10-set token-resolution proof on an UNPORTED page.
//
//   SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/verify-theme-vars.ts \
//       [--report <json>] [--commit <id>]
//
// For every variant×scheme set (10 total) it loads /portfolio (a real,
// entirely unported surface) on the main dev server with `?theme=N&color=C`,
// then asserts:
//
//  1. document.documentElement carries EXACTLY one pp-v{N} class (the right
//     one) and `dark` iff the scheme is dark — the scheme authority + (in
//     prod HTML) pre-paint bootstrap contract;
//  2. EVERY generated --pp-* var (colors, hues, glow, fonts, radii,
//     classicRadius pairs) computes on the root to the exact legacy value
//     derived from constants/theme-data.ts — not a sample: the full set,
//     per set.
//
// Exit 1 on any mismatch; --report writes the machine-readable evidence.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ColorsByVariant,
  FontsByVariant,
  GlowByVariant,
  RadiiByVariant,
  TokenHuesByVariant,
  type ColorScheme,
  type DesignVariant,
} from '../../constants/theme-data';
import { SLASH_OPACITY_TOKENS, kebab, legacyRadiusPairs, parseColor } from '../generate-theme-vars';
import { BASE_URL, FIXTURE_DIR, SETS } from './config';
import { openFixtureStore, type FixtureMode } from './fixtures';
import { launchBrowser, newDeterministicContext, openSurface } from './harness';

function expectedVars(variant: DesignVariant, scheme: ColorScheme): Record<string, string> {
  const out: Record<string, string> = {};
  const colors = ColorsByVariant[variant][scheme] as Record<string, string>;
  for (const token of Object.keys(colors)) out[`--pp-${kebab(token)}`] = colors[token];
  // Slash-opacity channel triplets: every allowlisted token must ALSO
  // resolve its --pp-*-rgb var (finding 7 — the proof covers the triplet
  // surface as soon as P1 adds the first entry).
  for (const token of SLASH_OPACITY_TOKENS) {
    const parsed = parseColor(colors[token]);
    out[`--pp-${kebab(token)}-rgb`] = `${parsed.r} ${parsed.g} ${parsed.b}`;
  }
  const hues = TokenHuesByVariant[variant][scheme];
  for (const symbol of Object.keys(hues)) {
    out[`--pp-hue-${symbol.toLowerCase()}-fg`] = hues[symbol].fg;
    out[`--pp-hue-${symbol.toLowerCase()}-bg`] = hues[symbol].bg;
  }
  out['--pp-glow'] = GlowByVariant[variant][scheme];
  const fonts = FontsByVariant[variant];
  for (const alias of Object.keys(fonts) as (keyof typeof fonts)[]) {
    out[`--pp-font-${kebab(alias)}`] = fonts[alias];
  }
  const radii = RadiiByVariant[variant];
  for (const key of Object.keys(radii)) {
    out[`--pp-radius-${key}`] = `${radii[key as keyof typeof radii]}px`;
  }
  for (const { vault, classic } of legacyRadiusPairs()) {
    out[`--pp-cr-${vault}-${classic}`] = `${vault}px`;
  }
  return out;
}

/**
 * Value equality, canonicalized: the dev/prod CSS pipeline (lightningcss)
 * minifies custom-property literals (`#000000` → `#000`,
 * `rgba(0, 0, 0, 0.05)` → `#0000000d`), so color-valued vars are compared as
 * PARSED colors — identical channels, and alpha EXACT at 8-bit resolution:
 * Math.round(alpha × 255) must match (hex alpha IS the rounded 255ths of the
 * rgba float, so this accepts the one true bucket and rejects neighbors).
 * Non-color values (font faces, px lengths) must match literally.
 */
function valuesEqual(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  try {
    const a = parseColor(expected);
    const b = parseColor(actual);
    return a.r === b.r && a.g === b.g && a.b === b.b && Math.round(a.a * 255) === Math.round(b.a * 255);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let reportOut = '';
  let commit = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report') reportOut = path.resolve(args[++i]);
    else if (args[i] === '--commit') commit = args[++i];
  }
  const mode: FixtureMode = 'replay';
  const store = openFixtureStore(FIXTURE_DIR, mode);
  const browser = await launchBrowser();

  const sets: Array<Record<string, unknown>> = [];
  let failures = 0;

  for (const { variant, color } of SETS) {
    const context = await newDeterministicContext(browser, {
      viewport: 'desktop',
      color,
      fixtures: { store, mode },
    });
    const page = await openSurface(context, {
      url: `${BASE_URL}/portfolio?theme=${variant}&color=${color}`,
      marker: 'Portfolio',
    });

    const rootClasses: string[] = await page.evaluate(() =>
      document.documentElement.className.split(/\s+/).filter(Boolean),
    );
    const ppClasses = rootClasses.filter((c) => /^pp-v\d+$/.test(c));
    const classesOk =
      ppClasses.length === 1 &&
      ppClasses[0] === `pp-v${variant}` &&
      rootClasses.includes('dark') === (color === 'dark');

    const expected = expectedVars(variant, color);
    const names = Object.keys(expected);
    const actual: Record<string, string> = await page.evaluate((varNames: string[]) => {
      const cs = getComputedStyle(document.documentElement);
      const out: Record<string, string> = {};
      for (const n of varNames) out[n] = cs.getPropertyValue(n).trim();
      return out;
    }, names);

    const mismatches: Array<{ name: string; expected: string; actual: string }> = [];
    for (const name of names) {
      if (!valuesEqual(expected[name], actual[name])) {
        mismatches.push({ name, expected: expected[name], actual: actual[name] });
      }
    }

    const ok = classesOk && mismatches.length === 0;
    if (!ok) failures++;
    sets.push({
      set: `v${variant}-${color}`,
      rootClasses: rootClasses.join(' '),
      classesOk,
      varsChecked: names.length,
      mismatches,
      verdict: ok ? 'ok' : 'fail',
    });
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} v${variant}-${color}: classes="${rootClasses.join(' ')}", ` +
        `${names.length} vars checked, ${mismatches.length} mismatches` +
        (mismatches.length ? ` (first: ${JSON.stringify(mismatches[0])})` : ''),
    );

    await context.close();
  }

  await browser.close();
  store.writeIndex();

  if (reportOut) {
    fs.mkdirSync(path.dirname(reportOut), { recursive: true });
    fs.writeFileSync(
      reportOut,
      JSON.stringify(
        {
          generatedBy: 'scripts/visual/verify-theme-vars.ts',
          date: new Date().toISOString(),
          ...(commit ? { commit } : {}),
          baseUrl: BASE_URL,
          surface: '/portfolio (unported)',
          policy:
            'ALL generated --pp-* vars asserted per set (not a sample); colors compared canonically (lightningcss minifies literals — identical channels, alpha within 1/255), fonts/lengths literally',
          failures,
          sets,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`report → ${reportOut}`);
  }
  if (store.misses.length > 0) {
    for (const m of store.misses) console.error(`  fixture MISS: ${m.method} ${m.url}`);
    process.exit(1);
  }
  if (failures > 0) {
    console.error(`\nTHEME-VAR PROOF FAILED (${failures} sets)`);
    process.exit(1);
  }
  console.log('\nTHEME-VAR PROOF OK — 10/10 sets');
}

main();
