// The relayer quotes its fee in GAS, then converts that gas cost into the
// withdrawn token through a live market rate (CowSwap on mainnet). Confirm
// re-quotes after Review, so the figure the user agreed to and the figure the
// relayer charges are taken at two different moments and are never bit-identical.
//
// This allowance is what the guard accepts between those two moments. It is a
// fraction of the FEE, not of the withdrawal.
//
// MEASURED, twice, because the first calibration was made from a single
// observation and was wrong by two orders of magnitude:
//
//   2026-09-05  two quotes 7 s apart at an unchanged gasPrice 79091466 differed
//               by 2 units in the last digits: pure market-rate tick.
//   2026-09-20  remeasured properly. At constant gas the spread is 45 to 470
//               ppm, not the ~0 the single sample suggested. Across a block
//               change, where the gas price itself moves, 1 to 4%.
//   2026-09-22  a live refusal: quoted 483638121340492343 against a reviewed
//               483480943603254602. That is 325 ppm, an ordinary constant-gas
//               re-quote, and the old 1 ppb allowance refused it. It refused
//               repeatedly, so the withdrawal could not be completed at all.
//
// 1 ppb was therefore about 300 times tighter than the fee actually moves, and
// it was not protecting anything: a relayer that wanted more would take a
// different amount entirely, not one part per billion more. What it did instead
// was refuse honest quotes and tell the user "Nothing was sent."
//
// 1% covers constant-gas drift with roughly 20 to 200 times headroom. It does
// NOT cover a gas-price change between Review and Confirm, which runs to 4%:
// that case still refuses, and refusing is right, because the fee genuinely
// went up and the user should see the new one. The structural fix for it is to
// re-quote at Confirm and re-seek consent, which is a UX change, not a constant.
//
// THE COST, because this number is not free. The allowance is pre-paid: note
// selection covers fee + allowance, and in gross mode the recipient's net is
// reduced by the whole allowance whether or not the re-quote uses it. So 1% of
// the fee comes off the recipient in gross mode. On a fee of 0.48 ppUSDC that is
// half a cent; on a small ETH withdrawal, where the fee can be half the amount,
// it is about 0.5% of the withdrawal. That is the price of the withdrawal
// completing at all, and it is the lever to pull if it is judged too high.
//
// Fund safety does not rest on this number. It rests on the allowance being
// paid up front, so the gross leaving the pool never exceeds what the entry
// covered, and on the guard still aborting anything above the band.

/** 1% of the reviewed fee, as parts per billion. */
export const RELAYER_FEE_JITTER_PPB = 10_000_000n;
export const RELAYER_FEE_JITTER_FLOOR_UNITS = 16n;

/** How far above the reviewed fee a re-quote may land and still be the same fee. */
export function relayerFeeJitterAllowance(reviewedFeeWei: bigint): bigint {
  if (reviewedFeeWei <= 0n) return 0n;
  const ppb = (reviewedFeeWei * RELAYER_FEE_JITTER_PPB) / 1_000_000_000n;
  return ppb > RELAYER_FEE_JITTER_FLOOR_UNITS ? ppb : RELAYER_FEE_JITTER_FLOOR_UNITS;
}

/** True when `feeWei` is at most the reviewed fee plus its jitter allowance. */
export function feeWithinReviewed(feeWei: bigint, reviewedFeeWei: bigint): boolean {
  return feeWei <= reviewedFeeWei + relayerFeeJitterAllowance(reviewedFeeWei);
}
