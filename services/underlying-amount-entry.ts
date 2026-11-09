// Underlying-denominated amounts that cross into the pool's units (DEV-622).
// Pure: no config imports, so it is bun-testable.
//
// The Send form holds its amount in the POOL's units. For a yield pool those are
// vault shares, worth `convertToAssets` underlying each, so "1018.40" typed or
// handed in as a share count is worth more than 1018.40 of the coin (rate 1.0054
// made it 1023.92). Anything that means an amount of the COIN (payroll, a salary)
// must cross this boundary instead of being passed through.
//
// Rounding rule, stated once: converting a coin amount to shares ROUNDS UP to the
// share's smallest unit, so the vault pays out at least the amount (the payee never
// gets less than the salary). Reading a share amount back as coin ROUNDS DOWN (what
// the vault pays out). Round trip: floor(ceil(a * 10^s / r) * r / 10^s) is a, or a
// plus at most one coin base unit (never more), which the payroll row check allows.
import { formatUnits } from 'viem';
import { parseTokenAmount } from '@/services/token-amount';
import type { ShareRate } from '@/services/share-rates';

const PLAIN_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Shares (exact decimal string, the share's decimals) that redeem for AT LEAST
 * `underlyingText` of the coin, or null when the text is not a plain decimal, has
 * more decimals than the coin, is zero, or the rate is unusable.
 */
export function sharesForUnderlyingCeil(underlyingText: string, rate: ShareRate): string | null {
  if (!PLAIN_DECIMAL.test(underlyingText) || rate.assetsPerShare <= 0n) return null;
  if ((underlyingText.split('.')[1] ?? '').length > rate.underlyingDecimals) return null;
  const assets = parseTokenAmount(underlyingText, rate.underlyingDecimals);
  if (assets <= 0n) return null;
  const unit = 10n ** BigInt(rate.shareDecimals);
  const numerator = assets * unit;
  const shares = numerator / rate.assetsPerShare + (numerator % rate.assetsPerShare > 0n ? 1n : 0n);
  return formatUnits(shares, rate.shareDecimals);
}

/**
 * Underlying (exact decimal string, the coin's decimals) a share amount redeems
 * for: convertToAssets, rounded down. Null when the text is not a plain decimal.
 */
export function underlyingForSharesFloor(sharesText: string, rate: ShareRate): string | null {
  if (!PLAIN_DECIMAL.test(sharesText)) return null;
  if ((sharesText.split('.')[1] ?? '').length > rate.shareDecimals) return null;
  const shares = parseTokenAmount(sharesText, rate.shareDecimals);
  return formatUnits(shares * rate.assetsPerShare / 10n ** BigInt(rate.shareDecimals), rate.underlyingDecimals);
}

/**
 * True when what a transfer delivered (coin, exact decimal string) is the expected
 * salary: at least the salary, and at most one coin base unit more (the rounding
 * of sharesForUnderlyingCeil). Null/unparseable delivered is never a match.
 */
export function deliveredMatchesExpected(args: { delivered: string | null | undefined; expected: string; decimals: number }): boolean {
  const { delivered, expected, decimals } = args;
  if (!delivered || !PLAIN_DECIMAL.test(delivered) || !PLAIN_DECIMAL.test(expected)) return false;
  if ((delivered.split('.')[1] ?? '').length > decimals || (expected.split('.')[1] ?? '').length > decimals) return false;
  const got = parseTokenAmount(delivered, decimals);
  const want = parseTokenAmount(expected, decimals);
  return got >= want && got <= want + 1n;
}
