// F-C codex finding 1 — PRODUCTION-mode gate on the patched
// react-native-css-interop@0.2.6 native scheme runtime.
//
// Upstream 0.2.6 (verified: dist-tag `latest` on npm, no newer patch
// exists) updates its colorScheme observable synchronously ONLY under
// NODE_ENV === "test", relying on the async Appearance change event in
// production — so a stored "dark" applied by the theme provider at startup
// could resolve `dark:` conditions as light for the first frames
// (stored-dark / OS-light). patches/react-native-css-interop@0.2.6.patch
// makes `colorScheme.set()` update the override synchronously in EVERY
// environment ("system" clears it so the system observable wins again).
//
// This suite exercises the INSTALLED, PATCHED dist file (the exact module
// Metro bundles) with NODE_ENV forced to "production" around each set()
// call — per the review, a NODE_ENV=test pass does NOT count, and the
// upstream code branches on NODE_ENV at call time, which is what makes this
// forcing valid. The Appearance mock NEVER fires its change listener, so
// any scheme the getter reports after set() was adopted synchronously.
//
// Still owed (blocked by the vendored SDK fs/promises native-export
// failure, F-B gate e): a rendered `dark:` first-frame check on an iOS and
// an Android device.

import { describe, expect, test, mock } from 'bun:test';

// Minimal react-native surface for dist/runtime/native/appearance-observables.js.
// The change listener is captured but NEVER invoked — that is the point.
const setColorSchemeCalls: unknown[] = [];
mock.module('react-native', () => ({
  Appearance: {
    getColorScheme: () => 'light', // OS says light
    setColorScheme: (v: unknown) => {
      setColorSchemeCalls.push(v);
    },
    addChangeListener: () => ({ remove() {} }),
  },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove() {} }),
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove() {} }),
  },
  Platform: { OS: 'ios', constants: { reactNativeVersion: { minor: 85 } } },
}));

// The exact artifact Metro bundles (package main -> dist).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { colorScheme, systemColorScheme } = require(
  '../node_modules/react-native-css-interop/dist/runtime/native/appearance-observables.js',
) as {
  colorScheme: { set(v: 'light' | 'dark' | 'system'): void; get(): 'light' | 'dark' | undefined };
  systemColorScheme: { get(): 'light' | 'dark' | undefined };
};

function inProduction<T>(fn: () => T): T {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return fn();
  } finally {
    process.env.NODE_ENV = prev;
  }
}

describe('patched interop colorScheme.set — synchronous in PRODUCTION (stored-dark / OS-light)', () => {
  test('sanity: the installed dist file carries the ppv2 patch', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../node_modules/react-native-css-interop/dist/runtime/native/appearance-observables.js', import.meta.url),
      'utf8',
    );
    expect(src).toContain('PATCH(ppv2, F-C codex finding 1)');
  });

  test('OS-light start: getter reports light before any override', () => {
    expect(systemColorScheme.get()).toBe('light');
    expect(colorScheme.get()).toBe('light');
  });

  test('set("dark") is adopted SYNCHRONOUSLY under NODE_ENV=production (no Appearance event ever fires)', () => {
    inProduction(() => {
      colorScheme.set('dark');
      // Same synchronous frame — the mock listener cannot have fired.
      expect(colorScheme.get()).toBe('dark');
    });
    // The OS-level override was still requested (upstream behavior kept).
    expect(setColorSchemeCalls).toContain('dark');
  });

  test('set("system") CLEARS the override synchronously — system (light) wins again', () => {
    inProduction(() => {
      colorScheme.set('dark');
      expect(colorScheme.get()).toBe('dark');
      colorScheme.set('system');
      expect(colorScheme.get()).toBe('light'); // falls back to systemColorScheme
    });
  });

  test('repeated production toggles stay synchronous', () => {
    inProduction(() => {
      for (const v of ['light', 'dark', 'light', 'dark'] as const) {
        colorScheme.set(v);
        expect(colorScheme.get()).toBe(v);
      }
    });
  });
});
