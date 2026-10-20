// Token amount formatting, kept OUT of config/tokens.ts so it can be tested.
//
// config/tokens.ts imports config/chains.ts, which reaches react-native, and the
// bun runner chokes on that package's Flow syntax. So anything living there is
// untestable in CI, and this helper in particular had no tests at all until
// 2026-09-01 - which is how three separate surfaces ended up printing "0.0000"
// for real money on Citrea. config/tokens.ts re-exports these, so every existing
// caller is unchanged.

const STABLECOIN_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDE', 'USDS', 'FRAX', 'LUSD', 'PYUSD', 'TUSD', 'FDUSD', 'U', 'USDG', 'PPUSDC', 'PPUSDT']);

export function isStablecoin(symbol: string | undefined | null): boolean {
  if (!symbol) return false;
  return STABLECOIN_SYMBOLS.has(symbol.toUpperCase());
}

/** Decimals a non-stablecoin rounds to, and the size below which a figure is
 *  shown by its significant digits instead (formatTokenBalance). */
export const MAX_TOKEN_FRACTION_DIGITS = 5;

/**
 * How many fraction digits a figure in `symbol` is shown with: cents for a
 * stablecoin, MAX_TOKEN_FRACTION_DIGITS otherwise. Shared by every surface
 * that has to round a threshold to what the user can actually type.
 */
export function displayFractionDigits(symbol: string | undefined | null): number {
  return isStablecoin(symbol) ? 2 : MAX_TOKEN_FRACTION_DIGITS;
}

/** Significant digits a figure smaller than its asset's rounding step keeps. */
const SMALL_AMOUNT_SIGNIFICANT_DIGITS = 2;

/**
 * A token amount as balances, activity rows and pool tables show it.
 *
 * Trailing zeros carry nothing, so they go: a stablecoin reads like money
 * ("1250", "23.30"), and any other asset keeps two decimals so a whole amount
 * does not read as rounded ("0.50", "1.00"). Digits that carry value stay, up
 * to MAX_TOKEN_FRACTION_DIGITS for a non-stablecoin (Pat, 2026-09-01: cBTC
 * tracks BTC, so an ordinary test amount is ~0.00001).
 *
 * A figure smaller than that step is shown by its leading significant digits
 * ("0.000004 cBTC", "0.004 USDC"), never as "<" or as a zero: a real balance
 * must not read as empty, and a range hides what the user actually holds.
 * A negative amount, which would mean an accounting bug upstream, keeps its sign.
 */
export function formatTokenBalance(amount: number, symbol: string): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const stable = isStablecoin(symbol);
  const step = Math.pow(10, -displayFractionDigits(symbol));
  if (abs > 0 && abs < step) {
    const decimals = Math.min(100, SMALL_AMOUNT_SIGNIFICANT_DIGITS - 1 - Math.floor(Math.log10(abs)));
    return `${sign}${abs.toFixed(decimals).replace(/0+$/, '')}`;
  }
  const [whole, frac = ''] = abs.toFixed(displayFractionDigits(symbol)).split('.');
  const trimmed = frac.replace(/0+$/, '');
  const digits = stable && trimmed === '' ? '' : trimmed.padEnd(2, '0');
  return `${sign}${whole}${digits ? `.${digits}` : ''}`;
}

/**
 * Plain decimal digits of a non-negative amount, never rounded. A string is
 * taken as-is (an exact formatUnits figure); a number uses its shortest
 * round-trip form, so 1.239999999999 stays below 1.24 instead of being
 * rounded across a display step by toFixed.
 */
function exactDecimal(abs: number | string): string {
  if (typeof abs === 'string') return abs.trim().replace(/^-/, '') || '0';
  const s = String(abs);
  if (!/e/i.test(s)) return s;
  // Exponent form only for very small or huge values; toFixed(100) of a tiny
  // double is its exact binary value, which never exceeds the double itself.
  return abs < 1 ? abs.toFixed(100) : BigInt(Math.trunc(abs)).toString();
}

/** Cut to `digits` fraction digits without rounding. */
function truncateDecimal(decimal: string, digits: number): string {
  const [whole, frac = ''] = decimal.split('.');
  return digits > 0 ? `${whole || '0'}.${frac.slice(0, digits).padEnd(digits, '0')}` : (whole || '0');
}

/**
 * formatTokenBalance for a figure the user may type back in as a MAX: rounds
 * DOWN, never up. A spendable 0.0044999 shown as "0.0045" invites an entry the
 * balance check then rejects with the same number (Artem, 2026-10-19). Pass
 * the exact formatUnits string when there is one.
 */
export function formatTokenBalanceDown(amount: number | string, symbol: string): string {
  const num = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(num)) return formatTokenBalance(0, symbol);
  const sign = num < 0 ? '-' : '';
  const absNum = Math.abs(num);
  const decimal = exactDecimal(typeof amount === 'string' ? amount : absNum);
  const stable = isStablecoin(symbol);
  const step = Math.pow(10, -displayFractionDigits(symbol));
  if (absNum > 0 && absNum < step) {
    const decimals = Math.min(100, SMALL_AMOUNT_SIGNIFICANT_DIGITS - 1 - Math.floor(Math.log10(absNum)));
    return `${sign}${truncateDecimal(decimal, decimals).replace(/\.?0+$/, '')}`;
  }
  const [whole, frac = ''] = truncateDecimal(decimal, displayFractionDigits(symbol)).split('.');
  const trimmed = frac.replace(/0+$/, '');
  const digits = stable && trimmed === '' ? '' : trimmed.padEnd(2, '0');
  return `${sign}${whole}${digits ? `.${digits}` : ''}`;
}

/**
 * An exact decimal string as the transaction detail shows it: trailing zeros
 * dropped, then padded back to the asset's floor. A stablecoin reads like
 * money, so a whole amount stays bare ("1250") and a fractional one shows
 * cents ("1250.50"). Every other asset is worth enough per unit that a bare
 * integer reads as rounded, so it keeps two decimals ("0.50", "1.00"). Digits
 * beyond the floor are never cut: "0.0006" stays "0.0006".
 */
export function detailAmountDigits(value: string, symbol: string | undefined | null): string {
  const negative = value.startsWith('-');
  const [whole, frac = ''] = (negative ? value.slice(1) : value).split('.');
  const trimmed = frac.replace(/0+$/, '');
  const floor = isStablecoin(symbol) && trimmed === '' ? 0 : 2;
  const digits = trimmed.length >= floor ? trimmed : trimmed.padEnd(floor, '0');
  return `${negative ? '-' : ''}${whole}${digits ? `.${digits}` : ''}`;
}
