// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
// Display-only coin names and amount formatting. Raw symbols stay in state,
// proof/signing inputs, storage and analytics. Accounting exports write a share
// as its underlying coin and amount at the time of the transaction.
// UI amounts use the converted value when available; otherwise share counts
// keep the share symbol until the rate is known.

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

/** Converted underlying when supplied; otherwise the count under its share symbol. */
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
    : `${format(amount, assetSymbol)} ${assetSymbol}`;
}

/** Legacy preformatted fallback. Share strings keep their own units until converted by the caller. */
export function approxUnderlyingText(text: string, assetSymbol: string): string {
  if (!text || isShareSymbol(assetSymbol)) return text;
  return text.replace(new RegExp(`\\b${assetSymbol}\\b`, 'gi'), displayTokenSymbol(assetSymbol));
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
 * amount unless it HAS been converted: converted → "≈ 105.2 USDC"; read in
 * flight → "Estimating USDC…"; not readable → the share count labelled as the
 * share ("100 ppUSDC"). Anything else: amount + its own symbol.
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
  if (underlying != null) return `≈ ${format(underlying, underlyingSymbol)} ${underlyingSymbol.toUpperCase()}`;
  if (pending) return `Estimating ${underlyingSymbol.toUpperCase()}…`;
  // A failed rate read keeps the count under its own share symbol.
  return `${format(shares, shareSymbol)} ${shareSymbol}`;
}
/**
 * A preformatted share COUNT on a surface that never names the share (the Swap
 * tab, DEV-591): "0.00999 ETH shares". The coin the user knows, and plainly a
 * count of shares rather than an ETH figure, so it cannot read as a fee. Use it
 * only where no rate is at hand; with a rate, show the converted underlying.
 * Anything that is not a share is its amount and coin, as tokenAmountLabel.
 */
export function shareCountLabel(amount: string, symbol: string): string {
  const coin = displayTokenSymbol(symbol);
  return isShareSymbol(symbol) ? `${amount} ${coin} shares` : `${amount} ${coin}`;
}

/** The fields of a balance view (services/share-balance-display.ts) this rule touches. */
type BalanceViewLike = { text: string; symbol: string; converted: boolean; hint: string | null };

/**
 * A balance view for a surface that never names the share (DEV-591). Converted:
 * the underlying figure, with the (i) hint's share count unnamed ("0.0998
 * shares, worth 0.1 ETH today"). Rate not known yet: the count as
 * shareCountLabel, never under the share's own symbol. Display only, like the
 * view it wraps: nothing here may feed an amount.
 */
export function underlyingOnlyView<V extends BalanceViewLike>(view: V, assetSymbol: string): V {
  if (!isShareSymbol(assetSymbol)) return view;
  const named = new RegExp(`\\s*\\b${assetSymbol}\\b`, 'gi');
  if (view.converted) {
    return { ...view, hint: view.hint ? view.hint.replace(named, '') : view.hint };
  }
  const coin = displayTokenSymbol(assetSymbol);
  const count = view.text.replace(named, '').trim();
  return {
    ...view,
    symbol: coin,
    text: /^0(?:\.0*)?$/.test(count) ? `0 ${coin}` : shareCountLabel(count, assetSymbol),
    hint: null,
  };
}

/**
 * Preformatted raw units at a display boundary, without claiming a share is
 * 1:1. Renames and marks only; convert first where a rate is available.
 */
export function tokenAmountLabel(amount: string, symbol: string): string {
  return `${amount} ${isShareSymbol(symbol) ? symbol : displayTokenSymbol(symbol)}`;
}

/**
 * The unit a share-denominated FIELD reads under while no rate is known:
 * "ETH shares", never the share's own name. Anything else is its coin. Display
 * only: the field's value stays the exact share count.
 */
export function shareUnitLabel(symbol: string): string {
  return isShareSymbol(symbol) ? `${displayTokenSymbol(symbol)} shares` : displayTokenSymbol(symbol);
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
 * else reads "0.1 ETH shares"; a bare share name reads as its coin. Display
 * only: never parse the result back into an amount.
 */
export function shareFreeText(text: string, amountText?: (exact: string, symbol: string) => string): string {
  return text.replace(SHARE_NAME_IN_TEXT, (_match, approx: string | undefined, count: string | undefined, symbol: string) => {
    if (count == null) return displayTokenSymbol(symbol);
    if (amountText) return amountText(count.replace(/,/g, ''), symbol);
    return `${approx ?? ''}${shareCountLabel(count, symbol)}`;
  });
}
