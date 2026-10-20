// Display-only exact-IN LiFi quote for the shield widget's conversion
// preview: the user types the PAY amount, this estimates the pool-asset
// output. The BINDING route still comes from the SDK's exact-out
// prepareSwapAndDeposit at submit time (we hand it `toAmountMin` as the
// deposit target, so the solved-back input stays at or under what the user
// typed, within slippage).
import { LIFI_API_KEY, NATIVE_ASSET_ADDRESS } from '@/config/intent-swaps';
import { contractCallDeniedBridges } from '@/services/lifi-native-delivery';

// LiFi uses the zero address for native, our config uses the 0xeee sentinel.
const LIFI_NATIVE = '0x0000000000000000000000000000000000000000';

function toLifiToken(address: string): string {
  return address.toLowerCase() === NATIVE_ASSET_ADDRESS.toLowerCase() ? LIFI_NATIVE : address;
}

export interface LifiExactInEstimate {
  /** Estimated pool-asset output (wei). */
  toAmount: bigint;
  /** Slippage-bounded minimum output (wei) — the safe deposit target. */
  toAmountMin: bigint;
}

export async function fetchLifiExactInQuote(params: {
  /** Source chain: where the pay token and the wallet are. */
  chainId: number;
  /** Destination chain. Defaults to `chainId` (same-chain swap). */
  toChainId?: number;
  fromToken: string;
  toToken: string;
  fromAmountWei: bigint;
  fromAddress: string;
  signal?: AbortSignal;
}): Promise<LifiExactInEstimate | null> {
  if (params.fromAmountWei <= 0n) return null;
  const qs = new URLSearchParams({
    fromChain: String(params.chainId),
    toChain: String(params.toChainId ?? params.chainId),
    fromToken: toLifiToken(params.fromToken),
    toToken: toLifiToken(params.toToken),
    fromAmount: params.fromAmountWei.toString(),
    fromAddress: params.fromAddress,
  });
  try {
    const res = await fetch(`https://li.quest/v1/quote?${qs.toString()}`, {
      headers: LIFI_API_KEY ? { 'x-lifi-api-key': LIFI_API_KEY } : undefined,
      signal: params.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { estimate?: { toAmount?: string; toAmountMin?: string } };
    const toAmount = data.estimate?.toAmount;
    const toAmountMin = data.estimate?.toAmountMin;
    if (!toAmount || !toAmountMin) return null;
    return { toAmount: BigInt(toAmount), toAmountMin: BigInt(toAmountMin) };
  } catch {
    return null;
  }
}

export interface LifiContractCallDeliverable {
  /** What the executable route delivers to the destination call at worst (its slippage floor), pool-token wei. */
  deliverableMin: bigint;
  /** Its expected delivery. */
  toAmount: bigint;
  /** LiFi tool that would carry it (informational). */
  tool: string | null;
  /**
   * Fees the route charges ON TOP of the token amount, in USD: a bridge's
   * native messaging fee (Stargate's LayerZero fee), paid as `msg.value` and
   * not taken out of `toAmount`. 0 when the route has none (Across).
   */
  nativeFeeUsd: number;
  /** The source token's USD price and decimals, from the same quote. */
  fromPriceUsd: number | null;
  fromDecimals: number | null;
}

/**
 * Price a swap-into-deposit through the SAME LiFi endpoint the SDK executes
 * it with — `/v1/quote/contractCalls` — instead of the plain `/v1/quote`.
 *
 * The two disagree materially cross-chain: plain quotes pick the cheapest of
 * ALL bridges, contract-call quotes only bridges that can run a destination
 * call, at the SDK's 3% cross-chain slippage. Sizing the deposit off the
 * cheap route made the SDK demand more than the executable route could
 * deliver (LiFi 404, code 1003; Pat, 0.0001 ETH → OP USDC, 2026-08-29).
 *
 * A probe custom call (1 unit, empty calldata, to the payer) stands in for
 * the real deposit call — LiFi does not simulate it at quote time. The
 * deliverable is what enters that probe step: the preceding step's floor.
 * `null` on any failure; callers show "no route" rather than a number.
 */
export async function fetchLifiContractCallDeliverable(params: {
  chainId: number;
  toChainId?: number;
  fromToken: string;
  toToken: string;
  fromAmountWei: bigint;
  fromAddress: string;
  /** Match what the SDK will send: 0.03 cross-chain (its default), 0.01 same-chain (pool-session-service shim). */
  slippage: number;
  signal?: AbortSignal;
}): Promise<LifiContractCallDeliverable | null> {
  if (params.fromAmountWei <= 0n) return null;
  const toChain = params.toChainId ?? params.chainId;
  const toToken = toLifiToken(params.toToken);
  const deniedBridges = contractCallDeniedBridges(params.chainId, toChain, toToken);
  try {
    const res = await fetch('https://li.quest/v1/quote/contractCalls', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(LIFI_API_KEY ? { 'x-lifi-api-key': LIFI_API_KEY } : {}) },
      signal: params.signal,
      body: JSON.stringify({
        fromChain: params.chainId,
        toChain,
        fromToken: toLifiToken(params.fromToken),
        toToken,
        fromAddress: params.fromAddress,
        fromAmount: params.fromAmountWei.toString(),
        slippage: params.slippage,
        integrator: 'privacy-pools-v2',
        // Same deny list the SDK quote gets (services/pool-session-service.ts),
        // so the preview and the execution route the same way.
        ...(deniedBridges ? { denyBridges: deniedBridges } : {}),
        contractCalls: [{
          fromAmount: '1',
          fromTokenAddress: toToken,
          toContractAddress: params.fromAddress,
          toContractCallData: '0x',
          toContractGasLimit: '800000',
        }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      tool?: string;
      action?: { fromToken?: { priceUSD?: string; decimals?: number } };
      estimate?: { feeCosts?: Array<{ amountUSD?: string; included?: boolean }> };
      includedSteps?: Array<{ type?: string; estimate?: { toAmount?: string; toAmountMin?: string; fromAmount?: string } }>;
    };
    const steps = data.includedSteps ?? [];
    const probeIdx = steps.findIndex((st) => st.type === 'custom');
    const feeder = probeIdx > 0 ? steps[probeIdx - 1] : steps[steps.length - 1];
    const min = feeder?.estimate?.toAmountMin;
    const exp = feeder?.estimate?.toAmount;
    if (!min || !exp) return null;
    const nativeFeeUsd = (data.estimate?.feeCosts ?? [])
      .filter((f) => f.included === false)
      .reduce((sum, f) => sum + (Number(f.amountUSD) || 0), 0);
    const price = Number(data.action?.fromToken?.priceUSD);
    const decimals = data.action?.fromToken?.decimals;
    return {
      deliverableMin: BigInt(min),
      toAmount: BigInt(exp),
      tool: data.tool ?? null,
      nativeFeeUsd,
      fromPriceUsd: Number.isFinite(price) && price > 0 ? price : null,
      fromDecimals: typeof decimals === 'number' ? decimals : null,
    };
  } catch {
    return null;
  }
}

/**
 * The SDK funds a bridge's native fee by swapping part of the input into the
 * source chain's gas token first (the "B2" gas swap, PoolSessionReshieldCrosschain
 * sizeB2GasSwap): 1.2x the quoted fee, 5% more on the swap's output target, and
 * about 1% for the swap itself. The rest of the input is what gets bridged. On
 * the 2026-09-27 BNB -> Ethereum run this gave 11.33 USDT for an $8.90 fee,
 * the SDK's own gas swap input to the cent.
 */
const B2_INPUT_FACTOR = 1.2 * 1.05 * 1.01;

/**
 * What a destination-call route actually delivers once the bridge's native fee
 * is paid out of the input. Plain `toAmount` ignores it, which showed ~19.50
 * for a 20 USDT BNB -> Ethereum reshield that deposits ~8.5 (Stargate's
 * LayerZero fee was $8.90, 2026-09-27).
 *
 * `null` when the fee cannot be priced or eats the whole input: the caller
 * shows no estimate rather than a number it cannot stand behind.
 */
export function deliverableAfterNativeFee(
  q: Pick<LifiContractCallDeliverable, 'toAmount' | 'nativeFeeUsd' | 'fromPriceUsd' | 'fromDecimals'>,
  fromAmountWei: bigint,
): bigint | null {
  if (fromAmountWei <= 0n) return null;
  if (q.nativeFeeUsd <= 0) return q.toAmount;
  if (q.fromPriceUsd === null || q.fromDecimals === null) return null;
  // Price in micro-units so the float only ever touches small numbers.
  const feeMicroTokens = BigInt(Math.ceil((q.nativeFeeUsd * B2_INPUT_FACTOR / q.fromPriceUsd) * 1e6));
  const feeWei = (feeMicroTokens * 10n ** BigInt(q.fromDecimals)) / 1_000_000n;
  if (feeWei >= fromAmountWei) return null;
  return (q.toAmount * (fromAmountWei - feeWei)) / fromAmountWei;
}
