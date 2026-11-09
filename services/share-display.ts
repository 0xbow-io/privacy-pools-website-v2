// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay. The screen
// never shows the pool unit's noun or its own symbol (Pat, hard rule), and a
// figure that cannot be converted yet is LOADING ("… USDC", LOADING_FIGURE),
// rendered as the Portfolio shimmer, never the count (DEV-621).
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
// Display-only coin names and amount formatting. Raw symbols stay in state,
// proof/signing inputs, storage and analytics. Accounting exports write a share
// as its underlying coin and amount at the time of the transaction.
// UI amounts use the converted value when available; otherwise the figure is
// loading until the rate is known.

import { formatTokenBalance, LOADING_FIGURE } from '@/services/token-format';

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

/**
 * Payout for a share note: the withdraw flow REDEEMS it through the PPRouter
 * (share in, underlying out), always. When the router route is unavailable
 * the flow refuses with a clear error rather than paying the share, so this
 * line can promise the underlying without a fallback clause (Pat,
 * 2026-09-05: "withdrawing ppUSDC should always unwrap to USDC").
 */
export function shareRedemptionDisclosure(symbol: string): string | null {
  if (!isShareSymbol(symbol)) return null;
  return `You receive ${displayTokenSymbol(symbol)}, redeemed at the vault on the way out.`;
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
  return chainName
    ? `${symbol} deposits on ${chainName} are coming soon.`
    : `${symbol} deposits are coming soon.`;
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
 * it: a share is renamed to its coin and its figure, a count, reads as loading
 * ("… USDC"). A non-share string is only renamed.
 */
export function approxUnderlyingText(text: string, assetSymbol: string): string {
  if (!text) return text;
  const renamed = text.replace(new RegExp(`\\b${assetSymbol}\\b`, 'gi'), displayTokenSymbol(assetSymbol));
  if (!isShareSymbol(assetSymbol)) return renamed;
  return renamed.replace(/(?:[≈~]\s*)?<?\d[\d,]*(?:\.\d+)?[KMB]?/gi, (figure) => shareCountFigure(figure));
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

/** The fields of a balance view (services/share-balance-display.ts) this rule touches. */
type BalanceViewLike = { text: string; symbol: string; converted: boolean; hint: string | null };

/**
 * A balance view guaranteed not to name the share (DEV-591). shareBalanceDisplay
 * already reads under the coin; this is the belt on top: any share name left in
 * the text or hint becomes the coin, and an unconverted view has no hint. A
 * loading view keeps `loading`, so a rendered figure still shows the shimmer.
 * Display only, like the view it wraps: nothing here may feed an amount.
 */
export function underlyingOnlyView<V extends BalanceViewLike>(view: V, assetSymbol: string): V {
  if (!isShareSymbol(assetSymbol)) return view;
  const coin = displayTokenSymbol(assetSymbol);
  const named = new RegExp(`\\b${assetSymbol}\\b`, 'gi');
  return {
    ...view,
    symbol: coin,
    text: view.text.replace(named, coin),
    hint: view.converted && view.hint ? view.hint.replace(named, coin) : null,
  };
}

/**
 * Preformatted raw units at a display boundary, without claiming a share is
 * 1:1: a share count is not shown at all, the figure reads as loading
 * ("… USDC", the shimmer where it is rendered: FigureText). Never the share's
 * name. Convert first where a rate is available.
 */
export function tokenAmountLabel(amount: string, symbol: string): string {
  return `${isShareSymbol(symbol) ? shareCountFigure(amount.trim()) : amount} ${displayTokenSymbol(symbol)}`;
}

/** Every share name this app knows, in free text (an error, a toast, a status line). */
const SHARE_NAME_IN_TEXT = new RegExp(
  `(?:(≈\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)\\s+)?\\b(${Object.keys(SHARE_UNDERLYING).join('|')})\\b`,
  'gi',
);

/**
 * Free text with every share name taken out, for messages built from a share
 * amount or handed up by the SDK or relayer (Send, 2026-10-24: a share name
 * flashed in the transfer flow). "<count> <share>" goes through `amountText`
 * when the caller has a rate-aware renderer (balance view, already share-free),
 * else reads as loading ("… ETH"); a bare share name reads as its coin. Display
 * only: never parse the result back into an amount.
 */
export function shareFreeText(text: string, amountText?: (exact: string, symbol: string) => string): string {
  return text.replace(SHARE_NAME_IN_TEXT, (_match, _approx: string | undefined, count: string | undefined, symbol: string) => {
    if (count == null) return displayTokenSymbol(symbol);
    if (amountText) return amountText(count.replace(/,/g, ''), symbol);
    return tokenAmountLabel(count, symbol);
  });
}
