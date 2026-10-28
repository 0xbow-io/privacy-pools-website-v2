// Display-only Across estimate for a route the SDK will send to Across direct
// (config/across-direct.ts), so the preview prices the same bridge the
// execution uses instead of a LI.FI route the session will not take.
//
// Called only when acrossDirectServes() says the route goes to Across, i.e.
// only with EXPO_PUBLIC_ACROSS_DIRECT on. It sends what the LI.FI preview sends
// for the same route (chains, tokens, amount, recipient) and nothing derived
// from a note. `null` on any failure, so the caller falls back to LI.FI.

import { acrossMulticallHandler } from '@/config/across-direct';

const ACROSS_API = 'https://app.across.to/api';

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
  if (params.fromAmountWei <= 0n) return null;
  const recipient = params.destinationCall ? acrossMulticallHandler(params.toChainId) : params.recipient;
  if (!recipient) return null;
  const qs = new URLSearchParams({
    inputToken: params.fromToken,
    outputToken: params.toToken,
    originChainId: String(params.chainId),
    destinationChainId: String(params.toChainId),
    amount: params.fromAmountWei.toString(),
    recipient,
  });
  try {
    const res = await fetch(`${ACROSS_API}/suggested-fees?${qs.toString()}`, { signal: params.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      outputAmount?: string;
      isAmountTooLow?: boolean;
      relayerGasFee?: { total?: string };
      inputToken?: { decimals?: number };
      outputToken?: { decimals?: number };
    };
    if (data.isAmountTooLow || !data.outputAmount) return null;
    const inDecimals = data.inputToken?.decimals;
    const outDecimals = data.outputToken?.decimals;
    // The SDK refuses unmatched decimals and routes them through LI.FI.
    if (inDecimals !== undefined && outDecimals !== undefined && inDecimals !== outDecimals) return null;
    const toAmount = BigInt(data.outputAmount);
    if (toAmount <= 0n) return null;
    const gas = data.relayerGasFee?.total ? BigInt(data.relayerGasFee.total) : 0n;
    const deliverableMin = params.destinationCall ? toAmount - gas : toAmount;
    if (deliverableMin <= 0n) return null;
    return { toAmount, deliverableMin, fromDecimals: typeof inDecimals === 'number' ? inDecimals : null };
  } catch {
    return null;
  }
}
