import { describe, expect, test } from 'bun:test';
import { MIN_CHROME_VERSION, assertPatchedChrome, isChromeOlderThan, parseChromeVersion } from './chrome-version.mjs';

describe('Chrome version guard', () => {
  test('the minimum is the release that fixed the four critical CVEs', () => {
    expect(MIN_CHROME_VERSION).toBe('156.0.8078.73');
  });

  test("Playwright 1.64.1's bundled Chromium is refused", () => {
    expect(isChromeOlderThan('156.0.8078.4')).toBe(true);
    expect(() => assertPatchedChrome('156.0.8078.4')).toThrow(/older than 156\.0\.8078\.73/);
  });

  test('compares numerically, part by part', () => {
    expect(isChromeOlderThan('156.0.8078.72')).toBe(true);
    expect(isChromeOlderThan('155.9.9999.999')).toBe(true);
    expect(isChromeOlderThan('156.0.8078.73')).toBe(false);
    expect(isChromeOlderThan('156.0.8078.79')).toBe(false);
    expect(isChromeOlderThan('156.0.8100.0')).toBe(false);
    expect(isChromeOlderThan('158.0.1.0')).toBe(false);
  });

  test('an unparseable version is an error, not a pass', () => {
    expect(() => parseChromeVersion('156.0')).toThrow();
    expect(() => parseChromeVersion('HeadlessChrome/156.0.8078.79')).toThrow();
    expect(() => assertPatchedChrome('')).toThrow();
  });
});
