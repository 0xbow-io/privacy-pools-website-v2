/**
 * The vault deposit kill switch, EXECUTED: prod registry, yield flags on, every
 * vault verified, and EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED=true. The registry and
 * the resolvers freeze at first import, so this needs its own process:
 * environments.test.ts spawns it with that env and pins the pass count, so a
 * silently skipped body fails loudly there.
 *
 * Pat, 2026-10-29: block new vault deposits, "let people withdraw though".
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';
process.env.EXPO_PUBLIC_YIELD_ENABLED = 'true';
process.env.EXPO_PUBLIC_YIELD_WITHDRAW_READY = 'true';

const ACTIVE = process.env.EXPO_PUBLIC_APP_ENV === 'prod' && process.env.EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED === 'true';
const describePaused = ACTIVE ? describe : (_name: string, _fn: () => void) => {
  test('runs under EXPO_PUBLIC_APP_ENV=prod with EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED=true (skipped here)', () => {
    expect(ACTIVE).toBe(false);
  });
};

const yieldConfig = await import('@/config/yield');
const { recordYieldVaultProbe } = await import('@/services/yield-vault-probe');
const { getActionableTokens, getDepositableTokens, getDepositComingSoonTokens, getEntrypointDepositableTokens, getKnownTokenMetadata } = await import('@/config/tokens');
const { defaultPoolFor, listShieldPools } = await import('@/services/shield-pools');
const { conversionTargetsFor, intentTargetRefusal } = await import('@/config/intent-targets');
const { getSwapDeliveryTokens } = await import('@/config/intent-swaps');
const { ENVIRONMENTS } = await import('@/config/environments');
const { PROD_YIELD_DEPLOYMENTS } = await import('@/config/prod-deployments');

const chains = Object.keys(PROD_YIELD_DEPLOYMENTS).map(Number);
// Every vault verified on chain: the strongest case for the deposit gates to
// still say no, and what lets the share-side money resolvers answer at all.
for (const chainId of chains) {
  for (const d of PROD_YIELD_DEPLOYMENTS[chainId]) recordYieldVaultProbe(chainId, 'ok', d.ppUSDC);
}

describePaused('vault deposits paused on prod', () => {
  test('the switch is on and the deposit money gates refuse every vault', () => {
    expect(yieldConfig.yieldDepositsPaused()).toBe(true);
    for (const chainId of chains) {
      for (const d of PROD_YIELD_DEPLOYMENTS[chainId]) {
        expect(yieldConfig.getYieldDepositDeploymentForUnderlying(chainId, d.underlying)).toBeUndefined();
      }
      expect(yieldConfig.getNativeYieldDepositDeployment(chainId)).toBeUndefined();
    }
  });

  test('withdraw, redemption, unwrap, ragequit and Portfolio resolvers are untouched', () => {
    for (const chainId of chains) {
      const list = PROD_YIELD_DEPLOYMENTS[chainId];
      expect(yieldConfig.getPinnedYieldDeployments(chainId)).toEqual(list);
      expect(yieldConfig.getConfiguredYieldDeployments(chainId)).toEqual(list);
      expect(yieldConfig.getYieldDeploymentsForChain(chainId)).toEqual(list);
      expect(yieldConfig.getYieldDeploymentForChain(chainId)).toEqual(list[0]);
      for (const d of list) {
        expect(yieldConfig.getYieldDeploymentForAsset(chainId, d.ppUSDC)).toEqual(d);
        expect(yieldConfig.getConfiguredYieldDeploymentForAsset(chainId, d.ppUSDC)).toEqual(d);
      }
    }
    expect(yieldConfig.yieldActiveForAnyChain(chains)).toBe(true);
    expect(yieldConfig.yieldConfiguredForAnyChain(chains)).toBe(true);
  });

  test('every asset stays known and spendable; only deposit lists drop the vault entries', () => {
    for (const chainId of Object.keys(ENVIRONMENTS.prod.tokensByChain).map(Number)) {
      expect(getActionableTokens(chainId).length).toBe(Object.keys(ENVIRONMENTS.prod.tokensByChain[chainId]).length);
      for (const t of getDepositableTokens(chainId)) expect(t.depositPaused).toBeUndefined();
      for (const t of getEntrypointDepositableTokens(chainId)) expect(t.depositPaused).toBeUndefined();
      for (const t of getDepositComingSoonTokens(chainId)) {
        expect(t.depositPaused).toBe(true);
        expect(t.yieldShare).toBeUndefined();
      }
    }
    // Mainnet: every pool is a vault, so nothing there takes a deposit.
    expect(getDepositableTokens(1)).toEqual([]);
    expect(getDepositComingSoonTokens(1).map((t) => t.symbol).sort()).toEqual(['ETH', 'USDC', 'USDT']);
  });

  test('the Shield destination keeps the vault pool, paused, never another pool', () => {
    for (const pay of ['USDC', 'USDT', 'ETH']) {
      const pool = defaultPoolFor(pay, 1);
      expect(pool.chainId).toBe(1);
      const meta = getKnownTokenMetadata(pool.address, 1);
      expect(meta?.yieldShare).toBeDefined();
      expect(meta?.depositPaused).toBe(true);
    }
    for (const pool of listShieldPools()) {
      expect(getKnownTokenMetadata(pool.address, pool.chainId)?.depositPaused).toBeUndefined();
    }
  });

  test('no swap or conversion can land in a vault; wallet delivery is unchanged', () => {
    for (const chainId of chains) {
      for (const d of PROD_YIELD_DEPLOYMENTS[chainId]) {
        expect(intentTargetRefusal(d.ppUSDC, chainId)).toBe(yieldConfig.VAULT_DEPOSITS_PAUSED_MESSAGE);
        expect(conversionTargetsFor(chainId).map((a) => a.toLowerCase())).not.toContain(d.ppUSDC.toLowerCase());
        expect(conversionTargetsFor(chainId, true).map((a) => a.toLowerCase())).not.toContain(d.ppUSDC.toLowerCase());
      }
    }
    // Withdraw's "Receive as" list never depended on deposit targets.
    expect(getSwapDeliveryTokens(1).map((t) => t.symbol).sort()).toEqual(['ETH', 'USDC', 'USDT']);
  });
});
