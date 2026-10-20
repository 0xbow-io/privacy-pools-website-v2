import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  fiatEntryAvailable,
  formatUsdLabel,
  sanitizeUsdInput,
  shieldDestinationLabel,
  tokenToUsdText,
  usdChipLabel,
  usdToTokenAmount,
} from '../hub-fiat-entry';

describe('fiatEntryAvailable', () => {
  test('a priced non-stablecoin on EVM offers dollar entry', () => {
    expect(fiatEntryAvailable({ symbol: 'ETH', priceUsd: 3000, isSui: false })).toBe(true);
    expect(fiatEntryAvailable({ symbol: 'BNB', priceUsd: 600, isSui: false })).toBe(true);
    // A share prices through its underlying and reads as the coin.
    expect(fiatEntryAvailable({ symbol: 'ppETH', priceUsd: 3000, isSui: false })).toBe(true);
  });

  test('stablecoins already read as dollars, so they never offer it', () => {
    expect(fiatEntryAvailable({ symbol: 'USDC', priceUsd: 1, isSui: false })).toBe(false);
    expect(fiatEntryAvailable({ symbol: 'usdt', priceUsd: 1, isSui: false })).toBe(false);
    expect(fiatEntryAvailable({ symbol: 'ppUSDC', priceUsd: 1, isSui: false })).toBe(false);
  });

  test('no price, no dollars: a missing or zero price hides the line', () => {
    expect(fiatEntryAvailable({ symbol: 'ETH', priceUsd: 0, isSui: false })).toBe(false);
    expect(fiatEntryAvailable({ symbol: 'ETH', priceUsd: NaN, isSui: false })).toBe(false);
  });

  test('the Sui card keeps its own layout', () => {
    expect(fiatEntryAvailable({ symbol: 'SUI', priceUsd: 2, isSui: true })).toBe(false);
  });
});

describe('usdToTokenAmount', () => {
  test('divides at the price and trims trailing zeros', () => {
    expect(usdToTokenAmount('15', 3000, 18)).toBe('0.005');
    expect(usdToTokenAmount('3000', 3000, 18)).toBe('1');
    expect(usdToTokenAmount('1', 3000, 18)).toBe('0.00033333');
  });

  test('never exceeds the token decimals', () => {
    expect(usdToTokenAmount('1', 3, 2)).toBe('0.33');
    expect(usdToTokenAmount('1', 3, 0)).toBe('0');
  });

  test('typing exactly the cap is never worth MORE than the cap', () => {
    // It floored to nearest before, so "100" under the $100 launch cap derived
    // an amount worth $100.00002 at roughly half of all prices and the CTA
    // went dead with no way for the user to see why. 100 is the single most
    // likely figure to type under a "$100 limit" banner.
    for (const price of [4123.77, 3456.78, 1234.56, 105432.19, 2999.99, 2850.41, 4000, 2630.5, 1799.33]) {
      const token = parseFloat(usdToTokenAmount('100', price, 18));
      expect(token * price).toBeLessThanOrEqual(100);
    }
  });

  test('empty, zero or unpriced input clears the amount', () => {
    expect(usdToTokenAmount('', 3000, 18)).toBe('');
    expect(usdToTokenAmount('0', 3000, 18)).toBe('');
    expect(usdToTokenAmount('.', 3000, 18)).toBe('');
    expect(usdToTokenAmount('15', 0, 18)).toBe('');
  });
});

describe('tokenToUsdText', () => {
  test('multiplies at the price, in cents', () => {
    expect(tokenToUsdText('0.005', 3000)).toBe('15.00');
    expect(tokenToUsdText('0.007985', 3000)).toBe('23.96');
  });

  test('empty, zero or unpriced input gives an empty dollar text', () => {
    expect(tokenToUsdText('', 3000)).toBe('');
    expect(tokenToUsdText('0', 3000)).toBe('');
    expect(tokenToUsdText('0.005', 0)).toBe('');
  });
});

describe('the dollar keystroke sanitizer and labels', () => {
  test('keeps digits, one dot and at most cents', () => {
    expect(sanitizeUsdInput('12.345')).toBe('12.34');
    expect(sanitizeUsdInput('$1,2.3.4')).toBe('12.34');
    expect(sanitizeUsdInput('abc')).toBe('');
  });

  test('the grey line always shows a currency figure', () => {
    expect(formatUsdLabel('15.00')).toBe('$15.00');
    expect(formatUsdLabel('1234.5')).toBe('$1,234.50');
    expect(formatUsdLabel('')).toBe('$0.00');
  });

  test('a dollar-mode chip reads as the whole dollars the preset was floored from', () => {
    // cappedQuickAmounts floors 10% of a $100 cap at $2,630 to 0.0038 ETH.
    expect(usdChipLabel('0.0038', 2630)).toBe('$10');
    expect(usdChipLabel('0.038', 2630)).toBe('$100');
    expect(usdChipLabel('1', 2630)).toBe('$2,630');
    expect(usdChipLabel('0.0001', 2630)).toBe('$0.26');
  });

  test('an unpriced chip falls back to the token preset', () => {
    expect(usdChipLabel('0.1', 0)).toBe('0.1');
  });
});

describe('shieldDestinationLabel', () => {
  test('names the ticker and the chain, with Ethereum read as Mainnet', () => {
    expect(shieldDestinationLabel({ symbol: 'ETH', chainId: 1, chainName: 'Ethereum' })).toBe('Into the $ETH pool on Mainnet');
    expect(shieldDestinationLabel({ symbol: 'USDC', chainId: 56, chainName: 'BNB Chain' })).toBe('Into the $USDC pool on BNB Chain');
    expect(shieldDestinationLabel({ symbol: 'cBTC', chainId: 4114, chainName: 'Citrea' })).toBe('Into the $cBTC pool on Citrea');
  });

  test('a share pool reads as its coin', () => {
    expect(shieldDestinationLabel({ symbol: 'ppETH', chainId: 1, chainName: 'Ethereum' })).toBe('Into the $ETH pool on Mainnet');
  });
});

describe('the hub wires dollar entry', () => {
  const src = readFileSync(fileURLToPath(new URL('../../components/home/action-hub.tsx', import.meta.url)), 'utf8');

  test('the figure can be typed in dollars and converted into the token amount', () => {
    expect(src).toContain('usdToTokenAmount(');
    expect(src).toContain('tokenToUsdText(');
    expect(src).toContain('hub-fiat-toggle');
  });

  test('dollar mode reaches the Request figure through the provider, not a local copy', () => {
    expect(src).toContain('syncRequestForm({ amount: next })');
  });

  test('Withdraw derives its chips the way Shield does, from the dollar anchors at price', () => {
    expect(src).toContain('const withdrawPresets = useMemo(');
    expect(src).toContain("(a === 'shield' ? shieldPresets : withdrawPresets)");
  });

  test('the recommended-amount chips read in dollars in dollar mode', () => {
    expect(src).toContain('usdChipLabel(');
  });

  test('the presets are captioned as recommended amounts, with the privacy hint', () => {
    expect(src).toContain('Recommended amounts');
    expect(src).toContain('hub-recommended-amounts-hint');
  });

  test('the destination card names the pool and the chain', () => {
    expect(src).toContain('shieldDestinationLabel(shieldPool)');
    expect(src).not.toContain('Into {shieldPool.chainName} pool');
  });

  test('the pay-token price is fetched whether or not a deposit cap is configured', () => {
    // The dollar line needs the price on every environment; the cap check
    // used to be the only consumer and gated the query on the cap.
    expect(src).not.toContain('enabled: shieldCapUsd !== undefined && !isSui');
  });
});
