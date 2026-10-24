// The PROD runtime graph, executed with prod ACTIVE. The unit suite runs with
// staging active (tests/bun-test-preload.ts), so this file is a no-op there;
// services/__tests__/environments.test.ts spawns it as a child `bun test` with
// EXPO_PUBLIC_APP_ENV=prod plus the STAGING overrides set, proving they cannot
// re-point prod (codex finding 2/3, 2026-09-02).
import { describe, expect, mock, test } from 'bun:test';

const PROD_ACTIVE = process.env.EXPO_PUBLIC_APP_ENV === 'prod';

if (PROD_ACTIVE) {
  // config transitively pulls react-native; stub the one symbol needed.
  mock.module('react-native', () => ({
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
    TurboModuleRegistry: { get: () => null, getEnforcing: () => ({}) },
  }));
  // Pulled in by services/sdk-storage.ts and the stores; native-only here.
  mock.module('expo-secure-store', () => ({
    getItem: () => null,
    setItem: () => undefined,
    getItemAsync: async () => null,
    setItemAsync: async () => undefined,
    deleteItemAsync: async () => undefined,
  }));
}

const PROD_RELAY = '0x01a8fa4dbb60187ad8d3c3d08e7fb8c14198a461';
// The relayer's RelaySwaps since its ppETH redeploy (/v1/details/evm/1 and /56, 2026-09-18).
const PROD_RELAY_SWAPS = '0xd0395c08dd8ea7671a7a65bdca8e473e8e8260a8';
const PROD_POOL = '0x0eb42804bf897662af851370eaeadcdbec1b97ed';
const STAGING_MAINNET_RELAY_SWAPS = '0x5f3927f24ec20f49b3850a5b78eb2015945e57f7';

// A plain conditional rather than describe.skipIf: the app's bun:test typings do
// not model skipIf, and the else branch keeps the file visible in the suite.
const describeProd = PROD_ACTIVE ? describe : (_name: string, _fn: () => void) => {
  test('prod runtime graph runs as a child bun test of environments.test.ts (skipped here: staging active)', () => {
    expect(process.env.EXPO_PUBLIC_APP_ENV).not.toBe('prod');
  });
};

describeProd('prod runtime graph (child bun test, EXPO_PUBLIC_APP_ENV=prod)', () => {
  test('chains: the prod deployments, no Sepolia, no Sui, Ethereum default', async () => {
    const chains = await import('@/config/chains');
    expect([...chains.supportedChainIds].sort((a, b) => a - b)).toEqual([1, 10, 56, 4114, 4663, 8453, 42161]);
    expect(chains.defaultChainId).toBe(1);
    expect(chains.getChainConfig(11155111)).toBeUndefined();
    expect(chains.getChainConfig(102)).toBeUndefined();
    expect(chains.getChainConfig(1)?.contracts?.poolAddress.toLowerCase()).toBe(PROD_POOL);
    expect(chains.getChainConfig(56)?.relayerBaseUrl).toMatch(/relayer-v2-prod/);
    expect(chains.getExplorerName(56)).toBe('BscScan');
    expect(chains.mainnetChainIds.sort((a, b) => a - b)).toEqual([1, 10, 56, 4114, 4663, 8453, 42161]);
  });

  test('env: prod ASP, and the STAGING key override does not leak in', async () => {
    const env = await import('@/config/env');
    expect(env.ASP_URL).toBe('https://api-v2.0xbow.io');
    // The spawner sets EXPO_PUBLIC_ASP_PUBLIC_KEY; it belongs to the dev ASP.
    expect(process.env.EXPO_PUBLIC_ASP_PUBLIC_KEY).toBeTruthy();
    expect(env.ASP_PUBLIC_KEY).toBeUndefined();
  });

  test('relayer: processors bind to the prod relay / signer / RelaySwaps', async () => {
    const relayer = await import('@/config/relayer');
    expect(relayer.getWithdrawalProcessorAddress(1).toLowerCase()).toBe(PROD_RELAY);
    expect(relayer.getWithdrawalProcessorAddress(4114).toLowerCase()).toBe(PROD_RELAY);
    expect(relayer.getTransferProcessorAddress(1).toLowerCase()).toBe('0x9e2f1b234953f46c6091636290e9035618ea3c07');
    // The BSC signer is the real 0x9e2f key now; the old pin was the account of
    // private key 0x1 (a placeholder) and reverted every relayed BSC transfer.
    expect(relayer.getTransferProcessorAddress(56).toLowerCase()).toBe('0x9e2f1b234953f46c6091636290e9035618ea3c07');
    expect(relayer.getTransferProcessorAddress(56).toLowerCase()).not.toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
    // The spawner sets EXPO_PUBLIC_MAINNET_SWAP_PROCESSOR_ADDRESS to the STAGING
    // RelaySwaps; prod must ignore it.
    expect(process.env.EXPO_PUBLIC_MAINNET_SWAP_PROCESSOR_ADDRESS?.toLowerCase()).toBe(STAGING_MAINNET_RELAY_SWAPS);
    expect(relayer.MAINNET_SWAP_PROCESSOR_ADDRESS?.toLowerCase()).toBe(PROD_RELAY_SWAPS);
    expect(relayer.OPTIMISM_SWAP_PROCESSOR_ADDRESS).toBe(relayer.MAINNET_SWAP_PROCESSOR_ADDRESS);
  });

  test('relayer: only the signer EOA places a Transacted log on the transfer route', async () => {
    const relayer = await import('@/config/relayer');
    // The callers of real BSC logs: a fee-only consolidation (signer), a relayed
    // withdrawal (PrivacyPoolRelay) and a swap exit (RelaySwaps).
    expect(relayer.isTransferRouteCaller('0x9e2f1b234953f46c6091636290e9035618ea3c07', 56)).toBe(true);
    expect(relayer.isTransferRouteCaller(PROD_RELAY, 56)).toBe(false);
    expect(relayer.isTransferRouteCaller(PROD_RELAY_SWAPS, 56)).toBe(false);
    // A self-submitted (disclosed) transact names the user's wallet.
    expect(relayer.isTransferRouteCaller('0x1e508e333eb17eef67afd3d22a6406eadfb5df43', 56)).toBe(false);
    // A malformed snapshot row must not throw during render.
    expect(relayer.isTransferRouteCaller(123, 56)).toBe(false);
  });

  test('routes: the relay, a yield router and a swap route place a log on a withdrawal route', async () => {
    const routes = await import('@/config/route-callers');
    // Callers of real prod logs: a relayed ppETH withdrawal through the
    // mainnet yield router that left three change notes (0xffb2fbe0...),
    // a relayed withdrawal and a swap exit on BSC.
    expect(routes.isWithdrawalRouteCaller('0x77613D670BB9fD48A9898D0eac8ebf21B566F960', 1)).toBe(true);
    expect(routes.isWithdrawalRouteCaller(PROD_RELAY, 56)).toBe(true);
    expect(routes.isWithdrawalRouteCaller(PROD_RELAY_SWAPS, 56)).toBe(true);
    // The relayer's signer is the transfer route; a user's own wallet names no route.
    expect(routes.isWithdrawalRouteCaller('0x9e2f1b234953f46c6091636290e9035618ea3c07', 56)).toBe(false);
    expect(routes.isWithdrawalRouteCaller('0x1e508e333eb17eef67afd3d22a6406eadfb5df43', 56)).toBe(false);
    expect(routes.isWithdrawalRouteCaller(123, 56)).toBe(false);
  });

  test('intent swaps: mainnet + BSC live, Citrea dark, LiFi 1/56', async () => {
    const swaps = await import('@/config/intent-swaps');
    expect(swaps.lifiServesChain(1)).toBe(true);
    expect(swaps.lifiServesChain(56)).toBe(true);
    expect(swaps.lifiServesChain(10)).toBe(true);
    expect(swaps.lifiServesChain(4114)).toBe(false);
    expect(swaps.getSwapProcessorAddress(10)).toBe(swaps.getSwapProcessorAddress(1));
    expect(swaps.getSwapProcessorAddress(56)?.toLowerCase()).toBe(PROD_RELAY_SWAPS);
    expect(swaps.getSwapProcessorAddress(4114)).toBeUndefined();
    // The intent LOCKDOWN (config/intent-lockdown.ts) hides the whole surface
    // on prod while LiFi cannot route the yield shares: the tab is dark and
    // the pool chain is the only destination, whatever the processors say.
    expect(swaps.intentSwapsEnabledForChain(1)).toBe(false);
    expect(swaps.intentSwapsEnabledForChain(56)).toBe(false);
    expect(swaps.intentSwapsEnabledForChain(4114)).toBe(false);
    expect(swaps.getSwapDestinationChains(1)).toEqual([1]);
    expect(swaps.crossChainSwapDepositSupported(1, 56)).toBe(false);
    expect(swaps.swapDepositEnabledForChain(1)).toBe(false);
    expect(swaps.getSwapOutputTokens(56).map((t) => t.symbol)).toEqual(['BNB', 'FDUSD', 'U']);
    // No yield share is a swap route: LiFi cannot fill ppUSDC / ppUSDT (relayer team, 2026-09-04).
    // ETH is a legacy input only. It must never be offered as a target.
    expect(swaps.getSwapOutputTokens(1)).toEqual([]);
    expect(swaps.getSwapInputTokens(1).map((t) => t.symbol)).toEqual(['ETH']);
  });

  test('tokens: the prod catalog, mainnet as the unknown-chain fallback', async () => {
    const tokens = await import('@/config/tokens');
    expect(tokens.getActionableTokens(56).map((t) => `${t.symbol}/${t.decimals}`)).toEqual(['BNB/18', 'ppUSDT/18', 'FDUSD/18', 'U/18', 'USDT/18']);
    expect(tokens.getDepositableTokens(56).map((t) => t.symbol)).toEqual(['BNB', 'ppUSDT', 'FDUSD', 'U']);
    expect(tokens.getTokenMetadata(tokens.NATIVE_ASSET_ADDRESS, 4114).symbol).toBe('cBTC');
    expect(tokens.getActionableTokens(undefined).map((t) => t.symbol)).toEqual(['ETH', 'ppUSDC', 'ppUSDT', 'ppETH', 'USDC', 'USDT']);
    // ETH is a mainnet pool ASSET (notes in it are spendable) but not a
    // deposit target: its pool has not opened yet (`depositComingSoon`,
    // 2026-09-05). Every deposit-shaped list drops it; getActionableTokens
    // above still carries it.
    // ETH is depositable from 2026-09-15: the ppETH entry is native-mode, and
    // mainnetEth() opens the row off the yield table (config/environments.ts).
    expect(tokens.getDepositableTokens(1).map((t) => t.symbol)).toEqual(['ETH', 'ppUSDC', 'ppUSDT', 'ppETH']);
    // Nothing is coming-soon on prod any more: mainnet ETH was the only one and
    // ppETH opened it.
    expect(tokens.getDepositComingSoonTokens(1).map((t) => t.symbol)).toEqual([]);
    expect(tokens.isDepositComingSoon(tokens.NATIVE_ASSET_ADDRESS, 1)).toBe(false);
    // Citrea's and BSC's native assets were always open, and still are.
    expect(tokens.isDepositComingSoon(tokens.NATIVE_ASSET_ADDRESS, 4114)).toBe(false);
    expect(tokens.isDepositComingSoon(tokens.NATIVE_ASSET_ADDRESS, 56)).toBe(false);
    // The orphaned-note shape of 2026-09-04: plain mainnet USDC must resolve with 6 decimals, not fall back to an address and 18.
    expect(tokens.getKnownTokenMetadata('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 1)).toMatchObject({ symbol: 'USDC', decimals: 6, withdrawOnly: true });
    expect(tokens.getTokenMetadataBySymbol('ppUSDC')?.decimals).toBe(18);
    // Shield targets: a withdraw-only asset is never offered, and defaulting to it says null.
    const shieldPools = await import('@/services/shield-pools');
    expect(shieldPools.listShieldPools().filter((p) => p.chainId === 1).map((p) => p.symbol)).toEqual(['ppETH', 'ppUSDC', 'ppUSDT']);
    // Base USDT is the one open plain 6dp USDT pool: Base has no ppUSDT.
    expect(shieldPools.listShieldPools().some((p) => p.symbol === 'USDC' || (p.symbol === 'USDT' && p.decimals === 6 && p.chainId !== 8453))).toBe(false);
  });

  test('cold start + storage scoping follow prod', async () => {
    const { supportsColdStartClaim } = await import('@/config/cold-start');
    const { envScopedStorageKey, ACTIVE_APP_ENVIRONMENT } = await import('@/config/app-environment');
    const { isActiveEnvironmentPhysicalKey } = await import('@/services/sdk-storage');
    expect(ACTIVE_APP_ENVIRONMENT).toBe('prod');
    for (const chainId of [1, 4114, 56]) expect(supportsColdStartClaim(chainId, PROD_RELAY)).toBe(true);
    expect(envScopedStorageKey('v1:payment-request-state:1:0xabc')).toBe('v1:payment-request-state:1:0xabc_prod');
    expect(isActiveEnvironmentPhysicalKey('v1:payment-request-state:1:0xabc_prod')).toBe(true);
    expect(isActiveEnvironmentPhysicalKey('v1:payment-request-state:1:0xabc')).toBe(false);
  });
});

describeProd('prod yield deployments (Artem, 2026-09-04)', () => {
  test('each router entry names a share the prod registry knows, with its real underlying and decimals; the flags still gate', async () => {
    const { PROD_YIELD_DEPLOYMENTS } = await import('@/config/prod-deployments');
    const { ENVIRONMENTS } = await import('@/config/environments');
    const prod = ENVIRONMENTS.prod;
    expect(Object.keys(PROD_YIELD_DEPLOYMENTS).map(Number).sort((a, b) => a - b)).toEqual([1, 10, 56, 8453, 42161]);
    for (const [chainId, list] of Object.entries(PROD_YIELD_DEPLOYMENTS)) {
      for (const d of list) {
        const share = prod.tokensByChain[Number(chainId)][d.ppUSDC.toLowerCase()];
        expect(share?.yieldShare).toBe('aave-v3');
        expect(share?.decimals).toBe(d.ppUSDCDecimals);
        expect(d.ppRouter).toMatch(/^0x[0-9a-fA-F]{40}$/);
        if (d.nativeMode) {
          // The wrapped underlying (WETH) is an implementation detail of the
          // wrapper: the user sends native ETH and the router wraps it, so WETH
          // is deliberately NOT a pool asset. What has to be in the registry is
          // the coin the user actually deposits, and it has to be open.
          const native = prod.tokensByChain[Number(chainId)]['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
          expect(native?.isNative).toBe(true);
          expect(native?.depositComingSoon).toBeUndefined();
          expect(d.underlyingDecimals).toBe(18);
          expect(d.ppUSDCDecimals).toBe(18);
          continue;
        }
        const underlying = prod.tokensByChain[Number(chainId)][d.underlying.toLowerCase()];
        expect(underlying?.withdrawOnly).toBe(true);
        expect(underlying?.decimals).toBe(d.underlyingDecimals);
        expect(underlying?.symbol).toBe(d.underlyingSymbol);
      }
    }
    expect(prod.yieldDeployments).toBe(PROD_YIELD_DEPLOYMENTS);
    expect(ENVIRONMENTS.staging.yieldDeployments).toBeUndefined();
    // Known deployments never open the module by themselves: with the flags off, nothing resolves.
    const yieldMod = await import('@/config/yield');
    expect(yieldMod.resolveYieldDeployments(1, { enabled: false, withdrawReady: false }, PROD_YIELD_DEPLOYMENTS)).toEqual([]);
    // Mainnet carried ppUSDC and ppUSDT from 2026-09-04 and ppETH from
    // 2026-09-15, each with its own router, zap and underlying: one router
    // serves one vault, and that one-to-one is what the Set sizes below pin.
    const mainnet = yieldMod.resolveYieldDeployments(1, { enabled: true, withdrawReady: true }, PROD_YIELD_DEPLOYMENTS);
    expect(mainnet).toHaveLength(3);
    expect(mainnet.map((d) => d.underlyingSymbol).sort()).toEqual(['USDC', 'USDT', 'WETH']);
    // Exactly one native-mode entry: two would mean a mis-copied row, since a
    // chain has one native coin.
    expect(mainnet.filter((d) => d.nativeMode)).toHaveLength(1);
    for (const field of ['ppRouter', 'zap', 'ppUSDC', 'underlying'] as const) {
      expect(new Set(mainnet.map((d) => String(d[field]).toLowerCase())).size).toBe(3);
    }
    expect(yieldMod.resolveYieldDeployments(56, { enabled: true, withdrawReady: true }, PROD_YIELD_DEPLOYMENTS)).toHaveLength(1);
  });
  test('a withdraw-only asset becomes depositable only as a VERIFIED yield underlying', async () => {
    const tokens = await import('@/config/tokens');
    const all = tokens.getActionableTokens(1);
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const none = tokens.resolveDepositableTokens(all, 1, () => false).map((t) => t.symbol);
    // ETH is here without any probe answer ON PURPOSE: the native-mode entry
    // opens the ROW, and services/yield-vault-probe.ts NATIVE_MODE() gates the
    // ROUTE at deposit time. The two layers are deliberate - see the launch
    // note in config/prod-deployments.ts.
    expect(none).toEqual(['ETH', 'ppUSDC', 'ppUSDT', 'ppETH']);
    const withUsdc = tokens.resolveDepositableTokens(all, 1, (_c, a) => a.toLowerCase() === usdc).map((t) => t.symbol);
    expect(withUsdc).toEqual(['ETH', 'ppUSDC', 'ppUSDT', 'ppETH', 'USDC']);
    // No yield route re-admits a pool that has not opened: naming ETH as an
    // underlying must not put it back in the depositable list.
    const withEth = tokens.resolveDepositableTokens(all, 1, (_c, a) => a.toLowerCase() === tokens.NATIVE_ASSET_ADDRESS).map((t) => t.symbol);
    expect(withEth).toEqual(['ETH', 'ppUSDC', 'ppUSDT', 'ppETH']);
  });
});

describeProd('Entrypoint-only routes never see a withdraw-only asset', () => {
  test('getEntrypointDepositableTokens excludes plain USDC/USDT on prod even when a yield underlying is depositable', async () => {
    const tokens = await import('@/config/tokens');
    expect(tokens.getEntrypointDepositableTokens(1).map((t) => t.symbol)).toEqual(['ETH', 'ppUSDC', 'ppUSDT', 'ppETH']);
    expect(tokens.getEntrypointDepositableTokens(56).map((t) => t.symbol)).toEqual(['BNB', 'ppUSDT', 'FDUSD', 'U']);
  });
});
