// Header nav collapse (codex P2: Classic hid Portfolio below 680px while
// the replacement link only appeared below 600px — a 600–679px band had no
// Portfolio entry anywhere; and the collapsed nav lived inside the
// connected-account menu, unreachable while disconnected).

import { describe, expect, test } from 'bun:test';

import { navCenteringLeftWidth, navCollapseWidth, splitNavItems } from '@/services/header-nav';

const NAV = [
  { label: 'Privacy Pools', href: '/' },
  { label: 'Portfolio', href: '/portfolio' },
  { label: 'Ecosystem', href: '/ecosystem' },
  { label: 'Payroll', href: '/payroll' },
];

function labels(items: Array<{ label: string }>): string[] {
  return items.map((i) => i.label);
}

describe('splitNavItems. Every item is ALWAYS in exactly one place', () => {
  test('no width band strands an item', () => {
    for (let width = 300; width <= 1400; width += 1) {
      const { visible, collapsed } = splitNavItems(NAV, width);
      expect(visible.length + collapsed.length).toBe(NAV.length);
    }
  });

  test('640px (the reported gap): Portfolio is in the collapsed menu', () => {
    const { visible, collapsed } = splitNavItems(NAV, 640);
    expect(labels(visible)).not.toContain('Portfolio');
    expect(labels(collapsed)).toContain('Portfolio');
    expect(labels(collapsed)).toContain('Ecosystem');
    expect(labels(collapsed)).toContain('Payroll');
  });

  test('wide viewport shows everything in the bar, empty menu', () => {
    const { visible, collapsed } = splitNavItems(NAV, 1280);
    expect(labels(visible)).toEqual(labels(NAV));
    expect(collapsed).toHaveLength(0);
  });

  test('very narrow viewport collapses everything (incl. Privacy Pools)', () => {
    const { visible, collapsed } = splitNavItems(NAV, 400);
    expect(visible).toHaveLength(0);
    expect(labels(collapsed)).toEqual(labels(NAV));
  });

  test('the secondary band SURVIVES the widths the centred layout collapsed', () => {
    // Rewritten 2026-08-28. The old assertion (collapsed at 1100px) encoded the
    // ABSOLUTELY CENTRED nav, where an actions cluster W px wide cost 2W px of
    // viewport. As a flex child the nav uses the real gap, and the browser
    // measures 129px of clearance at 1123px and 87px at 1039px — so collapsing
    // there hid items with obvious room to spare, which is what was reported.
    for (const width of [1123, 1100, 1039, 1000]) {
      expect(labels(splitNavItems(NAV, width).visible)).toContain('Portfolio');
    }
  });

  test('the secondary band still collapses BEFORE the measured collision', () => {
    // Real collision is ~865px (clearance closes ~0.5px per 1px of viewport
    // from 51px at 966px). The threshold must sit above it with margin, so the
    // items are gone before they can slide under the wallet chip.
    expect(labels(splitNavItems(NAV, 860).visible)).not.toContain('Portfolio');
    expect(labels(splitNavItems(NAV, 900).visible)).not.toContain('Portfolio');
  });
});

describe('navCollapseWidth', () => {
  test('secondary items collapse before the primary one', () => {
    expect(navCollapseWidth('Portfolio')).toBeGreaterThan(navCollapseWidth('Privacy Pools'));
  });
  test('unknown items never collapse', () => {
    expect(navCollapseWidth('Whatever')).toBe(0);
  });
});

describe('wideActions. The connected header (bell + address chip)', () => {
  // The nav is absolutely centred, so an actions cluster W px wide costs 2W px
  // of viewport. Connected adds ~190px of cluster => ~380px more viewport, which
  // is why Payroll slid under the address chip at ~1040px while the rule said 600.
  const WIDE = true;

  test('thresholds are connection-independent. The vault cluster is the same either way', () => {
    for (const label of ['Payroll', 'Ecosystem', 'Portfolio', 'Assets', 'Privacy Pools']) {
      expect(navCollapseWidth(label, WIDE)).toBe(navCollapseWidth(label));
    }
  });

  test('the original regression still cannot recur: nothing overlaps the chip', () => {
    // Payroll was once half-hidden under the wallet chip at 1039px. Under the
    // CENTRED nav that width really did collide (measured 1098px), and the fix
    // was to collapse there. Under the FLEX nav 1039px measures 87px of
    // clearance, so the item belongs in the bar — the regression is prevented
    // by the threshold sitting above the real collision (~865px), not by
    // collapsing at a width that now has room.
    for (const wide of [true, false]) {
      // Below the real collision: gone from the bar, present in the menu.
      const tight = splitNavItems(NAV, 860, wide);
      expect(labels(tight.visible)).not.toContain('Payroll');
      expect(labels(tight.collapsed)).toContain('Payroll');
      // With measured clearance: in the bar.
      expect(labels(splitNavItems(NAV, 1039, wide).visible)).toContain('Payroll');
    }
  });

  test('Payroll is back in the top bar at 1200px, where there is real room', () => {
    expect(labels(splitNavItems(NAV, 1200, WIDE).visible)).toContain('Payroll');
  });

  test('the primary item survives far below the secondary band', () => {
    // Only ~65px of nav left by then, so it clears the cluster much longer.
    expect(labels(splitNavItems(NAV, 800, WIDE).visible)).toContain('Privacy Pools');
  });

  test('every item is still in exactly one place at every width, connected too', () => {
    for (let w = 320; w <= 1440; w += 8) {
      const { visible, collapsed } = splitNavItems(NAV, w, WIDE);
      expect(visible.length + collapsed.length).toBe(NAV.length);
      expect([...labels(visible), ...labels(collapsed)].sort()).toEqual(labels(NAV).slice().sort());
    }
  });
});

describe('navCenteringLeftWidth', () => {
  test('wide viewport: the logo side takes the cluster width, so the nav is on the axis', () => {
    expect(navCenteringLeftWidth({ containerWidth: 1240, clusterWidth: 317, navWidth: 300, logoWidth: 41 })).toBe(317);
  });
  test('too narrow for symmetry: undefined, the elastic layout keeps the collapse thresholds honest', () => {
    // 984 - 2*317 - 300 = 50 >= 24 ok; 960 - 634 - 300 = 26 ok; 950 - 634 - 300 = 16 < 24 no
    expect(navCenteringLeftWidth({ containerWidth: 960, clusterWidth: 317, navWidth: 300, logoWidth: 41 })).toBe(317);
    expect(navCenteringLeftWidth({ containerWidth: 950, clusterWidth: 317, navWidth: 300, logoWidth: 41 })).toBeUndefined();
  });
  test('unmeasured (0) sizes never claim symmetry', () => {
    expect(navCenteringLeftWidth({ containerWidth: 1240, clusterWidth: 0, navWidth: 300, logoWidth: 41 })).toBeUndefined();
    expect(navCenteringLeftWidth({ containerWidth: 1240, clusterWidth: 317, navWidth: 0, logoWidth: 41 })).toBeUndefined();
  });
  test('a logo wider than the cluster sets the side', () => {
    expect(navCenteringLeftWidth({ containerWidth: 1240, clusterWidth: 30, navWidth: 300, logoWidth: 41 })).toBe(41);
  });
});

test('the compact action widget is phones only, never a portrait tablet', async () => {
  const { compactPhoneLayout } = await import('@/services/header-nav');
  for (const w of [360, 390, 412, 540]) expect(compactPhoneLayout(w)).toBe(true);
  for (const w of [768, 820, 929, 1280]) expect(compactPhoneLayout(w)).toBe(false);
});

// --- DEV-553 (Mike, Android MetaMask in-app browser).

test('My balances and My activity wear the app header on mobile web only', async () => {
  const { explorePageUsesAppHeader } = await import('@/services/header-nav');
  for (const w of [360, 390, 412, 768]) expect(explorePageUsesAppHeader('web', w)).toBe(true);
  expect(explorePageUsesAppHeader('web', 1280)).toBe(false);
  expect(explorePageUsesAppHeader('ios', 390)).toBe(false);
  expect(explorePageUsesAppHeader('android', 412)).toBe(false);
});

test('one-line transaction rows with tap-for-details are phone web only', async () => {
  const { phoneTransactionRows } = await import('@/services/header-nav');
  for (const w of [360, 390, 412]) expect(phoneTransactionRows('web', w)).toBe(true);
  for (const w of [768, 1280]) expect(phoneTransactionRows('web', w)).toBe(false);
  expect(phoneTransactionRows('ios', 390)).toBe(false);
  expect(phoneTransactionRows('android', 412)).toBe(false);
});

test('the web tab bar sits on the bottom edge, whatever inset the webview reports', async () => {
  const { tabBarBottomOffset, effectiveSafeAreaInset } = await import('@/services/header-nav');
  expect(tabBarBottomOffset('web', 0)).toBe(0);
  // Android MetaMask webview (DEV-553): the page has no viewport-fit=cover, so a
  // reported system-bar inset is not real and must not open a band.
  expect(tabBarBottomOffset('web', 45)).toBe(0);
  expect(tabBarBottomOffset('web', Number.NaN)).toBe(0);
  expect(effectiveSafeAreaInset('web', 45)).toBe(0);
  // Native unchanged: the inset with an 8px floor.
  expect(tabBarBottomOffset('ios', 34)).toBe(34);
  expect(tabBarBottomOffset('android', 0)).toBe(8);
  expect(effectiveSafeAreaInset('ios', 47)).toBe(47);
  expect(effectiveSafeAreaInset('android', Number.NaN)).toBe(0);
});
