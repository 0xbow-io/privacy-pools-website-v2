// APY availability policy (codex P2: a static-placeholder APY rendered as
// an ordinary "APY"). Policy in config/yield.ts: unconfigured/invalid env →
// null → every surface omits the number.

import { describe, expect, test } from 'bun:test';

import { parseApyPercent } from '@/config/yield';

describe('parseApyPercent (unconfigured APY is unavailable, never a fabricated number)', () => {
  test('absent/blank env → null (omit the number)', () => {
    expect(parseApyPercent(undefined)).toBeNull();
    expect(parseApyPercent('')).toBeNull();
    expect(parseApyPercent('   ')).toBeNull();
  });

  test('a configured numeric APY parses', () => {
    expect(parseApyPercent('4.5')).toBe(4.5);
    expect(parseApyPercent('0')).toBe(0);
    expect(parseApyPercent(' 3.24 ')).toBe(3.24);
  });

  test('garbage or negative values fail closed to null. No 3.24 default', () => {
    expect(parseApyPercent('abc')).toBeNull();
    expect(parseApyPercent('-1')).toBeNull();
    expect(parseApyPercent('NaN')).toBeNull();
    expect(parseApyPercent('Infinity')).toBeNull();
  });
});
