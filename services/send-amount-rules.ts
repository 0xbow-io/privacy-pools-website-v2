/**
 * Send-amount rules the form and its tests share (DEV-409, DEV-437).
 *
 * PURE (no react-native imports) so bun can pin it.
 */
import { formatUnits } from 'viem';

/**
 * Does the relayer fee come out of the typed amount (send-exact) or ride on top
 * of it (recipient receives the amount)?
 *
 * The ordinary rules: a full-balance entry, or one the fee would push over the
 * one-transfer cap, is gross (DEV-409, DEV-490), so Max and a typed balance
 * just work.
 *
 * EXCEPT an amount a caller handed in that the user has not touched (a payroll
 * salary, DEV-622 review on #78) while "Recipient receives the exact amount" is
 * ticked: that figure is what the payee is owed, so the fee stays on top and a
 * balance that cannot carry both gets the insufficient-balance error, instead
 * of a payment quietly short by the fee that leaves the row unpaid. An edit of
 * the amount or unticking the box returns to the ordinary rules.
 */
export function sendFeeMode(args: {
  enteredWei: bigint;
  capWei: bigint;
  feeWei: bigint | null | undefined;
  /** "Recipient receives the exact amount" is ticked. */
  requestedReceiveExact: boolean;
  /** The amount is still exactly what the opener handed in. */
  callerAmountUntouched: boolean;
  /** Relayed private send (the only path with a fee to place). */
  relayedSend: boolean;
  /** Same-signature resolver the Withdraw form uses (services/withdraw-quotes.ts). */
  resolveReceiveExact: (p: { requestedReceiveExact: boolean; enteredWei: bigint; totalBalanceWei: bigint; singleProofCapWei: bigint }) => boolean;
}): { maxGrossIntent: boolean; effectiveReceiveExact: boolean } {
  const { enteredWei, capWei, feeWei, requestedReceiveExact, callerAmountUntouched, relayedSend } = args;
  const owedOnTop = callerAmountUntouched && requestedReceiveExact && enteredWei > 0n;
  const maxGrossIntent = !owedOnTop && enteredWei > 0n && (
    enteredWei === capWei || (relayedSend && feeOverflowsCap(enteredWei, feeWei, capWei))
  );
  const effectiveReceiveExact = !maxGrossIntent && (owedOnTop || args.resolveReceiveExact({
    requestedReceiveExact, enteredWei, totalBalanceWei: capWei, singleProofCapWei: capWei,
  }));
  return { maxGrossIntent, effectiveReceiveExact };
}

/**
 * An amount at or under the one-transfer cap that the relayer fee would push
 * OVER it is gross: the fee comes out of it, the same way an exactly-Max entry
 * already is. Before this only an entry equal to the cap was gross, so Max
 * filled from a slightly different figure, or a typed full balance, errored
 * with "Amount plus the relayer fee exceeds…" (DEV-409).
 */
export function feeOverflowsCap(enteredWei: bigint, feeWei: bigint | null | undefined, capWei: bigint): boolean {
  if (enteredWei <= 0n || capWei <= 0n || feeWei == null) return false;
  return enteredWei <= capWei && enteredWei + feeWei > capWei;
}

/**
 * A cap shown next to a rejected amount must read smaller than that amount.
 * It is FLOORED (never rounded up) at 6 decimals, which keeps it close to the
 * true cap, or shown exact when even 6 decimals would not read below the
 * entry. "0.0050" beside a rejected 0.005 was the DEV-437 report.
 */
export function capText(capWei: bigint, enteredWei: bigint, decimals: number): string {
  const floorTo = (dp: number): bigint => {
    if (decimals <= dp) return capWei;
    const grain = 10n ** BigInt(decimals - dp);
    return (capWei / grain) * grain;
  };
  const shown = floorTo(6);
  // A positive cap below 0.000001 floors to 0, which would claim there is no
  // balance at all: show it exact instead (#157 review).
  if (shown === 0n && capWei > 0n) return formatUnits(capWei, decimals);
  return shown < enteredWei ? trim(formatUnits(shown, decimals)) : formatUnits(capWei, decimals);
}

function trim(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * Why an amount is over the one-transfer cap: the note caps (5 inputs, 2
 * deposits) only when the eligible balance is larger than the cap; otherwise
 * the amount is simply more than the balance (DEV-437).
 */
export function overCapReason(eligibleTotalWei: bigint, capWei: bigint): 'note-caps' | 'balance' {
  return eligibleTotalWei > capWei ? 'note-caps' : 'balance';
}

/**
 * The "Send at most" figure after the binding relayer fee is known (DEV-490).
 *
 * It is taken from the one-transfer cap, never from the notes picked for the
 * amount just tried. Those shrink with the amount, so each retry at the
 * suggested figure picked fewer notes and was told a smaller one (8.67 gave
 * 7.52, 7.5 then gave ~6.3). Floored to 6 decimals so it always passes.
 */
export function stableSendMax(capWei: bigint, feeWei: bigint, decimals: number): bigint {
  const max = capWei - feeWei;
  if (max <= 0n) return 0n;
  const grain = decimals > 6 ? 10n ** BigInt(decimals - 6) : 1n;
  const floored = (max / grain) * grain;
  // Below 0.000001 the floor would read "Send at most 0" beside an amount
  // that fits: show it exact instead (same rule as capText).
  return floored > 0n ? floored : max;
}

/** The binding fee came in above the one the form showed. */
export function feeMovedUp(formFeeWei: bigint | null | undefined, boundFeeWei: bigint): boolean {
  return formFeeWei != null && boundFeeWei > formFeeWei;
}
