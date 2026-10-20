import { describe, expect, test } from 'bun:test';
import { ACTIVE_ENVIRONMENT, NATIVE_ASSET_ADDRESS } from '@/config/environments';
import { NO_HOLDINGS, preferredHubToken, heldSymbolsFor, selectHubTokens, type HubCatalogSource } from '@/services/hub-token-catalog-rule';

type Tok = { symbol: string; isNative: boolean; yieldShare?: boolean; withdrawOnly?: boolean; superseded?: boolean };
const NATIVE = NATIVE_ASSET_ADDRESS.toLowerCase();

// The real registry of the active environment, EVM chains only (the ones whose
// native asset is the EVM sentinel), fed through the same shaping config/tokens
// applies: entrypoint-depositable drops withdraw-only assets; depositable keeps a
// withdraw-only one when it is a verified yield underlying (stubbed: none).
function realSource(chainId: number): HubCatalogSource<Tok> {
  const actionable = Object.values(ACTIVE_ENVIRONMENT.tokensByChain[chainId] ?? {}) as unknown as Tok[];
  return {
    actionable,
    depositable: actionable.filter((t) => !t.withdrawOnly),
    entrypointDepositable: actionable.filter((t) => !t.withdrawOnly),
  };
}
const evmChains = Object.entries(ACTIVE_ENVIRONMENT.tokensByChain)
  .filter(([, tokens]) => Object.values(tokens).some((t) => t.address.toLowerCase() === NATIVE))
  .map(([id]) => Number(id));

// Hand-made chain: native, a plain asset, a legacy withdraw-only asset, a yield
// share and its underlying (withdraw-only for the Entrypoint, depositable through
// the router once verified).
const eth: Tok = { symbol: 'ETH', isNative: true };
const usdt: Tok = { symbol: 'USDT', isNative: false };
const legacy: Tok = { symbol: 'DAI', isNative: false, withdrawOnly: true };
const share: Tok = { symbol: 'ppUSDC', isNative: false, yieldShare: true };
const underlying: Tok = { symbol: 'USDC', isNative: false, withdrawOnly: true };
const FIX: HubCatalogSource<Tok> = {
  actionable: [eth, usdt, legacy, share, underlying],
  depositable: [eth, usdt, share, underlying],
  entrypointDepositable: [eth, usdt, share],
};
const syms = (list: Tok[]) => list.map((t) => t.symbol);

describe('hub token rule', () => {
  test('every tab lists the native asset first on every EVM chain of the real registry', () => {
    expect(evmChains.length).toBeGreaterThan(0);
    for (const id of evmChains) {
      for (const action of ['shield', 'withdraw', 'send', 'request', 'swap'] as const) {
        const list = selectHubTokens(action, realSource(id), NO_HOLDINGS);
        expect(list.length).toBeGreaterThan(0);
        expect(list[0]!.isNative).toBe(true);
      }
    }
  });

  test('shield never offers a yield share, held or not; the verified underlying stays', () => {
    const held = { symbols: new Set(['PPUSDC']), ready: true };
    expect(syms(selectHubTokens('shield', FIX, held))).toEqual(['ETH', 'USDT', 'USDC']);
    expect(syms(selectHubTokens('shield', FIX, NO_HOLDINGS))).toEqual(['ETH', 'USDT', 'USDC']);
  });

  test('withdraw and send offer what is held plus native once holdings are known', () => {
    expect(syms(selectHubTokens('withdraw', FIX, NO_HOLDINGS))).toEqual(['ETH']);
    expect(syms(selectHubTokens('send', FIX, { symbols: new Set(['PPUSDC', 'DAI']), ready: true }))).toEqual(['ETH', 'DAI', 'ppUSDC']);
    // Unknown held symbols create no entry; matching is case-insensitive.
    expect(syms(selectHubTokens('withdraw', FIX, { symbols: new Set(['NOPE', 'usdt']), ready: true }))).toEqual(['ETH']);
    expect(syms(selectHubTokens('withdraw', FIX, { symbols: new Set(['USDT']), ready: true }))).toEqual(['ETH', 'USDT']);
  });

  test('until holdings are known the spend tabs keep the full actionable list', () => {
    const unknown = { symbols: new Set<string>(), ready: false };
    expect(syms(selectHubTokens('withdraw', FIX, unknown))).toEqual(syms([...FIX.actionable]));
    expect(syms(selectHubTokens('send', FIX, unknown))).toEqual(syms([...FIX.actionable]));
  });

  test('request names what a plain Entrypoint deposit may pay', () => {
    expect(syms(selectHubTokens('request', FIX, NO_HOLDINGS))).toEqual(['ETH', 'USDT', 'ppUSDC']);
  });

  // Pat, 2026-09-22: a plain pool a share has replaced is withdrawable and
  // sendable, never swappable. The Swap tab must not offer it at all, and not
  // merely hide it while it is empty, or the chip reappears the moment someone
  // holds a legacy balance, which is the case this removes it for.
  describe('swap never offers a superseded pool', () => {
    const supersededEth: Tok = { symbol: 'ETH', isNative: true, superseded: true };
    const SUPERSEDED: HubCatalogSource<Tok> = { ...FIX, actionable: [supersededEth, usdt, share] };
    const holdingLegacy = { symbols: new Set(['ETH']), ready: true };

    test('it is gone whether or not the user holds it', () => {
      expect(syms(selectHubTokens('swap', SUPERSEDED, NO_HOLDINGS))).toEqual(['USDT', 'ppUSDC']);
      expect(syms(selectHubTokens('swap', SUPERSEDED, holdingLegacy))).toEqual(['USDT', 'ppUSDC']);
    });

    test('withdraw still offers it, but only when it is funded', () => {
      expect(syms(selectHubTokens('withdraw', SUPERSEDED, holdingLegacy))).toContain('ETH');
      expect(syms(selectHubTokens('withdraw', SUPERSEDED, NO_HOLDINGS))).not.toContain('ETH');
    });

    test('send does not offer it either, funded or not', () => {
      // Withdraw is the way out of a closed pool; Send would keep it moving.
      expect(syms(selectHubTokens('send', SUPERSEDED, holdingLegacy))).not.toContain('ETH');
      expect(syms(selectHubTokens('send', SUPERSEDED, NO_HOLDINGS))).not.toContain('ETH');
    });

    test('a native asset no share has replaced is still a swap source', () => {
      expect(syms(selectHubTokens('swap', FIX, NO_HOLDINGS))).toContain('ETH');
    });
  });

  test('held symbols: chain-scoped, upper-cased, positive balance only, dust counts', () => {
    const pools = [
      { chainId: 1, name: 'ppUSDC', balanceTokenExact: '0.000000000000000001' },
      { chainId: 1, name: 'usdt', balanceTokenExact: '0' },
      { chainId: 56, name: 'FDUSD', balanceTokenExact: '12' },
      { chainId: 1, name: 'ETH', balanceTokenExact: '' },
    ];
    expect([...heldSymbolsFor(pools, 1)]).toEqual(['PPUSDC']);
    expect([...heldSymbolsFor(pools, 56)]).toEqual(['FDUSD']);
    expect(heldSymbolsFor(pools, 4114).size).toBe(0);
  });
});

test('superseded native sources disappear when empty; active or pending legacy remains', () => {
  const oldEth = { ...eth, superseded: true };
  const ppEth = { symbol: 'ppETH', isNative: false, yieldShare: true };
  const source = { actionable: [oldEth, ppEth], depositable: [oldEth, ppEth], entrypointDepositable: [oldEth, ppEth] };
  const held = { symbols: new Set(['PPETH']), ready: true };
  // WITHDRAW keeps a funded legacy pool: it is how the holder gets out.
  expect(syms(selectHubTokens('withdraw', source, held))).toEqual(['ppETH']);
  expect(selectHubTokens('withdraw', source, NO_HOLDINGS)).toEqual([]);
  expect(syms(selectHubTokens('withdraw', source, { ...held, symbols: new Set(['ETH', 'PPETH']) }))).toEqual(['ETH', 'ppETH']);

  // SEND does not, funded or not (Pat, 2026-09-22): withdraw is the way out.
  expect(syms(selectHubTokens('send', source, held))).toEqual(['ppETH']);
  expect(syms(selectHubTokens('send', source, { ...held, symbols: new Set(['ETH', 'PPETH']) }))).toEqual(['ppETH']);
  expect(syms(selectHubTokens('send', source, NO_HOLDINGS))).toEqual([]);
  expect(preferredHubToken(source.actionable, held)?.symbol).toBe('ppETH');
  expect(preferredHubToken(source.actionable, { symbols: new Set(), ready: false })?.symbol).toBe('ppETH');
  expect(syms(selectHubTokens('request', source, NO_HOLDINGS))).toEqual(['ppETH']);
  expect([...heldSymbolsFor([{ chainId: 1, name: 'ETH', balanceTokenExact: '0', pendingTokenExact: '0.1' }], 1)]).toEqual(['ETH']);
});
