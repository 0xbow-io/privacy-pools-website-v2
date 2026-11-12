import { describe, expect, test } from 'bun:test';
import { parseUnits } from 'viem';

import { figureRounding, presetChipLabel, withoutShareNames } from '@/services/share-display';
import { costShareText, feeShareText, shareRateOf, shareWeiText, type ShareRate } from '@/services/share-rates';
import { formatRelayedPaymentShortfall } from '@/services/relayed-payment-shortfall';
import { checkDepositCap } from '@/services/deposit-cap';

/**
 * Pat on #324: a share figure under the underlying's name must be CONVERTED at
 * the live rate, not just renamed. Only without a rate may it fall back to the
 * approximate share count.
 */

// ppUSDC: 18-decimal share over 6-decimal USDC, 1 share = 1.05 USDC.
const PP_USDC_MAINNET: ShareRate = {
  chainId: 1,
  share: '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6',
  underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  shareSymbol: 'ppUSDC',
  shareDecimals: 18,
  assetsPerShare: 1_050_000n,
  underlyingSymbol: 'USDC',
  underlyingDecimals: 6,
};
// The same symbol on Base, at a different rate.
const PP_USDC_BASE: ShareRate = { ...PP_USDC_MAINNET, chainId: 8453, share: '0x4a5b11c3898367664d94b43be1dcea163bb1d094', assetsPerShare: 1_020_000n };
// ppETH: 18 over WETH 18, 1 share = 1.5 WETH (read as ETH).
const PP_ETH: ShareRate = {
  chainId: 1,
  share: '0x66051920d25af4e3596a8a46309f4d045f9d83b7',
  underlying: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  shareSymbol: 'ppETH',
  shareDecimals: 18,
  assetsPerShare: 1_500_000_000_000_000_000n,
  underlyingSymbol: 'WETH',
  underlyingDecimals: 18,
};

describe('withoutShareNames converts a quoted share count at the live rate', () => {
  const mainnet = shareRateOf([PP_USDC_MAINNET, PP_USDC_BASE, PP_ETH], 1);

  test('with a rate: the figure is converted, keeping the rate even on an integer', () => {
    expect(withoutShareNames('Need 100.00 ppUSDC, have 20.00 ppUSDC', mainnet)).toBe('Need 105.00 USDC, have 21.00 USDC');
    expect(withoutShareNames('Fee 1.23K ppUSDC.', mainnet)).toBe('Fee 1.30K USDC.'); // 1.2915K, a fee: up
    expect(withoutShareNames('1,000.5 ppETH left', mainnet)).toBe('1,500.75 ETH left');
    // A marker the text already carried stays, as the estimate mark "~"; none is added to a converted figure.
    expect(withoutShareNames('≈ 2 ppUSDC', mainnet)).toBe('~2.10 USDC');
    expect(withoutShareNames('Relayer fee 4 ppUSDC', mainnet)).toBe('Relayer fee 4.20 USDC');
  });

  // The P3 on #72: nearest rounding at the source precision made a limit read
  // higher than it is, and an integer figure lost the rate.
  test('a limit rounds DOWN, so typing it back is never refused', () => {
    const at = (rate: number) => () => rate;
    expect(withoutShareNames('max 1.99 ppUSDC', at(1.003))).toBe('max 1.99 USDC'); // 1.99597, not 2.00
    expect(withoutShareNames('max 10 ppUSDC', at(1.06))).toBe('max 10.60 USDC'); // not 11
    expect(withoutShareNames('up to 1 ppETH', at(1.04))).toBe('up to 1.04 ETH'); // not 1
    expect(withoutShareNames('1 ppETH', at(1.04))).toBe('1.04 ETH');
    // Truncated at the underlying's display digits (5 for ETH), never rounded up.
    expect(withoutShareNames('You can send at most 0.3 ppETH', at(1.03333))).toBe('You can send at most 0.30999 ETH'); // 0.309999, not 0.31
    expect(withoutShareNames('balance 1 ppETH', at(1.0000099))).toBe('balance 1 ETH'); // 1.0000099: below the display step
  });

  test('a cost rounds UP, so it never reads low', () => {
    const at = (rate: number) => () => rate;
    expect(withoutShareNames('This payment needs 1.99 ppUSDC', at(1.003))).toBe('This payment needs 2.00 USDC');
    expect(withoutShareNames('Relayer fee 1 ppETH', at(1.0000011))).toBe('Relayer fee 1.00001 ETH');
    // Each figure takes the nearest word before it in its own clause.
    expect(withoutShareNames('Needs 1.99 ppUSDC, max 1.99 ppUSDC', at(1.003))).toBe('Needs 2.00 USDC, max 1.99 USDC');
  });

  test('figureRounding: nearest cost or limit word in the clause, down by default', () => {
    expect(figureRounding('This payment needs ')).toBe('up');
    expect(figureRounding('Fee ')).toBe('up');
    expect(figureRounding('Minimum ')).toBe('up');
    expect(figureRounding('Send at most ')).toBe('down');
    expect(figureRounding('The fee is too high. You can use up to ')).toBe('down');
    expect(figureRounding('Needs 2 USDC. Balance ')).toBe('down');
    expect(figureRounding('')).toBe('down');
  });

  test('without a rate: renamed, the figure loading, never the count (DEV-621)', () => {
    expect(withoutShareNames('Need 100.00 ppUSDC', () => undefined)).toBe('Need … USDC');
    expect(withoutShareNames('Need 100.00 ppUSDC')).toBe('Need … USDC');
  });

  test('a bare name is renamed either way, and other text is untouched', () => {
    expect(withoutShareNames('Insufficient ppUSDC balance', mainnet)).toBe('Insufficient USDC balance');
    expect(withoutShareNames('3 USDC', mainnet)).toBe('3 USDC');
    expect(withoutShareNames(null, mainnet)).toBeNull();
  });
});

describe('shareRateOf', () => {
  test('a chain picks its own rate', () => {
    expect(shareRateOf([PP_USDC_MAINNET, PP_USDC_BASE], 1)('PPUSDC')).toBeCloseTo(1.05, 9);
    expect(shareRateOf([PP_USDC_MAINNET, PP_USDC_BASE], 8453)('ppusdc')).toBeCloseTo(1.02, 9);
  });

  test('without a chain, a symbol converts only when every configured deployment has a rate and they agree', () => {
    const configured = [PP_USDC_MAINNET, PP_USDC_BASE];
    const baseSame = { ...PP_USDC_BASE, assetsPerShare: PP_USDC_MAINNET.assetsPerShare };
    expect(shareRateOf([PP_USDC_MAINNET, PP_USDC_BASE], undefined, configured)('ppUSDC')).toBeUndefined();
    expect(shareRateOf([PP_USDC_MAINNET, baseSame], undefined, configured)('ppUSDC')).toBeCloseTo(1.05, 9);
    // Base's read failed: mainnet alone is not unanimity (cubic on #324).
    expect(shareRateOf([PP_USDC_MAINNET], undefined, configured)('ppUSDC')).toBeUndefined();
    // Nothing configured to check coverage against: no chainless conversion.
    expect(shareRateOf([PP_USDC_MAINNET])('ppUSDC')).toBeUndefined();
    expect(shareRateOf([], undefined, configured)('ppUSDC')).toBeUndefined();
  });

  test('with a chain, a failed read elsewhere does not matter', () => {
    expect(shareRateOf([PP_USDC_MAINNET], 1, [PP_USDC_MAINNET, PP_USDC_BASE])('ppUSDC')).toBeCloseTo(1.05, 9);
  });
});

describe('shareWeiText', () => {
  const units = { symbol: 'ppUSDC', decimals: 18 };

  test('a share with its rate reads as the underlying it is worth', () => {
    expect(shareWeiText(parseUnits('10', 18), units, PP_USDC_MAINNET)).toBe('10.5 USDC');
    expect(shareWeiText(parseUnits('2', 18), { symbol: 'ppETH', decimals: 18 }, PP_ETH)).toBe('3 ETH');
  });

  test('a share without a rate is loading under the underlying, never its count', () => {
    expect(shareWeiText(parseUnits('10', 18), units, undefined)).toBe('… USDC');
  });

  test('a rate for other units is not applied', () => {
    expect(shareWeiText(parseUnits('10', 6), { symbol: 'ppUSDC', decimals: 6 }, PP_USDC_MAINNET)).toBe('… USDC');
  });

  test('a plain token is itself', () => {
    expect(shareWeiText(1_500_000n, { symbol: 'USDC', decimals: 6 }, PP_USDC_MAINNET)).toBe('1.5 USDC');
  });
});

describe('relayed payment shortfall converts share figures', () => {
  const base = {
    requestedAmount: parseUnits('100', 18),
    relayerFee: parseUnits('1', 18),
    reachableAmount: parseUnits('50', 18),
    lineageBlindAmount: parseUnits('50', 18),
    totalSpendable: parseUnits('50', 18),
    tokenSymbol: 'ppUSDC',
    decimals: 18,
    maxLabels: 2,
    singleDepositTopUp: parseUnits('51', 18),
  };

  test('with a rate: every figure in USDC at the rate, never the share name', () => {
    const msg = formatRelayedPaymentShortfall({ ...base, rate: PP_USDC_MAINNET });
    expect(msg).toContain('106.05 USDC'); // (100 + 1) x 1.05
    expect(msg).not.toMatch(/ppUSDC|≈/);
  });

  test('without a rate: the figures load, never the count', () => {
    const msg = formatRelayedPaymentShortfall(base);
    expect(msg).toContain('needs … USDC');
    expect(msg).not.toMatch(/101|≈/);
    expect(msg).not.toContain('ppUSDC');
  });
});

describe('launch-limit figure for a share priced per share', () => {
  test('with the rate, "about N" is in the underlying it names', () => {
    // $100 cap, $1.05 per share, 1.05 USDC per share: about 100 USDC, not 95.23.
    const v = checkDepositCap({ amount: 200, symbol: 'ppUSDC', priceUsd: 1.05, capUsd: 100, underlyingPerShare: 1.05 });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.message).toBe('Launch limit is $100 per deposit (about 100.00 USDC).');
  });

  test('the verdict does not depend on the rate', () => {
    const a = checkDepositCap({ amount: 90, symbol: 'ppUSDC', priceUsd: 1.05, capUsd: 100 });
    const b = checkDepositCap({ amount: 90, symbol: 'ppUSDC', priceUsd: 1.05, capUsd: 100, underlyingPerShare: 1.05 });
    expect(a.ok).toBe(b.ok);
  });
});

describe('a Send fee never reads low', () => {
  test('a share fee converts rounding UP and is written rounding up', () => {
    // 0.0041 shares x 1.5 = 0.00615 ETH exactly: shown as at least that.
    const fee = parseUnits('0.0041', 18);
    const text = feeShareText(fee, { symbol: 'ppETH', decimals: 18 }, PP_ETH);
    expect(text).toBe('~0.00615 ETH');
    // A remainder in the conversion rounds the figure up, never down.
    const odd = feeShareText(1n, { symbol: 'ppUSDC', decimals: 18 }, PP_USDC_MAINNET);
    expect(odd).toBe('~0.01 USDC'); // 1 wei of share is worth a sliver of a cent: shown as a cent, not 0
    // Never below the exact underlying value.
    const fee2 = parseUnits('1.23456789', 18);
    const shown = feeShareText(fee2, { symbol: 'ppUSDC', decimals: 18 }, PP_USDC_MAINNET);
    const exact = fee2 * PP_USDC_MAINNET.assetsPerShare / 10n ** 18n;
    expect(parseUnits(shown.replace(/^~/, '').split(' ')[0], 6) >= exact).toBe(true);
  });

  test('without a rate: loading, never the count and never the share name', () => {
    const text = feeShareText(parseUnits('0.00412345', 18), { symbol: 'ppETH', decimals: 18 }, undefined);
    expect(text).toBe('… ETH');
    expect(text).not.toMatch(/pp/i);
  });
});

describe('a relayed shortfall "needs" figure never reads low', () => {
  test('a share cost converts rounding UP, without the estimate mark', () => {
    // 1.00005 shares x 1.05 = 1.0500525 USDC: shown as 1.06, not 1.05.
    expect(costShareText(parseUnits('1.00005', 18), { symbol: 'ppUSDC', decimals: 18 }, PP_USDC_MAINNET)).toBe('1.06 USDC');
    expect(costShareText(parseUnits('0.0041', 18), { symbol: 'ppETH', decimals: 18 }, PP_ETH)).toBe('0.00615 ETH');
  });

  test('without a rate: loading, never the count', () => {
    expect(costShareText(parseUnits('0.00412345', 18), { symbol: 'ppETH', decimals: 18 }, undefined)).toBe('… ETH');
  });

  test('feeShareText is the same figure marked as an estimate', () => {
    expect(feeShareText(parseUnits('0.0041', 18), { symbol: 'ppETH', decimals: 18 }, PP_ETH)).toBe('~0.00615 ETH');
  });
});

describe('preset chip label', () => {
  test('with a rate: figure then unit', () => {
    expect(presetChipLabel('0.1', 'ETH')).toBe('0.1 ETH');
  });

  test('without a rate the approximate mark goes before the number', () => {
    expect(presetChipLabel('0.1', '≈ ETH')).toBe('≈ 0.1 ETH');
    expect(presetChipLabel('1,000', '≈ USDC')).toBe('≈ 1,000 USDC');
  });
});
