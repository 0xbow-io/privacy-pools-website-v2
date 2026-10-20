import { describe, expect, test } from 'bun:test';
import { SHIELD_ELSEWHERE_CONFIG, SHIELD_GAS_UNITS } from '../../config/fee-warnings';
import { crossChainShieldFeeUsd, shieldElsewhere, type ElsewherePool, type ShieldElsewhereInput } from '../shield-elsewhere';

const GWEI = 1_000_000_000n;

const pool = (chainId: number, chainName: string, symbol: string): ElsewherePool => ({
  chainId, chainName, symbol, address: `0x${chainId.toString(16).padStart(4, '0')}${symbol.length.toString(16).padStart(36, '0')}`, decimals: 18,
});

// Prod's shape: Ethereum, BNB Chain (BNB plain native is not a bridged target), Citrea (no LI.FI).
const PROD_POOLS = [
  pool(1, 'Ethereum', 'ETH'), pool(1, 'Ethereum', 'ppUSDC'),
  pool(56, 'BNB Chain', 'BNB'), pool(56, 'BNB Chain', 'ppUSDT'), pool(56, 'BNB Chain', 'FDUSD'),
  pool(4114, 'Citrea', 'cBTC'),
];

function input(over: Partial<ShieldElsewhereInput> & { mainnetGwei?: bigint } = {}): ShieldElsewhereInput {
  const gas: Record<number, bigint> = { 1: (over.mainnetGwei ?? 5n) * GWEI, 56: 50_000_000n, 4114: 10_000_000n };
  const usd: Record<number, number> = { 1: 2500, 56: 600, 4114: 100_000 };
  return {
    sourceChainId: 1,
    sourceChainName: 'Ethereum',
    amountUsd: 40,
    directGasUnits: SHIELD_GAS_UNITS.deposit,
    pools: PROD_POOLS,
    gasPriceOf: (id) => gas[id] ?? null,
    nativeUsdOf: (id) => usd[id] ?? null,
    routeAvailable: (_from, to) => to === 56,
    poolAccepts: (p) => p.symbol !== 'BNB',
    ...over,
  };
}

describe('when it applies', () => {
  test('$49.99 on Mainnet suggests BNB Chain', () => {
    const result = shieldElsewhere(input({ amountUsd: 49.99 }));
    expect(result).not.toBeNull();
    expect(result!.rows[0]!.chainId).toBe(56);
    expect(result!.rows[0]!.disabledReason).toBeNull();
  });

  test('$50.00 and over does not', () => {
    expect(shieldElsewhere(input({ amountUsd: 50 }))).toBeNull();
    expect(shieldElsewhere(input({ amountUsd: 500 }))).toBeNull();
  });

  test('any chain other than a configured source does not', () => {
    expect(shieldElsewhere(input({ sourceChainId: 56, sourceChainName: 'BNB Chain' }))).toBeNull();
    expect(shieldElsewhere(input({ sourceChainId: 10, sourceChainName: 'OP Mainnet' }))).toBeNull();
  });

  test('an amount that cannot be priced is no suggestion, not a guess', () => {
    expect(shieldElsewhere(input({ amountUsd: null }))).toBeNull();
    expect(shieldElsewhere(input({ amountUsd: 0 }))).toBeNull();
  });

  test('with no chain that can take a bridged deposit there is nothing to suggest', () => {
    expect(shieldElsewhere(input({ routeAvailable: () => false }))).toBeNull();
    expect(shieldElsewhere(input({ poolAccepts: () => false }))).toBeNull();
  });
});

describe('today\'s gas never decides it', () => {
  // Every later withdraw, send or swap of a Mainnet note pays Mainnet gas at
  // whatever it costs then, so a cheap deposit today is no reason to stay.
  test('0.005 ETH ($12.61) at 0.3 gwei is told about BNB Chain', () => {
    const result = shieldElsewhere(input({ amountUsd: 12.61, gasPriceOf: (id) => (id === 1 ? 300_000_000n : 50_000_000n), nativeUsdOf: (id) => (id === 1 ? 2522 : id === 56 ? 600 : null) }));
    expect(result).not.toBeNull();
    expect(result!.directFeeUsd).toBeCloseTo(0.681, 3);
    expect(result!.rows[0]!.chainId).toBe(56);
  });

  test('at 0.074 gwei, where depositing directly is cheaper, the chain is still offered with its fee', () => {
    const result = shieldElsewhere(input({ gasPriceOf: (id) => (id === 1 ? 74_000_000n : 50_000_000n) }))!;
    const bnb = result.rows[0]!;
    expect(bnb.disabledReason).toBeNull();
    expect(bnb.feeUsd!).toBeGreaterThan(result.directFeeUsd!);
  });

  test('without a gas or price reading it still shows, with the fees unknown', () => {
    const noGas = shieldElsewhere(input({ gasPriceOf: () => null }))!;
    expect(noGas.directFeeUsd).toBeNull();
    expect(noGas.rows[0]!.feeUsd).toBeNull();
    expect(noGas.rows[0]!.disabledReason).toBeNull();
    const noPrice = shieldElsewhere(input({ nativeUsdOf: () => null }))!;
    expect(noPrice.directFeeUsd).toBeNull();
    expect(noPrice.rows[0]!.feeUsd).toBeNull();
    expect(noPrice.rows[0]!.disabledReason).toBeNull();
  });
});

describe('estimate', () => {
  test('the estimate counts source gas, destination gas, bridge share and the fixed cost', () => {
    const fee = crossChainShieldFeeUsd({ ...input(), destinationChainId: 56, amountUsd: 40 })!;
    const source = Number(SHIELD_GAS_UNITS.crossChainSource) * 5e-9 * 2500;
    const destination = Number(SHIELD_ELSEWHERE_CONFIG.destinationGas) * 0.05e-9 * 600;
    const bridge = (40 * SHIELD_ELSEWHERE_CONFIG.bridgeFeeBps) / 10_000 + SHIELD_ELSEWHERE_CONFIG.bridgeFixedUsd;
    expect(fee).toBeCloseTo(source + destination + bridge, 9);
  });
});

describe('rows', () => {
  test('every other chain is listed; unavailable ones are disabled with a reason, not hidden', () => {
    const result = shieldElsewhere(input())!;
    expect(result.rows.map((r) => r.chainId)).toEqual([56, 4114]);
    expect(result.rows[1]!.disabledReason).toBe('No route from Ethereum yet');
  });

  test('a chain lists every pool a bridged deposit can enter, not only the asset being paid', () => {
    const bnb = shieldElsewhere(input())!.rows[0]!;
    expect(bnb.pools.map((p) => p.symbol)).toEqual(['ppUSDT', 'FDUSD']);
  });

  test('a routable chain with no pool that takes a bridged deposit is disabled', () => {
    const result = shieldElsewhere(input({
      pools: [...PROD_POOLS, pool(10, 'OP Mainnet', 'ETH')],
      routeAvailable: (_from, to) => to === 56 || to === 10,
      poolAccepts: (p) => p.symbol !== 'BNB' && p.chainId !== 10,
    }))!;
    expect(result.rows.find((r) => r.chainId === 10)!.disabledReason).toBe('No pool here takes a bridged deposit');
  });

  test('pickable rows come first, cheapest first', () => {
    const result = shieldElsewhere(input({
      pools: [...PROD_POOLS, pool(10, 'OP Mainnet', 'ETH'), pool(8453, 'Base', 'ETH')],
      routeAvailable: (_from, to) => to === 56 || to === 10 || to === 8453,
      gasPriceOf: (id) => ({ 1: 5n * GWEI, 56: 50_000_000n, 10: 1_000_000n, 8453: 5_000_000n } as Record<number, bigint>)[id] ?? null,
      nativeUsdOf: (id) => ({ 1: 2500, 56: 600, 10: 2500, 8453: 2500 } as Record<number, number>)[id] ?? null,
    }))!;
    const pickable = result.rows.filter((r) => r.disabledReason === null);
    expect(pickable.map((r) => r.chainId)).toEqual([10, 8453, 56]);
    expect(result.rows.at(-1)!.chainId).toBe(4114);
  });
});
