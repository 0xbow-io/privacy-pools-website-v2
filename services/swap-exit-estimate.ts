/**
 * The LiFi input for a FORM-TIME swap-exit estimate.
 *
 * The withdraw form used to show an honest dash for a swap exit until Review,
 * because the real quote is the SDK's: relayer fee committed, then LiFi
 * routed on the net. Users read the dash as "no quote" (Pat, 2026-08-29).
 * The Shield tab already previews its LiFi route live with a direct
 * `li.quest/v1/quote` estimate; this gives the withdraw form the same
 * preview, over the same amount the SDK will route:
 *
 *   net = gross − fee·(1 + WITHDRAW_SWAP_FEE_BUFFER_BPS/10 000)
 *
 * (PoolSessionWithdrawAndSwap inflates the fee by 30 bps before routing so
 * the committed fee can drift without starving the swap.) Before Review no
 * relayer fee exists yet — the form does not quote the relayer — so the
 * estimate then runs on the GROSS and is marked approximate; Review's figure
 * will be a hair lower. Nothing here is committed or spent; the SDK's own
 * quote at Review stays the only figure that binds.
 *
 * PRIVACY: the request carries amount, tokens, chains and a public address
 * (the swap processor); no note-derived value. Same shape as the Shield
 * preview and as the SDK's own LiFi request.
 */
export const WITHDRAW_SWAP_FEE_BUFFER_BPS = 30n;

export function swapExitEstimateInputWei(input: {
  grossWei: bigint;
  /** Relayer fee in the input token's wei, when one is known; null before Review. */
  feeWei: bigint | null;
}): bigint {
  const { grossWei, feeWei } = input;
  if (grossWei <= 0n) return 0n;
  if (feeWei === null || feeWei <= 0n) return grossWei;
  const inflated = feeWei + (feeWei * WITHDRAW_SWAP_FEE_BUFFER_BPS) / 10_000n;
  return inflated >= grossWei ? 0n : grossWei - inflated;
}

/** Human figure for the estimate: trimmed to 6 fractional digits, never "0" for a non-zero amount. */
export function formatSwapExitEstimate(toAmountWei: bigint, decimals: number): string {
  if (toAmountWei <= 0n) return '0';
  const base = 10n ** BigInt(decimals);
  const whole = toAmountWei / base;
  const frac = toAmountWei % base;
  if (frac === 0n) return whole.toString();
  let fracStr = frac.toString().padStart(decimals, '0');
  const shown = fracStr.slice(0, 6).replace(/0+$/, '');
  if (shown === '') {
    // Below display precision: show the full fraction rather than lying with "0".
    fracStr = fracStr.replace(/0+$/, '');
    return `${whole}.${fracStr}`;
  }
  return `${whole}.${shown}`;
}
