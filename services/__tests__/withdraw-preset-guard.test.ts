import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseUnits } from 'viem';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import type { ShareRate } from '@/services/share-rates';
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
    expect(src).not.toContain('!amountField.underlyingAvailable');
    expect(src).toContain('amountField.presetExceedsMax(preset)');
    expect(src).toContain("${outOfReach ? 'opacity-40' : ''}");
    expect(src).toContain('accessibilityState={{ disabled: outOfReach');
    const handler = src.slice(src.indexOf('if (outOfReach && withdrawMaxWei !== null)'), src.indexOf('// nw-keep(data-color): active chip'));
    expect(handler).toContain('balanceDisplay(formatUnits(withdrawMaxWei, tokenMeta.decimals), tokenMeta.symbol, chainId).text');
    expect(handler).toContain("variant: 'warning'");
    expect(handler.indexOf('return;')).toBeLessThan(handler.indexOf('amountField.toShares(preset)'));
    expect(handler.indexOf('return;')).toBeLessThan(handler.indexOf('setAmount(next)'));
  });
});

const RATE: ShareRate = { chainId: 1, share: 'share', underlying: 'asset', shareSymbol: 'ppETH',
  shareDecimals: 18, underlyingDecimals: 18, underlyingSymbol: 'ETH', assetsPerShare: 2_000_000_000_000_000_000n };

test('share preset preview compares exact shares before the entry boundary clamps, without filling', () => {
  const preview = (text: string) => shareAmountFromUnderlying({ text, rate: RATE,
    maxSharesExact: '0.014', displayedMax: '0.028', preview: true });
  expect(preview('0.1')).toEqual({ shares: '0.014', exceedsMax: true });
  expect(preview('0.02')).toEqual({ shares: '0.01', exceedsMax: false });
  expect(preview('0.028')).toEqual({ shares: '0.014', exceedsMax: false });
  expect(preview('0.028000000000000002').exceedsMax).toBe(true);
  const hook = readFileSync(new URL('../../hooks/use-share-amount-field.ts', import.meta.url), 'utf8');
  const guard = hook.slice(hook.indexOf('presetExceedsMax(text: string)'), hook.indexOf('toShares(text: string'));
  expect(guard).toContain('preview: true');
  expect(guard).toContain('if (!rate) return null');
  expect(guard).not.toMatch(/setEdit|setAmount|toShares\(/);
});

test('a rounded displayed MAX preset keeps the exact cap; stable underlying decimals remain distinct', () => {
  expect(shareAmountFromUnderlying({ text: '0.10', rate: { ...RATE, assetsPerShare: 1_001_100_000_000_000_000n },
    maxSharesExact: '0.09989', displayedMax: '0.10', preview: true }))
    .toEqual({ shares: '0.09989', exceedsMax: false });
  const stable = { ...RATE, underlyingDecimals: 6, assetsPerShare: 1_000_103n };
  expect(shareAmountFromUnderlying({ text: '38.11', rate: stable, maxSharesExact: '38.1', displayedMax: '38.10', preview: true }))
    .toEqual({ shares: '38.1', exceedsMax: true });
});

test('the hub evaluates share presets against the pre-clamp verdict and leaves other actions alone', () => {
  const source = readFileSync(new URL('../../components/home/action-hub.tsx', import.meta.url), 'utf8');
  const expression = source.match(/const outOfReach = ([\s\S]*?);\n/)?.[1];
  expect(expression).toBeDefined();
  const evaluate = (a: string, preset: string, rate: ShareRate | null = RATE, blocked = false, max: bigint | null = ETH_MAX) => {
    const env = { a, preset, withdrawBalanceBlocked: blocked, withdrawMaxWei: max, tokenMeta: { decimals: 18 },
      presetExceedsWithdrawMax, amountField: { presetExceedsMax: (text: string) => rate
        ? shareAmountFromUnderlying({ text, rate, maxSharesExact: '0.014', displayedMax: '0.028', preview: true }).exceedsMax
        : null } };
    return new Function(...Object.keys(env), `return (${expression});`)(...Object.values(env));
  };
  expect(evaluate('withdraw', '0.1')).toBe(true);
  expect(evaluate('withdraw', '0.02')).toBe(false); // 0.01 shares at the non-par rate
  expect(evaluate('withdraw', '0.028')).toBe(false);
  expect(evaluate('withdraw', '0.02', null)).toBe(true); // unknown rate: preset is in shares
  expect(evaluate('withdraw', '0.1', RATE, true)).toBe(false);
  expect(evaluate('withdraw', '0.1', RATE, false, null)).toBe(false);
  for (const a of ['shield', 'send', 'swap', 'request']) expect(evaluate(a, '0.1')).toBe(false);
});
