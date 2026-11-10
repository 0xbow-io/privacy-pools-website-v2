// What a payment request's Amount field means, and the one place it crosses into
// the pool's units.
//
// The field is labelled with the COIN ("Amount (USDT)"), so a requester who types
// 100 asks for 100 USDT. A yield pool's own unit is a vault share worth more than
// one coin (rate 1.05: 100 shares are 105 USDT), so reading the typed text as a
// share count made the payer pay 105 (Matthew, PR 29 review).
//
// Design: convert the typed coin amount to exact shares ONCE, when the request is
// created, and keep that share count fixed in the link (the link format carries
// shares and is unchanged, old links decode as before). Pages that show the
// request display those shares at their current underlying value.
//
// Rounding: UP. The payer must pay at least what the requester typed, never less,
// so the share count is the smallest that redeems for at least the typed amount
// (sharesForUnderlyingCeil). The requester can receive at most one share base unit
// of value more than typed.
//
// Pure: no config imports, so it is bun-testable. The rate comes from the fixed
// feed grid (useShareRates); this module never fetches one.
import { sharesForUnderlyingCeil } from '@/services/underlying-amount-entry';
import { isShareSymbol } from '@/services/share-display';
import type { ShareRate } from '@/services/share-rates';

export type RequestAmountResolution =
  | { ok: true; /** exact decimal string in the pool's own units (shares for a share pool) */ units: string }
  | { ok: false; reason: 'rate-unavailable' | 'invalid' };

/**
 * The pool-unit amount a request for `text` (an amount of the coin) must carry.
 * A plain token is its own unit: the text passes through unchanged. A share
 * token needs its rate: without one nothing is converted and nothing is
 * returned, so a coin amount can never be sent on as a share count.
 */
export function requestAmountInPoolUnits(args: {
  text: string;
  symbol: string;
  rate: ShareRate | undefined;
}): RequestAmountResolution {
  const { text, symbol, rate } = args;
  const trimmed = text.trim();
  if (!isShareSymbol(symbol)) return { ok: true, units: trimmed };
  if (!rate || rate.assetsPerShare <= 0n) return { ok: false, reason: 'rate-unavailable' };
  const shares = sharesForUnderlyingCeil(trimmed, rate);
  return shares ? { ok: true, units: shares } : { ok: false, reason: 'invalid' };
}

/** True while a share request's field cannot convert yet (no rate): the field waits. */
export function requestRateMissing(symbol: string, rate: ShareRate | undefined): boolean {
  return isShareSymbol(symbol) && (!rate || rate.assetsPerShare <= 0n);
}
