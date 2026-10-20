// Display-only coin names and amount formatting. Raw symbols stay in state,
// proof/signing inputs, storage and analytics. Accounting exports write a share
// as its underlying coin and amount at the time of the transaction.
// UI amounts use the converted value when available; otherwise share counts
// are explicitly approximate under their coin name.

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
 * A transaction amount under the name the user is shown. For an ordinary asset
 * that is its own symbol and its own number. For a SHARE it is always the
 * underlying's name (Pat, relaying Ameen, 2026-09-12: the share is named
 * nowhere), with the figure converted when the live rate has been read.
 *
 * Before the rate lands - it is an on-chain read, so the first paint of a feed
 * is usually without it - the share COUNT is printed under the underlying's
 * name and marked approximate. That is the one place a number and a symbol
 * come from different objects, and it is deliberate:
 *   - the gap is the accrued exchange rate (1.0007 USDC per share today), so
 *     the tilde is honest at the precision shown;
 *   - it UNDERSTATES, never overstates, so the row can never claim more than
 *     the note holds;
 *   - the alternative shipped the share count under the SHARE's name, and a
 *     deposit of 49.913840 USDC then read "49.87911 ppUSDC", which looks like
 *     a fee was taken (Pat, 2026-09-12).
 * Once the rate arrives the same row prints the exact converted figure.
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
    : `≈ ${format(amount, symbol)} ${symbol}`;
}

/**
 * The same rule for an amount that arrives ALREADY FORMATTED with its symbol
 * in it - the ASP's compact figures ("1.23K ppUSDC"), a provider's
 * balanceToken. Renames the share to its underlying and marks the result
 * approximate, for exactly the reasons in shareAmountText. A non-share string
 * is returned untouched.
 */
export function approxUnderlyingText(text: string, assetSymbol: string): string {
  if (!text) return text;
  const symbol = displayTokenSymbol(assetSymbol);
  if (symbol === assetSymbol && !isShareSymbol(assetSymbol)) return text;
  const renamed = text.replace(new RegExp(`\\b${assetSymbol}\\b`, 'gi'), symbol);
  if (!isShareSymbol(assetSymbol)) return renamed;
  return renamed.trimStart().startsWith('≈') ? renamed : `≈ ${renamed}`;
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
  // The read failed rather than being in flight. Same rule as shareAmountText:
  // the share count under the UNDERLYING's name, marked approximate, because
  // naming the share here is the one thing this module may not do
  // (Pat, 2026-09-12).
  return `≈ ${format(shares, shareSymbol)} ${underlyingSymbol.toUpperCase()}`;
}

/**
 * Preformatted raw units at a display boundary, without claiming a share is
 * 1:1. Renames and marks only; convert first where a rate is available.
 */
export function tokenAmountLabel(amount: string, symbol: string): string {
  return `${isShareSymbol(symbol) ? '≈ ' : ''}${amount} ${displayTokenSymbol(symbol)}`;
}
