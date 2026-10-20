/**
 * The native-gas top-up a relayed withdrawal delivers, read from the SIGNED
 * fee commitment rather than estimated.
 *
 * The relayer's quote response does carry `extraGasFundAmount` (600k gas
 * units), but the SDK's zod schema strips it, and a `units × gasPrice`
 * reconstruction would depend on a relayer constant this app cannot see
 * change. The signed `feeCommitment.data` is an ABI-encoded PayoutRouting
 * whose `nativeGas` slot IS the wei the relay contract will enforce as
 * `msg.value` (PrivacyPoolRelay: `msg.value == nativeGas`), and the SDK's own
 * guard refuses a commitment whose slot disagrees with the user's request. So
 * this figure is exact for the relay that follows, not a forecast.
 *
 * Why it exists (QA I-b, 2026-09-03): the first top-up that actually landed
 * (tx 0xdce04c91…63dd, 0.000587 ETH) was reported by the tester as "did not
 * send gas", because nothing in the flow ever printed the ETH figure and
 * 0.0006 ETH is invisible in a wallet balance.
 *
 * PURE module: viem decode + the shared formatter, no React, no network.
 */
import { decodeAbiParameters, type Hex } from 'viem';
import { formatTokenBalance } from '@/services/token-format';

// PayoutRouting's wire format; the tests decode values from the pinned SDK's encoder.
// Keep this small render-time decoder independent of the proving SDK.
const PAYOUT_ROUTING_ABI = [{
  type: 'tuple',
  components: [
    { name: 'recipient', type: 'address' },
    { name: 'feeRecipient', type: 'address' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'nativeGas', type: 'uint256' },
  ],
}] as const;

/**
 * `nativeGas` from a relayer-signed PayoutRouting, in wei. `null` when the
 * bytes do not decode as one (a malformed or foreign commitment must not
 * render as "0 gas", which would read as a deliberate zero).
 */
export function decodeGasTopUpWei(data: Hex | null | undefined): bigint | null {
  if (!data || data === '0x') return null;
  try {
    const [tuple] = decodeAbiParameters(PAYOUT_ROUTING_ABI, data);
    const nativeGas = (tuple as { nativeGas?: unknown }).nativeGas;
    return typeof nativeGas === 'bigint' ? nativeGas : null;
  } catch {
    return null;
  }
}

export interface GasTopUpDisplay {
  wei: bigint;
  /** e.g. "0.00059 ETH" (shared five-decimal floor, symbol from the chain). */
  amountText: string;
  /** e.g. "$1.23", or null when no price is known for the native asset. */
  usdText: string | null;
}

/**
 * Format a non-zero top-up for the review and success screens. Returns null
 * for zero so callers can render nothing instead of "0 ETH for gas".
 */
export function formatGasTopUp(input: {
  wei: bigint | null | undefined;
  symbol: string;
  decimals: number;
  priceUsd?: number | null;
}): GasTopUpDisplay | null {
  const { wei, symbol, decimals, priceUsd } = input;
  if (wei === null || wei === undefined || wei <= 0n) return null;
  const amount = Number(wei) / 10 ** decimals;
  const amountText = `${formatTokenBalance(amount, symbol)} ${symbol}`;
  const usd = priceUsd && priceUsd > 0 ? amount * priceUsd : null;
  const usdText = usd === null ? null : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
  return { wei, amountText, usdText };
}
