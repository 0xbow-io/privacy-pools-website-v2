import { FEE_WARNING_CONFIG, type FeeWarningConfig, type FeeWarningTier } from '@/config/fee-warnings';

export type FeeWarningLevel = 'none' | 'first' | 'second';

const EPSILON = 1e-9;

const usable = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export function feeWarningTier(amountUsd: number, tiers: readonly FeeWarningTier[] = FEE_WARNING_CONFIG.tiers): FeeWarningTier | null {
  let match: FeeWarningTier | null = null;
  for (const tier of tiers) {
    if (amountUsd + EPSILON >= tier.minAmountUsd) match = tier;
  }
  return match;
}

export function feePercent(amountUsd: number | null | undefined, feeUsd: number | null | undefined): number | null {
  if (!usable(amountUsd) || !usable(feeUsd) || amountUsd <= 0 || feeUsd < 0) return null;
  return (feeUsd / amountUsd) * 100;
}

export function feeWarningLevel(
  amountUsd: number | null | undefined,
  feeUsd: number | null | undefined,
  config: FeeWarningConfig = FEE_WARNING_CONFIG,
): FeeWarningLevel {
  const pct = feePercent(amountUsd, feeUsd);
  if (pct === null || (feeUsd as number) + EPSILON < config.minFeeUsd) return 'none';
  const tier = feeWarningTier(amountUsd as number, config.tiers);
  if (!tier) return 'none';
  if (pct + EPSILON >= tier.secondPct) return 'second';
  if (pct + EPSILON >= tier.firstPct) return 'first';
  return 'none';
}

/** USD cost of `gasUnits` at `gasPriceWei`, priced in the chain's native coin. */
export function gasCostUsd(
  gasUnits: bigint,
  gasPriceWei: bigint | null | undefined,
  nativeUsd: number | null | undefined,
  nativeDecimals = 18,
): number | null {
  if (gasPriceWei === null || gasPriceWei === undefined || gasPriceWei < 0n || gasUnits < 0n) return null;
  if (!usable(nativeUsd) || nativeUsd <= 0) return null;
  return tokenUsd(gasUnits * gasPriceWei, nativeDecimals, nativeUsd);
}

/** USD value of a base-unit token amount, without passing the bigint through a float whole. */
export function tokenUsd(amount: bigint | null | undefined, decimals: number, priceUsd: number | null | undefined): number | null {
  if (amount === null || amount === undefined || !usable(priceUsd) || priceUsd <= 0) return null;
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = amount % scale;
  return (Number(whole) + Number(frac) / Number(scale)) * priceUsd;
}

/**
 * A relayer prices its fee as the gas it pays plus a margin. Splits the fee so
 * the gas part shows as network cost; with no gas reading the whole fee is.
 */
export function splitRelayerFee(relayerFeeUsd: number, gasUsd: number | null): { networkUsd: number; serviceUsd: number } {
  if (gasUsd === null || !usable(gasUsd) || gasUsd < 0) return { networkUsd: relayerFeeUsd, serviceUsd: 0 };
  const networkUsd = Math.min(gasUsd, relayerFeeUsd);
  return { networkUsd, serviceUsd: Math.max(0, relayerFeeUsd - networkUsd) };
}

/** The gas price and gas units a relayer quote was priced at, when it carries them. */
export function quoteGas(quote: unknown): { gasPriceWei: bigint; gasUnits: bigint } | null {
  const q = quote as { gasPrice?: unknown; txCost?: unknown } | null | undefined;
  if (!q || q.gasPrice === undefined || q.txCost === undefined) return null;
  try {
    const gasPriceWei = BigInt(q.gasPrice as string | number | bigint);
    const gasUnits = BigInt(q.txCost as string | number | bigint);
    return gasPriceWei > 0n && gasUnits > 0n ? { gasPriceWei, gasUnits } : null;
  } catch {
    return null;
  }
}

/** What a swap loses between what goes in and what comes out, in USD; null when either side is unpriced. */
export function swapLossUsd(
  input: { amount: bigint; decimals: number; usd: number | null | undefined },
  output: { amount: bigint; decimals: number; usd: number | null | undefined },
): number | null {
  const inUsd = tokenUsd(input.amount, input.decimals, input.usd);
  const outUsd = tokenUsd(output.amount, output.decimals, output.usd);
  if (inUsd === null || outUsd === null) return null;
  return Math.max(0, inUsd - outUsd);
}

export type FeeGasReading = { chainId: number; gasPriceWei: bigint | null | undefined };

export type FeeComponent = 'network' | 'swap' | 'service';

/**
 * Each part is `undefined` when the action has no such cost and `null` when it
 * has one that could not be priced, which makes the total a lower bound.
 */
export type FeeBreakdownInput = {
  amountUsd: number | null | undefined;
  /** Gas the user pays for, from the wallet or through the relayer's fee. */
  networkUsd: number | null | undefined;
  /** Bridge, LI.FI, DEX and protocol (vetting) fees. */
  swapUsd?: number | null;
  /** The relayer's margin over the gas it re-bills. */
  serviceUsd?: number | null;
  /** Chains whose gas sets the network cost; source first for a cross-chain action. */
  gas: readonly FeeGasReading[];
};

export type FeeBreakdown = {
  level: FeeWarningLevel;
  amountUsd: number;
  networkUsd: number | null;
  swapUsd: number | null;
  serviceUsd: number | null;
  totalUsd: number;
  pct: number;
  /** Network cost as a share of the total fee, 0..1. */
  networkShare: number;
  /** Parts the action has but that could not be priced; the total leaves them out. */
  unpriced: FeeComponent[];
  /** Show the fee as a share of the amount; a small amount shows it in dollars. */
  showPercent: boolean;
  suggestWaiting: boolean;
  gas: { chainId: number; gwei: string | null }[];
};

const part = (n: number | null | undefined): number | null => (usable(n) ? Math.max(0, n) : null);

export function buildFeeBreakdown(input: FeeBreakdownInput, config: FeeWarningConfig = FEE_WARNING_CONFIG): FeeBreakdown | null {
  const amountUsd = input.amountUsd;
  if (!usable(amountUsd) || amountUsd <= 0) return null;
  const networkUsd = part(input.networkUsd);
  const swapUsd = part(input.swapUsd);
  const serviceUsd = part(input.serviceUsd);
  if (networkUsd === null && swapUsd === null && serviceUsd === null) return null;
  const parts: [FeeComponent, number | null | undefined, number | null][] = [
    ['network', input.networkUsd, networkUsd],
    ['swap', input.swapUsd, swapUsd],
    ['service', input.serviceUsd, serviceUsd],
  ];
  const unpriced = parts.filter(([, given, priced]) => given !== undefined && priced === null).map(([name]) => name);
  const totalUsd = (networkUsd ?? 0) + (swapUsd ?? 0) + (serviceUsd ?? 0);
  const pct = feePercent(amountUsd, totalUsd) ?? 0;
  const networkShare = totalUsd > 0 ? (networkUsd ?? 0) / totalUsd : 0;
  return {
    level: feeWarningLevel(amountUsd, totalUsd, config),
    amountUsd,
    networkUsd,
    swapUsd,
    serviceUsd,
    totalUsd,
    pct,
    networkShare,
    unpriced,
    showPercent: amountUsd + EPSILON >= config.percentFromAmountUsd,
    // With a part unpriced, the network's share of the whole fee is unknown.
    suggestWaiting: unpriced.length === 0 && networkShare + EPSILON >= config.waitSuggestionMinNetworkShare,
    gas: input.gas.map(({ chainId, gasPriceWei }) => ({
      chainId,
      gwei: gasPriceWei === null || gasPriceWei === undefined || gasPriceWei < 0n ? null : formatGweiShort(gasPriceWei),
    })),
  };
}

/** A relayed spend paid out of the note: the fee in the note's asset, its gas share from the relayer's budget. */
export function relayedSpendBreakdown(
  input: {
    chainId: number;
    amountWei: bigint;
    feeWei: bigint | null | undefined;
    decimals: number;
    tokenUsd: number | null | undefined;
    gasUnits: bigint;
    gasPriceWei: bigint | null | undefined;
    nativeUsd: number | null | undefined;
  },
  config: FeeWarningConfig = FEE_WARNING_CONFIG,
): FeeBreakdown | null {
  if (input.feeWei === null || input.feeWei === undefined || input.amountWei <= 0n) return null;
  const relayerFeeUsd = tokenUsd(input.feeWei, input.decimals, input.tokenUsd);
  if (relayerFeeUsd === null) return null;
  const { networkUsd, serviceUsd } = splitRelayerFee(relayerFeeUsd, gasCostUsd(input.gasUnits, input.gasPriceWei, input.nativeUsd));
  return buildFeeBreakdown({
    amountUsd: tokenUsd(input.amountWei, input.decimals, input.tokenUsd),
    networkUsd,
    serviceUsd,
    gas: [{ chainId: input.chainId, gasPriceWei: input.gasPriceWei }],
  }, config);
}

/** "12.4", "0.074", "0.0021": enough digits to read, never "0". */
export function formatGweiShort(wei: bigint): string {
  const gwei = tokenUsd(wei, 9, 1) ?? 0;
  if (gwei === 0) return '0';
  if (gwei >= 100) return Math.round(gwei).toString();
  if (gwei >= 1) return trimZeros(gwei.toFixed(1));
  return trimZeros(gwei.toPrecision(2));
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function formatFeePercent(pct: number): string {
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${trimZeros(pct.toFixed(1))}%`;
}
