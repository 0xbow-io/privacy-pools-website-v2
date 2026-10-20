import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { Hex } from 'viem';
import { nameRelayerTransportFailure } from '@/services/transfer-outcome';

export interface WithdrawalQuote {
  feeAmount: string;
  gasPrice: string;
  txCost: string;
  amountSent: string;
  amountReceived: string;
  feeCommitment: {
    data: Hex;
    asset: Hex;
    expiration: number;
    feeAmount: string;
    signedRelayerCommitment: Hex;
    recipient: Hex;
    amountSent: string;
    amountReceived: string;
    extraGas: boolean;
  };
  relayer: {
    name: string;
    url: string;
    chainId: number;
    chainType: string;
    status: string;
    address: Hex;
    processorAddress: Hex;
  };
}

export function useRelayerQuote() {
  const mutation = useMutation<
    WithdrawalQuote,
    Error,
    { chainId: number; amount: string; asset: Hex; recipient: Hex; extraGas?: boolean }
  >({
    mutationFn: async ({ chainId, amount, asset, recipient, extraGas }) => {
      const { createRelayerInteractor } = await import('@/services/sdk-runtime');
      const relayerInteractor = createRelayerInteractor(chainId);
      // Both calls below go to the relayer. A transport failure here IS the
      // relayer being unreachable, so name it: the withdraw modal's outage
      // copy keys on that, and a bare "Failed to fetch" used to reach the user
      // raw (Pack L-a, 2026-08-27).
      let relayer;
      let quote;
      try {
        const relayers = await relayerInteractor.getRelayers();
        relayer = relayers[0];
        if (!relayer) {
          throw new Error('No relayer configured');
        }
        quote = await relayerInteractor.getWithdrawalQuote(relayer, {
          asset,
          commit: true,
          recipient,
          extraGas: extraGas ?? false,
          amount,
        });
      } catch (err) {
        throw nameRelayerTransportFailure(err);
      }
      return {
        feeAmount: quote.feeAmount,
        gasPrice: quote.gasPrice,
        txCost: quote.txCost,
        amountSent: quote.amountSent,
        amountReceived: quote.amountReceived,
        feeCommitment: quote.feeCommitment as WithdrawalQuote['feeCommitment'],
        relayer: {
          name: relayer.name,
          url: relayer.url,
          chainId: relayer.chainId,
          chainType: relayer.chainType,
          status: relayer.status,
          address: relayer.address as Hex,
          processorAddress: relayer.processorAddress as Hex,
        },
      };
    },
  });

  const getQuote = useCallback(
    (chainId: number, amount: string, asset: Hex, recipient: Hex, extraGas?: boolean) =>
      mutation.mutateAsync({ chainId, amount, asset, recipient, extraGas }),
    [mutation.mutateAsync],
  );

  return {
    getQuote,
    quote: mutation.data ?? null,
    isLoading: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}
