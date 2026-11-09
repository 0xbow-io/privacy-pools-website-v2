/**
 * The vault deposit kill switch scoped to ONE chain, EXECUTED: prod registry,
 * yield flags on, every vault verified, and EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED=1.
 * Aave froze its Ethereum reserves only (Pat, 2026-10-29), so Ethereum's vaults
 * refuse new deposits while BNB Chain's keep taking them, and every exit
 * resolves as before. Own process for the same reason as
 * yield-deposits-paused-prod.test.ts; environments.test.ts spawns it and pins
 * the pass count.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';
process.env.EXPO_PUBLIC_YIELD_ENABLED = 'true';
process.env.EXPO_PUBLIC_YIELD_WITHDRAW_READY = 'true';

const ACTIVE = process.env.EXPO_PUBLIC_APP_ENV === 'prod' && process.env.EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED === '1';
const describePaused = ACTIVE ? describe : (_name: string, _fn: () => void) => {
  test('runs under EXPO_PUBLIC_APP_ENV=prod with EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED=1 (skipped here)', () => {
    expect(ACTIVE).toBe(false);
  });
};

const yieldConfig = await import('@/config/yield');
const pauseConfig = await import('@/config/yield-deposits-paused');
const { recordYieldVaultProbe } = await import('@/services/yield-vault-probe');
const { getActionableTokens, getKnownTokenMetadata } = await import('@/config/tokens');
const { ENVIRONMENTS } = await import('@/config/environments');
const { PROD_YIELD_DEPLOYMENTS } = await import('@/config/prod-deployments');

const chains = Object.keys(PROD_YIELD_DEPLOYMENTS).map(Number);
for (const chainId of chains) {
  for (const d of PROD_YIELD_DEPLOYMENTS[chainId]) recordYieldVaultProbe(chainId, 'ok', d.ppUSDC);
}

describePaused('vault deposits paused on Ethereum only', () => {
  test('only chain 1 is paused, and the default banner is up', () => {
    expect(pauseConfig.YIELD_DEPOSITS_PAUSE).toEqual({ all: false, chainIds: [1] });
    expect(yieldConfig.yieldDepositsPaused()).toBe(true);
    expect(yieldConfig.yieldDepositsPausedOnChain(1)).toBe(true);
    for (const chainId of chains.filter((id) => id !== 1)) expect(yieldConfig.yieldDepositsPausedOnChain(chainId)).toBe(false);
    expect(pauseConfig.YIELD_PAUSE_BANNER_TEXT).toBe(pauseConfig.DEFAULT_YIELD_PAUSE_BANNER_TEXT);
  });

  test('the deposit money gates refuse Ethereum and still route every other vault', () => {
    expect(chains).toContain(56);
    for (const chainId of chains) {
      for (const d of PROD_YIELD_DEPLOYMENTS[chainId]) {
        const got = d.nativeMode
          ? yieldConfig.getNativeYieldDepositDeployment(chainId)
          : yieldConfig.getYieldDepositDeploymentForUnderlying(chainId, d.underlying);
        if (chainId === 1) expect(got).toBeUndefined();
        else expect(got).toEqual(d);
      }
    }
  });

  test('the registry marks Ethereum vault entries only', () => {
    for (const chainId of Object.keys(ENVIRONMENTS.prod.tokensByChain).map(Number)) {
      const marked = getActionableTokens(chainId).filter((t) => t.depositPaused);
      if (chainId === 1) expect(marked.length).toBeGreaterThan(0);
      else expect(marked).toEqual([]);
    }
    for (const d of PROD_YIELD_DEPLOYMENTS[56]) {
      expect(getKnownTokenMetadata(d.ppUSDC, 56)?.depositPaused).toBeUndefined();
      expect(getKnownTokenMetadata(d.underlying, 56)?.depositPaused).toBeUndefined();
    }
  });

  test('withdraw, redemption, unwrap, ragequit and Portfolio resolvers are untouched', () => {
    for (const chainId of chains) {
      const list = PROD_YIELD_DEPLOYMENTS[chainId];
      expect(yieldConfig.getPinnedYieldDeployments(chainId)).toEqual(list);
      expect(yieldConfig.getConfiguredYieldDeployments(chainId)).toEqual(list);
      expect(yieldConfig.getYieldDeploymentsForChain(chainId)).toEqual(list);
      for (const d of list) {
        expect(yieldConfig.getYieldDeploymentForAsset(chainId, d.ppUSDC)).toEqual(d);
        expect(yieldConfig.getConfiguredYieldDeploymentForAsset(chainId, d.ppUSDC)).toEqual(d);
      }
    }
  });
});
