// DEV-621, Zeeshan's review of #29: a PLAIN stablecoin (BNB Chain USDT, USDC on
// OP) is two decimals cut down on every figure, like the balance views:
//  - Send review "Amount: 1.00 USDC" and "Remaining: 4.00 USDC"
//  - the pay and claim pages "2.50 USDC", the figure the requester's card shows.
// ETH, other plain tokens and share tokens keep their own rules.
import { describe, expect, test } from 'bun:test';
import { parseUnits } from 'viem';

import { linkAmountText, type LinkToken } from '@/services/link-token';
import { noteFigureText } from '@/services/note-figure';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import { plainTokenFigure } from '@/services/share-display';
import type { ShareRate } from '@/services/share-rates';

const USDC = { symbol: 'USDC', decimals: 6 };
const USDT_BNB = { symbol: 'USDT', decimals: 18 };
const ETH = { symbol: 'ETH', decimals: 18 };

const PP_USDC: ShareRate = {
  chainId: 1,
  share: '0x1111111111111111111111111111111111111111',
  underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  shareSymbol: 'ppUSDC',
  shareDecimals: 18,
  assetsPerShare: 1_050_000n,
  underlyingSymbol: 'USDC',
  underlyingDecimals: 6,
};

describe('Send review figures for a plain stablecoin', () => {
  test('Amount 1 USDC reads 1.00 USDC', () => {
    expect(noteFigureText(parseUnits('1', 6), USDC, undefined)).toBe('1.00 USDC');
  });

  test('Remaining 4 USDC reads 4.00 USDC', () => {
    expect(noteFigureText(parseUnits('4', 6), USDC, undefined)).toBe('4.00 USDC');
  });

  test('a longer figure is cut down, never rounded up', () => {
    expect(noteFigureText(2_999_999n, USDC, undefined)).toBe('2.99 USDC');
    expect(noteFigureText(parseUnits('2.999', 18), USDT_BNB, undefined)).toBe('2.99 USDT');
  });

  test('a limit message figure is two decimals too', () => {
    expect(noteFigureText(2_999_999n, USDC, undefined, { cap: { enteredWei: 5_000_000n } })).toBe('2.99 USDC');
  });

  test('ETH is untouched', () => {
    expect(noteFigureText(parseUnits('1', 18), ETH, undefined)).toBe('1 ETH');
    expect(noteFigureText(parseUnits('0.123456789', 18), ETH, undefined)).toBe('0.123456789 ETH');
  });

  test('a share token still goes through its own writer and rate', () => {
    const shareFigure = (exact: string) => `field:${exact}`;
    expect(noteFigureText(parseUnits('2', 18), { symbol: 'ppUSDC', decimals: 18 }, PP_USDC, { shareFigure })).toBe('field:2');
    expect(noteFigureText(parseUnits('10', 18), { symbol: 'ppUSDC', decimals: 18 }, PP_USDC)).toBe('10.5 USDC');
    expect(noteFigureText(parseUnits('10', 18), { symbol: 'ppUSDC', decimals: 18 }, undefined)).toBe('… USDC');
  });
});

describe('pay and claim pages for a plain stablecoin', () => {
  const usdc: LinkToken = { known: true, symbol: 'USDC', decimals: 6 };
  const usdt: LinkToken = { known: true, symbol: 'USDT', decimals: 18 };
  const eth: LinkToken = { known: true, symbol: 'ETH', decimals: 18 };

  test('2.5 USDC reads 2.50 USDC', () => {
    expect(linkAmountText(2_500_000n, usdc)).toBe('2.50 USDC');
  });

  test('cut down on a longer figure', () => {
    expect(linkAmountText(2_999_000n, usdc)).toBe('2.99 USDC');
    expect(linkAmountText(parseUnits('2.999', 18), usdt)).toBe('2.99 USDT');
  });

  test('ETH is untouched', () => {
    expect(linkAmountText(parseUnits('0.0123', 18), eth)).toBe('0.0123 ETH');
  });

  test('a share request keeps the underlying at the page rate', () => {
    const pp: LinkToken = { known: true, symbol: 'ppUSDC', decimals: 18 };
    expect(linkAmountText(parseUnits('100', 18), pp, PP_USDC)).toBe('105.00 USDC');
  });

  test('pay page, receive page and requester card agree on one number', () => {
    const exact = '2.5';
    const card = shareBalanceDisplay({ sharesExact: exact, shareSymbol: 'USDC', rate: undefined, priceMap: undefined, fallbackPrice: 1 }).text;
    expect(card).toBe('2.50 USDC');
    expect(linkAmountText(2_500_000n, usdc)).toBe(card);
  });
});

describe('plainTokenFigure', () => {
  test('stablecoins only, share symbols and other tokens pass through', () => {
    expect(plainTokenFigure('1', 'USDC')).toBe('1.00');
    expect(plainTokenFigure('-0.505', 'USDT')).toBe('-0.50');
    expect(plainTokenFigure('1', 'ETH')).toBe('1');
    expect(plainTokenFigure('1.23456789', 'ppUSDC')).toBe('1.23456789');
  });
});
