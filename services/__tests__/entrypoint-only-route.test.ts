import { describe, expect, test } from 'bun:test';
import { conversionTargetRefusal, entrypointOnlyTargetBlocked, targetAcceptsConversion, type EntrypointTarget, type TargetRouteFacts } from '@/services/entrypoint-only-route';

const matrix: { name: string; token: EntrypointTarget | undefined; route: TargetRouteFacts; works: boolean }[] = [
  { name: 'mainnet legacy ETH', token: { symbol: 'ETH', isNative: true }, route: { chainId: 1, nativeYieldConfigured: true }, works: false },
  { name: 'superseded native even without a live vault probe', token: { symbol: 'ETH', isNative: true }, route: { chainId: 1, superseded: true }, works: false },
  { name: 'mainnet closed USDC', token: { symbol: 'USDC', withdrawOnly: true }, route: { chainId: 1 }, works: false },
  { name: 'mainnet closed USDT', token: { symbol: 'USDT', withdrawOnly: true }, route: { chainId: 1 }, works: false },
  // A share with no configured router is still a dead end; with one, the
  // conversion ends in that router on its own chain and nowhere else.
  ...['ppETH', 'ppUSDC', 'ppUSDT'].map((symbol) => ({ name: `mainnet ${symbol}, router unknown`, token: { symbol, yieldShare: 'aave-v3' }, route: { chainId: 1 }, works: false })),
  ...['ppETH', 'ppUSDC', 'ppUSDT'].map((symbol) => ({ name: `mainnet ${symbol}, router configured`, token: { symbol, yieldShare: 'aave-v3' }, route: { chainId: 1, shareRouteConfigured: true }, works: true })),
  // A bridged deposit funds a share now: runReshieldCrosschain goes through
  // buildRedeposit, the same path the same-chain flow uses. The ROUTER decides,
  // not the transport.
  ...['ppETH', 'ppUSDC'].map((symbol) => ({ name: `mainnet ${symbol} bridged, router configured`, token: { symbol, yieldShare: 'aave-v3' }, route: { chainId: 1, shareRouteConfigured: true, bridgedEntrypointDeposit: true }, works: true })),
  // Without that chain's router there is still no call that lands in the share.
  ...['ppETH', 'ppUSDC'].map((symbol) => ({ name: `mainnet ${symbol} bridged, no router`, token: { symbol, yieldShare: 'aave-v3' }, route: { chainId: 1, bridgedEntrypointDeposit: true }, works: false })),
  { name: 'a superseded share is still refused', token: { symbol: 'ppETH', yieldShare: 'aave-v3' }, route: { chainId: 1, shareRouteConfigured: true, superseded: true }, works: false },
  { name: 'a withdraw-only share is still refused', token: { symbol: 'ppUSDC', yieldShare: 'aave-v3', withdrawOnly: true }, route: { chainId: 1, shareRouteConfigured: true }, works: false },
  { name: 'configured ERC-20 router route', token: { symbol: 'USDC' }, route: { chainId: 1, yieldRouteConfigured: true }, works: false },
  { name: 'BNB native', token: { symbol: 'BNB', isNative: true }, route: { chainId: 56 }, works: true },
  { name: 'BNB FDUSD', token: { symbol: 'FDUSD' }, route: { chainId: 56 }, works: true },
  { name: 'BNB closed USDT', token: { symbol: 'USDT', withdrawOnly: true }, route: { chainId: 56 }, works: false },
  { name: 'BNB share', token: { symbol: 'ppUSDT', yieldShare: 'aave-v3' }, route: { chainId: 56 }, works: false },
  { name: 'OP plain ETH', token: { symbol: 'ETH', isNative: true }, route: { chainId: 10 }, works: true },
  // A bridge cannot send the exact msg.value a plain native deposit needs
  // (v2-monorepo#437; three BNB losses 2026-09-22/23), so the coin is refused
  // over a bridge and only there. A native-mode share is exempt: its router
  // caps msg.value and refunds the rest.
  { name: 'BNB native bridged', token: { symbol: 'BNB', isNative: true }, route: { chainId: 56, bridgedEntrypointDeposit: true }, works: false },
  { name: 'OP plain ETH bridged', token: { symbol: 'ETH', isNative: true }, route: { chainId: 10, bridgedEntrypointDeposit: true }, works: false },
  { name: 'BNB FDUSD bridged', token: { symbol: 'FDUSD' }, route: { chainId: 56, bridgedEntrypointDeposit: true }, works: true },
  { name: 'native-mode share bridged', token: { symbol: 'ppETH', isNative: true, yieldShare: 'aave-v3' }, route: { chainId: 1, shareRouteConfigured: true, bridgedEntrypointDeposit: true }, works: true },
  { name: 'unopened pool', token: { symbol: 'ETH', depositComingSoon: true }, route: { chainId: 1 }, works: false },
  { name: 'unknown target', token: undefined, route: { chainId: 56 }, works: false },
  { name: 'unknown destination chain', token: { symbol: 'ETH' }, route: { chainId: NaN }, works: false },
];

describe('intent final-leg capability matrix (independent of transport and probes)', () => {
  for (const row of matrix) {
    test(row.name, () => {
      expect(targetAcceptsConversion(row.token, row.route)).toBe(row.works);
      expect(conversionTargetRefusal(row.token, row.route) === null).toBe(row.works);
    });
  }

  test('same native sentinel is refused on mainnet and allowed on OP/BNB', () => {
    const native = { symbol: 'ETH', isNative: true };
    expect(entrypointOnlyTargetBlocked(native, { chainId: 1, nativeYieldConfigured: true })).toBe(true);
    expect(entrypointOnlyTargetBlocked(native, { chainId: 10 })).toBe(false);
    expect(entrypointOnlyTargetBlocked(native, { chainId: 56 })).toBe(false);
  });

  test('refusal copy uses display coins and sentences', () => {
    for (const symbol of ['ETH', 'ppETH', 'ppUSDC', 'ppUSDT', 'WETH']) {
      const refusal = conversionTargetRefusal({ symbol, yieldShare: 'aave-v3' }, { chainId: 1 });
      expect(refusal).toContain('Shield ');
      expect(refusal).not.toMatch(/ppETH|ppUSDC|ppUSDT|WETH|—/);
    }
    expect(conversionTargetRefusal({ symbol: 'ETH', isNative: true }, { chainId: 1, nativeYieldConfigured: true }))
      .toBe('ETH deposits on this network go through the yield vault, and a conversion cannot land there yet. Shield ETH directly instead.');
  });
  test('a share destination is the router question, not the transport question', () => {
    const share = { symbol: 'ppUSDC', yieldShare: 'aave-v3' };
    expect(conversionTargetRefusal(share, { chainId: 1, shareRouteConfigured: true })).toBeNull();
    // Bridged is allowed on the same terms: the deposit leg funds the share
    // through its router either way.
    expect(conversionTargetRefusal(share, { chainId: 1, shareRouteConfigured: true, bridgedEntrypointDeposit: true })).toBeNull();
    // Without a router the reason is the same either way, and never names the share.
    for (const route of [{ chainId: 1 }, { chainId: 1, bridgedEntrypointDeposit: true }]) {
      const refusal = conversionTargetRefusal(share, route);
      expect(refusal).toBe('USDC deposits on this network go through the yield vault, and a conversion cannot land there yet. Shield USDC directly instead.');
      expect(refusal).not.toMatch(/ppUSDC|—/);
    }
  });

  test('a native coin over a bridge says to pick another asset, and only a bridge refuses it', () => {
    const bnb = { symbol: 'BNB', isNative: true };
    expect(conversionTargetRefusal(bnb, { chainId: 56 })).toBeNull();
    expect(conversionTargetRefusal(bnb, { chainId: 56, bridgedEntrypointDeposit: true }))
      .toBe('Converting into BNB from another network is not available yet. Pick another asset, or swap into BNB on its own network.');
    // A coin already closed for its own reason keeps that reason.
    expect(conversionTargetRefusal({ symbol: 'ETH', isNative: true }, { chainId: 1, nativeYieldConfigured: true, bridgedEntrypointDeposit: true }))
      .toBe('ETH deposits on this network go through the yield vault, and a conversion cannot land there yet. Shield ETH directly instead.');
  });

  test('the underlying of a wrapped pool stays refused: the share is the destination', () => {
    // Allowing the underlying would send the conversion into an Entrypoint
    // deposit the pool no longer accepts.
    expect(targetAcceptsConversion({ symbol: 'USDC' }, { chainId: 1, yieldRouteConfigured: true })).toBe(false);
    expect(targetAcceptsConversion({ symbol: 'ETH', isNative: true }, { chainId: 1, nativeYieldConfigured: true })).toBe(false);
  });
});
