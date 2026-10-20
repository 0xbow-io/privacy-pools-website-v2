import { SHIELD_ELSEWHERE_CONFIG, SHIELD_GAS_UNITS, type ShieldElsewhereConfig } from '@/config/fee-warnings';
import { gasCostUsd } from '@/services/fee-warning';

/**
 * A small shield on an expensive chain points at the other chains it could
 * land on, through the cross-chain shield route. The deposit is not the only
 * cost: every later withdraw, send or swap of the note pays this chain's gas
 * again, at whatever gas costs then. So it is gated on the chain and the
 * amount, never on today's gas price, and the per-chain fees are information.
 *
 * Estimated from the gas and price feeds only: asking LI.FI for a quote per
 * chain would put requests on the wire the moment this form was filled in.
 * The binding quote is still taken once a chain is picked.
 */

export type ElsewherePool = { chainId: number; chainName: string; symbol: string; address: string; decimals: number };

export type ElsewhereRow = {
  chainId: number;
  chainName: string;
  /** Pools on that chain a bridged deposit can enter. */
  pools: ElsewherePool[];
  feeUsd: number | null;
  /** Why the chain cannot be picked; null when it can. */
  disabledReason: string | null;
};

export type ShieldElsewhere = {
  /** What shielding here costs in gas right now; null while gas or price is unknown. */
  directFeeUsd: number | null;
  /** Pickable rows first, cheapest first; then the rest with their reasons. */
  rows: ElsewhereRow[];
};

export type ShieldElsewhereInput = {
  sourceChainId: number;
  sourceChainName: string;
  amountUsd: number | null | undefined;
  /** Gas the shield the form would send costs on the source chain. */
  directGasUnits: bigint;
  pools: readonly ElsewherePool[];
  gasPriceOf: (chainId: number) => bigint | null;
  nativeUsdOf: (chainId: number) => number | null;
  routeAvailable: (sourceChainId: number, poolChainId: number) => boolean;
  poolAccepts: (pool: ElsewherePool) => boolean;
};

export function crossChainShieldFeeUsd(
  input: Pick<ShieldElsewhereInput, 'sourceChainId' | 'gasPriceOf' | 'nativeUsdOf'> & { destinationChainId: number; amountUsd: number },
  config: ShieldElsewhereConfig = SHIELD_ELSEWHERE_CONFIG,
): number | null {
  const source = gasCostUsd(SHIELD_GAS_UNITS.crossChainSource, input.gasPriceOf(input.sourceChainId), input.nativeUsdOf(input.sourceChainId));
  if (source === null) return null;
  const destination = gasCostUsd(config.destinationGas, input.gasPriceOf(input.destinationChainId), input.nativeUsdOf(input.destinationChainId));
  if (destination === null) return null;
  return source + destination + (input.amountUsd * config.bridgeFeeBps) / 10_000 + config.bridgeFixedUsd;
}

/** Null when the suggestion does not apply or no other chain can take the deposit. */
export function shieldElsewhere(input: ShieldElsewhereInput, config: ShieldElsewhereConfig = SHIELD_ELSEWHERE_CONFIG): ShieldElsewhere | null {
  const { amountUsd, sourceChainId } = input;
  if (!config.sourceChainIds.includes(sourceChainId)) return null;
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd >= config.maxAmountUsd) return null;
  const directFeeUsd = gasCostUsd(input.directGasUnits, input.gasPriceOf(sourceChainId), input.nativeUsdOf(sourceChainId));

  const byChain = new Map<number, ElsewherePool[]>();
  for (const pool of input.pools) {
    if (pool.chainId === sourceChainId) continue;
    byChain.set(pool.chainId, [...(byChain.get(pool.chainId) ?? []), pool]);
  }

  const rows: ElsewhereRow[] = [...byChain.entries()].map(([chainId, pools]) => {
    const chainName = pools[0]!.chainName;
    const reachable = pools.filter(input.poolAccepts);
    if (!input.routeAvailable(sourceChainId, chainId)) {
      return { chainId, chainName, pools: reachable, feeUsd: null, disabledReason: `No route from ${input.sourceChainName} yet` };
    }
    if (reachable.length === 0) {
      return { chainId, chainName, pools: reachable, feeUsd: null, disabledReason: 'No pool here takes a bridged deposit' };
    }
    const feeUsd = crossChainShieldFeeUsd({ ...input, destinationChainId: chainId, amountUsd }, config);
    return { chainId, chainName, pools: reachable, feeUsd, disabledReason: null };
  });

  rows.sort((a, b) => {
    if ((a.disabledReason === null) !== (b.disabledReason === null)) return a.disabledReason === null ? -1 : 1;
    return (a.feeUsd ?? Number.POSITIVE_INFINITY) - (b.feeUsd ?? Number.POSITIVE_INFINITY);
  });
  if (!rows.some((row) => row.disabledReason === null)) return null;
  return { directFeeUsd, rows };
}
