// Regression assertions from the codex review of 1454f30 (findings 2-4):
// each pins one of the review-fix behaviours that the earlier tests covered
// only indirectly, so reverting any single fix now fails a named test.

import { describe, expect, test, mock } from 'bun:test';
import { STAGING_CHAINS } from '../../config/staging-deployments';
import { buildStagingPoolMenuOptions } from '../staging-pool-menu';

const OP_ENTRYPOINT = '0x4A20b3ae656339b9707C61992dCdA642366D3004';
const OP_POOL = '0x02a1E00294291d0E938eC92A8c2883044524ec4B';

describe('OP staging entry facts (finding 4)', () => {
  const op = STAGING_CHAINS.find((d) => d.chainId === 10);

  test('OP is present with the verified deployment facts', () => {
    // Skipped-by-flag builds drop OP from STAGING_CHAINS; the wagmi-map test
    // carries the env-independent pin. Here we assert the entry's FACTS when
    // it exists (the default test env has no hide flag set).
    expect(op).toBeDefined();
    expect(op?.entrypoint).toBe(OP_ENTRYPOINT);
    expect(op?.pool).toBe(OP_POOL);
    expect(op?.fromBlock).toBe(155397570n);
    // The eth_getLogs window is a property of WHO SERVES the endpoint, not of
    // the deployment, so it is asserted against the resolved RPC rather than
    // pinned to one number:
    //   - mainnet.optimism.io rejects the 10k default (probed 2026-08-14: 3000
    //     passes, 4000 fails), and losing that ceiling breaks the state-leaf
    //     scan every withdrawal runs;
    //   - Alchemy has no such limit (probed 2026-08-20 against opt-mainnet:
    //     3000 / 10k / 100k / 500k all return), and staying at 3000 there cost
    //     ~140 requests per scan across this pool's ~420k blocks, which the
    //     public endpoint answered with 429s.
    const opOnAlchemy = /\.g\.alchemy\.com\//.test(op?.rpcUrl ?? '');
    expect(op?.logsMaxBlockRange).toBe(opOnAlchemy ? 50_000n : 3000n);
    // Whichever endpoint is in play, the window must never be absent or above
    // what was measured to work there.
    expect(op?.logsMaxBlockRange).toBeGreaterThan(0n);
    expect(op?.logsMaxBlockRange).toBeLessThanOrEqual(opOnAlchemy ? 500_000n : 3000n);
  });

  test('Ethereum stays first — STAGING_CHAINS[0] is the staging default chain', () => {
    expect(STAGING_CHAINS[0]?.chainId).toBe(1);
  });
});

describe('staging pool-menu options (finding 3)', () => {
  test('a staging chain yields exactly ONE always-default option from the pin', () => {
    const op = STAGING_CHAINS.find((d) => d.chainId === 10)!;
    const options = buildStagingPoolMenuOptions(op);
    expect(options).toHaveLength(1);
    // isDefault:true is the safety property: the header's pick handler maps
    // default → applyPoolSelection(null), so picking can only CLEAR a stored
    // selection — the misregistered chain-10 feed row can never be persisted
    // into the Sepolia pool config through this menu.
    expect(options[0].isDefault).toBe(true);
    expect(options[0].isActive).toBe(true);
    expect(options[0].poolVault).toBe(OP_POOL.toLowerCase());
    expect(options[0].entrypoint).toBe(OP_ENTRYPOINT);
    expect(options[0].fromBlock).toBe(155397570);
  });
});

describe('resolveConfiguredEntrypoint delegates to the PINNED resolver (finding 2)', () => {
  test('on chain 10 it returns the pinned entrypoint, not the poisoned feed row', async () => {
    // bun's mock.module leaks PROCESS-WIDE into every later test file — a
    // wholesale replacement here gutted @/config/chains for files that ran
    // after this one (shield-pools.test broke with 'No shield pool
    // configured'). Capture the real modules first and re-mock them back in
    // the finally below.
    const realApiClient = { ...(await import('@/services/api-client')) };
    const realChains = { ...(await import('@/config/chains')) };
    const realEnv = { ...(await import('@/config/env')) };
    const realStaging = { ...(await import('@/config/staging-deployments')) };
    try {
    // The REAL wrong feed row the ASP served for chain 10.
    mock.module('@/services/api-client', () => ({
      default: {
        getEntrypoints: async () => ({
          pools: [{
            poolId: '8',
            chainId: '10',
            entrypoint: OP_POOL.toLowerCase(), // poisoned: the pool vault
            poolVault: '0x8884dc0c0decd2558f128ee00dd522abfa21dd52',
            fromBlock: 155397570,
          }],
          cacheTimestamp: '',
        }),
      },
    }));
    mock.module('@/config/chains', () => ({
      getChainConfig: (chainId: number) =>
        chainId === 10 ? { contracts: { poolAddress: OP_POOL } } : undefined,
    }));
    mock.module('@/config/env', () => ({ LEGACY_CONFIG: null }));
    // Force the pin map on: the shared resolver defaults its stagingByChain
    // param to STAGING_BY_CHAIN, which is {} unless EXPO_PUBLIC_STAGING is
    // set in the test env — mock it to the always-defined STAGING_CHAINS.
    mock.module('@/config/staging-deployments', () => ({
      STAGING_BY_CHAIN: Object.fromEntries(STAGING_CHAINS.map((d) => [d.chainId, d])),
      STAGING_CHAINS,
      STAGING_ENABLED: true,
    }));

    const { resolveConfiguredEntrypoint } = await import('@/services/pool-entrypoint');
    // Old behaviour (direct feed matching): vault never matches the wrong row
    // → first-row fallback → returns the POOL VAULT as the entrypoint. The
    // delegation must return the pin instead.
    expect(await resolveConfiguredEntrypoint(10)).toBe(OP_ENTRYPOINT);
    } finally {
      // Hand later test files the REAL modules back (see the leak note above).
      mock.module('@/services/api-client', () => realApiClient);
      mock.module('@/config/chains', () => realChains);
      mock.module('@/config/env', () => realEnv);
      mock.module('@/config/staging-deployments', () => realStaging);
    }
  });
});
