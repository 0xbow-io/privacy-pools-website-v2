/**
 * The intent lockdown: one switch that hides the Swap tab, every cross-CHAIN
 * action and every cross-ASSET conversion, because LiFi cannot route the prod
 * yield shares (Pat, 2026-09-04). `?swap=true` brings the tab back for whoever
 * asks; the cross-flows have no url hatch on purpose.
 *
 * The module reads the flag at import time and the url on every call, so each
 * case re-imports with its own env and its own stubbed url.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const previousLockdown = process.env.EXPO_PUBLIC_INTENT_LOCKDOWN;
afterAll(() => {
  if (previousLockdown === undefined) delete process.env.EXPO_PUBLIC_INTENT_LOCKDOWN;
  else process.env.EXPO_PUBLIC_INTENT_LOCKDOWN = previousLockdown;
});

let urlParams: Record<string, string | null> = {};
mock.module('@/components/ui-url-events', () => ({
  getUiParam: (key: string) => urlParams[key] ?? null,
}));

async function load(lockdown: string | undefined) {
  urlParams = {};
  if (lockdown === undefined) delete process.env.EXPO_PUBLIC_INTENT_LOCKDOWN;
  else process.env.EXPO_PUBLIC_INTENT_LOCKDOWN = lockdown;
  // Bust the module cache so the import-time flag is re-read.
  const mod = await import(`@/config/intent-lockdown?lockdown=${lockdown ?? 'unset'}`);
  return mod as typeof import('@/config/intent-lockdown');
}

describe('intent lockdown', () => {
  test('unlocked by default: route capabilities govern the surface', async () => {
    const m = await load(undefined);
    expect(m.INTENT_LOCKDOWN).toBe(false);
    expect(m.swapSurfaceEnabled()).toBe(true);
    expect(m.crossFlowsEnabled()).toBe(true);
  });

  test('?swap=true brings the tab back, and only the tab', async () => {
    const m = await load('true');
    for (const value of ['true', '1', 'yes', 'TRUE', '']) {
      urlParams = { swap: value };
      expect(m.swapRequestedByUrl()).toBe(true);
      expect(m.swapSurfaceEnabled()).toBe(true);
      // The cross-chain / cross-asset flows stay off: they span four surfaces
      // and a half-open one is worse than none.
      expect(m.crossFlowsEnabled()).toBe(false);
    }
  });

  test('any other ?swap value is not a request', async () => {
    const m = await load('true');
    for (const value of ['false', '0', 'no', 'maybe']) {
      urlParams = { swap: value };
      expect(m.swapRequestedByUrl()).toBe(false);
      expect(m.swapSurfaceEnabled()).toBe(false);
    }
  });

  test('EXPO_PUBLIC_INTENT_LOCKDOWN=false is the one-line revert: everything back', async () => {
    for (const off of ['false', '0', 'off', 'FALSE']) {
      const m = await load(off);
      expect(m.INTENT_LOCKDOWN).toBe(false);
      expect(m.swapSurfaceEnabled()).toBe(true);
      expect(m.crossFlowsEnabled()).toBe(true);
    }
  });

  test('a stray value does NOT unlock (fail closed)', async () => {
    const m = await load('nope');
    expect(m.INTENT_LOCKDOWN).toBe(true);
    expect(m.crossFlowsEnabled()).toBe(false);
  });
});
