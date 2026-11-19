import { useEffect, useRef, useState } from 'react';
import { CROSS_CHAIN_DENY_EXCHANGES } from '@/config/intent-swaps';
import { deliverableAfterNativeFee, fetchLifiContractCallDeliverable, fetchLifiExactInQuote } from '@/services/lifi-quote';

export type SwapPreview =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
    status: 'ok';
    toAmount: bigint;
    toAmountMin: bigint;
  }
  | { status: 'none' };

/** The SDK's cross-chain slippage (PoolSessionReshieldCrosschain default). */
const CROSS_CHAIN_SLIPPAGE = 0.03;

/**
 * Live "~ what you would receive" for a swap route, before Review. A LiFi
 * exact-in quote on the entered amount, debounced and generation-guarded;
 * the binding quote (relayer fee, slippage floor) is still fetched at Review,
 * so this is an estimate and every consumer labels it as one. Same shape the
 * Withdraw tab's receive-as estimate has used since 2026-08-29; extracted so
 * Send and the Swap tab show one too (Pat, 2026-08-30: "no preview before I
 * hit confirm").
 *
 * `destinationCall`: the output is deposited on arrival (a cross-chain
 * reshield), so price it through `/v1/quote/contractCalls` like the SDK does.
 * The plain quote picks bridges that cannot run the deposit call and leaves
 * out their native fee: it showed ~19.50 for a 20 USDT BNB -> Ethereum
 * reshield that could only deposit ~8.5 (Pat, 2026-09-27).
 *
 * One request per debounced preview; all fee/note adjustments stay local.
 * Do not add preliminary, gas-purchase or resized-input quotes here: their
 * related amounts/timing add a fingerprint before Review.
 * Privacy: the request carries amount, tokens, chains and the relay
 * processor (or wallet) address as `fromAddress`; nothing note-derived.
 */
export function useSwapPreview(params: {
  enabled: boolean;
  /** Stop requests during Review while retaining the current form's completed estimate. */
  paused?: boolean;
  chainId: number;
  toChainId?: number;
  fromToken: string | null | undefined;
  toToken: string | null | undefined;
  fromAmountWei: bigint;
  /** Stable user input identity when the quoted amount depends on public feeds. */
  formKey?: string;
  fromAddress: string | null | undefined;
  destinationCall?: boolean;
  slippage?: number;
}): SwapPreview {
  const { enabled, chainId, toChainId, fromToken, toToken, fromAmountWei, fromAddress } = params;
  const paused = !!params.paused;
  const destinationCall = !!params.destinationCall && toChainId !== undefined && toChainId !== chainId;
  const requestKey = JSON.stringify([chainId, toChainId, fromToken, toToken, params.formKey ?? fromAmountWei.toString(), fromAddress, destinationCall, params.slippage]);
  const [result, setResult] = useState<{ key: string; value: SwapPreview } | null>(null);
  const seqRef = useRef(0);
  const ready = !!fromToken && !!toToken && !!fromAddress && fromAmountWei > 0n;
  useEffect(() => {
    const seq = ++seqRef.current;
    const setPreview = (value: SwapPreview) => setResult({ key: requestKey, value });
    if (!enabled || paused || !fromToken || !toToken || !fromAddress || fromAmountWei <= 0n) {
      return;
    }
    // Keep a completed quote through feed refreshes and Review/Back. A form
    // edit changes requestKey; missing initial public data can still arrive.
    if (result?.key === requestKey && result.value.status !== 'loading') return;
    setPreview({ status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const request: Promise<SwapPreview> = destinationCall
        ? fetchLifiContractCallDeliverable({
          chainId,
          toChainId,
          depositGasLimit: '2000000',
          denyExchanges: CROSS_CHAIN_DENY_EXCHANGES,
          fromToken,
          toToken,
          fromAmountWei,
          fromAddress,
          slippage: params.slippage ?? CROSS_CHAIN_SLIPPAGE,
          signal: controller.signal,
        }).then((q) => {
          if (!q) return { status: 'none' };
          const toAmount = deliverableAfterNativeFee(q, fromAmountWei);
          if (toAmount === null || q.toAmount <= 0n) return { status: 'none' };
          return { status: 'ok', toAmount, toAmountMin: q.deliverableMin * toAmount / q.toAmount };
        })
        : fetchLifiExactInQuote({
          chainId,
          toChainId,
          fromToken,
          toToken,
          fromAmountWei,
          fromAddress,
          signal: controller.signal,
          slippage: params.slippage,
        }).then((q) => (q ? { status: 'ok', toAmount: q.toAmount, toAmountMin: q.toAmountMin } : { status: 'none' }));
      request.then((next) => {
        if (seqRef.current === seq) setPreview(next);
      }).catch(() => {
        if (seqRef.current === seq) setPreview({ status: 'none' });
      });
    }, 450);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formKey intentionally freezes computed inputs until a form edit; result is the existing quote cache
  }, [enabled, paused, ready, requestKey]);
  // Never paint the previous pair/amount while its replacement effect starts.
  if (!enabled || !fromToken || !toToken || !fromAddress || fromAmountWei <= 0n) return { status: 'idle' };
  if (paused && (result?.key !== requestKey || result.value.status !== 'ok')) return { status: 'idle' };
  return result?.key === requestKey ? result.value : { status: 'loading' };
}
