// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
import { useBalanceDisplay } from '@/hooks/use-balance-display';

import React, { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { formatUnits } from 'viem';

import { usePaymentRequestModal } from '@/components/payment-request-modal-provider';
import { getChainConfig } from '@/config/chains';
import { getTokenMetadata } from '@/config/tokens';
import { decodePaymentReceiptPayloadFromUrl } from '@/services/payment-requests';

function formatRequestCode(requestId: string | null | undefined): string {
  if (!requestId) return 'Pending';
  const clean = requestId.replace(/[^a-zA-Z0-9]/g, '');
  if (clean.length <= 8) return clean;
  return `${clean.slice(0, 5)}...${clean.slice(-4)}`;
}

export default function ReceivePaymentScreen() {
  const { openReceivePaymentModal, isOpen: receiveFlowOpen, mode: receiveFlowMode } = usePaymentRequestModal();
  // Strictly worse than the /pay page's version of this bug (QA 2026-08-27):
  // openReceivePaymentModal takes no `opts`, so this flow is ALWAYS the
  // overlay -- there is no inline swap to hide the button behind -- and the
  // Pressable below had no `disabled` prop at all. It stayed live through the
  // whole import + on-chain claim. A re-press re-enters the opener, which
  // calls resetState() and bumps opEpochRef, staleding the run in flight.
  // Scoped to the RECEIVE mode being open. Deliberately not `isBusy`: that
  // flag is shared by every flow in the provider, so a create-request or a
  // payment running elsewhere made this button read "Importing..." and go
  // disabled while nothing was importing (code review 2026-08-27).
  const importLocked = receiveFlowOpen && receiveFlowMode === 'receive';
  const params = useLocalSearchParams<{ encoded?: string | string[] }>();

  const encoded = Array.isArray(params.encoded) ? params.encoded[0] : params.encoded;

  const receipt = useMemo(() => {
    if (!encoded) return null;
    try {
      return decodePaymentReceiptPayloadFromUrl(encoded);
    } catch {
      return null;
    }
  }, [encoded]);

  const balanceDisplay = useBalanceDisplay();
  const token = receipt ? getTokenMetadata(receipt.tokenId, receipt.chainId) : null;
  const chainName = receipt ? getChainConfig(receipt.chainId)?.displayName ?? `Chain ${receipt.chainId}` : 'Sepolia';
  const amountLabel = receipt && token
    ? balanceDisplay(formatUnits(BigInt(receipt.amount), token.decimals), token.symbol, receipt.chainId, receipt.tokenId).text
    : null;

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="items-center gap-[16px] px-[24px] py-[32px]"
    >
      <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY POOLS V2</Text>
      <Text className="font-pp-bold text-[20px] text-center text-text">Receive Payment</Text>
      <Text className="font-pp-regular text-[12px] text-center text-text-secondary">
        Import a private payment on {chainName}
      </Text>

      <View className="w-full max-w-[560px] gap-[18px] border border-border-light bg-card-background px-[24px] py-[24px]">
        {receipt && amountLabel ? (
          <>
            <View className="gap-[4px]">
              <Text className="font-pp-bold text-[16px] text-text">Payment Receipt</Text>
              <Text className="font-pp-regular text-[12px] text-text-muted">Import this note into your local account</Text>
            </View>

            <View className="flex-row items-center justify-between gap-[12px]">
              <Text className="font-pp-medium text-[14px] text-text">1x Received private payment</Text>
              <Text className="font-pp-semi-bold text-[14px] text-text">{amountLabel}</Text>
            </View>

            <View className="border-t border-dashed border-border-light" />

            <View className="flex-row items-center justify-between">
              <Text className="font-pp-bold text-[16px] text-text">Total</Text>
              <Text className="font-pp-bold text-[16px] text-text">{amountLabel}</Text>
            </View>

            <View className="gap-[8px]">
              <View className="flex-row items-center justify-between gap-[12px]">
                <Text className="font-pp-medium text-[12px] text-text-muted">Payment code</Text>
                <Text className="font-pp-medium text-[12px] text-right text-text-secondary">{formatRequestCode(receipt.requestId)}</Text>
              </View>
              <View className="flex-row items-center justify-between gap-[12px]">
                <Text className="font-pp-medium text-[12px] text-text-muted">Commitment</Text>
                <Text className="font-pp-medium text-[12px] text-right text-text-secondary">{`${receipt.commitment.slice(0, 8)}...${receipt.commitment.slice(-6)}`}</Text>
              </View>
              <View className="flex-row items-center justify-between gap-[12px]">
                <Text className="font-pp-medium text-[12px] text-text-muted">Status</Text>
                <Text className="font-pp-medium text-[12px] text-right text-success">Ready to import</Text>
              </View>
            </View>

            <View className="gap-[6px] border border-border bg-warning-bg px-[14px] py-[12px]">
              <Text className="font-pp-semi-bold text-[13px] text-warning">Saved to this browser only. Until claimed</Text>
              <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                Importing merges this payment into this browser's local notes; it won't survive a different browser or wallet unless you claim it on-chain afterwards (the import flow offers the claim). The original payment request must exist on this device.
              </Text>
            </View>

            <Pressable
              className={`items-center justify-center bg-button-primary py-[14px] ${importLocked ? 'opacity-[0.45]' : 'opacity-100'}`}
              onPress={() => openReceivePaymentModal(encoded)}
              disabled={importLocked}
            >
              <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                {importLocked ? 'Importing...' : 'Import Payment'}
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text className="font-pp-bold text-[16px] text-center text-text">Invalid receive link</Text>
            <Text className="font-pp-regular text-[13px] text-center leading-[20px] text-text-secondary">
              This receipt link could not be decoded. Ask the sender to create a new one.
            </Text>
          </>
        )}
      </View>
    </ScrollView>
  );
}
