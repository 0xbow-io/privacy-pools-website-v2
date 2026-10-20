/**
 * Why a swap cannot cover the amount, when it cannot.
 *
 * Three different limits all used to surface as one sentence with one number
 * ("A swap spends up to 5 approved notes in one proof. Largest spendable now:
 * 18.827507 ppUSDC"), so a user holding more than that could not tell whether
 * the rest was waiting for approval, or excluded by the input cap, or simply
 * not there. QA read it as the swap being unable to spend two notes at all
 * (Mike, 2026-09-23). It can; it spends up to five, the same as withdraw.
 *
 * Pure so it can be tested: the component that owns the note set cannot be.
 */
import { approxUnderlyingText, displayTokenSymbol } from '@/services/share-display';
import { formatTokenUnits } from '@/services/intent-swaps';

export type NoteShortfallReason = 'unapproved' | 'input-cap' | 'insufficient';

export interface NoteShortfall {
  reason: NoteShortfallReason;
  /** What the selection could actually spend right now. */
  selectableWei: bigint;
  /** Held in this asset but not spendable yet, for the reason above. */
  withheldWei: bigint;
}

/**
 * @param totalWei every ACTIVE note in the spent asset, approved or not
 * @param approvedWei the ACTIVE notes the ASP has approved
 * @param selectableWei what the selector could cover within the input cap
 */
export function noteShortfall(args: {
  totalWei: bigint;
  approvedWei: bigint;
  selectableWei: bigint;
}): NoteShortfall {
  const { totalWei, approvedWei, selectableWei } = args;
  // Order matters: the cap is checked first because it is the one the user can
  // act on immediately (swap less, or consolidate). Approval is a wait.
  if (selectableWei < approvedWei) {
    return { reason: 'input-cap', selectableWei, withheldWei: approvedWei - selectableWei };
  }
  if (approvedWei < totalWei) {
    return { reason: 'unapproved', selectableWei, withheldWei: totalWei - approvedWei };
  }
  return { reason: 'insufficient', selectableWei, withheldWei: 0n };
}

/** One sentence, and a second only when there is something else to say. */
export function noteShortfallMessage(
  shortfall: NoteShortfall,
  units: { symbol: string; decimals: number },
  maxInputs = 5,
): string {
  // A share reads as its coin, and its amounts are share counts, so they carry
  // the approximate marker (services/share-display.ts). Anything else is as is.
  const coin = displayTokenSymbol(units.symbol);
  const amount = (wei: bigint) => approxUnderlyingText(`${formatTokenUnits(wei, units.decimals)} ${units.symbol}`, units.symbol);
  if (shortfall.selectableWei <= 0n && shortfall.reason === 'unapproved') {
    return `None of your ${coin} notes are approved yet. ${amount(shortfall.withheldWei)} is waiting.`;
  }
  if (shortfall.selectableWei <= 0n) {
    return `No approved, spendable ${coin} notes are available yet.`;
  }
  switch (shortfall.reason) {
    case 'input-cap':
      return `A swap spends up to ${maxInputs} notes in one proof, which covers ${amount(shortfall.selectableWei)} of what you hold. Swap that or less, or send yourself one note first.`;
    case 'unapproved':
      return `Spendable now: ${amount(shortfall.selectableWei)}. Another ${amount(shortfall.withheldWei)} is waiting for approval.`;
    default:
      return `Your approved ${coin} notes come to ${amount(shortfall.selectableWei)}.`;
  }
}
