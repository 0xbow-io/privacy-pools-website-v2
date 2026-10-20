import { describe, expect, test } from 'bun:test';
import { assertDepositCap, cappedQuickAmounts, checkDepositCap, DepositCapError, formatCapMaxTokens, parseDepositCapUsd } from '../deposit-cap';

describe('parseDepositCapUsd', () => {
  test('unset keeps the default; off/none and every decimal zero disable', () => {
    expect(parseDepositCapUsd(undefined, 100)).toBe(100);
    expect(parseDepositCapUsd('', 100)).toBe(100);
    expect(parseDepositCapUsd('off', 100)).toBeUndefined();
    expect(parseDepositCapUsd('none', undefined)).toBeUndefined();
    for (const zero of ['0', '0.0', '00', '0.000']) expect(parseDepositCapUsd(zero, 100)).toBeUndefined();
  });
  test('a decimal overrides; anything else keeps the default', () => {
    expect(parseDepositCapUsd('250', 100)).toBe(250);
    expect(parseDepositCapUsd(' 42.5 ', 100)).toBe(42.5);
    expect(parseDepositCapUsd('lots', 100)).toBe(100);
    expect(parseDepositCapUsd('-5', 100)).toBe(100);
    expect(parseDepositCapUsd('0x64', 100)).toBe(100);
    expect(parseDepositCapUsd('1e2', 100)).toBe(100);
  });
});

describe('formatCapMaxTokens never recommends a figure over the cap', () => {
  test('floors at the display precision', () => {
    // $100 / $2,850 = 0.035087…; nearest-rounding said 0.0351 = $100.04.
    expect(formatCapMaxTokens(100, 2850)).toBe('0.0350');
    // $100 / $50.001 = 1.99996; nearest said 2.00 = $100.002.
    expect(formatCapMaxTokens(100, 50.001)).toBe('1.99');
    expect(formatCapMaxTokens(100, 2100)).toBe('0.0476');
    expect(formatCapMaxTokens(100, 1)).toBe('100.00');
    expect(formatCapMaxTokens(100, 60_000)).toBe('0.00166');
  });
  test('every recommended figure times its price stays at or under the cap', () => {
    for (const price of [0.37, 1, 2.5, 50.001, 2100, 2850, 60_000, 123_456.7]) {
      expect(Number(formatCapMaxTokens(100, price)) * price).toBeLessThanOrEqual(100);
    }
  });
});

describe('checkDepositCap', () => {
  test('no cap, or nothing entered, is always fine; a non-number is refused', () => {
    expect(checkDepositCap({ amount: 1_000_000, symbol: 'ETH', priceUsd: 2100, capUsd: undefined }).ok).toBe(true);
    expect(checkDepositCap({ amount: 0, symbol: 'ETH', priceUsd: null, capUsd: 100 }).ok).toBe(true);
    const nan = checkDepositCap({ amount: Number.NaN, symbol: 'ETH', priceUsd: 2100, capUsd: 100 });
    expect(nan.ok).toBe(false);
    if (!nan.ok) expect(nan.reason).toBe('invalid');
  });
  test('at or under the cap passes, over it fails with the floored token equivalent', () => {
    expect(checkDepositCap({ amount: 0.047, symbol: 'ETH', priceUsd: 2100, capUsd: 100 }).ok).toBe(true);
    const over = checkDepositCap({ amount: 0.05, symbol: 'ETH', priceUsd: 2100, capUsd: 100 });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toBe('over');
      expect(over.message).toBe('Launch limit is $100 per deposit (about 0.0476 ETH).');
    }
    const usdc = checkDepositCap({ amount: 100.01, symbol: 'USDC', priceUsd: 1, capUsd: 100 });
    expect(usdc.ok).toBe(false);
    if (!usdc.ok) expect(usdc.message).toBe('Launch limit is $100 per deposit (about 100.00 USDC).');
    expect(checkDepositCap({ amount: 100, symbol: 'USDC', priceUsd: 1, capUsd: 100 }).ok).toBe(true);
  });
  test('stablecoins are $1 when the price is missing; anything else fails closed', () => {
    expect(checkDepositCap({ amount: 99, symbol: 'USDT', priceUsd: 0, capUsd: 100 }).ok).toBe(true);
    const fdusd = checkDepositCap({ amount: 101, symbol: 'FDUSD', priceUsd: undefined, capUsd: 100 });
    expect(fdusd.ok).toBe(false);
    if (!fdusd.ok) expect(fdusd.message).toBe('Launch limit is $100 per deposit (about 100.00 FDUSD).');
    const eth = checkDepositCap({ amount: 0.001, symbol: 'ETH', priceUsd: 0, capUsd: 100 });
    expect(eth.ok).toBe(false);
    if (!eth.ok) expect(eth.reason).toBe('no-price');
    const inf = checkDepositCap({ amount: 0.001, symbol: 'ETH', priceUsd: Number.POSITIVE_INFINITY, capUsd: 100 });
    expect(inf.ok).toBe(false);
    if (!inf.ok) expect(inf.reason).toBe('no-price');
  });
  test('a price still loading is a quiet pending state, not a failure', () => {
    const pending = checkDepositCap({ amount: 0.001, symbol: 'ETH', priceUsd: 0, capUsd: 100, pricePending: true });
    expect(pending.ok).toBe(false);
    if (!pending.ok) {
      expect(pending.reason).toBe('pending');
      expect(pending.message).toBe('Checking the $100 launch limit…');
    }
    // Stablecoins never wait on the feed.
    expect(checkDepositCap({ amount: 5, symbol: 'USDC', priceUsd: 0, capUsd: 100, pricePending: true }).ok).toBe(true);
  });
});

describe('assertDepositCap (payment requests, reshields)', () => {
  const eth = { decimals: 18, symbol: 'ETH' };
  test('no cap: passes without touching the price feed', async () => {
    let calls = 0;
    await assertDepositCap({ amountWei: 10n ** 21n, ...eth, capUsd: undefined, fetchPrice: async () => { calls += 1; return 2100; } });
    expect(calls).toBe(0);
  });
  test('over the cap throws DepositCapError with the user message', async () => {
    await expect(assertDepositCap({ amountWei: 10n ** 17n, ...eth, capUsd: 100, fetchPrice: async () => 2100 }))
      .rejects.toBeInstanceOf(DepositCapError);
    await expect(assertDepositCap({ amountWei: 10n ** 17n, ...eth, capUsd: 100, fetchPrice: async () => 2100 }))
      .rejects.toThrow('Launch limit is $100 per deposit (about 0.0476 ETH).');
    await assertDepositCap({ amountWei: 4n * 10n ** 16n, ...eth, capUsd: 100, fetchPrice: async () => 2100 }); // under the cap: resolves
  });
  test('a failing price feed fails closed; stablecoins skip the feed', async () => {
    await expect(assertDepositCap({ amountWei: 10n ** 15n, ...eth, capUsd: 100, fetchPrice: async () => { throw new Error('down'); } }))
      .rejects.toThrow(/no ETH price/);
    let calls = 0;
    await assertDepositCap({ amountWei: 99_000_000n, decimals: 6, symbol: 'USDC', capUsd: 100, fetchPrice: async () => { calls += 1; return 1; } });
    expect(calls).toBe(0);
    await expect(assertDepositCap({ amountWei: 101_000_000n, decimals: 6, symbol: 'USDC', capUsd: 100, fetchPrice: async () => 1 }))
      .rejects.toThrow(/100.00 USDC/);
  });
});

describe('cappedQuickAmounts', () => {
  const stable = ['100', '1000', '5000', '10000', '100000'];
  const native = ['0.1', '1', '5', '10', '100'];
  test('no cap keeps the defaults', () => {
    expect(cappedQuickAmounts({ capUsd: undefined, priceUsd: 1, symbol: 'USDC', fallback: stable })).toEqual(stable);
  });
  test('a $100 cap turns the stable presets into 10 / 25 / 50 / 100', () => {
    expect(cappedQuickAmounts({ capUsd: 100, priceUsd: 0, symbol: 'USDC', fallback: stable })).toEqual(['10', '25', '50', '100']);
  });
  test('native presets follow the price, floored, never over the cap', () => {
    const eth = cappedQuickAmounts({ capUsd: 100, priceUsd: 2100, symbol: 'ETH', fallback: native });
    expect(eth).toEqual(['0.0047', '0.011', '0.023', '0.047']);
    for (const p of eth) expect(Number(p) * 2100).toBeLessThanOrEqual(100);
  });
  test('an unknown non-stable price keeps the defaults (the check still refuses over-cap)', () => {
    expect(cappedQuickAmounts({ capUsd: 100, priceUsd: 0, symbol: 'ETH', fallback: native })).toEqual(native);
  });
});
