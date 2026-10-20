/**
 * SDK swap errors, in units instead of base units.
 *
 * The SDK builds its messages from raw amounts, which is right for a log and
 * wrong for a screen. One reached a user on 2026-09-22:
 *
 *   "Invalid transact params: LiFi needs 18623284 input but only 18623008
 *    available after fee. Reduce the amount or retry."
 *
 * Both figures are the SWAP INPUT token, which for a share is the underlying it
 * redeems to, so they are 6-decimal USDC: it needs 18.623284 and has 18.623008,
 * a shortfall of 0.000276. As base units the sentence is unreadable, and the
 * two numbers look identical at a glance, which makes the advice ("reduce the
 * amount") look absurd.
 *
 * This is the third SDK message this app has had to translate, after the two in
 * services/deposit-limits.ts. The pattern is the same: match the exact wording,
 * pull the figures, print them in the units the user is looking at, and leave
 * everything else untouched so an unrecognised error still reaches them whole.
 *
 * PURE: the units come from the caller (config/intent-swaps `swapInputUnits`,
 * which already resolves a share to its underlying), so a test drives the real
 * rule.
 */
import { approxUnderlyingText } from '@/services/share-display';
import { isRelayerOutOfGas, isRelayerRateLimited, relayerOutOfGasMessage, relayerRateLimitedMessage } from '@/services/transfer-outcome';
import { formatUnits } from 'viem';

export interface AmountUnits {
  decimals: number;
  symbol: string;
}

/**
 * `Invalid transact params: LiFi needs N input but only M available after fee.`
 *
 * Anchored on the SDK's wording, and both captures are required, so a reworded
 * upstream message falls through untranslated rather than being half-rewritten.
 */
const LIFI_INPUT_SHORTFALL = /LiFi needs\s+(\d+)\s+input but only\s+(\d+)\s+available after fee/i;

/** Trim a formatted amount to something readable without losing the difference. */
function amountText(raw: string, units: AmountUnits): string {
  return approxUnderlyingText(`${formatUnits(BigInt(raw), units.decimals)} ${units.symbol}`, units.symbol);
}

/**
 * A user-facing version of a swap error, or null when we do not recognise it.
 *
 * Null means "show what the SDK said". That is deliberate: an unrecognised
 * error is still information, and swallowing it would be worse than an ugly
 * one.
 */
export function friendlySwapError(message: string, units: AmountUnits): string | null {
  const shortfall = LIFI_INPUT_SHORTFALL.exec(message);
  if (shortfall) {
    const needed = shortfall[1]!;
    const available = shortfall[2]!;
    // The gap is the actionable part: "reduce the amount" is only useful if you
    // can see how far off you are, and at base-unit scale the two figures read
    // as the same number.
    const gap = BigInt(needed) - BigInt(available);
    return `This route needs ${amountText(needed, units)} but only ${amountText(available, units)} is left after the fee,`
      + ` a shortfall of ${amountText(gap.toString(), units)}. Reduce the amount slightly and try again.`;
  }
  return null;
}

/**
 * The relayer answered the relay-swap with an HTTP refusal: a 4xx from its own
 * simulation or gas cap, e.g. Mike's, verbatim on screen (DEV-459):
 *
 *   HTTP 400: {"message":"RelaySwaps failed: The contract function
 *   \"executeUnwrapped\" reverted (RelaySwaps_SwapFailed).", ...}
 *
 * or its 503 when its own wallet cannot pay for gas, or its 429 throttle (which
 * keeps the wait-and-retry copy Withdraw and Transfer show).
 *
 * A 4xx alone does not prove nothing was sent: the relayer's failWrite also
 * turns a failed or timed-out broadcast into a 400. So "Nothing was sent" is
 * only shown for answers the relayer gives BEFORE it signs: a simulation or
 * estimate revert, its gas-cap refusal, an expired fee commitment, or an
 * unsupported chain. A note already in flight gets its own copy. Anything else,
 * like a transport failure, returns null and keeps its own wording.
 */
const PRE_BROADCAST_REFUSAL = [
  // The body is JSON, so the quotes around the function name arrive escaped.
  /The contract function \\?"[^"\\]+\\?" reverted/,
  /rejected: estimated gas \d+ exceeds the relayer's cap/,
  /fee commitment has expired/i,
  /Swaps not supported for chain/,
];
const NULLIFIER_IN_FLIGHT = /Nullifier \S+ is already in-flight/;

export function relaySwapRefusalText(err: unknown): string | null {
  if (!(err instanceof Error) || err.name !== 'RelayerRejected') return null;
  if (isRelayerOutOfGas(err.message)) return relayerOutOfGasMessage('swap');
  if (isRelayerRateLimited(err.message)) return relayerRateLimitedMessage('swap');
  if (!/^HTTP 4\d\d\b/.test(err.message)) return null;
  if (NULLIFIER_IN_FLIGHT.test(err.message)) return 'A swap from this balance is still pending. Wait for it to finish before trying again.';
  return PRE_BROADCAST_REFUSAL.some((re) => re.test(err.message)) ? 'The swap could not be executed. Nothing was sent.' : null;
}
