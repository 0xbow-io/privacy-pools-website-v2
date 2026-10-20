import { createContext, useContext, useState, useCallback, useEffect, useLayoutEffect, ReactNode } from 'react';
import { Platform, useColorScheme as useSystemColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { colorScheme as nativeWindColorScheme } from 'nativewind';

import { ActiveDesignVariant } from '@/constants/theme';
import { THEME_PREFERENCE_KEY, resolveColorScheme } from '@/services/theme-precedence';
import { applyRootThemeClasses } from '@/services/theme-dom';

type ThemeContextType = {
  colorScheme: 'light' | 'dark';
  toggleColorScheme: () => void;
};

const ThemeContext = createContext<ThemeContextType>({
  colorScheme: 'light',
  toggleColorScheme: () => {},
});

// Precedence (`?color` → storage → system; URL overrides are web-only and
// persist under the same key the toggle uses) lives in
// services/theme-precedence.ts — shared with the +html.tsx pre-paint
// bootstrap and fixture-tested against it.
function getItem(key: string): string | null {
  if (Platform.OS === 'web') return localStorage.getItem(key);
  return SecureStore.getItem(key);
}

function setItem(key: string, value: string): void {
  if (Platform.OS === 'web') {
    localStorage.setItem(key, value);
    return;
  }
  SecureStore.setItem(key, value);
}

function persistThemePreference(colorScheme: 'light' | 'dark') {
  try {
    setItem(THEME_PREFERENCE_KEY, colorScheme);
  } catch {
    // Non-fatal: theme still updates for the current session.
  }
}

/**
 * SCHEME AUTHORITY (F-C): the provider is the single owner of the resolved
 * color scheme. It drives, in one place:
 *
 *  1. its React context (unchanged consumer API),
 *  2. NativeWind's runtime scheme on NATIVE via `colorScheme.set()` —
 *     including the initially stored value, so `dark:` utilities are correct
 *     from the first ported component onward, and
 *  3. the root classes on `document.documentElement` on WEB (exactly one
 *     `pp-v{N}` plus optional `dark`, stale classes removed —
 *     services/theme-dom.ts). The classes sit on <html> because RN-Web
 *     Modals portal to document.body. The +html.tsx inline bootstrap applies
 *     the same classes BEFORE first paint; the provider's sync here is the
 *     post-hydration reconcile (a no-op unless the two ever disagree) and
 *     the toggle path.
 *
 * NativeWind's web runtime is deliberately NOT driven via `colorScheme.set()`
 * — with `darkMode: 'class'` (tailwind.config.js) the CSS cascade keys off
 * the `dark` class alone, and a second writer on the root classes would
 * fight this provider's ownership.
 */
function syncSchemeSinks(scheme: 'light' | 'dark') {
  if (Platform.OS === 'web') {
    if (typeof document !== 'undefined') {
      applyRootThemeClasses(document.documentElement, ActiveDesignVariant, scheme);
    }
    return;
  }
  nativeWindColorScheme.set(scheme);
}

const useIsomorphicLayoutEffect =
  Platform.OS !== 'web' || typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemColorScheme = useSystemColorScheme();
  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>(() => {
    const resolved = resolveColorScheme({
      getSearch: () =>
        Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.search : '',
      getItem,
      setItem,
      systemDark: systemColorScheme === 'dark',
    });
    // Synchronous initial drive (plan §Theme-architecture 4): native must
    // hold the stored scheme before the first child renders; on web this
    // matches what the pre-paint bootstrap already applied.
    syncSchemeSinks(resolved);
    return resolved;
  });

  const toggleColorScheme = useCallback(() => {
    setColorScheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      persistThemePreference(next);
      return next;
    });
  }, []);

  // Post-hydration reconcile + every scheme change: keep all sinks (root
  // classes on web, NativeWind runtime on native) in step with the context.
  // LAYOUT effect, not a passive one (codex F-C review, finding 5): layout
  // effects run synchronously after commit and BEFORE paint, so a toggle can
  // never paint a frame where context-driven inline colors show the new
  // scheme while the CSS vars/`dark:` cascade still shows the old one.
  // Isomorphic guard: useLayoutEffect warns when rendered in a Node/SSR
  // context (harness/tests) — fall back to useEffect there; real clients
  // (web + native) always take the layout path.
  useIsomorphicLayoutEffect(() => {
    syncSchemeSinks(colorScheme);
  }, [colorScheme]);

  return (
    <ThemeContext.Provider value={{ colorScheme, toggleColorScheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
