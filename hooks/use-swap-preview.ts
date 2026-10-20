import { useEffect, useRef, useState } from 'react';
import { deliverableAfterNativeFee, fetchLifiContractCallDeliverable, fetchLifiExactInQuote } from '@/services/lifi-quote';

export type SwapPreview =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
    status: 'ok';
    toAmount: bigint;
    toAmountMin: bigint;
    /** A bridge fee paid on top of the token amount (USD), already netted out of `toAmount`. */
    bridgeFeeUsd?: number;
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
 * Privacy: the request carries amount, tokens, chains and the relay
 * processor (or wallet) address as `fromAddress`; nothing note-derived.
 */
export function useSwapPreview(params: {
  enabled: boolean;
  chainId: number;
  toChainId?: number;
  fromToken: string | null | undefined;
  toToken: string | null | undefined;
  fromAmountWei: bigint;
  fromAddress: string | null | undefined;
  destinationCall?: boolean;
}): SwapPreview {
  const { enabled, chainId, toChainId, fromToken, toToken, fromAmountWei, fromAddress } = params;
  const destinationCall = !!params.destinationCall && toChainId !== undefined && toChainId !== chainId;
  const [preview, setPreview] = useState<SwapPreview>({ status: 'idle' });
  const seqRef = useRef(0);
  // bigint is not a stable dep for React's Object.is on every runtime; key on its string.
  const amountKey = fromAmountWei.toString();
  useEffect(() => {
    const seq = ++seqRef.current;
    if (!enabled || !fromToken || !toToken || !fromAddress || fromAmountWei <= 0n) {
      setPreview({ status: 'idle' });
      return;
    }
    setPreview({ status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const request: Promise<SwapPreview> = destinationCall
        ? fetchLifiContractCallDeliverable({
          chainId,
          toChainId,
          fromToken,
          toToken,
          fromAmountWei,
          fromAddress,
          slippage: CROSS_CHAIN_SLIPPAGE,
          signal: controller.signal,
        }).then((q) => {
          if (!q) return { status: 'none' };
          const toAmount = deliverableAfterNativeFee(q, fromAmountWei);
          if (toAmount === null || q.toAmount <= 0n) return { status: 'none' };
          return {
            status: 'ok',
            toAmount,
            toAmountMin: (q.deliverableMin * toAmount) / q.toAmount,
            ...(q.nativeFeeUsd > 0 ? { bridgeFeeUsd: q.nativeFeeUsd } : {}),
          };
        })
        : fetchLifiExactInQuote({
          chainId,
          toChainId,
          fromToken,
          toToken,
          fromAmountWei,
          fromAddress,
          signal: controller.signal,
        }).then((q) => (q ? { status: 'ok', toAmount: q.toAmount, toAmountMin: q.toAmountMin } : { status: 'none' }));
      request.then((next) => {
        if (seqRef.current === seq) setPreview(next);
      }).catch(() => {
        if (seqRef.current === seq) setPreview({ status: 'none' });
      });
    }, 450);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fromAmountWei is keyed by amountKey
  }, [enabled, chainId, toChainId, fromToken, toToken, amountKey, fromAddress, destinationCall]);
  return preview;
}
