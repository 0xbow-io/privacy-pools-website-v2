/**
 * What the user actually consented to at Review, as a floor for Confirm.
 *
 * Confirm re-estimates from scratch and refuses a route that got worse. The
 * floor was the reviewed note value itself, exactly, so ANY downward drift
 * refused: a cross-chain reshield re-quotes through LiFi, its output moves
 * between the two clicks essentially always, and the flow answered "The rate
 * moved against you since you reviewed" on attempt after attempt (QA,
 * 2026-09-22, 50 USDC into FDUSD on BNB).
 *
 * A zero-tolerance floor is also not what the screen said. The user picked a
 * max slippage and the review is labelled an estimate. Consent is therefore
 * "the reviewed figure, minus the slippage I chose", and that is the floor this
 * computes. Drift beyond it still stops and still asks, which is the point of
 * the gate: it protects against a route turning bad, not against it moving at
 * all.
 *
 * Deliberately NOT a fixed tolerance. Tying it to the control the user set
 * means a tighter slippage really is a tighter promise, and nobody has to pick
 * a magic number that is wrong for one pair or the other.
 */

/** Slippage is a fraction (0.005 = 0.5%). Basis points keep the maths integral. */
const BPS = 10_000n;

export function slippageBps(slippage: number): bigint {
  if (!Number.isFinite(slippage) || slippage <= 0) return 0n;
  // Round UP, so a floor is never stricter than the slippage shown.
  return BigInt(Math.ceil(slippage * Number(BPS)));
}

/**
 * The floor Confirm compares a fresh estimate against.
 *
 * Returns undefined when there is nothing to compare, which the caller passes
 * straight through: the gate is skipped rather than defaulted to zero.
 */
export function reshieldConsentFloor(
  reviewedNoteValueWei: bigint | undefined,
  slippage: number,
): bigint | undefined {
  if (reviewedNoteValueWei === undefined) return undefined;
  if (reviewedNoteValueWei <= 0n) return reviewedNoteValueWei;
  const allowance = slippageBps(slippage);
  if (allowance <= 0n) return reviewedNoteValueWei;
  if (allowance >= BPS) return 0n;
  return (reviewedNoteValueWei * (BPS - allowance)) / BPS;
}
