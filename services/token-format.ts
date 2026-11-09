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

/**
 * What a figure reads while the rate it depends on is still loading: "… USDC".
 * A rendered amount shows the Portfolio shimmer in its place
 * (components/ui/share-figure.tsx FigureText), and plain text that cannot hold
 * a shimmer keeps the ellipsis. Never a stand-in number (DEV-621).
 */
export const LOADING_FIGURE = '…';

/**
 * Text cut at every loading figure: the pieces between them, so a renderer
 * puts a shimmer between each two. One piece means there is none. A loading
 * figure stands alone where a number would ("… USDC", "Fee …"); a sentence ending in an ellipsis ("Estimating USDC…") is not one.
 */
export function splitLoadingFigures(text: string): string[] {
  const slot = new RegExp(`(^|[\\s(])${LOADING_FIGURE}(?=\\s\\S|[).,]|$)`, 'g');
  const parts: string[] = [];
  let last = 0;
  for (let m = slot.exec(text); m; m = slot.exec(text)) {
    const start = m.index + m[1].length;
    parts.push(text.slice(last, start));
    last = start + LOADING_FIGURE.length;
  }
  parts.push(text.slice(last));
  return parts;
}

/**
 * A stablecoin figure: always exactly two decimals, like money ("5.00",
 * "4.97"), never "5" and never "4.918123" (DEV-621). Rounded DOWN, so a
 * balance, a pool row and a MAX that hold the same amount print the same
 * cents and a figure typed back is never refused. A positive amount below a
 * cent reads "<0.01" so a real balance never reads as empty. `cents` is the
 * figure already cut to two decimals.
 */
function stablecoinFigure(sign: string, abs: number, cents: string): string {
  if (abs > 0 && Number(cents) === 0) return `${sign}<0.01`;
  return `${Number(cents) === 0 ? '' : sign}${cents}`;
}

/** Two decimals, cut down, with a hair of slack for float noise (5.03 x 100 = 502.99999…). */
function centsDown(abs: number): string {
  return (Math.floor(abs * 100 * (1 + 1e-12)) / 100).toFixed(2);
}

/** Significant digits a figure smaller than its asset's rounding step keeps. */
const SMALL_AMOUNT_SIGNIFICANT_DIGITS = 2;

/**
 * A token amount as balances, activity rows and pool tables show it.
 *
 * A stablecoin reads like money with exactly two decimals, rounded down
 * ("1250.00", "23.30", "4.97"). Any other asset drops trailing zeros but keeps
 * two decimals so a whole amount does not read as rounded ("0.50", "1.00"). Digits that carry value stay, up
 * to MAX_TOKEN_FRACTION_DIGITS for a non-stablecoin (Pat, 2026-09-01: cBTC
 * tracks BTC, so an ordinary test amount is ~0.00001).
 *
 * A figure smaller than that step is shown by its leading significant digits
 * ("0.000004 cBTC"), never as "<" or as a zero: a real balance
 * must not read as empty, and a range hides what the user actually holds.
 * A negative amount, which would mean an accounting bug upstream, keeps its sign.
 */
export function formatTokenBalance(amount: number, symbol: string): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (isStablecoin(symbol)) return stablecoinFigure(sign, abs, centsDown(abs));
  const step = Math.pow(10, -displayFractionDigits(symbol));
  if (abs > 0 && abs < step) {
    const decimals = Math.min(100, SMALL_AMOUNT_SIGNIFICANT_DIGITS - 1 - Math.floor(Math.log10(abs)));
    return `${sign}${abs.toFixed(decimals).replace(/0+$/, '')}`;
  }
  const [whole, frac = ''] = abs.toFixed(displayFractionDigits(symbol)).split('.');
  const digits = frac.replace(/0+$/, '').padEnd(2, '0');
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
  if (isStablecoin(symbol)) return stablecoinFigure(sign, absNum, truncateDecimal(decimal, 2));
  const step = Math.pow(10, -displayFractionDigits(symbol));
  if (absNum > 0 && absNum < step) {
    const decimals = Math.min(100, SMALL_AMOUNT_SIGNIFICANT_DIGITS - 1 - Math.floor(Math.log10(absNum)));
    return `${sign}${truncateDecimal(decimal, decimals).replace(/\.?0+$/, '')}`;
  }
  const [whole, frac = ''] = truncateDecimal(decimal, displayFractionDigits(symbol)).split('.');
  const digits = frac.replace(/0+$/, '').padEnd(2, '0');
  return `${sign}${whole}${digits ? `.${digits}` : ''}`;
}

/**
 * An exact decimal string as the transaction detail shows it. A stablecoin
 * reads like money: exactly two decimals, cut down ("1250.00", "4.91"), the
 * formatTokenBalanceDown rule. Every other asset drops trailing zeros and is
 * padded back to two decimals so a bare integer does not read as rounded
 * ("0.50", "1.00"); its digits beyond that are never cut: "0.0006" stays.
 */
export function detailAmountDigits(value: string, symbol: string | undefined | null): string {
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  if (isStablecoin(symbol)) return stablecoinFigure(negative ? '-' : '', Number(abs), truncateDecimal(abs || '0', 2));
  const [whole, frac = ''] = abs.split('.');
  const trimmed = frac.replace(/0+$/, '');
  const digits = trimmed.padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}${digits ? `.${digits}` : ''}`;
}

/**
 * A figure in running copy ("Vetting fee 0.05 USDC", "You can shield up to
 * 1,250.00 USDC"), with thousands separators. A stablecoin has exactly two
 * decimals (DEV-621), cut toward `direction`: a cost rounds up so it never
 * reads low, a limit or balance rounds down. Any other asset keeps up to
 * `maxDigits` decimals.
 */
export function formatCopyAmount(amount: number, symbol: string, direction: 'up' | 'down' = 'down', maxDigits = 6): string {
  if (!Number.isFinite(amount)) return '0';
  if (!isStablecoin(symbol)) return amount.toLocaleString('en-US', { maximumFractionDigits: maxDigits });
  const scaled = Math.abs(amount) * 100;
  const cents = (direction === 'up' ? Math.ceil(scaled * (1 - 1e-12)) : Math.floor(scaled * (1 + 1e-12))) / 100;
  return `${amount < 0 && cents > 0 ? '-' : ''}${cents.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Thousands separators for a figure that is only DISPLAYED ("4526.74 USDC" to
 * "4,526.74 USDC"). Every number in the text is grouped, the decimals and the
 * symbol untouched, and an already grouped figure stays as it is.
 *
 * Display only: the result is not a number any more. Never feed it back into an
 * input, a quote or a submit, and never run it over text that can hold an
 * address or a hash (hex digit runs would be grouped).
 */
export function groupThousands(text: string): string {
  return text.replace(/(\d+)(\.\d+)?/g, (_match, whole: string, fraction?: string) => {
    if (whole.length <= 3) return `${whole}${fraction ?? ''}`;
    return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ?? ''}`;
  });
}

/**
 * A short figure for a recommended-amount chip: "1000" to "1k", "12500" to
 * "12.5k", "1000000" to "1M". Below 1,000 it is the grouped figure as is.
 * Big presets ("100000 USDC") overflowed the chip row (Pat, 2026-11-02).
 *
 * Display only, like groupThousands: the chip still fills the exact preset.
 * Rounds DOWN to one decimal so a chip never reads more than it fills.
 */
export function compactAmountLabel(text: string): string {
  const n = Number(text);
  if (!Number.isFinite(n) || n < 1000) return groupThousands(text);
  const units: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  const [size, suffix] = units.find(([s]) => n >= s)!;
  const scaled = Math.floor((n / size) * 10) / 10;
  return `${scaled % 1 === 0 ? scaled.toFixed(0) : scaled.toFixed(1)}${suffix}`;
}

/**
 * The amount input's text while the field is NOT being typed in: grouped when it
 * is a plain decimal ("4526.5" to "4,526.5", "4526." to "4,526."), as is
 * otherwise. While focused the field keeps the raw text, so the caret and the
 * keystrokes are never fought by the separators.
 */
export function amountInputDisplay(raw: string, focused: boolean): string {
  if (focused || !/^\d+\.?\d*$/.test(raw)) return raw;
  return groupThousands(raw);
}

/**
 * What a typed or pasted amount means: separators dropped, nothing else
 * changed, so "4,526.50" reads as "4526.50". The only place display commas turn
 * back into an amount.
 */
export function stripAmountSeparators(text: string): string {
  return text.replace(/,/g, '');
}
