import { policedFetch } from '@/services/egress-fetch';
import { getChainConfig } from '@/config/chains';
import { isAmountRejection } from '@/services/cold-start-claim';

/** Submit-time nonbinding quote; fees are amount-independent, so no amount leaves the client. */
export async function fetchTransferFeeQuote(
  chainId: number,
  asset: string,
  signal?: AbortSignal,
): Promise<bigint | null> {
  const r = await requestTransferFee(chainId, asset, undefined, signal);
  return typeof r === 'bigint' ? r : null;
}

/**
 * Same estimate, but a relayer that REFUSES the amount as too small to relay
 * is told apart from an estimate that is merely unavailable: the claim
 * preflight (DEV-456) must stop on the first and carry on after the second.
 */
export async function probeTransferFee(
  chainId: number,
  asset: string,
  amountWei: bigint,
  signal?: AbortSignal,
): Promise<bigint | 'rejected' | null> {
  const r = await requestTransferFee(chainId, asset, amountWei, signal);
  return r;
}

async function requestTransferFee(
  chainId: number,
  asset: string,
  amountWei: bigint | undefined,
  signal?: AbortSignal,
): Promise<bigint | 'rejected' | null> {
  const base = getChainConfig(chainId)?.relayerBaseUrl;
  if (!base || (amountWei !== undefined && amountWei <= 0n)) return null;
  try {
    const res = await policedFetch('relayer', base, `${base.replace(/\/$/, '')}/v1/quote/evm/${chainId}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ asset, ...(amountWei === undefined ? {} : { amount: amountWei.toString() }), commit: false }),
      // Confirm-time callers pass no signal — cap the wait so a hung relayer
      // can't stall the send at "Checking private funds" (GLM review M1); the
      // relay-time guard still protects the money path when this times out.
      signal: signal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(8_000) : undefined),
    });
    if (res.status === 429) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return isAmountRejection(detail) ? 'rejected' : null;
    }
    const data = (await res.json()) as { feeAmount?: string };
    if (typeof data.feeAmount !== 'string' || !/^\d+$/.test(data.feeAmount)) return null;
    const fee = BigInt(data.feeAmount);
    return fee >= 0n ? fee : null;
  } catch {
    return null;
  }
}
