/**
 * /pay page for a Stellar payment request (services/stellar/stellar-request.ts).
 *
 * Same card as the EVM request page (app/pay/[encoded].tsx). Two link formats:
 * - blind (every new link): paid here with the SDK's
 *   prepareFulfillPaymentRequest, a private transfer to the request's note
 *   slots. The link names no account, so neither does this page.
 * - address (links shared before): paid with the ordinary Stellar Send flow
 *   prefilled with the request, a private transfer the SDK announces to the
 *   recipient's viewing key.
 * Either way the recipient discovers the payment on their next sync and
 * nothing has to be handed back.
 */
import React, { useMemo, useState } from 'react';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { formatUnits } from 'viem';

import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { useTransferModal } from '@/components/transfer-modal-provider';
import { STELLAR_TESTNET_ID, getExplorerTxUrl } from '@/config/chains';
import { STELLAR_XLM, stellarTransferRelayFee } from '@/config/stellar-deployment';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { toStellarSdkPaymentRequest } from '@/services/payment-request-codec';
import { describeStellarStage, stellarErrorMessage } from '@/services/stellar/stellar-copy';
import { decodeStellarPayLink, isStellarRequestExpired, type DecodedStellarRequest } from '@/services/stellar/stellar-request';
import { selectGreedyTransferInputs, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS } from '@/services/transfer-note-selection';
import type { Note as UiNote } from '@/services/sdk-types';
import { CARD_SHADOW } from '@/components/ui/web-style-shims';

function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

export function StellarPayRequestScreen({ encoded }: { encoded: string }) {
  const { selectChain, activeChainId } = useChainRouter();
  const wallet = useStellarWallet();
  const stellarSession = useStellarSession();
  const { openTransferModal } = useTransferModal();
  const [paidTx, setPaidTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decoded = useMemo((): { link: DecodedStellarRequest | null; error: string | null } => {
    try {
      return { link: decodeStellarPayLink(encoded), error: null };
    } catch (e) {
      return { link: null, error: e instanceof Error ? e.message : 'This payment request link is not valid.' };
    }
  }, [encoded]);
  const link = decoded.link;
  // Hex (blind) or decimal stroops (address): BigInt reads both.
  const stroops = link ? BigInt(link.request.amount) : null;
  const amountText = stroops !== null ? formatUnits(stroops, STELLAR_XLM.decimals) : null;
  const amountLabel = amountText ? `${amountText} XLM` : null;
  const paymentCode = link
    ? short(link.format === 'blind' ? link.request.paymentId.replace(/^0x/, '') : link.request.requestId.replace(/-/g, ''))
    : '';
  const expired = link?.format === 'blind' && isStellarRequestExpired(link.request);
  const isOwnRequest = !!link && (link.format === 'blind'
    ? stellarSession.paymentRequests.some((r) => r.paymentId.toLowerCase() === link.request.paymentId.toLowerCase())
    : wallet.address === link.request.recipient);
  // Disconnected counts too: a first press connects and signs in, the next one pays.
  const needsSignIn = link?.format === 'blind' && (!wallet.isConnected || !stellarSession.unlocked);

  const ensureStellar = async (): Promise<boolean> => {
    if (activeChainId !== STELLAR_TESTNET_ID) {
      const outcome = await selectChain(STELLAR_TESTNET_ID);
      if (outcome !== 'committed') {
        setError('Could not switch to Stellar Testnet.');
        return false;
      }
    }
    if (!wallet.isConnected) {
      const connected = await wallet.connect();
      if (!connected) {
        setError(wallet.isAvailable ? 'Connect Freighter to pay.' : 'Install Freighter to pay.');
        return false;
      }
    }
    return true;
  };

  const payByAddress = async () => {
    if (link?.format !== 'address' || !amountText) return;
    const request = link.request;
    setError(null);
    if (!(await ensureStellar())) return;
    openTransferModal({
      recipient: request.recipient,
      amount: amountText,
      tokenSymbol: 'XLM',
      onSent: (txHash, details) => {
        // The modal is editable: only a payment that matches the request
        // marks it paid here.
        if (details && details.recipient === request.recipient && details.amount === amountText) setPaidTx(txHash);
      },
    });
  };

  // Explicit user action: unlock and sync, so the balance below is current.
  const signIn = async () => {
    setError(null);
    setBusy(true);
    try {
      if (!(await ensureStellar())) return;
      setStatus(describeStellarStage('unlocking'));
      await stellarSession.unlock();
    } catch (e) {
      setError(stellarErrorMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setStatus(null);
      setBusy(false);
    }
  };

  const payBlind = async () => {
    if (link?.format !== 'blind' || stroops === null || busy) return;
    setError(null);
    if (isStellarRequestExpired(link.request)) {
      setError('This payment request has expired. Ask for a new link.');
      return;
    }
    if (!(await ensureStellar())) return;
    // Just connected: the balance is not read yet. Sign in first (one more tap to pay).
    if (!stellarSession.unlocked) {
      await signIn();
      return;
    }
    // A relayed payment pays the relayer's fee from the same notes.
    const fee = stellarTransferRelayFee();
    const need = stroops + fee;
    const pick = selectGreedyTransferInputs(
      stellarSession.spendableNotes as unknown as UiNote[],
      need,
      TRANSFER_MAX_INPUTS,
      TRANSFER_MAX_LABELS,
    );
    if (!pick.covered) {
      const available = formatUnits(stellarSession.spendableTotal, STELLAR_XLM.decimals);
      setError(stellarSession.spendableTotal < need
        ? `Insufficient Stellar balance (${available} XLM available${fee > 0n ? `, ${formatUnits(fee, STELLAR_XLM.decimals)} XLM relayer fee on top` : ''}).`
        : `One transfer can spend up to ${TRANSFER_MAX_INPUTS} notes from ${TRANSFER_MAX_LABELS} deposits.`);
      return;
    }
    setBusy(true);
    try {
      const result = await stellarSession.payPaymentRequest({
        request: toStellarSdkPaymentRequest(link.request),
        inputCommitments: pick.selectedNotes.map((n) => n.commitment as `0x${string}`),
        onStage: (stage) => setStatus(describeStellarStage(stage)),
      });
      setPaidTx(result.txHash);
    } catch (e) {
      const raw = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      setError(/PaymentRequestExpired/.test(raw)
        ? 'This payment request has expired. Ask for a new link.'
        : /reject|denied|cancel|declined/i.test(raw) ? 'Payment cancelled in Freighter.' : stellarErrorMessage(raw));
    } finally {
      setStatus(null);
      setBusy(false);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="items-center gap-[16px] px-[24px] py-[32px]"
    >
      <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY POOLS V2</Text>
      <Text className="font-pp-bold text-[20px] text-center text-text">Payment Request</Text>
      <Text className="font-pp-regular text-[12px] text-center text-text-secondary">
        Private payment on Stellar testnet
      </Text>

      <View className="w-full max-w-[560px] gap-[18px] rounded-card border border-border-light bg-card-background px-[24px] py-[24px]"
        // nw-keep(platform-css): the shared soft card shadow (web box-shadow, native elevation)
        style={CARD_SHADOW}>
        {paidTx ? (
          <View className="items-center gap-[10px] py-[8px]">
            <Text className="font-pp-bold text-[16px] text-success">Payment sent ✓</Text>
            <Text className="text-center font-pp-regular text-[13px] text-text-secondary">
              This request is paid. The recipient discovers the payment automatically on their next sync. No receipt link is needed.
            </Text>
            <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(getExplorerTxUrl(STELLAR_TESTNET_ID, paidTx))} accessibilityRole="link" hitSlop={8}>
              <Text className="font-pp-medium text-[12px] underline text-primary">
                Tx: {paidTx.replace(/^0x/, '').slice(0, 10)}…{paidTx.slice(-8)}
              </Text>
            </Pressable>
              <ExplorerPrivacyHint explorerName={'StellarExpert'} />
            </View>
          </View>
        ) : link && amountLabel ? (
          <>
            <View className="gap-[4px]">
              <Text className="font-pp-bold text-[16px] text-text">Privacy Pools Payment</Text>
              <Text className="font-pp-regular text-[12px] text-text-muted">Pay privately from your pool balance</Text>
            </View>

            <View className="flex-row items-center justify-between gap-[12px]">
              <Text className="font-pp-medium text-[14px] text-text">1x Private pool payment</Text>
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
                <Text className="font-pp-medium text-[12px] text-right text-text-secondary">{paymentCode}</Text>
              </View>
              {link.format === 'address' ? (
                <View className="flex-row items-center justify-between gap-[12px]">
                  <Text className="font-pp-medium text-[12px] text-text-muted">Recipient</Text>
                  <Text className="font-pp-medium text-[12px] text-right text-text-secondary">{short(link.request.recipient)}</Text>
                </View>
              ) : null}
              <View className="flex-row items-center justify-between gap-[12px]">
                <Text className="font-pp-medium text-[12px] text-text-muted">Status</Text>
                <Text className={`font-pp-medium text-[12px] text-right ${expired ? 'text-text-muted' : 'text-success'}`}>{expired ? 'Expired' : 'Ready'}</Text>
              </View>
            </View>

            <View className="gap-[6px] rounded-inner border border-border bg-success-bg px-[14px] py-[12px]">
              <Text className="font-pp-semi-bold text-[13px] text-success">Private payment</Text>
              <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                {link.format === 'blind'
                  ? 'You pay from your shielded balance with a private transfer. The amount, who paid and who is paid stay private.'
                  : "You pay from your shielded balance with a private transfer. The amount and who paid stay private. This older link names the recipient's Stellar address."}
              </Text>
            </View>

            {isOwnRequest ? (
              <View className="gap-[6px] rounded-inner border border-border-light px-[14px] py-[12px]">
                <Text className="font-pp-semi-bold text-[13px] text-text">This is your payment request</Text>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                  Share this link with the payer. The payment shows up in your balance after your next sync.
                </Text>
              </View>
            ) : expired ? null : (
              <Pressable
                onPress={() => { void (link.format === 'blind' ? (needsSignIn ? signIn() : payBlind()) : payByAddress()); }}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                testID="stellar-pay-private"
                className={`items-center justify-center rounded-control bg-button-primary py-[14px] ${busy ? 'opacity-60' : 'opacity-100'}`}
              >
                <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                  {busy ? 'Working...' : needsSignIn ? 'Sign in to pay' : 'Pay privately'}
                </Text>
              </Pressable>
            )}
            {status ? <Text className="font-pp-regular text-[12px] text-text-secondary">{status}</Text> : null}
            {error ? <Text className="font-pp-regular text-[12px] text-[#E11D48]">{error}</Text> : null}
          </>
        ) : (
          <View className="gap-[6px]">
            <Text className="font-pp-bold text-[16px] text-text">Invalid payment request</Text>
            <Text className="font-pp-regular text-[13px] text-text-secondary">{decoded.error}</Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}
