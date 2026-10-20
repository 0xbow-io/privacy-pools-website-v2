import { describe, expect, test } from 'bun:test';

import { entrypointOnlyTargetBlocked, targetAcceptsConversion } from '@/services/entrypoint-only-route';

describe('yield critical route split', () => {
  const plainUsdc = { symbol: 'USDC', withdrawOnly: true };
  const ppUsdc = { symbol: 'ppUSDC', yieldShare: 'aave-v3', withdrawOnly: undefined };

  test('a wallet-funded /pay link cannot deposit plain USDC into the Entrypoint', () => {
    expect(entrypointOnlyTargetBlocked(plainUsdc, { chainId: 1 })).toBe(true);
  });

  test('alternate-pay and cross-chain Shield cannot convert into plain USDC', () => {
    expect(entrypointOnlyTargetBlocked(plainUsdc, { chainId: 1 })).toBe(true);
  });

  test('the ppUSDC share remains a valid plain Entrypoint target', () => {
    expect(entrypointOnlyTargetBlocked(ppUsdc, { chainId: 1 })).toBe(false);
    expect(entrypointOnlyTargetBlocked(undefined, { chainId: 1 })).toBe(true);
  });
});

describe('a closed-at-the-Entrypoint destination is never offered a conversion', () => {
  const plainUsdc = { symbol: 'USDC', withdrawOnly: true } as const;
  const ppUsdc = { symbol: 'ppUSDC', yieldShare: 'aave-v3', withdrawOnly: undefined };
  const eth = { symbol: 'ETH', isNative: true, withdrawOnly: undefined };

  test('plain USDC takes no pay-with and no bridge: its only way in is the direct router route', () => {
    // The deposit modal reads this where the options are OFFERED. False here
    // means no pay token list, no cross-chain, and any pay token already set is
    // dropped by the existing validity effect — so the deposit falls back to
    // the route that works instead of erroring at confirm.
    expect(targetAcceptsConversion(plainUsdc, { chainId: 1 })).toBe(false);
  });

  test('only known open plain assets convert; shares have no LiFi liquidity', () => {
    expect(targetAcceptsConversion(ppUsdc, { chainId: 1 })).toBe(false);
    expect(targetAcceptsConversion(eth, { chainId: 1 })).toBe(true);
    expect(targetAcceptsConversion(undefined, { chainId: 1 })).toBe(false);
  });
});
