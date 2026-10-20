// F-C deliverable 3 — the drift guard between the TWO theme-precedence
// implementations:
//
//   A. the pure resolvers in services/theme-precedence.ts (consumed by
//      constants/theme.ts and components/theme-provider.tsx), and
//   B. the inline pre-paint bootstrap string in services/theme-bootstrap.ts
//      (rendered into <head> by app/+html.tsx), evaluated here against a
//      fake window/document environment.
//
// Every fixture in services/theme-precedence-fixtures.ts runs against BOTH —
// including the storage-failure quirks — plus the root-class algorithm
// (services/theme-dom.ts) is checked to byte-match the bootstrap's class
// output on pre-seeded documentElement classNames.

import { describe, expect, test } from 'bun:test';
import {
  THEME_PRECEDENCE_FIXTURES,
  type ThemePrecedenceFixture,
} from '../theme-precedence-fixtures';
import { resolveTheme } from '../theme-precedence';
import { applyRootThemeClasses } from '../theme-dom';
import { THEME_BOOTSTRAP_SCRIPT } from '../theme-bootstrap';

function makeStorage(fixture: ThemePrecedenceFixture) {
  const data: Record<string, string> = { ...(fixture.stored ?? {}) };
  const throws = fixture.storageThrows;
  return {
    data,
    getItem(key: string): string | null {
      if (throws === 'get' || throws === 'all') throw new Error('storage unavailable');
      return key in data ? data[key] : null;
    },
    setItem(key: string, value: string): void {
      if (throws === 'set' || throws === 'all') throw new Error('storage unavailable');
      data[key] = value;
    },
  };
}

/** Evaluate the inline bootstrap against a minimal fake browser environment. */
function runBootstrap(fixture: ThemePrecedenceFixture, initialClassName = '') {
  const storage = makeStorage(fixture);
  const documentElement = { className: initialClassName };
  const location = fixture.searchThrows
    ? Object.defineProperty({}, 'search', {
        get() {
          throw new Error('hostile location');
        },
      })
    : { search: fixture.search };
  const fakeWindow = {
    location,
    localStorage: storage,
    matchMedia: (query: string) => ({ matches: query.includes('dark') && fixture.systemDark }),
  };
  const fakeDocument = { documentElement };
  // The script is an IIFE referencing only `window` and `document`.
  new Function('window', 'document', THEME_BOOTSTRAP_SCRIPT)(fakeWindow, fakeDocument);
  return { documentElement, storage };
}

function classesOf(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

describe('theme precedence. Pure resolvers vs pre-paint bootstrap (shared fixtures)', () => {
  for (const fixture of THEME_PRECEDENCE_FIXTURES) {
    test(fixture.name, () => {
      // A. pure resolvers
      const pureStorage = makeStorage(fixture);
      const resolved = resolveTheme({
        getSearch: () => {
          if (fixture.searchThrows) throw new Error('hostile location');
          return fixture.search;
        },
        getItem: (k) => pureStorage.getItem(k),
        setItem: (k, v) => pureStorage.setItem(k, v),
        systemDark: fixture.systemDark,
      });
      expect(resolved).toEqual(fixture.expected);
      if (fixture.expectedStored) expect(pureStorage.data).toEqual(fixture.expectedStored);

      // B. bootstrap script — must land on the SAME variant/scheme (via the
      // root classes it writes) and the SAME persistence side-effects.
      const { documentElement, storage } = runBootstrap(fixture);
      const classes = classesOf(documentElement.className);
      expect(classes).toContain(`pp-v${fixture.expected.variant}`);
      expect(classes.filter((c) => /^pp-v\d+$/.test(c))).toHaveLength(1);
      expect(classes.includes('dark')).toBe(fixture.expected.scheme === 'dark');
      if (fixture.expectedStored) expect(storage.data).toEqual(fixture.expectedStored);

      // C. the provider-side class algorithm agrees byte-for-byte with the
      // bootstrap output for a clean root.
      const el = { className: '' };
      applyRootThemeClasses(el, fixture.expected.variant, fixture.expected.scheme);
      expect(el.className).toBe(documentElement.className);
    });
  }
});

describe('root class management', () => {
  test('stale pp-v*/dark classes are replaced, foreign classes preserved', () => {
    const el = { className: 'pp-v2 dark something-else' };
    applyRootThemeClasses(el, 4, 'light');
    expect(el.className).toBe('something-else pp-v4');
  });

  test('repeated toggles never accumulate classes', () => {
    const el = { className: '' };
    for (let i = 0; i < 5; i++) {
      applyRootThemeClasses(el, 1, i % 2 === 0 ? 'dark' : 'light');
    }
    expect(el.className).toBe('pp-v1 dark');
  });

  test('bootstrap replaces stale classes the same way (reconcile is a no-op)', () => {
    const fixture = THEME_PRECEDENCE_FIXTURES.find((f) => f.name.startsWith('?theme=3'))!;
    const { documentElement } = runBootstrap(fixture, 'pp-v1 dark keep-me');
    expect(documentElement.className).toBe('keep-me pp-v3');
    const el = { className: 'pp-v1 dark keep-me' };
    applyRootThemeClasses(el, 3, 'light');
    expect(el.className).toBe(documentElement.className);
  });

  test('bootstrap never throws without matchMedia/localStorage (best-effort)', () => {
    const documentElement = { className: '' };
    new Function('window', 'document', THEME_BOOTSTRAP_SCRIPT)(
      { location: { search: '' } },
      { documentElement },
    );
    // localStorage access throws inside → variant 4; matchMedia missing → light.
    expect(documentElement.className).toBe('pp-v4');
  });
});
