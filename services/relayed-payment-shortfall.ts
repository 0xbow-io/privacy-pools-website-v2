import { formatUnits } from 'viem';
import { isStablecoin } from '@/services/token-format';

/** Significant digits shown for an amount in a shortfall message. */
const SIG_DIGITS = 4;

/** Fraction digits a stablecoin figure is shown with (Mike, #282). */
const STABLE_FRACTION_DIGITS = 2;

/**
 * Show an amount at a human precision instead of every wei: 2 decimals for a
 * stablecoin (pass `symbol`), SIG_DIGITS significant digits otherwise.
 * `up` rounds toward what the user must provide (a cost, a shortfall), so the
 * number they act on is never too small; reachable balances round down.
 */
export function formatShortfallAmount(value: bigint, decimals: number, up: boolean, symbol?: string): string {
  if (value <= 0n) return '0';
  const digits = value.toString().length;
  const drop = isStablecoin(symbol)
    ? Math.max(0, decimals - STABLE_FRACTION_DIGITS)
    : Math.max(0, Math.min(decimals, digits - SIG_DIGITS));
  const unit = 10n ** BigInt(drop);
  let rounded = (value / unit) * unit;
  if (up && rounded < value) rounded += unit;
  return formatUnits(rounded, decimals);
}

/**
 * The relayed payment path spends amount + relayer fee out of the SAME inputs,
 * so "this cannot be funded" has three causes with different user actions:
 * short on value, single-lineage request, or value spread over more lineages
 * than one transact can draw from.
 *
 * It must NEVER suggest "pay from your wallet instead": that path puts the
 * payer's address on-chain next to the payment (product decision 2026-08-27).
 *
 * In the lineage cases "deposit a little more" is wrong: the transact circuit
 * conserves value per label, so a new deposit is a new lineage and cannot be
 * merged into an existing one (services/consolidate-notes.ts). The shield
 * target is therefore always `singleDepositTopUp`, never the bare shortfall.
 *
 * Copy is kept short (house rule): stablecoins at 2 decimals, other assets at
 * 4 significant digits, no em
 * dashes, the why lives in this comment and not in the toast.
 */
export function formatRelayedPaymentShortfall(params: {
  requestedAmount: bigint;
  /** null when the relayer quote could not be fetched. */
  relayerFee: bigint | null;
  /** Max coverable within BOTH caps for THIS request. */
  reachableAmount: bigint;
  /** Max coverable at the full TRANSFER_MAX_LABELS budget. */
  lineageBlindAmount: bigint;
  /** Every spendable note, ignoring both caps. */
  totalSpendable: bigint;
  tokenSymbol: string;
  decimals: number;
  /** Lineages this request may spend. */
  maxLabels: number;
  /** Smallest SINGLE new deposit that makes this payable. */
  singleDepositTopUp: bigint;
}): string {
  const up = (v: bigint) => `${formatShortfallAmount(v, params.decimals, true, params.tokenSymbol)} ${params.tokenSymbol}`;
  const down = (v: bigint) => `${formatShortfallAmount(v, params.decimals, false, params.tokenSymbol)} ${params.tokenSymbol}`;
  if (params.relayerFee === null) {
    return `Could not get a relayer fee quote. You can pay up to ${down(params.reachableAmount)} privately, before the fee. Try again in a moment.`;
  }
  const total = params.requestedAmount + params.relayerFee;
  // The fee is already inside `total`, so it is not named again (Mike, #282).
  const head = `Your balance isn't high enough. This payment needs ${up(total)}.`;
  const shield = `Shield at least ${up(params.singleDepositTopUp)} in one deposit, or ask for a smaller amount.`;
  // Enough value overall, but one transact caps inputs and deposits. Name the
  // one-deposit rule only when this request really is single-lineage; any
  // other cap (input count, selected inputs vs a fresh quote) gets the
  // neutral line (cubic review on #282).
  if (params.totalSpendable >= total) {
    const limit = params.maxLabels <= 1 && params.lineageBlindAmount >= total
      ? `This request can only use one deposit, and your largest covers ${down(params.reachableAmount)}.`
      : `You hold enough, but one payment can only use up to ${down(params.reachableAmount)} of it.`;
    return `${head} ${limit} ${shield}`;
  }
  return `${head} You can use up to ${down(params.reachableAmount)}. ${shield}`;
}
