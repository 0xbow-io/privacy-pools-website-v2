import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseUnits } from 'viem';
import { presetExceedsWithdrawMax, withdrawMaxToastTitle } from '../withdraw-preset-guard';

const ETH_MAX = parseUnits('0.014', 18); // the shielded balance in the report

describe('presetExceedsWithdrawMax', () => {
  test('every native preset above a 0.014 ETH ceiling is out of reach, none below it', () => {
    const verdicts = ['0.1', '1', '5', '10', '100'].map((p) => presetExceedsWithdrawMax(p, ETH_MAX, 18));
    expect(verdicts).toEqual([true, true, true, true, true]);
    expect(presetExceedsWithdrawMax('0.01', ETH_MAX, 18)).toBe(false);
    expect(presetExceedsWithdrawMax('0.014', ETH_MAX, 18)).toBe(false); // equal is reachable
  });

  test('stable presets compare in the token’s own decimals', () => {
    const max = parseUnits('2500', 6);
    expect(presetExceedsWithdrawMax('1000', max, 6)).toBe(false);
    expect(presetExceedsWithdrawMax('5000', max, 6)).toBe(true);
  });

  test('an unresolved ceiling never disables a preset', () => {
    expect(presetExceedsWithdrawMax('100', null, 18)).toBe(false);
    expect(presetExceedsWithdrawMax('100', undefined, 18)).toBe(false);
  });

  test('a preset that does not parse is left alone', () => {
    expect(presetExceedsWithdrawMax('abc', ETH_MAX, 18)).toBe(false);
  });
});

describe('withdrawMaxToastTitle', () => {
  test('names the ceiling in display precision with the token', () => {
    expect(withdrawMaxToastTitle(ETH_MAX, 18, 'ETH')).toBe('You can withdraw up to 0.014 ETH.');
    expect(withdrawMaxToastTitle(parseUnits('2500', 6), 6, 'USDC')).toBe('You can withdraw up to 2,500 USDC.');
  });

  test('a dust ceiling is shown exactly, never as "up to 0"', () => {
    expect(withdrawMaxToastTitle(1n, 18, 'ETH')).toBe('You can withdraw up to 0.000000000000000001 ETH.');
    expect(withdrawMaxToastTitle(0n, 18, 'ETH')).toBe('You can withdraw up to 0 ETH.');
  });
});

describe('the hub Withdraw presets use the guard', () => {
  test('action-hub greys out-of-reach presets and toasts the ceiling instead of filling the amount', () => {
    const src = readFileSync(fileURLToPath(new URL('../../components/home/action-hub.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('presetExceedsWithdrawMax(');
    expect(src).toContain('withdrawMaxToastTitle(');
  });
});
