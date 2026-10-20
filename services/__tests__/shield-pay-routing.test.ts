/**
 * Paying a yield share's underlying is that pool's ORDINARY deposit (the
 * PPRouter wraps it in the same transaction), not a LiFi conversion. The hub
 * got this wrong twice, both times on prod, both times ending in the same
 * sentence on the one pool the asset can enter:
 *
 *   2026-09-04  addresses compared directly, so USDT into the ppUSDT pool was
 *               a "conversion" with no route.
 *   2026-09-12  the vault-VERIFIED resolver answered the question, so until
 *               the probe landed USDC into the ppUSDC pool was a "conversion"
 *               too, the destination fell through to another pool, and the
 *               picker called USDC "Deposits closed" on the deposit screen.
 *
 * The second one got through a suite that already covered the first, for two
 * reasons this file now fixes:
 *   - the predicate was REPRODUCED here instead of imported, so fixing the
 *     component left the copy in the test passing. It imports the shipped
 *     module now (services/shield-pay-routing.ts).
 *   - this file's prod body was never spawned under EXPO_PUBLIC_APP_ENV=prod,
 *     so every assertion in it was skipped in CI. environments.test.ts spawns
 *     it now, the same way it spawns prod-runtime.test.ts.
 */
import { describe, expect, test, mock } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';
process.env.EXPO_PUBLIC_YIELD_ENABLED = 'true';
process.env.EXPO_PUBLIC_YIELD_WITHDRAW_READY = 'true';
process.env.EXPO_PUBLIC_PAY_URL_BASE = 'https://pay.example.test';

const { recordYieldVaultProbe, resetYieldVaultProbesForTests } = await import('@/services/yield-vault-probe');
const { getYieldDeploymentForAsset, getConfiguredYieldDeploymentForAsset, getYieldDepositDeploymentForUnderlying } = await import('@/config/yield');
const { payWrapsIntoPool, resolvePayWrapsIntoPool } = await import('@/services/shield-pay-routing');
const { defaultPoolFor, listShieldPools } = await import('@/services/shield-pools');
const { getDepositableTokens, getKnownTokenMetadata } = await import('@/config/tokens');
const { wrapsIntoShareSubtitle, LEGACY_ASSET_SUBTITLE, displayTokenSymbol } = await import('@/services/share-display');
const { PROD_YIELD_DEPLOYMENTS } = await import('@/config/prod-deployments');

// The prod deployments only resolve when prod is the active environment; under
// staging (the suite's default) the whole pair does not exist. Same child-run
// pattern as prod-runtime.test.ts, spawned by environments.test.ts.
const PROD_ACTIVE = process.env.EXPO_PUBLIC_APP_ENV === 'prod';
const describeProd = PROD_ACTIVE ? describe : (_name: string, _fn: () => void) => {
  test('shield pay routing runs under EXPO_PUBLIC_APP_ENV=prod (skipped here: staging active)', () => {
    expect(process.env.EXPO_PUBLIC_APP_ENV).not.toBe('prod');
  });
};

const MAINNET = 1;
const BSC = 56;
const PPUSDC = '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6';
const PPUSDT = '0xA4cF419558Ef36CC6FfB666195684dC963910426';
const BSC_PPUSDT = '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Every (chain, underlying, share) pair prod ships. Nothing below names one by hand. */
const PAIRS = [
  { chainId: MAINNET, symbol: 'USDC', underlying: USDC, share: PPUSDC, shareSymbol: 'ppUSDC' },
  { chainId: MAINNET, symbol: 'USDT', underlying: USDT, share: PPUSDT, shareSymbol: 'ppUSDT' },
  { chainId: BSC, symbol: 'USDT', underlying: BSC_USDT, share: BSC_PPUSDT, shareSymbol: 'ppUSDT' },
] as const;

const wraps = (payChainId: number, poolChainId: number, poolAddress: string, payAddress: string) =>
  payWrapsIntoPool({ payChainId, poolChainId, poolAddress, payAddress });

describeProd('paying a share underlying is a direct deposit, not a conversion', () => {
  test('the table under test is the one prod ships', () => {
    expect(PROD_YIELD_DEPLOYMENTS[MAINNET].map((d) => d.underlyingSymbol).sort()).toEqual(['USDC', 'USDT', 'WETH']);
    expect(PROD_YIELD_DEPLOYMENTS[BSC].map((d) => d.underlyingSymbol)).toEqual(['USDT']);
    // The fixtures above are the table, not a parallel copy of it.
    for (const pair of PAIRS) {
      const shipped = PROD_YIELD_DEPLOYMENTS[pair.chainId].find(
        (d) => d.underlying.toLowerCase() === pair.underlying.toLowerCase());
      expect(shipped?.ppUSDC.toLowerCase()).toBe(pair.share.toLowerCase());
    }
  });

  // THE 2026-09-12 REGRESSION. This assertion used to read `false` with the
  // comment "the probe still gates the pair", which is what shipped the bug:
  // the probe gates whether money MOVES, never what an asset IS.
  test('an unanswered vault probe does not turn a wrap into a conversion', () => {
    resetYieldVaultProbesForTests();
    for (const pair of PAIRS) {
      expect(wraps(pair.chainId, pair.chainId, pair.share, pair.underlying)).toBe(true);
    }
  });

  test('a FAILED probe does not either: it closes the deposit, not the classification', () => {
    resetYieldVaultProbesForTests();
    recordYieldVaultProbe(MAINNET, 'missing', PPUSDC);
    expect(wraps(MAINNET, MAINNET, PPUSDC, USDC)).toBe(true);
    // ...and the money gate is still shut, which is the half that matters.
    expect(getYieldDepositDeploymentForUnderlying(MAINNET, USDC)).toBeUndefined();
  });

  test('each share accepts its OWN underlying, and only that one', () => {
    resetYieldVaultProbesForTests();
    for (const pair of PAIRS) {
      expect(wraps(pair.chainId, pair.chainId, pair.share, pair.underlying)).toBe(true);
    }
    // Crossed pairs are real conversions and must stay refused.
    expect(wraps(MAINNET, MAINNET, PPUSDT, USDC)).toBe(false);
    expect(wraps(MAINNET, MAINNET, PPUSDC, USDT)).toBe(false);
    expect(wraps(MAINNET, MAINNET, PPUSDT, ETH)).toBe(false);
    // Same symbol, different chain's contract: an address is not a symbol.
    expect(wraps(MAINNET, MAINNET, PPUSDT, BSC_USDT)).toBe(false);
  });

  test('the wallet must be on the pool chain: a cross-chain pay is a bridge, not a wrap', () => {
    resetYieldVaultProbesForTests();
    expect(wraps(BSC, MAINNET, PPUSDT, USDT)).toBe(false);
    expect(wraps(MAINNET, BSC, BSC_PPUSDT, BSC_USDT)).toBe(false);
  });

  test('no pay token, no wrap', () => {
    expect(payWrapsIntoPool({ payChainId: MAINNET, poolChainId: MAINNET, poolAddress: PPUSDC, payAddress: undefined })).toBe(false);
  });

  test('the rule is injectable, and the VERIFIED resolver is what it must NOT be wired to', () => {
    resetYieldVaultProbesForTests();
    const args = { payChainId: MAINNET, poolChainId: MAINNET, poolAddress: PPUSDC, payAddress: USDC };
    // This is the wiring that shipped the bug, kept here so the difference is
    // visible rather than asserted in prose.
    expect(resolvePayWrapsIntoPool(args, getYieldDeploymentForAsset)).toBe(false);
    expect(resolvePayWrapsIntoPool(args, getConfiguredYieldDeploymentForAsset)).toBe(true);
    expect(payWrapsIntoPool(args)).toBe(true);
  });
});

describeProd('with the probe unanswered, an open pool still looks open', () => {
  test('the underlying is depositable, so a picker lists it', () => {
    resetYieldVaultProbesForTests();
    for (const pair of PAIRS) {
      const listed = getDepositableTokens(pair.chainId).some(
        (t) => t.address.toLowerCase() === pair.underlying.toLowerCase());
      expect(listed).toBe(true);
    }
  });

  test('its destination is its OWN share pool, never another chain\'s pool and never null', () => {
    resetYieldVaultProbesForTests();
    for (const pair of PAIRS) {
      const pool = defaultPoolFor(pair.symbol, pair.chainId);
      expect(pool.chainId).toBe(pair.chainId);
      expect(pool.address.toLowerCase()).toBe(pair.share.toLowerCase());
      expect(pool.symbol).toBe(pair.shareSymbol);
      // ...and the pool is shown under the underlying's name.
      expect(displayTokenSymbol(pool.symbol)).toBe(pair.symbol);
    }
  });

  test('one row per pool: the underlying does not appear as a pool of its own', () => {
    resetYieldVaultProbesForTests();
    const pools = listShieldPools();
    for (const pair of PAIRS) {
      expect(pools.some((p) => p.chainId === pair.chainId && p.address.toLowerCase() === pair.underlying.toLowerCase())).toBe(false);
      expect(pools.filter((p) => p.chainId === pair.chainId && p.address.toLowerCase() === pair.share.toLowerCase())).toHaveLength(1);
    }
  });

  test('the picker line says what it earns, never that deposits are closed', () => {
    resetYieldVaultProbesForTests();
    for (const pair of PAIRS) {
      const shareSymbol = getKnownTokenMetadata(
        getConfiguredYieldDeploymentForAsset(pair.chainId, pair.underlying)?.ppUSDC ?? '',
        pair.chainId,
      )?.symbol;
      const subtitle = wrapsIntoShareSubtitle(shareSymbol);
      expect(subtitle).toBe('Earns Aave yield');
      expect(subtitle).not.toBe(LEGACY_ASSET_SUBTITLE);
      // Ameen via Pat, 2026-09-12: the share name is in no sentence.
      expect(subtitle).not.toMatch(/\bpp(usdc|usdt)\b/i);
    }
  });
});

describe('a native-mode share is minted from the native coin (ppETH, 2026-09-18)', () => {
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const PPETH = '0x66051920D25af4E3596A8a46309F4D045F9D83B7';
  const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
  const nativeShare = (_c: number, addr: string) =>
    (addr.toLowerCase() === PPETH.toLowerCase() ? { underlying: WETH, nativeMode: true } : undefined);
  const erc20Share = (_c: number, addr: string) =>
    (addr.toLowerCase() === PPETH.toLowerCase() ? { underlying: WETH } : undefined);
  const args = (payAddress: string) => ({ payChainId: 1, poolChainId: 1, poolAddress: PPETH, payAddress });

  test('paying ETH into the ppETH pool is that pool’s ordinary deposit, not a conversion', () => {
    expect(resolvePayWrapsIntoPool(args(NATIVE), nativeShare)).toBe(true);
  });
  test('paying the WETH underlying still wraps too', () => {
    expect(resolvePayWrapsIntoPool(args(WETH), nativeShare)).toBe(true);
  });
  test('without nativeMode the native coin is NOT the underlying', () => {
    expect(resolvePayWrapsIntoPool(args(NATIVE), erc20Share)).toBe(false);
  });
  test('another chain’s wallet is a bridge, not a wrap, even for the native coin', () => {
    expect(resolvePayWrapsIntoPool({ ...args(NATIVE), payChainId: 10 }, nativeShare)).toBe(false);
  });
});
