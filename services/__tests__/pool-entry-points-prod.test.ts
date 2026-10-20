/**
 * Every pool the prod build carries must be ENTERABLE from every door the UI
 * opens: the hub's Shield (which names the destination pool), the pool page's
 * Deposit and Withdraw buttons and ?action= deep links (which name the route
 * token), and My balances (which names the registry token). Two launch-day
 * regressions got through a green suite because each door was tested in
 * isolation and nothing walked a pool from its route to its modal (codex on
 * dd034a1, 2026-09-18):
 *   - the hub named ppETH and the share-to-pay-asset resolver mapped it to
 *     WETH, which the registry does not carry, so every ETH shield was refused;
 *   - the pool route handed the withdraw modal PPETH, the notes were keyed
 *     ppETH, and the ETH pool page showed no spendable funds.
 * Prod-gated like shield-pay-routing.test.ts: environments.test.ts spawns this
 * file with EXPO_PUBLIC_APP_ENV=prod, and the pinned count there makes a
 * silently skipped body loud.
 */
import { describe, expect, test, mock } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';
process.env.EXPO_PUBLIC_YIELD_ENABLED = 'true';
process.env.EXPO_PUBLIC_YIELD_WITHDRAW_READY = 'true';
process.env.EXPO_PUBLIC_PAY_URL_BASE = 'https://pay.example.test';

const PROD_ACTIVE = process.env.EXPO_PUBLIC_APP_ENV === 'prod';
const describeProd = PROD_ACTIVE ? describe : (_name: string, _fn: () => void) => {
  test('pool entry points run under EXPO_PUBLIC_APP_ENV=prod (skipped here: staging active)', () => {
    expect(process.env.EXPO_PUBLIC_APP_ENV).not.toBe('prod');
  });
};

const { getConfiguredYieldDeploymentForAsset, getConfiguredNativeYieldDeployment } = await import('@/config/yield');
const { listShieldPools, defaultPoolFor, resolveDepositPayAsset } = await import('@/services/shield-pools');
const { getActionableTokens, getDepositableTokens, getKnownTokenMetadata, getTokenMetadataBySymbol } = await import('@/config/tokens');
const { getPoolPath, poolSymbolFromRoute, poolDisplayLabel, isSupersededLegacyPool } = await import('@/config/pool-paths');
const { displayTokenSymbol } = await import('@/services/share-display');
const { supportedChainIds, getChainConfig } = await import('@/config/chains');

const evmChains = supportedChainIds.filter((id) => getChainConfig(id)?.chainType === 'evm');
const routeSlug = (path: string) => path.split('/').pop() ?? '';
const FORBIDDEN = /^pp|WETH/i;

describeProd('every prod pool is enterable from every door', () => {
  test('the build carries the mainnet ETH share pool and ETH defaults into it', () => {
    expect(defaultPoolFor('ETH', 1).symbol).toBe('ppETH');
    expect(getConfiguredNativeYieldDeployment(1)?.ppUSDC.toLowerCase()).toBe(defaultPoolFor('ETH', 1).address.toLowerCase());
    expect(isSupersededLegacyPool('ETH', 1)).toBe(true);
  });

  test('hub Shield: the destination pool the hub names resolves to a pay asset the modal catalog has', () => {
    // components/deposit-modal-provider.tsx resolveSupportedToken: the open
    // is REFUSED when this answers null or names something outside the
    // depositable catalog. Walk every pool the hub can point at.
    const pools = listShieldPools();
    expect(pools.length).toBeGreaterThan(0);
    for (const pool of pools) {
      const meta = getKnownTokenMetadata(pool.address, pool.chainId);
      expect(meta).toBeDefined();
      const paid = resolveDepositPayAsset(meta!, pool.chainId, getConfiguredYieldDeploymentForAsset, getKnownTokenMetadata);
      expect(paid).not.toBeNull();
      const inCatalog = getDepositableTokens(pool.chainId).some((t) => t.address.toLowerCase() === paid!.address.toLowerCase());
      expect(inCatalog).toBe(true);
      // A share is never the thing the wallet pays.
      expect(paid!.yieldShare).toBeUndefined();
    }
    // The native-mode share specifically: paid with the coin, never WETH.
    const ppEth = getTokenMetadataBySymbol('ppETH', 1)!;
    expect(resolveDepositPayAsset(ppEth, 1, getConfiguredYieldDeploymentForAsset, getKnownTokenMetadata)?.isNative).toBe(true);
  });

  test('pool page: every registry pool has a route, and the route token names a registry token again', () => {
    // components/pools/pool-page-content.tsx opens deposit/withdraw with
    // poolSymbolFromRoute(slug); the modals accept it only when
    // getTokenMetadataBySymbol knows it, and must pin the REGISTRY spelling.
    for (const chainId of evmChains) {
      for (const token of getActionableTokens(chainId)) {
        const path = getPoolPath(token.symbol, chainId);
        const routeToken = poolSymbolFromRoute(routeSlug(path), chainId);
        const meta = getTokenMetadataBySymbol(routeToken, chainId);
        expect(meta?.address.toLowerCase()).toBe(token.address.toLowerCase());
      }
    }
    // The coin's route is the SHARE pool; the superseded plain pool keeps -legacy.
    expect(getPoolPath('ppETH', 1)).toBe('/chains/ethereum/eth');
    expect(getPoolPath('ETH', 1)).toBe('/chains/ethereum/eth-legacy');
    expect(getTokenMetadataBySymbol(poolSymbolFromRoute('eth', 1), 1)?.symbol).toBe('ppETH');
    expect(getTokenMetadataBySymbol(poolSymbolFromRoute('ppeth', 1), 1)?.symbol).toBe('ppETH');
    expect(getTokenMetadataBySymbol(poolSymbolFromRoute('eth-legacy', 1), 1)?.symbol).toBe('ETH');
  });

  test('no pool is ever shown to the user under a pp or WETH name', () => {
    for (const chainId of evmChains) {
      for (const token of getActionableTokens(chainId)) {
        expect(displayTokenSymbol(token.symbol)).not.toMatch(FORBIDDEN);
        expect(poolDisplayLabel(token.symbol, chainId)).not.toMatch(FORBIDDEN);
        // The upper-cased route spelling is what the pool page holds in state.
        expect(displayTokenSymbol(token.symbol.toUpperCase())).not.toMatch(FORBIDDEN);
      }
    }
    expect(poolDisplayLabel('ETH', 1)).toBe('ETH (legacy)');
    expect(poolDisplayLabel('ppETH', 1)).toBe('ETH');
    expect(poolDisplayLabel('PPETH', 1)).toBe('ETH');
  });
});
