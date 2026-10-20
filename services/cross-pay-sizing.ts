/**
 * How much to ask the pool for when the deposit is FUNDED THROUGH A ROUTE.
 *
 * Flow 1 (swap-into-deposit, same-chain or bridged) executes through LiFi's
 * `/v1/quote/contractCalls`: only bridges that can run a destination call
 * qualify (Stargate, Across…), at the SDK's cross-chain slippage of 3%. The
 * hub used to preview with plain `/v1/quote`, which picks the cheapest of ALL
 * bridges, and then handed that figure (+1% vetting fee) to the SDK as the
 * exact deposit. For 0.0001 ETH → OP USDC the cheap route promised 0.242 USDC
 * while the only executable route delivered 0.226 min; LiFi answered
 * `404 code 1003 Unable to find quote to match expected output` (Pat,
 * 2026-08-29). The preview and the execution must price the SAME route.
 *
 * Given the executable route's guaranteed delivery (its slippage floor), the
 * deposit we may ask for is that floor, minus the entrypoint's vetting fee
 * (the SDK adds it back on top of the deposit when it sizes the contract
 * call), minus a small safety margin for the SDK's exact-out solve-back.
 *
 * PURE.
 */
export const CONVERTING_DEPOSIT_SAFETY_BPS = 75n;

export function sizeConvertingDeposit(input: {
  /** What the executable LiFi route delivers at worst (its toAmountMin), in pool-token wei. */
  deliverableMin: bigint;
  /** Entrypoint vetting fee for the pool asset, basis points. */
  vettingFeeBps: number | bigint;
  safetyBps?: bigint;
}): bigint {
  const { deliverableMin } = input;
  if (deliverableMin <= 0n) return 0n;
  const safety = input.safetyBps ?? CONVERTING_DEPOSIT_SAFETY_BPS;
  const vetting = BigInt(input.vettingFeeBps);
  const afterSafety = (deliverableMin * (10_000n - safety)) / 10_000n;
  // deposit + deposit*vetting/10000 <= afterSafety  =>  deposit <= afterSafety*10000/(10000+vetting)
  return (afterSafety * 10_000n) / (10_000n + vetting);
}
