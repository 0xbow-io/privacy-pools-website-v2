/** Display-only accounting. Never use these values to size a transaction. */
export function estimatedReshieldSurplus(estimatedOutput: bigint, totalDepositCost: bigint): bigint {
  // totalDepositCost is the funding-token budget, including deposit fees.
  // A yield note's market value is not the amount consumed by its deposit.
  return estimatedOutput > totalDepositCost ? estimatedOutput - totalDepositCost : 0n;
}

/**
 * Quantize a partition by its boundaries, rather than rounding each term.
 * The displayed output equals the displayed deposit budget plus surplus.
 * This allocates only a display rounding remainder, never token amounts.
 */
export function displayedReshieldSurplus(output: bigint, depositCost: bigint, quantum: bigint): bigint {
  if (quantum <= 0n) throw new RangeError('Display quantum must be positive');
  return estimatedReshieldSurplus(output / quantum, depositCost / quantum) * quantum;
}
