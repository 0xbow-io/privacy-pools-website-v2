/**
 * The vault deposit kill switch (EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED), pure half.
 *
 * Pat, 2026-10-29: pause NEW deposits into every vault, default OFF, and "let
 * people withdraw though". So two directions are pinned here:
 *   - entering a vault: the deposit money resolvers answer undefined and the
 *     registry marks every vault entry (share, underlying, native coin with a
 *     vault route) as paused, never reopening the plain pool;
 *   - leaving one: every share-side resolver and every exit list answers
 *     exactly as it does with the switch off.
 * The executed prod half (flag ON in its own process) is
 * yield-deposits-paused-prod.test.ts, spawned by environments.test.ts.
 */
import { describe, expect, test } from 'bun:test';

import { ENVIRONMENTS, NATIVE_ASSET_ADDRESS, pauseVaultDeposits, type TokenMetadata } from '@/config/environments';
import { PROD_YIELD_DEPLOYMENTS } from '@/config/prod-deployments';
import {
  resolveNativeYieldDepositDeployment,
  resolveYieldDeploymentForAsset,
  resolveYieldDeployments,
  resolveYieldDepositDeploymentForUnderlying,
  YIELD_DEPOSITS_PAUSED,
} from '@/config/yield';
import {
  DEFAULT_YIELD_PAUSE_BANNER_TEXT,
  parseYieldDepositsPaused,
  pauseActive,
  pauseCoversChain,
  resolveYieldPauseBannerText,
  VAULT_DEPOSITS_PAUSED_MESSAGE,
  YIELD_PAUSE_BANNER_TEXT,
} from '@/config/yield-deposits-paused';
import { conversionTargetRefusal, entrypointOnlyTargetBlocked } from '@/services/entrypoint-only-route';
import { NO_HOLDINGS, selectHubTokens } from '@/services/hub-token-catalog-rule';

const ON = { enabled: true, withdrawReady: true };
const PAUSED = { ...ON, depositsPaused: true };
const usable = () => true;
const chains = Object.keys(PROD_YIELD_DEPLOYMENTS).map(Number);
const prodTokens = ENVIRONMENTS.prod.tokensByChain;
const paused = pauseVaultDeposits(prodTokens, PROD_YIELD_DEPLOYMENTS);

describe('default OFF', () => {
  test('the switch is off unless the env says true, and the served registries carry no pause', () => {
    expect(process.env.EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED).toBeUndefined();
    expect(YIELD_DEPOSITS_PAUSED).toBe(false);
    for (const env of ['prod', 'staging'] as const) {
      for (const tokens of Object.values(ENVIRONMENTS[env].tokensByChain)) {
        for (const t of Object.values(tokens)) expect(t.depositPaused).toBeUndefined();
      }
    }
  });

  test('deposit resolvers answer exactly as before when depositsPaused is absent or false', () => {
    expect(chains.length).toBeGreaterThan(0);
    for (const chainId of chains) {
      for (const d of PROD_YIELD_DEPLOYMENTS[chainId]) {
        for (const opts of [ON, { ...ON, depositsPaused: false }]) {
          if (d.nativeMode) {
            expect(resolveNativeYieldDepositDeployment(chainId, opts, PROD_YIELD_DEPLOYMENTS, usable)).toBe(d);
          } else {
            expect(resolveYieldDepositDeploymentForUnderlying(chainId, d.underlying, opts, PROD_YIELD_DEPLOYMENTS, usable)).toBe(d);
          }
        }
      }
    }
  });
});

describe('paused: no deposit into a vault can be resolved', () => {
  test('every underlying (USDC, USDT) and every native vault route answers undefined', () => {
    let underlyings = 0;
    let natives = 0;
    for (const chainId of chains) {
      for (const d of PROD_YIELD_DEPLOYMENTS[chainId]) {
        expect(resolveYieldDepositDeploymentForUnderlying(chainId, d.underlying, PAUSED, PROD_YIELD_DEPLOYMENTS, usable)).toBeUndefined();
        underlyings += 1;
      }
      if (PROD_YIELD_DEPLOYMENTS[chainId].some((d) => d.nativeMode)) {
        expect(resolveNativeYieldDepositDeployment(chainId, PAUSED, PROD_YIELD_DEPLOYMENTS, usable)).toBeUndefined();
        natives += 1;
      }
    }
    expect(underlyings).toBeGreaterThan(0);
    expect(natives).toBeGreaterThan(0);
  });

  test('every vault entry in the prod registry is paused, and nothing else is', () => {
    const marked = Object.entries(paused).flatMap(([chainId, tokens]) =>
      Object.values(tokens).filter((t) => t.depositPaused).map((t) => `${chainId}:${t.symbol}`));
    // Every share, every legacy underlying the shares replaced, and ETH where
    // a native-mode route takes it.
    for (const [chainId, tokens] of Object.entries(prodTokens)) {
      const list = PROD_YIELD_DEPLOYMENTS[Number(chainId)] ?? [];
      for (const t of Object.values(tokens)) {
        const entersVault = !!t.yieldShare
          || list.some((d) => d.underlying.toLowerCase() === t.address.toLowerCase())
          || (t.isNative && list.some((d) => d.nativeMode));
        expect(marked.includes(`${chainId}:${t.symbol}`)).toBe(entersVault);
      }
    }
    // Pools with no vault stay open: no plain pool is reopened or closed.
    for (const open of ['56:BNB', '56:FDUSD', '56:U', '4114:cBTC', '8453:USDT', '4663:ETH', '4663:USDG']) {
      expect(marked).not.toContain(open);
    }
    for (const m of ['1:ETH', '1:USDC', '1:USDT', '56:USDT', '10:ETH', '8453:ETH', '42161:USDC']) {
      expect(marked).toContain(m);
    }
  });

  test('a paused entry is refused as a conversion target with the paused reason', () => {
    for (const tokens of Object.values(paused)) {
      for (const t of Object.values(tokens).filter((x) => x.depositPaused)) {
        const route = { chainId: 1, shareRouteConfigured: true };
        expect(entrypointOnlyTargetBlocked(t, route)).toBe(true);
        expect(conversionTargetRefusal(t, route)).toBe(VAULT_DEPOSITS_PAUSED_MESSAGE);
      }
    }
  });
});

describe('paused: every exit resolves exactly as before', () => {
  test('share-side resolvers (withdraw, redemption, unwrap, Portfolio) ignore the switch', () => {
    for (const chainId of chains) {
      expect(resolveYieldDeployments(chainId, PAUSED, PROD_YIELD_DEPLOYMENTS)).toEqual(resolveYieldDeployments(chainId, ON, PROD_YIELD_DEPLOYMENTS));
      for (const d of PROD_YIELD_DEPLOYMENTS[chainId]) {
        expect(resolveYieldDeploymentForAsset(chainId, d.ppUSDC, PAUSED, PROD_YIELD_DEPLOYMENTS, usable)).toBe(d);
      }
    }
  });

  test('the registry keeps every asset, with the same identity, decimals and legacy state', () => {
    for (const [chainId, tokens] of Object.entries(prodTokens)) {
      const after = paused[Number(chainId)];
      expect(Object.keys(after)).toEqual(Object.keys(tokens));
      for (const [address, t] of Object.entries(tokens)) {
        const { depositComingSoon: _c, depositPaused: _p, ...rest } = after[address];
        const { depositComingSoon: _c0, ...before } = t;
        expect(rest).toEqual(before);
      }
    }
  });

  test('withdraw, send and swap catalogs list the same assets paused or not', () => {
    const holdings = {
      ready: true,
      symbols: new Set(Object.values(prodTokens).flatMap((tokens) => Object.values(tokens).map((t) => t.symbol.toUpperCase()))),
    };
    const source = (reg: Record<string, TokenMetadata>) => {
      const all = Object.values(reg);
      return { actionable: all, depositable: all, entrypointDepositable: all };
    };
    for (const chainId of Object.keys(prodTokens).map(Number)) {
      for (const action of ['withdraw', 'send', 'swap'] as const) {
        for (const h of [holdings, NO_HOLDINGS]) {
          const before = selectHubTokens(action, source(prodTokens[chainId]), h).map((t) => t.address);
          const after = selectHubTokens(action, source(paused[chainId]), h).map((t) => t.address);
          expect(after).toEqual(before);
        }
      }
    }
    // The native coin itself is still a known asset on every chain.
    for (const chainId of Object.keys(prodTokens).map(Number)) {
      expect(paused[chainId][NATIVE_ASSET_ADDRESS.toLowerCase()]).toBeDefined();
    }
  });
});

describe('per chain scope (Pat, 2026-10-29: Aave froze its Ethereum reserves only)', () => {
  test('the flag parses true, a chain id list, or off', () => {
    expect(parseYieldDepositsPaused(undefined)).toEqual({ all: false, chainIds: [] });
    expect(parseYieldDepositsPaused('')).toEqual({ all: false, chainIds: [] });
    expect(parseYieldDepositsPaused('  ')).toEqual({ all: false, chainIds: [] });
    expect(parseYieldDepositsPaused('false')).toEqual({ all: false, chainIds: [] });
    expect(parseYieldDepositsPaused('true')).toEqual({ all: true, chainIds: [] });
    expect(parseYieldDepositsPaused(' TRUE ')).toEqual({ all: true, chainIds: [] });
    expect(parseYieldDepositsPaused('1')).toEqual({ all: false, chainIds: [1] });
    expect(parseYieldDepositsPaused('1,56')).toEqual({ all: false, chainIds: [1, 56] });
    expect(parseYieldDepositsPaused(' 1 , 56 ,1,')).toEqual({ all: false, chainIds: [1, 56] });
    // Junk entries are ignored, never widened into "every chain".
    expect(parseYieldDepositsPaused('1,abc,-5,0,1.5')).toEqual({ all: false, chainIds: [1] });
    expect(parseYieldDepositsPaused('yes')).toEqual({ all: false, chainIds: [] });
    // `true` inside a list is still "every chain": a typo must not narrow the kill switch.
    expect(parseYieldDepositsPaused('true,56')).toEqual({ all: true, chainIds: [] });
    expect(parseYieldDepositsPaused('56,TRUE')).toEqual({ all: true, chainIds: [] });
  });

  test('true covers every chain, a list covers only its chains, off covers none', () => {
    for (const chainId of [1, 56, 10, 8453, 42161]) {
      expect(pauseCoversChain(parseYieldDepositsPaused('true'), chainId)).toBe(true);
      expect(pauseCoversChain(parseYieldDepositsPaused(undefined), chainId)).toBe(false);
      expect(pauseCoversChain(parseYieldDepositsPaused('1'), chainId)).toBe(chainId === 1);
    }
    expect(pauseActive(parseYieldDepositsPaused('1'))).toBe(true);
    expect(pauseActive(parseYieldDepositsPaused('true'))).toBe(true);
    expect(pauseActive(parseYieldDepositsPaused('false'))).toBe(false);
  });

  test('chain 1 paused: its vault entries are marked, BNB Chain and the rest stay open', () => {
    const only1 = pauseVaultDeposits(prodTokens, PROD_YIELD_DEPLOYMENTS, (id) => id === 1);
    for (const [chainId, tokens] of Object.entries(only1)) {
      if (Number(chainId) === 1) {
        expect(tokens).toEqual(paused[1]);
      } else {
        expect(tokens).toBe(prodTokens[Number(chainId)]);
        for (const t of Object.values(tokens)) expect(t.depositPaused).toBeUndefined();
      }
    }
    for (const symbol of ['ETH', 'USDC', 'USDT']) {
      expect(Object.values(only1[1]).filter((t) => t.symbol === symbol).every((t) => t.depositPaused)).toBe(true);
    }
    // BNB Chain has a vault, and it is still open.
    expect((PROD_YIELD_DEPLOYMENTS[56] ?? []).length).toBeGreaterThan(0);
    expect(Object.values(only1[56]).some((t) => t.yieldShare)).toBe(true);
  });

  test('the money gates pause chain 1 while another chain still resolves its vault', () => {
    const flagsFor = (chainId: number) => ({ ...ON, depositsPaused: pauseCoversChain(parseYieldDepositsPaused('1'), chainId) });
    for (const chainId of chains) {
      for (const d of PROD_YIELD_DEPLOYMENTS[chainId]) {
        const want = chainId === 1 ? undefined : d;
        if (d.nativeMode) {
          expect(resolveNativeYieldDepositDeployment(chainId, flagsFor(chainId), PROD_YIELD_DEPLOYMENTS, usable)).toBe(want);
        } else {
          expect(resolveYieldDepositDeploymentForUnderlying(chainId, d.underlying, flagsFor(chainId), PROD_YIELD_DEPLOYMENTS, usable)).toBe(want);
        }
        // Exits never read the switch.
        expect(resolveYieldDeploymentForAsset(chainId, d.ppUSDC, flagsFor(chainId), PROD_YIELD_DEPLOYMENTS, usable)).toBe(d);
      }
    }
  });
});

describe('the pause banner text', () => {
  const on = parseYieldDepositsPaused('1');
  const off = parseYieldDepositsPaused(undefined);

  test('unset text with a pause on shows Pat\'s default', () => {
    expect(resolveYieldPauseBannerText(on, undefined)).toBe(DEFAULT_YIELD_PAUSE_BANNER_TEXT);
    // The default names Ethereum, so any other scope needs its own text.
    expect(resolveYieldPauseBannerText(parseYieldDepositsPaused('true'), undefined)).toBeNull();
    expect(resolveYieldPauseBannerText(parseYieldDepositsPaused('56'), undefined)).toBeNull();
    expect(resolveYieldPauseBannerText(parseYieldDepositsPaused('1,56'), undefined)).toBeNull();
    // Ethereum and Base, both Aave chains (Pat, 2026-10-29).
    expect(resolveYieldPauseBannerText(parseYieldDepositsPaused('1,8453'), undefined))
      .toBe('Deposits are paused for yield assets on Ethereum and Base because of Aave.');
    expect(resolveYieldPauseBannerText(parseYieldDepositsPaused('8453'), undefined))
      .toBe('Deposits are paused for yield assets on Base because of Aave.');
    expect(resolveYieldPauseBannerText(parseYieldDepositsPaused('1,10,8453'), undefined))
      .toBe('Deposits are paused for yield assets on Ethereum, Optimism and Base because of Aave.');
    expect(resolveYieldPauseBannerText(parseYieldDepositsPaused('true'), 'Deposits are paused.')).toBe('Deposits are paused.');
    expect(DEFAULT_YIELD_PAUSE_BANNER_TEXT).toBe('Deposits are paused for yield assets on Ethereum because of Aave.');
  });

  test('custom text is shown trimmed, an empty string hides the banner', () => {
    expect(resolveYieldPauseBannerText(on, '  Deposits are paused on Ethereum.  ')).toBe('Deposits are paused on Ethereum.');
    expect(resolveYieldPauseBannerText(on, '')).toBeNull();
    expect(resolveYieldPauseBannerText(on, '   ')).toBeNull();
  });

  test('no pause, no banner, whatever the text', () => {
    for (const raw of [undefined, '', 'Something']) expect(resolveYieldPauseBannerText(off, raw)).toBeNull();
    expect(YIELD_PAUSE_BANNER_TEXT).toBeNull();
  });
});
