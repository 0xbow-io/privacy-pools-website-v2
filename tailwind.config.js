// Scan the styled trees and the shared landing copy containing inline links.
const content = ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'config/landing-content.tsx'];

// Harness-only content: the NativeWind compatibility gallery is served from
// its own router root (see app.config.js) when PPV2_NW_GALLERY=1. Its
// utilities join the CSS ONLY on that harness server — production exports
// never set the variable, so gallery-only selectors stay out of prod CSS
// (asserted by scripts/visual/perf-baseline.ts).
if (process.env.PPV2_NW_GALLERY === '1') {
  content.push(
    'scripts/visual/gallery-app/**/*.{ts,tsx}',
    'scripts/visual/gallery-src/**/*.{ts,tsx}',
  );
}

/** @type {import('tailwindcss').Config} */
module.exports = {
  content,
  presets: [require('nativewind/preset')],
  // 'class', not the default 'media': (1) the app owns its color scheme
  // (components/theme-provider.tsx — URL ?color → storage → system), and F-C
  // drives a `dark` class on document.documentElement, which is exactly
  // Tailwind's class strategy; (2) with 'media', react-native-css-interop's
  // web runtime throws "Cannot manually set color scheme" from its own <head>
  // MutationObserver as soon as the injected stylesheet's darkMode flag
  // appears (verified against the dev server — see
  // workflows/plans/nativewind-fb-gates.md, gate a).
  darkMode: 'class',
  // Preflight OFF — decided with evidence in F-B (gate f, see
  // workflows/plans/nativewind-fb-gates.md and the toolchain section of
  // workflows/plans/nativewind-port.md): deterministic captures were
  // pixel-identical with preflight ON vs OFF (0 px — zero visual benefit;
  // RN-Web's own reset plus atomic classes out-specify element selectors on
  // everything the app draws), while the DOM probe measured 354 computed-
  // style changes on raw-DOM islands (inherited font metrics on
  // RNW-rendered <button>/<a> hosts, svg vertical-align/box-sizing/border
  // resets) — an uncontrolled boundary for raw DOM and third-party widgets
  // with no offsetting gain. Nothing in the port relies on preflight
  // defaults. CONVENTION this creates (audit-enforced, raw-dom-border-style
  // rule): on raw DOM islands, width-bearing border-*/divide-* utilities
  // must carry an explicit border style (border-solid etc.) — preflight
  // would otherwise have supplied `border-style: solid`. RN components are
  // unaffected (RNW defaults to solid).
  corePlugins: { preflight: false },
  future: {
    // Only emit hover styles inside @media (hover: hover) so touch devices
    // never get sticky hover states if/when hover: utilities ship.
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      // ---- EXACT custom scales ----
      // Policy: every value here must be an EXACT match of an existing
      // StyleSheet literal (px) or theme token — never a "nearest" Tailwind
      // default.
      // colors/fontFamily/borderRadius are GENERATED from
      // constants/theme-data.ts by `bun scripts/generate-theme-vars.ts`
      // (semantic tokens as var(--pp-*) references; fontFamily keys carry a
      // `pp-` prefix so they can never shadow core fontWeight utilities like
      // `font-medium`). Drift between theme-data and the committed generated
      // files fails scripts/generate-theme-vars.test.ts.
      ...require('./constants/theme-scales.generated.js'),
      // spacing/fontSize/zIndex/screens stay empty until the P1+ inventory
      // fills them (migrated code uses arbitrary values in the meantime).
      spacing: {},
      fontSize: {},
      zIndex: {},
      screens: {},
    },
  },
  plugins: [],
};
