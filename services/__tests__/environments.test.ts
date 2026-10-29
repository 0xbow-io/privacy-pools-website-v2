// The two environment records (config/environments.ts). The unit suite runs
// with the STAGING world active (tests/bun-test-preload.ts), so `staging`
// must reproduce exactly what the app was before the switch, and `prod` is
// asserted through its record.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_DEPLOYMENTS,
  ACTIVE_DEPLOYMENTS_BY_CHAIN,
  ACTIVE_ENVIRONMENT,
  ENVIRONMENTS,
  NATIVE_ASSET_ADDRESS,
} from '@/config/environments';
import { STAGING_CHAINS, STAGING_ENABLED } from '@/config/staging-deployments';
import { PROD_CHAINS, PROD_RELAYER_URL } from '@/config/prod-deployments';
import { VIEM_CHAIN_BY_ID } from '@/config/wagmi-chain-map';
import { resolveEntrypointChainConfig } from '@/services/entrypoint-resolution';
import { supportsColdStartClaim } from '@/config/cold-start';

// What the prod ASP feed advertised on 2026-09-02 (one address set, three chains).
const PROD_ENTRYPOINT = '0xca1e072236d231130059eea6bfceb7f4e9a1f0c3';
const PROD_POOL = '0x0eb42804bf897662af851370eaeadcdbec1b97ed';
const PROD_FEED = {
  1: 25884228,
  4114: 12093842,
  56: 119401440,
} as const;

const prod = ENVIRONMENTS.prod;
const staging = ENVIRONMENTS.staging;

describe('the active world follows EXPO_PUBLIC_APP_ENV (staging by default, tests/bun-test-preload.ts)', () => {
  test('ACTIVE_* views are the active record', () => {
    const expected = process.env.EXPO_PUBLIC_APP_ENV === 'prod' ? prod : staging;
    expect(ACTIVE_ENVIRONMENT).toBe(expected);
    expect(ACTIVE_DEPLOYMENTS).toBe(expected.deployments);
    expect(ACTIVE_DEPLOYMENTS_BY_CHAIN).toBe(expected.deploymentsByChain);
  });
});

describe('staging reproduces today\'s app exactly', () => {
  test('same deployments, same order, as STAGING_CHAINS', () => {
    expect(STAGING_ENABLED).toBe(true);
    expect(staging.deployments).toEqual(STAGING_CHAINS);
    expect(staging.deployments.map((d) => d.chainId)).toEqual(STAGING_CHAINS.map((d) => d.chainId));
    expect(staging.deployments[0]?.chainId).toBe(1);
  });

  test('dev ASP, Sepolia and Sui served', () => {
    expect(staging.aspUrl).toBe((process.env.EXPO_PUBLIC_ASP_URL ?? 'https://api-dev.0xbow.io').replace(/\/+$/, ''));
    expect(staging.includesBaseChain).toBe(true);
    expect(staging.includesSui).toBe(true);
    expect(staging.fallbackTokenChainId).toBe(11155111);
  });

  test('token catalog: every staging chain, Sepolia included', () => {
    expect(Object.keys(staging.tokensByChain).map(Number).sort((a, b) => a - b)).toEqual([1, 10, 56, 4114, 8453, 11155111]);
    const sepolia = staging.tokensByChain[11155111];
    expect(Object.values(sepolia).map((t) => t.symbol)).toEqual(['ETH', 'USDC', 'USDT']);
    expect(staging.tokensByChain[56]['0x55d398326f99059ff775485246999027b3197955']?.decimals).toBe(18);
    expect(staging.tokensByChain[4114][NATIVE_ASSET_ADDRESS]?.symbol).toBe('cBTC');
    // Base: native USDC (not bridged USDbC) and Base USDT, both 6 decimals on-chain.
    const baseTokens = staging.tokensByChain[8453];
    expect(Object.values(baseTokens).map((t) => t.symbol)).toEqual(['ETH', 'USDC', 'USDT']);
    expect(baseTokens['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']?.decimals).toBe(6);
    expect(baseTokens['0xfde4c96c8593536e31f229ea8f37b2ada2699bb2']?.decimals).toBe(6);
  });

  test('swap outputs on Sepolia, OP, BSC, Base and mainnet; LiFi on 1, 10, 8453 and 56', () => {
    expect(Object.keys(staging.swapOutputTokens).map(Number).sort((a, b) => a - b)).toEqual([1, 10, 56, 8453, 11155111]);
    // 56 was missing, so BNB Chain was never a "Receive as" destination (DEV-495).
    expect([...staging.lifiServedChainIds]).toEqual([1, 10, 8453, 56]);
  });

  test('the staging RelaySwaps pins are the processors the staging relayer publishes', () => {
    // What the staging relayer publishes (/v1/details/evm/{1,10}); the app binds
    // proofs to these, and a mismatch pauses every staging swap.
    expect(staging.deploymentsByChain[1]?.relaySwaps?.toLowerCase()).toBe('0x1ab4008b96b1791ec693304ab8855b86fe093724');
    expect(staging.deploymentsByChain[10]?.relaySwaps?.toLowerCase()).toBe('0x581bc5d58597c0602f05c4f58e88418d27920980');
    expect(staging.deploymentsByChain[8453]?.relaySwaps?.toLowerCase()).toBe('0x1069f1b3a5bad78a38af64a9018a4724bd8a738c');
    expect(staging.deploymentsByChain[4114]?.relaySwaps).toBeUndefined();
    expect(staging.deploymentsByChain[56]?.relaySwaps?.toLowerCase()).toBe('0xbe16948700c538d71599db99df604a2ea9a7e61a');
  });
});

describe('prod', () => {
  test('launch deposit cap: $100 on prod, none on staging (EXPO_PUBLIC_MAX_DEPOSIT_USD unset here)', () => {
    expect(process.env.EXPO_PUBLIC_MAX_DEPOSIT_USD).toBeUndefined();
    expect(prod.maxDepositUsd).toBe(100);
    expect(staging.maxDepositUsd).toBeUndefined();
  });

  test('is the prod ASP + prod relayer, no Sepolia, no Sui', () => {
    expect(prod.aspUrl).toBe('https://api-v2.0xbow.io');
    expect(prod.aspUrl.startsWith('https://')).toBe(true);
    expect(prod.includesBaseChain).toBe(false);
    expect(prod.includesSui).toBe(false);
    expect(prod.deploymentsByChain[11155111]).toBeUndefined();
    expect(prod.tokensByChain[11155111]).toBeUndefined();
    expect(prod.swapOutputTokens[11155111]).toBeUndefined();
    // OP is a prod chain since 2026-10-14, with the PROD pool, never staging's.
    expect(prod.deploymentsByChain[10]?.pool.toLowerCase()).toBe(PROD_POOL);
  });

  test('serves the feed chains plus the 2026-10-14 chains, Ethereum first', () => {
    expect(prod.deployments).toEqual(PROD_CHAINS);
    expect(prod.deployments.map((d) => d.chainId)).toEqual([1, 4114, 56, 10, 8453, 42161, 4663]);
    for (const d of prod.deployments) {
      expect(d.entrypoint.toLowerCase()).toBe(PROD_ENTRYPOINT);
      expect(d.pool.toLowerCase()).toBe(PROD_POOL);
      // The new chains are not in the ASP feed yet; their fromBlock is the
      // keystore's binary-searched deploy block (config/prod-deployments.ts).
      if (d.chainId in PROD_FEED) expect(Number(d.fromBlock)).toBe(PROD_FEED[d.chainId as keyof typeof PROD_FEED]);
      expect(d.keystoreFromBlock <= d.fromBlock).toBe(true);
      expect(d.relayerBaseUrl).toBe(PROD_RELAYER_URL);
      expect(d.relayerSigner).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(d.relayerSigner?.toLowerCase()).not.toBe(d.relay.toLowerCase());
      expect(VIEM_CHAIN_BY_ID[d.chainId]).toBeDefined();
    }
  });

  test('RelaySwaps only where one is deployed (1 and 56), never Citrea', () => {
    expect(prod.deploymentsByChain[1]?.relaySwaps).toBeDefined();
    expect(prod.deploymentsByChain[56]?.relaySwaps).toBeDefined();
    expect(prod.deploymentsByChain[4114]?.relaySwaps).toBeUndefined();
    expect(Object.keys(prod.swapOutputTokens).map(Number).sort((a, b) => a - b)).toEqual([1, 10, 56, 8453, 42161]);
    for (const id of [10, 8453, 42161]) expect(prod.deploymentsByChain[id]?.relaySwaps).toBe(prod.deploymentsByChain[1]?.relaySwaps);
    expect(prod.deploymentsByChain[4663]?.relaySwaps).toBeUndefined();
    expect([...prod.lifiServedChainIds]).toEqual([1, 56, 10, 8453, 42161, 4663]);
  });

  test('token catalog matches the entrypoint\'s enabled assets, decimals off the contracts', () => {
    expect(Object.keys(prod.tokensByChain).map(Number).sort((a, b) => a - b)).toEqual([1, 10, 56, 4114, 4663, 8453, 42161]);
    // The depositable stables are the Aave yield wrappers; plain USDC/USDT are
    // disabled on the prod entrypoint (read on-chain 2026-09-04) but stay in the
    // registry as withdraw-only so notes already in those pools remain usable.
    expect(Object.values(prod.tokensByChain[1]).map((t) => t.symbol)).toEqual(['ETH', 'ppUSDC', 'ppUSDT', 'ppETH', 'USDC', 'USDT']);
    expect(prod.tokensByChain[1]['0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6']?.decimals).toBe(18);
    expect(prod.tokensByChain[1]['0xa4cf419558ef36cc6ffb666195684dc963910426']?.decimals).toBe(18);
    expect(prod.tokensByChain[1]['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']).toMatchObject({ symbol: 'USDC', decimals: 6, withdrawOnly: true });
    expect(prod.tokensByChain[1]['0xdac17f958d2ee523a2206206994597c13d831ec7']).toMatchObject({ symbol: 'USDT', decimals: 6, withdrawOnly: true });
    expect(Object.values(prod.tokensByChain[4114]).map((t) => t.symbol)).toEqual(['cBTC']);
    const bsc = prod.tokensByChain[56];
    expect(Object.values(bsc).map((t) => t.symbol)).toEqual(['BNB', 'ppUSDT', 'FDUSD', 'U', 'USDT']);
    expect(bsc['0x6c17be9c864254ca4b2d36223f31ade94b4d64c2']?.decimals).toBe(18);
    expect(bsc['0x55d398326f99059ff775485246999027b3197955']).toMatchObject({ symbol: 'USDT', decimals: 18, withdrawOnly: true });
    expect(bsc['0xc5f0f7b66764f6ec8c8dff7ba683102295e16409']?.decimals).toBe(18);
    // Every registry key is the lowercase of its address.
    for (const chainTokens of Object.values(prod.tokensByChain)) {
      for (const [key, token] of Object.entries(chainTokens)) {
        expect(key).toBe(token.address.toLowerCase());
      }
    }
  });

  test('the swap output list and the token catalog agree on symbol + decimals per address', () => {
    for (const [chainId, outputs] of Object.entries(prod.swapOutputTokens)) {
      for (const out of outputs) {
        const token = prod.tokensByChain[Number(chainId)][out.address.toLowerCase()];
        expect(token).toBeDefined();
        expect(token.symbol).toBe(out.symbol);
        expect(token.decimals).toBe(out.decimals);
      }
    }
  });

  test('entrypoint resolution pins the prod entrypoint and ignores the feed', () => {
    const poisoned = {
      pools: [{ poolId: '1', chainId: '1', entrypoint: PROD_POOL, poolVault: '0x' + '9'.repeat(40), fromBlock: 0 }],
      cacheTimestamp: '',
    };
    const resolved = resolveEntrypointChainConfig(poisoned, 1, undefined, prod.deploymentsByChain);
    expect(resolved?.entrypoint.toLowerCase()).toBe(PROD_ENTRYPOINT);
    expect(resolved?.poolVault?.toLowerCase()).toBe(PROD_POOL);
    expect(resolved?.fromBlock).toBe(PROD_FEED[1]);
  });

  test('the prod relay is on the cold-start allow-list for the three relayer-served chains only', () => {
    for (const d of prod.deployments) {
      // The 2026-10-14 chains join once the prod relayer serves register-and-relay there.
      expect(supportsColdStartClaim(d.chainId, d.relay)).toBe([1, 4114, 56].includes(d.chainId));
    }
    // And a staging relay still passes on its own chain: the list is per relay.
    expect(supportsColdStartClaim(1, staging.deploymentsByChain[1]!.relay)).toBe(true);
  });
});

describe('the two worlds are disjoint objects', () => {
  test('no deployment, token table or swap list is shared by reference', () => {
    for (const chainId of [1, 4114, 56]) {
      const p = prod.deploymentsByChain[chainId];
      const s = staging.deploymentsByChain[chainId];
      expect(p).toBeDefined();
      expect(s).toBeDefined();
      expect(p).not.toBe(s);
      // Same chain id, DIFFERENT pool: this is why chain-keyed state must be scoped.
      expect(p!.pool.toLowerCase()).not.toBe(s!.pool.toLowerCase());
      expect(p!.relay.toLowerCase()).not.toBe(s!.relay.toLowerCase());
    }
    expect(prod.tokensByChain).not.toBe(staging.tokensByChain);
    for (const chainId of [1, 4114, 56]) {
      expect(prod.tokensByChain[chainId]).not.toBe(staging.tokensByChain[chainId]);
      for (const key of Object.keys(prod.tokensByChain[chainId])) {
        const s = staging.tokensByChain[chainId][key];
        if (s) expect(prod.tokensByChain[chainId][key]).not.toBe(s);
      }
    }
    expect(prod.swapOutputTokens[1]).not.toBe(staging.swapOutputTokens[1]);
    expect(prod.deployments).not.toBe(staging.deployments);
  });

  test('identical entries are duplicated, not shared: mainnet native ETH exists in both', () => {
    const eth = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    // Same token, two worlds, never the same object - that is the property.
    expect(prod.tokensByChain[1][eth]).not.toBe(staging.tokensByChain[1][eth]);
    for (const world of [prod, staging]) {
      expect(world.tokensByChain[1][eth]).toMatchObject({ symbol: 'ETH', decimals: 18, isNative: true });
    }
    // They stopped being EQUAL on 2026-09-15 and that difference is the launch:
    // prod's mainnet ETH row opened when the native-mode ppETH entry landed,
    // staging's has no such entry and still says "coming soon".
    expect(prod.tokensByChain[1][eth].depositComingSoon).toBeUndefined();
    expect(staging.tokensByChain[1][eth].depositComingSoon).toBe(true);
  });
});

describe('runtime code reads the ACTIVE pins, never the staging map directly', () => {
  // Source-text guard (the pattern of services/__tests__/no-targeted-reads.test.ts):
  // a processor binding or entrypoint pin that reads STAGING_BY_CHAIN in a prod
  // session would bind a proof to the staging relay. Only the two modules that
  // define/consume it for the record itself may name it.
  const allowed = new Set([
    'config/staging-deployments.ts',
    'config/environments.ts',
  ]);
  // `import.meta.dir` is a Bun extension the app's tsconfig doesn't model; the
  // URL form is portable (same as services/__tests__/no-targeted-reads.test.ts).
  const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__' && entry !== 'node_modules') yield* walk(full);
      } else if (/\.tsx?$/.test(entry)) {
        yield full;
      }
    }
  }
  test('no runtime module imports STAGING_BY_CHAIN', () => {
    const offenders: string[] = [];
    for (const dir of ['config', 'services', 'components', 'hooks', 'app']) {
      for (const file of walk(join(ROOT, dir))) {
        const path = file.slice(ROOT.length + 1);
        if (allowed.has(path)) continue;
        const text = readFileSync(file, 'utf8');
        if (/import[^;]*\bSTAGING_BY_CHAIN\b[^;]*from/.test(text)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the PROD runtime graph, executed with prod active', () => {
  // Module-level constants are frozen at first import, so prod cannot be
  // exercised in this process once staging is active. Spawn a child `bun test`
  // with prod as the build default AND the staging overrides set, and let
  // services/__tests__/prod-runtime.test.ts assert chains, processors, ASP,
  // tokens and swaps. Its describe is skipped unless EXPO_PUBLIC_APP_ENV=prod.
  test('services/__tests__/prod-runtime.test.ts passes under EXPO_PUBLIC_APP_ENV=prod', () => {
    const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
    const run = spawnSync(process.execPath, ['test', 'services/__tests__/prod-runtime.test.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPO_PUBLIC_APP_ENV: 'prod',
        // Staging-world overrides that must NOT reach prod.
        EXPO_PUBLIC_MAINNET_SWAP_PROCESSOR_ADDRESS: '0x5f3927f24ec20f49b3850a5b78eb2015945e57f7',
        EXPO_PUBLIC_ASP_PUBLIC_KEY: `0x${'11'.repeat(32)}`,
        // Pinned, not inherited: bun runs the whole suite in ONE process, and
        // config/__tests__/cross-chain-swap-deposit.test.ts lifts the lockdown
        // for its routing matrix. Without this the child inherited that write
        // and prod looked unlocked - the same test-order trap that once made
        // the golden CSV depend on which file ran first.
        EXPO_PUBLIC_INTENT_LOCKDOWN: 'true',
        // This catalog fixture exercises yield-disabled prod, regardless of local .env flags.
        EXPO_PUBLIC_YIELD_ENABLED: 'false',
        EXPO_PUBLIC_YIELD_WITHDRAW_READY: 'false',
      },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    if (run.status !== 0) throw new Error(`Prod runtime checks failed:\n${out}`);
  }, 60_000);
});

describe('the SHIELD PAY ROUTING, executed with prod active', () => {
  // shield-pay-routing.test.ts guards the rule that decides whether paying an
  // asset into a pool is that pool's ordinary deposit or a conversion. Its body
  // is gated on prod (the pairs do not exist under staging) and, until
  // 2026-09-12, NOTHING spawned it under prod - so every assertion in it was
  // skipped in CI while the rule regressed underneath. Spawn it, and assert the
  // real count: a file that silently takes its skip branch must fail here.
  test('services/__tests__/shield-pay-routing.test.ts passes under EXPO_PUBLIC_APP_ENV=prod', () => {
    const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
    const run = spawnSync(process.execPath, ['test', 'services/__tests__/shield-pay-routing.test.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPO_PUBLIC_APP_ENV: 'prod',
        EXPO_PUBLIC_YIELD_ENABLED: 'true',
        EXPO_PUBLIC_YIELD_WITHDRAW_READY: 'true',
        EXPO_PUBLIC_INTENT_LOCKDOWN: 'true',
      },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    // The skip branch is ONE test. Anything near that means the prod body did
    // not run, which is the failure this spawn exists to make loud. 15 since
    // the native-mode (ppETH) wrap cases, 2026-09-18.
    expect(out).toMatch(/ 15 pass/);
    expect(out).toMatch(/ 0 fail/);
    expect(run.status).toBe(0);
  }, 60_000);
});

describe('the POOL ENTRY POINTS, executed with prod active', () => {
  // pool-entry-points-prod.test.ts walks every prod pool from the hub's
  // destination, the pool route and My balances into the deposit / withdraw
  // modals' acceptance rules. Two launch-day regressions (the hub ETH shield
  // refused, the ETH pool page withdraw showing no funds) passed a suite that
  // covered each door alone (codex on dd034a1, 2026-09-18).
  test('services/__tests__/pool-entry-points-prod.test.ts passes under EXPO_PUBLIC_APP_ENV=prod', () => {
    const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
    const run = spawnSync(process.execPath, ['test', 'services/__tests__/pool-entry-points-prod.test.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPO_PUBLIC_APP_ENV: 'prod',
        EXPO_PUBLIC_YIELD_ENABLED: 'true',
        EXPO_PUBLIC_YIELD_WITHDRAW_READY: 'true',
        EXPO_PUBLIC_INTENT_LOCKDOWN: 'true',
      },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    // The skip branch is ONE test; the prod body is four.
    expect(out).toMatch(/ 4 pass/);
    expect(out).toMatch(/ 0 fail/);
    expect(run.status).toBe(0);
  }, 60_000);
});

describe('the vault deposit kill switch, executed with it ON under prod', () => {
  // The registry and the resolvers freeze at first import, so the paused world
  // needs its own process. 5 = the prod body; the skip branch is one test.
  test('services/__tests__/yield-deposits-paused-prod.test.ts passes with EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED=true', () => {
    const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
    const run = spawnSync(process.execPath, ['test', 'services/__tests__/yield-deposits-paused-prod.test.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPO_PUBLIC_APP_ENV: 'prod',
        EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED: 'true',
        EXPO_PUBLIC_YIELD_ENABLED: 'true',
        EXPO_PUBLIC_YIELD_WITHDRAW_READY: 'true',
      },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(out).toMatch(/ 5 pass/);
    expect(out).toMatch(/ 0 fail/);
    expect(run.status).toBe(0);
  }, 60_000);
});

describe('the mainnet ETH deposit flag, executed with it ON', () => {
  // Same reason as the prod graph above: the registry freezes at first import,
  // so the "flag lifts the hold" direction needs its own process.
  test('services/__tests__/mainnet-eth-deposits-open.test.ts passes with EXPO_PUBLIC_MAINNET_ETH_DEPOSITS=true', () => {
    const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
    const run = spawnSync(process.execPath, ['test', 'services/__tests__/mainnet-eth-deposits-open.test.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, EXPO_PUBLIC_MAINNET_ETH_DEPOSITS: 'true' },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(out).toMatch(/ 1 pass/);
    expect(out).toMatch(/ 0 fail/);
    expect(run.status).toBe(0);
  }, 60_000);
});

describe('yield-bearing share tokens', () => {
  test('prod flags exactly ppUSDC/ppUSDT (1) and ppUSDT (56) as Aave-v3 shares, 18 decimals; staging flags none', () => {
    const shares = (env: 'prod' | 'staging') =>
      Object.entries(ENVIRONMENTS[env].tokensByChain).flatMap(([chainId, tokens]) =>
        Object.values(tokens).filter((t) => t.yieldShare).map((t) => `${chainId}:${t.symbol}:${t.decimals}:${t.yieldShare}`));
    expect(shares('prod').sort()).toEqual(['10:ppETH:18:aave-v3', '10:ppUSDC:18:aave-v3', '10:ppUSDT:18:aave-v3', '1:ppETH:18:aave-v3', '1:ppUSDC:18:aave-v3', '1:ppUSDT:18:aave-v3', '42161:ppETH:18:aave-v3', '42161:ppUSDC:18:aave-v3', '42161:ppUSDT:18:aave-v3', '56:ppUSDT:18:aave-v3', '8453:ppETH:18:aave-v3', '8453:ppUSDC:18:aave-v3']);
    expect(shares('staging')).toEqual([]);
  });
});

describe('pools that have not opened for deposits yet', () => {
  test('mainnet (chain 1) ETH is depositComingSoon in BOTH worlds - the same real Ethereum - and nothing else is', () => {
    const comingSoon = (env: 'prod' | 'staging') =>
      Object.entries(ENVIRONMENTS[env].tokensByChain).flatMap(([chainId, tokens]) =>
        Object.values(tokens).filter((t) => t.depositComingSoon).map((t) => `${chainId}:${t.symbol}`));
    // 2026-09-15: prod's mainnet ETH OPENED when the native-mode ppETH entry
    // landed - that entry is the thing that opens it (config/environments.ts
    // mainnetEth). Staging has no ppETH, so it still waits.
    expect(comingSoon('prod')).toEqual([]);
    expect(comingSoon('staging')).toEqual(['1:ETH']);
    // Chain 1 ONLY: the other native assets (Citrea cBTC, BSC BNB, Sepolia and
    // OP ETH) are open, and Sepolia ETH in particular must stay depositable or
    // the staging build has no test asset at all.
    for (const env of ['prod', 'staging'] as const) {
      for (const [chainId, tokens] of Object.entries(ENVIRONMENTS[env].tokensByChain)) {
        if (chainId === '1') continue;
        for (const t of Object.values(tokens)) expect(t.depositComingSoon).toBeUndefined();
      }
    }
    // "Not open yet" and "closed for good" are opposite states, never both.
    for (const env of ['prod', 'staging'] as const) {
      for (const tokens of Object.values(ENVIRONMENTS[env].tokensByChain)) {
        for (const t of Object.values(tokens)) expect(!!t.depositComingSoon && !!t.withdrawOnly).toBe(false);
      }
    }
  });

  test('the asset itself is untouched - a coming-soon pool is still known, priced and spendable', () => {
    // Staging still waits on its ETH pool, and this is the property that
    // mattered: closing DEPOSITS never made the asset unknown, unpriced or
    // unspendable. Prod's row opened on 2026-09-15 with ppETH, so the
    // coming-soon half of the pair now lives on staging.
    const eth = ENVIRONMENTS.staging.tokensByChain[1]['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
    expect(eth).toMatchObject({ symbol: 'ETH', decimals: 18, isNative: true, depositComingSoon: true });
    const open = ENVIRONMENTS.prod.tokensByChain[1]['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
    expect(open).toMatchObject({ symbol: 'ETH', decimals: 18, isNative: true });
    expect(open.depositComingSoon).toBeUndefined();
  });
});

describe('withdraw-only legacy assets (deposits closed, notes still spendable)', () => {
  test('prod keeps plain USDC/USDT (1) and USDT (56) as withdrawOnly with their real decimals; nothing else is flagged', () => {
    const legacy = (env: 'prod' | 'staging') =>
      Object.entries(ENVIRONMENTS[env].tokensByChain).flatMap(([chainId, tokens]) =>
        Object.values(tokens).filter((t) => t.withdrawOnly).map((t) => `${chainId}:${t.symbol}:${t.decimals}`));
    expect(legacy('prod').sort()).toEqual(['10:USDC:6', '10:USDT:6', '1:USDC:6', '1:USDT:6', '42161:USDC:6', '42161:USDT:6', '56:USDT:18', '8453:USDC:6']);
    expect(legacy('staging')).toEqual([]);
    // A legacy asset is never also a yield share.
    for (const tokens of Object.values(ENVIRONMENTS.prod.tokensByChain)) {
      for (const t of Object.values(tokens)) expect(!!t.withdrawOnly && !!t.yieldShare).toBe(false);
    }
  });
});


describe('intent landing matrix with the prod registry', () => {
  test('prod intent capabilities and builder refusals pass before any probe', () => {
    const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
    const run = spawnSync(process.execPath, ['test', 'services/__tests__/intent-targets-prod.test.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      // Explicitly UNLOCKED, so this matrix does not silently depend on the
      // default: it checks what is offered once the surface is on. The default
      // itself is asserted in services/__tests__/intent-lockdown-rule.test.ts.
      env: { ...process.env, EXPO_PUBLIC_APP_ENV: 'prod', EXPO_PUBLIC_INTENT_LOCKDOWN: 'false',
        EXPO_PUBLIC_INTENT_SWAPS: 'true', EXPO_PUBLIC_RESHIELD_CROSSCHAIN: 'true',
        EXPO_PUBLIC_YIELD_ENABLED: 'true', EXPO_PUBLIC_YIELD_WITHDRAW_READY: 'true',
        EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON: '', EXPO_PUBLIC_DISABLED_CHAIN_IDS: '' },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    if (run.status !== 0) throw new Error(`Prod intent checks failed:\n${out}`);
    // 9 since 2026-09-22: the bridged-shield-into-a-vault case got its own test.
    // 10 since 2026-10-09: the cross-chain private swap-send got its own test.
    // 11 since 2026-10-14: destinationCallsSupported gates bridged deposits.
    expect(out).toMatch(/ 11 pass/);
    expect(out).toMatch(/ 0 fail/);
    expect(run.status).toBe(0);
  }, 60_000);

  test('the Swap tab recipient route passes with the prod registry (DEV-510)', () => {
    const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
    const run = spawnSync(process.execPath, ['test', 'services/__tests__/swap-tab-recipient-prod.test.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, EXPO_PUBLIC_APP_ENV: 'prod', EXPO_PUBLIC_INTENT_LOCKDOWN: 'false',
        EXPO_PUBLIC_INTENT_SWAPS: 'true', EXPO_PUBLIC_RESHIELD_CROSSCHAIN: 'true',
        EXPO_PUBLIC_YIELD_ENABLED: 'true', EXPO_PUBLIC_YIELD_WITHDRAW_READY: 'true',
        EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON: '', EXPO_PUBLIC_DISABLED_CHAIN_IDS: '' },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    if (run.status !== 0) throw new Error(`Swap tab recipient checks failed:\n${out}`);
    expect(out).toMatch(/ 4 pass/);
    expect(out).toMatch(/ 0 fail/);
  }, 60_000);

});

import { readFileSync as readSrcForBridges } from 'node:fs';
import { fileURLToPath as toPathForBridges } from 'node:url';

describe('the bridge allowlist is e2e-only', () => {
  test('real builds leave the bridge to LiFi; only the cross-chain e2e sets Across', () => {
    const src = readSrcForBridges(toPathForBridges(new URL('../pool-session-service.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain("= ['across']");
    expect(src).toContain('process.env.EXPO_PUBLIC_LIFI_ALLOW_BRIDGES');
    expect(src).toContain('...(LIFI_CROSS_CHAIN_BRIDGES?.length ? { allowBridges: LIFI_CROSS_CHAIN_BRIDGES } : {}),');
    const wf = readSrcForBridges(toPathForBridges(new URL('../../.github/workflows/e2e-crosschain.yml', import.meta.url)), 'utf8');
    expect(wf).toContain('EXPO_PUBLIC_LIFI_ALLOW_BRIDGES=across');
  });
});
