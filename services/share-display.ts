// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay. While the rate
// is unknown a figure is LOADING ("… USDC", LOADING_FIGURE), rendered as the
// Portfolio shimmer; a count stand-in never reaches the screen, not even marked
// approximate (DEV-621). The share symbol itself is never shown (Mike,
// 2026-11-07).
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
// Display-only coin names and amount formatting. Raw symbols stay in state,
// proof/signing inputs, storage and analytics. Accounting exports write a share
// as its underlying coin and amount at the time of the transaction.
// UI amounts use the converted value when available; otherwise the figure is
// loading until the rate is known.

import { displayFractionDigits, formatTokenBalance, formatTokenBalanceDown, isStablecoin, LOADING_FIGURE } from '@/services/token-format';

/** Share symbol (upper-cased) → the underlying it is denominated in. */
const SHARE_UNDERLYING: Record<string, string> = {
  PPUSDC: 'USDC',
  PPUSDT: 'USDT',
  // ppETH (mainnet, 2026-09-18): the router wraps native ETH into WETH on the
  // way in, so the coin the user knows and deposits is ETH, not WETH.
  PPETH: 'ETH',
};

/**
 * Underlying symbols the user never chose. ppETH's underlying is WETH because the
 * router wraps on the way in, but the coin deposited, priced and paid out is ETH;
 * a balance, pending line or payout that says WETH names plumbing (Pat,
 * 2026-09-18). Display only, like SHARE_UNDERLYING: never a lookup key.
 */
const UNDERLYING_DISPLAY: Record<string, string> = {
  WETH: 'ETH',
};

/** True for a symbol this app knows to be a yield-bearing share. */
export function isShareSymbol(symbol: string | null | undefined): boolean {
  return !!symbol && (symbol.toUpperCase() in SHARE_UNDERLYING);
}

/** Headline symbol: the underlying for a share ("USDC" for ppUSDC), else itself. */
export function displayTokenSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (upper === 'CBTC') return 'cBTC';
  return SHARE_UNDERLYING[upper] ?? UNDERLYING_DISPLAY[upper] ?? symbol;
}

/**
 * Subtitle for a share, or null for anything else. With a live rate:
 * "Earns 2.88% net APY"; without: "Earns Aave yield". The share is not named
 * (see the header).
 */
export function shareSubtitle(symbol: string, netApyPercent?: number | null): string | null {
  if (!isShareSymbol(symbol)) return null;
  return typeof netApyPercent === 'number' && Number.isFinite(netApyPercent)
    ? `Earns ${netApyPercent.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% net APY`
    : 'Earns Aave yield';
}

/** Subtitle for a withdraw-only legacy asset (deposits closed, notes spendable). */
export const LEGACY_ASSET_SUBTITLE = 'Deposits closed · withdraw or send';

/**
 * Subtitle for a pool that has not OPENED yet (`depositComingSoon`, mainnet
 * ETH). The mirror image of LEGACY_ASSET_SUBTITLE: that one says a pool is
 * over, this one says it has not started. Both keep the asset visible, which
 * is the point - a user who came to deposit ETH gets an answer instead of an
 * absence.
 */
export const COMING_SOON_ASSET_SUBTITLE = 'Deposits available soon';

/** The same sentence in full, for a toast or a caption that has no row to sit under. */
export function comingSoonDepositMessage(symbol: string, chainName?: string): string {
  const shown = displayTokenSymbol(symbol);
  return chainName
    ? `${shown} deposits on ${chainName} are coming soon.`
    : `${shown} deposits are coming soon.`;
}

/**
 * Subtitle for an asset you PAY with that the PPRouter wraps on the way in
 * (mainnet USDC and USDT). Such an asset is withdraw-only for a plain
 * Entrypoint deposit, so the legacy line called it closed on the very picker
 * where it works (Pat, 2026-09-04). Say what it earns instead.
 *
 * `shareSymbol` is the GATE, not the copy: present means this build has a
 * share pool for the asset. It is no longer printed (Pat, 2026-09-12), so the
 * row reads the same line a share row does, which is right - they are one
 * pool.
 */
export function wrapsIntoShareSubtitle(shareSymbol: string | undefined): string | null {
  if (!shareSymbol) return null;
  return 'Earns Aave yield';
}

/**
 * Converted underlying when supplied. While the rate is unknown the figure is
 * loading ("… USDC"): a count is not what the note is worth, so it is never
 * shown in its place (DEV-621). The share's own name is never shown.
 */
export function shareAmountText(args: {
  amount: number;
  assetSymbol: string;
  /** The share amount converted to underlying, or null while the rate is unknown. */
  underlyingAmount: number | null;
  format: (amount: number, symbol: string) => string;
}): string {
  const { amount, assetSymbol, underlyingAmount, format } = args;
  if (!isShareSymbol(assetSymbol)) return `${format(amount, displayTokenSymbol(assetSymbol))} ${displayTokenSymbol(assetSymbol)}`;
  const symbol = displayTokenSymbol(assetSymbol);
  return underlyingAmount != null
    ? `${format(underlyingAmount, symbol)} ${symbol}`
    : `${amount === 0 ? format(0, symbol) : LOADING_FIGURE} ${symbol}`;
}

/**
 * The same rule for an amount that arrives ALREADY FORMATTED with its symbol in
 * it (an ASP compact figure, a provider balanceToken): a share is renamed to its
 * underlying and its figure, a count, reads as loading ("… USDC"). A
 * non-share string is only renamed.
 */
export function approxUnderlyingText(text: string, assetSymbol: string): string {
  if (!text) return text;
  const symbol = displayTokenSymbol(assetSymbol);
  if (symbol === assetSymbol && !isShareSymbol(assetSymbol)) return text;
  const renamed = text.replace(new RegExp(`\\b${assetSymbol}\\b`, 'gi'), symbol);
  if (!isShareSymbol(assetSymbol)) return renamed;
  return renamed.replace(/(?:[≈~]\s*)?<?\d[\d,]*(?:\.\d+)?[KMB]?/gi, (figure) => shareCountFigure(figure));
}

/**
 * Net SHARES leaving after the relayer fee, sized the way submit sizes them:
 * the entered amount in receive-exact mode, entered − fee otherwise. Null when
 * nothing is left. Bigint in, bigint out: no float ever touches it.
 */
export function netSharesWei(enteredWei: bigint, feeWei: bigint, receiveExact: boolean): bigint | null {
  const net = receiveExact ? enteredWei : enteredWei - feeWei;
  return net > 0n ? net : null;
}

/**
 * Review/success headline for the net figure. A share never reads as a USDC
 * amount unless it HAS been converted: converted → "~105.20 USDC" (an
 * estimate: the vault rate moves until it settles); read in flight →
 * "Estimating USDC…"; not readable → loading ("… USDC"), never the count.
 * Anything else: amount + its own symbol.
 */
export function shareReviewHeadline(args: {
  isShare: boolean;
  shares: number;
  shareSymbol: string;
  underlyingSymbol: string;
  underlying: number | null;
  pending: boolean;
  format: (amount: number, symbol: string) => string;
}): string {
  const { isShare, shares, shareSymbol, underlying, pending, format } = args;
  // The underlying as the user knows it (WETH reads as ETH).
  const underlyingSymbol = displayTokenSymbol(args.underlyingSymbol);
  if (!isShare) return `${format(shares, shareSymbol)} ${underlyingSymbol}`;
  if (underlying != null) return `~${format(underlying, underlyingSymbol)} ${underlyingSymbol.toUpperCase()}`;
  if (pending) return `Estimating ${underlyingSymbol.toUpperCase()}…`;
  // A failed rate read: still loading, never the count (shareAmountText).
  return `${LOADING_FIGURE} ${underlyingSymbol.toUpperCase()}`;
}

/**
 * The number in the greyed "Receive publicly as USDC" preview on the Withdraw
 * form, shown before Review. A share pool holds the amount in SHARES, so the
 * figure must be the redeemed underlying: printing the share count under the
 * coin's name understated a 4000 USDC exit as 3,980.01 when the rate was 1.005.
 * Null while the redeem read is unknown, so the caller shows a dash rather than
 * a wrong number.
 */
export function previewReceiveFigure(args: { isShare: boolean; amount: number; underlying: number | null }): number | null {
  return args.isShare ? args.underlying : args.amount;
}

/**
 * A quote's rate line, "1 ETH = 2,512.12 USDC", from the quote's own rate and
 * the balance views of one unit of each side (a pool side at its vault rate).
 * The figure loads while either side's rate does, and is formatted by the
 * coin's own rules (two decimals for a stablecoin), never a raw float.
 */
export function swapRateText(
  rate: number,
  from: { symbol: string; amount: number; loading?: boolean },
  to: { symbol: string; amount: number; loading?: boolean },
): string {
  const fromCoin = displayTokenSymbol(from.symbol);
  const toCoin = displayTokenSymbol(to.symbol);
  if (from.loading || to.loading || !(from.amount > 0) || !Number.isFinite(rate)) return `1 ${fromCoin} = ${LOADING_FIGURE} ${toCoin}`;
  return `1 ${fromCoin} = ${formatTokenBalance(rate * to.amount / from.amount, toCoin)} ${toCoin}`;
}

/**
 * A share count where a figure is due: zero is zero in any unit, so it is kept;
 * anything else is not what the note is worth and reads as loading.
 */
function shareCountFigure(figure: string): string {
  return /^[\d,.]+$/.test(figure) && Number(figure.replace(/,/g, '')) === 0 ? figure : LOADING_FIGURE;
}

/**
 * Preformatted raw units at a display boundary, without claiming a share is
 * 1:1: a share count is not shown at all, the figure reads as loading
 * ("… USDC"). Convert first where a rate is available.
 */
/**
 * An exact decimal in a PLAIN token as a figure to show: a stablecoin reads like
 * money, two decimals cut down ("1.00", "2.99"); every other token, and any
 * share symbol, is returned untouched (DEV-621). Display only, the exact amount
 * is kept by the caller.
 */
export function plainTokenFigure(exact: string, symbol: string): string {
  return !isShareSymbol(symbol) && isStablecoin(symbol) ? formatTokenBalanceDown(exact, displayTokenSymbol(symbol)) : exact;
}

export function tokenAmountLabel(amount: string, symbol: string): string {
  return `${isShareSymbol(symbol) ? shareCountFigure(amount.trim()) : amount} ${displayTokenSymbol(symbol)}`;
}

// A share symbol as a whole word in free text, case-insensitive.
const SHARE_WORD = new RegExp(`(?<![A-Za-z0-9_])(${Object.keys(SHARE_UNDERLYING).join('|')})(?![A-Za-z0-9_])`, 'gi');
// A figure written right before a share symbol ("1.5 ppUSDC", "1,234.5K ppUSDT"),
// with any approximate marker already in front of it.
const SHARE_FIGURE = new RegExp(
  `([≈~]\\s*)?(?<![\\w.])(\\d[\\d,]*(?:\\.\\d+)?[KMB]?)\\s+(${Object.keys(SHARE_UNDERLYING).join('|')})(?![A-Za-z0-9_])`,
  'gi',
);

/** withoutShareNames with its rate lookup bound: a string in, a string out. */
export type ShareNameText = {
  (text: string): string;
  (text: string | null | undefined): string | null | undefined;
};

/** Underlying units one whole share is worth, by share symbol; undefined while unknown. */
export type ShareRateOf = (shareSymbol: string) => number | undefined;

// Words that make the figure after them a COST (rounded up) or a LIMIT
// (rounded down). The nearest one before the figure, in the same clause, wins.
const COST_WORDS = /\b(fees?|needs?|needed|requires?|required|costs?|minimum|min|at least|short(?:fall)?|missing)\b/gi;
const LIMIT_WORDS = /\b(max(?:imum)?|at most|up to|ha(?:ve|s)|available|balance|limit|cap|spendable|left|remaining)\b/gi;

function lastIndexOfWord(text: string, words: RegExp): number {
  let last = -1;
  words.lastIndex = 0;
  for (let m = words.exec(text); m; m = words.exec(text)) last = m.index;
  return last;
}

/**
 * Which way a converted figure rounds, from the words before it in its clause:
 * a cost ("fee", "needs", "at least") rounds UP so it never reads low, anything
 * else (a max, a balance, a bare figure) rounds DOWN so typing it back is never
 * refused (Pat: caps/limits/spendable down, fees/costs/needed up).
 */
export function figureRounding(before: string): 'up' | 'down' {
  const clause = before.split(/[.;!?\n](?=\s|$)|,\s/).pop() ?? '';
  return lastIndexOfWord(clause, COST_WORDS) > lastIndexOfWord(clause, LIMIT_WORDS) ? 'up' : 'down';
}

/**
 * A figure as written in text ("1,234.5", "1.23K") times a rate, written the
 * same way. Precision is the underlying's display digits (2 for a stablecoin, 5
 * otherwise), so an integer figure keeps the rate ("1 ppETH" at 1.04 is
 * "1.04 ETH", not "1 ETH"); trailing zeros beyond the written precision go, and
 * a stablecoin with cents shows both. Rounds in `direction`, never to nearest.
 */
function convertFigure(figure: string, rate: number, underlying: string, direction: 'up' | 'down'): string | null {
  const m = /^([\d,]+)(?:\.(\d+))?([KMB]?)$/i.exec(figure);
  if (!m) return null;
  const value = Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`) * rate;
  if (!Number.isFinite(value)) return null;
  const written = m[2]?.length ?? 0;
  const digits = Math.min(Math.max(written, m[3] ? 2 : displayFractionDigits(underlying)), 6);
  const scale = 10 ** digits;
  // A hair of slack so float noise (1.15 x 100 = 114.99999…) does not cost a unit.
  const units = direction === 'up' ? Math.ceil(value * scale * (1 - 1e-12)) : Math.floor(value * scale * (1 + 1e-12));
  const exact = (units / scale).toFixed(digits);
  const [, frac = ''] = exact.split('.');
  let keep = Math.max(written, frac.replace(/0+$/, '').length);
  if (keep > 0 && isStablecoin(underlying)) keep = Math.max(keep, 2);
  return `${(units / scale).toLocaleString('en-US', {
    minimumFractionDigits: keep,
    maximumFractionDigits: keep,
    useGrouping: m[1].includes(','),
  })}${m[3]}`;
}

/**
 * Free text that may quote a share by name: an SDK or relayer error, a LiFi
 * status, a step label, a toast. Applied where such text is RENDERED, never to
 * the text a flow keeps, logs or reports. A bare share name becomes the
 * underlying's name. A figure written right before a share name is a share
 * count: with the live rate (`rateOf`, from the share-rate feed) it is
 * converted to the underlying (convertFigure: a cost rounds up, a limit or
 * anything else rounds down, see figureRounding); without one the figure
 * reads as loading ("… USDC"), the rule in shareAmountText. An estimate mark
 * in front of a converted figure is written "~". Text without a share name is
 * returned untouched.
 */
export function withoutShareNames(text: string, rateOf?: ShareRateOf): string;
export function withoutShareNames(text: string | null | undefined, rateOf?: ShareRateOf): string | null | undefined;
export function withoutShareNames(text: string | null | undefined, rateOf?: ShareRateOf): string | null | undefined {
  if (!text) return text;
  SHARE_WORD.lastIndex = 0;
  if (!SHARE_WORD.test(text)) return text;
  SHARE_WORD.lastIndex = 0;
  const marked = text.replace(SHARE_FIGURE, (_m, mark: string | undefined, figure: string, share: string, offset: number) => {
    const underlying = SHARE_UNDERLYING[share.toUpperCase()];
    const rate = rateOf?.(share.toUpperCase());
    const converted = rate != null && Number.isFinite(rate) && rate > 0
      ? convertFigure(figure, rate, underlying, figureRounding(text.slice(0, offset)))
      : null;
    return converted != null
      ? `${mark ? '~' : ''}${converted} ${underlying}`
      : `${LOADING_FIGURE} ${underlying}`;
  });
  return marked.replace(SHARE_WORD, (share: string) => SHARE_UNDERLYING[share.toUpperCase()]);
}

/**
 * A quick-amount chip: the preset figure and its unit. While the rate is
 * unknown the unit carries the approximate mark ("≈ ETH"), which belongs in
 * front of the number, so the chip reads "≈ 0.1 ETH", never "0.1 ≈ ETH".
 */
export function presetChipLabel(figure: string, unitLabel: string): string {
  const approx = /^[≈~]\s*/.exec(unitLabel);
  return approx ? `≈ ${figure} ${unitLabel.slice(approx[0].length)}` : `${figure} ${unitLabel}`;
}
