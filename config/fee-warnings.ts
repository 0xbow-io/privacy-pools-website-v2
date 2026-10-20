/**
 * When an action's total fee is a large enough share of the amount to warn
 * about it. Pure module, edited here rather than through the environment.
 */

export type FeeWarningTier = {
  /** Lower bound of the amount band in USD, inclusive. */
  minAmountUsd: number;
  /** Fee as a percentage of the amount at which the warning shows. */
  firstPct: number;
  /** Fee as a percentage of the amount at which the warning turns severe. */
  secondPct: number;
};

export type FeeWarningConfig = {
  /** Ascending by `minAmountUsd`; the first band must start at 0. */
  tiers: readonly FeeWarningTier[];
  /** Below this total fee no warning shows, whatever the percentage. */
  minFeeUsd: number;
  /** Share of the fee that has to be network cost before suggesting the user wait for lower gas. */
  waitSuggestionMinNetworkShare: number;
  /** From this amount in USD the fee reads as a share of it; below it, in dollars. */
  percentFromAmountUsd: number;
};

export const FEE_WARNING_CONFIG: FeeWarningConfig = {
  tiers: [
    { minAmountUsd: 0, firstPct: 20, secondPct: 50 },
    { minAmountUsd: 50, firstPct: 15, secondPct: 30 },
    { minAmountUsd: 150, firstPct: 10, secondPct: 20 },
    { minAmountUsd: 500, firstPct: 5, secondPct: 10 },
    { minAmountUsd: 1_000, firstPct: 2.5, secondPct: 5 },
    { minAmountUsd: 10_000, firstPct: 1, secondPct: 5 },
  ],
  minFeeUsd: 1,
  waitSuggestionMinNetworkShare: 0.5,
  percentFromAmountUsd: 100,
};

/** Gas a wallet spends to shield, for estimating the network cost before it is sent. */
export const SHIELD_GAS_UNITS = {
  /** A direct deposit into the pool (observed ~873k-918k). */
  deposit: 900_000n,
  /** A same-chain LI.FI swap whose output is deposited in the same transaction. */
  swapDeposit: 1_150_000n,
  /** The source-chain LI.FI call of a cross-chain shield; the bridge pays the destination side. */
  crossChainSource: 300_000n,
};

export type ShieldElsewhereConfig = {
  /**
   * Chains where a small shield suggests another chain. Whatever gas costs
   * today, every later spend of the note pays this chain's gas again.
   */
  sourceChainIds: readonly number[];
  /** Amounts under this, in USD, get the suggestion. */
  maxAmountUsd: number;
  /** Destination execution of a cross-chain shield, paid through the bridge. */
  destinationGas: bigint;
  /** LI.FI and bridge fees as a share of the amount (0.25% LI.FI plus the bridge's own). */
  bridgeFeeBps: number;
  /** Fixed bridge cost on top, in USD. */
  bridgeFixedUsd: number;
};

export const SHIELD_ELSEWHERE_CONFIG: ShieldElsewhereConfig = {
  sourceChainIds: [1],
  maxAmountUsd: 50,
  destinationGas: 800_000n,
  bridgeFeeBps: 30,
  bridgeFixedUsd: 0.25,
};
