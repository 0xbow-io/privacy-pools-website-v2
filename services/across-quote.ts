// Reserved display-only Across estimate interface. No browser quote transport is
// approved yet; returning null preserves the existing aggregator comparisons.

export interface AcrossDirectEstimate {
  /** What Across would deliver for this input, destination-token wei. */
  toAmount: bigint;
  /**
   * What a deposit sized from this preview can rely on. For a plain bridge the
   * output is exact, so it equals `toAmount`. For a route ending in a pool
   * deposit the filler also pays the deposit's gas, which this probe cannot
   * price (the deposit calldata does not exist yet), so one more relayer-gas fee
   * is held back.
   */
  deliverableMin: bigint;
  /** Input token decimals as Across reports them, when it does. */
  fromDecimals: number | null;
}

export async function fetchAcrossDirectEstimate(params: {
  chainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  fromAmountWei: bigint;
  /** The payout address of a plain bridge (what LI.FI's preview sends as fromAddress). */
  recipient: string;
  /** True when the route ends in a pool deposit on the destination. */
  destinationCall: boolean;
  signal?: AbortSignal;
}): Promise<AcrossDirectEstimate | null> {
  // No action-timed request is permitted. A future estimate must read only a
  // public snapshot populated independently of this caller (no note, message,
  // recipient or amount keyed fetch). Until then keep every existing aggregator.
  void params;
  return null;
}
