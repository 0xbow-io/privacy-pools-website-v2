/**
 * Pre-paint theme bootstrap — the inline <script> rendered into <head> by
 * `app/+html.tsx`. It resolves the SAME precedence as the app
 * (services/theme-precedence.ts: `?theme` → storage → 4 (Mono Studio); `?color` → storage
 * → system) and applies the root classes (services/theme-dom.ts algorithm:
 * exactly one `pp-v{N}` + optional `dark` on <html>, stale ones removed)
 * BEFORE first paint, so themed CSS vars are correct from the very first
 * frame and the provider's post-hydration reconcile is a no-op.
 *
 * This file must stay importable from the Node context that renders
 * +html.tsx at export time AND from Bun tests: no react-native imports.
 *
 * DRIFT GUARD: services/__tests__/theme-precedence.test.ts evaluates this
 * script against the same fixture set as the pure resolvers — including the
 * two legacy storage-failure quirks documented in theme-precedence.ts (the
 * `?theme` persistence write sits INSIDE the variant try-block; the `?color`
 * persistence failure is swallowed separately). Change either implementation
 * and the fixtures fail.
 */

export const THEME_BOOTSTRAP_SCRIPT = `(function () {
  try {
    var variant = 4;
    try {
      var themeParam = new URLSearchParams(window.location.search).get('theme');
      if (themeParam !== null && ['1', '2', '3', '4'].indexOf(themeParam) !== -1) {
        window.localStorage.setItem('ppv2_design_variant', themeParam);
        variant = Number(themeParam);
      } else {
        var storedVariant = window.localStorage.getItem('ppv2_design_variant');
        if (storedVariant !== null && ['1', '2', '3', '4'].indexOf(storedVariant) !== -1) {
          variant = Number(storedVariant);
        }
      }
    } catch (e) {
      variant = 4;
    }
    var scheme = null;
    try {
      // location.search is read INSIDE each guarded block (like the pure
      // resolvers): a hostile/throwing getter degrades to defaults instead
      // of aborting the whole bootstrap.
      var colorParam = new URLSearchParams(window.location.search).get('color');
      if (colorParam === 'light' || colorParam === 'dark') {
        scheme = colorParam;
        try {
          window.localStorage.setItem('ppv2_theme_preference', colorParam);
        } catch (e) {}
      }
    } catch (e) {}
    if (scheme === null) {
      try {
        var storedScheme = window.localStorage.getItem('ppv2_theme_preference');
        if (storedScheme === 'light' || storedScheme === 'dark') scheme = storedScheme;
      } catch (e) {}
    }
    if (scheme === null) {
      scheme =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    }
    var root = document.documentElement;
    var kept = root.className.split(/\\s+/).filter(function (c) {
      return c !== '' && !/^pp-v\\d+$/.test(c) && c !== 'dark';
    });
    kept.push('pp-v' + variant);
    if (scheme === 'dark') kept.push('dark');
    root.className = kept.join(' ');
  } catch (e) {
    // Never block first paint — the provider reconciles after hydration.
  }
})();`;
