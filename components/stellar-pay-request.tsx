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
import { Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
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
import { buildStellarClaimUrl } from '@/services/stellar/stellar-claim-url';
import { stellarTimeoutMessage, WALLET_MINIMUM_MESSAGE } from '@/services/stellar/stellar-request-deposit';
import type { PendingLabel } from '@/services/stellar/stellar-account';
import { StellarLabelRetryNotice } from '@/components/stellar-label-retry';
import { selectGreedyTransferInputs, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS } from '@/services/transfer-note-selection';
import type { Note as UiNote } from '@/services/sdk-types';
import { CARD_SHADOW } from '@/components/ui/web-style-shims';

/** The payer-facing text for a failed Stellar pay attempt. */
export function stellarPayErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/PaymentRequestExpired/.test(raw)) return 'This payment request has expired. Ask for a new link.';
  if (/reject|denied|cancel|declined/i.test(raw)) return 'Payment cancelled in Freighter.';
  // DEV-500: proving plus the Freighter prompt can outlast the tx's 30s validity.
  const timeout = stellarTimeoutMessage(raw);
  if (timeout) return timeout;
  return stellarErrorMessage(raw);
}

async function copyText(value: string) {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(value);
  } else {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(value);
  }
}

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
  const [busy, setBusy] = useState<'private' | 'wallet' | null>(null);
  const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The deposit landed but its ASP registration did not (DEV-500 review).
  const [labelPending, setLabelPending] = useState<PendingLabel | null>(null);

  const retryLabel = async (): Promise<boolean> => {
    if (!labelPending) return true;
    try {
      const { failed, firstError } = await stellarSession.retryPendingLabels([labelPending]);
      if (failed > 0) throw new Error(firstError ?? 'The approval request did not go through.');
      setLabelPending(null);
      return true;
    } catch (e) {
      setError(stellarPayErrorMessage(e));
      return false;
    }
  };

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
  const belowWalletMinimum = stroops !== null && stroops < STELLAR_XLM.minDeposit;
  const amountText = stroops !== null ? formatUnits(stroops, STELLAR_XLM.decimals) : null;
  const amountLabel = amountText ? `${amountText} XLM` : null;
  // Paid through the relayer: its fee comes on top of the amount.
  const relayFee = stellarTransferRelayFee();
  const totalLabel = stroops !== null ? `up to ${formatUnits(stroops + relayFee, STELLAR_XLM.decimals)} XLM` : null;
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
    if (busy) return;
    // Busy across the switch and connect, so the wallet button cannot start
    // a second payment meanwhile (cubic on #304).
    setBusy('private');
    let ready = false;
    try {
      ready = await ensureStellar();
    } finally {
      setBusy(null);
    }
    if (!ready) return;
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
    setBusy('private');
    try {
      if (!(await ensureStellar())) return;
      setStatus(describeStellarStage('unlocking'));
      await stellarSession.unlock();
    } catch (e) {
      setError(stellarErrorMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setStatus(null);
      setBusy(null);
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
        ? `Insufficient Stellar balance (${available} XLM available${fee > 0n ? `, plus a relayer fee of up to ${formatUnits(fee, STELLAR_XLM.decimals)} XLM` : ''}).`
        : `One transfer can spend up to ${TRANSFER_MAX_INPUTS} notes from ${TRANSFER_MAX_LABELS} deposits.`);
      return;
    }
    setBusy('private');
    try {
      const result = await stellarSession.payPaymentRequest({
        request: toStellarSdkPaymentRequest(link.request),
        inputCommitments: pick.selectedNotes.map((n) => n.commitment as `0x${string}`),
        onStage: (stage) => setStatus(describeStellarStage(stage)),
      });
      setPaidTx(result.txHash);
    } catch (e) {
      setError(stellarPayErrorMessage(e));
    } finally {
      setStatus(null);
      setBusy(null);
    }
  };

  // "Pay via Wallet" (DEV-500): a deposit from the payer's Freighter wallet,
  // as on EVM. A blind link takes the request's own slot and tag; an old
  // address link is a deposit for that account (blind with a claim link when
  // it has no viewing key, DEV-499).
  const payFromWallet = async () => {
    if (!link || stroops === null || busy) return;
    setError(null);
    setClaimUrl(null);
    setLabelPending(null);
    if (belowWalletMinimum) {
      setError(WALLET_MINIMUM_MESSAGE);
      return;
    }
    if (link.format === 'blind' && isStellarRequestExpired(link.request)) {
      setError('This payment request has expired. Ask for a new link.');
      return;
    }
    // Busy before the chain switch and connect: a second press while those
    // wait would queue a second deposit.
    setBusy('wallet');
    try {
      if (!(await ensureStellar())) return;
      const onStage = (stage: Parameters<typeof describeStellarStage>[0]) => setStatus(describeStellarStage(stage));
      if (link.format === 'blind') {
        const result = await stellarSession.depositForPaymentRequest({ request: link.request, onStage });
        setLabelPending(result.pendingLabel);
        setPaidTx(result.txHash);
      } else {
        const result = await stellarSession.deposit({
          amount: stroops,
          recipient: link.request.recipient,
          onStage,
          onClaimReady: (notes) => setClaimUrl(buildStellarClaimUrl(notes)),
        });
        setClaimUrl(result.claimNotes ? buildStellarClaimUrl(result.claimNotes) : null);
        setLabelPending(result.pendingLabel);
        setPaidTx(result.txHash);
      }
    } catch (e) {
      setClaimUrl(null);
      setError(stellarPayErrorMessage(e));
    } finally {
      setStatus(null);
      setBusy(null);
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
              {claimUrl
                ? 'Send the recipient this claim link. It is the only way to the money.'
                : 'This request is paid. The recipient discovers the payment automatically on their next sync. No receipt link is needed.'}
            </Text>
            <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(getExplorerTxUrl(STELLAR_TESTNET_ID, paidTx))} accessibilityRole="link" hitSlop={8}>
              <Text className="font-pp-medium text-[12px] underline text-primary">
                Tx: {paidTx.replace(/^0x/, '').slice(0, 10)}…{paidTx.slice(-8)}
              </Text>
            </Pressable>
              <ExplorerPrivacyHint explorerName={'StellarExpert'} />
            </View>
            {labelPending ? <StellarLabelRetryNotice retry={retryLabel} /> : null}
            {error ? <Text className="font-pp-regular text-[12px] text-[#E11D48]">{error}</Text> : null}
            {claimUrl ? (
              <Pressable
                onPress={() => { void copyText(claimUrl).then(() => setCopied(true), () => setCopied(false)); }}
                accessibilityRole="button"
                testID="stellar-pay-copy-claim"
                className="items-center justify-center rounded-control bg-button-primary px-[16px] py-[10px]"
              >
                <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                  {copied ? 'Claim link copied' : 'Copy claim link for the recipient'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : link && amountLabel ? (
          <>
            <View className="gap-[4px]">
              <Text className="font-pp-bold text-[16px] text-text">Privacy Pools Payment</Text>
              <Text className="font-pp-regular text-[12px] text-text-muted">Pay from your pool balance or your wallet</Text>
            </View>

            <View className="flex-row items-center justify-between gap-[12px]">
              <Text className="font-pp-medium text-[14px] text-text">1x Private pool payment</Text>
              <Text className="font-pp-semi-bold text-[14px] text-text">{amountLabel}</Text>
            </View>
            <View className="flex-row items-center justify-between gap-[12px]">
              <Text className="font-pp-medium text-[14px] text-text">Relayer fee</Text>
              <Text className="font-pp-semi-bold text-[14px] text-text" testID="stellar-pay-fee">up to {formatUnits(relayFee, STELLAR_XLM.decimals)} XLM</Text>
            </View>

            <View className="border-t border-dashed border-border-light" />

            <View className="flex-row items-center justify-between">
              <Text className="font-pp-bold text-[16px] text-text">Total</Text>
              <Text className="font-pp-bold text-[16px] text-text">{totalLabel}</Text>
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
                  ? 'Private Transfer pays from your shielded balance. The amount, who paid and who is paid stay private.'
                  : "Private Transfer pays from your shielded balance. The amount and who paid stay private. This older link names the recipient's Stellar address."}
                {' Wallet pay is a public deposit: your wallet and the amount are visible on chain.'}
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
              <>
                <Pressable
                  onPress={() => { void (link.format === 'blind' ? (needsSignIn ? signIn() : payBlind()) : payByAddress()); }}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !!busy }}
                  disabled={!!busy}
                  testID="stellar-pay-private"
                  className={`items-center justify-center rounded-control bg-button-primary py-[14px] ${busy ? 'opacity-[0.45]' : 'opacity-100'}`}
                >
                  <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                    {busy === 'private' ? 'Processing...' : needsSignIn ? 'Sign in to pay' : 'Pay via Private Transfer'}
                  </Text>
                </Pressable>
                {/* Same pair as the EVM /pay page: the wallet route needs no
                    shielded balance, so a first-time payer can pay too. */}
                {belowWalletMinimum ? (
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{WALLET_MINIMUM_MESSAGE}</Text>
                ) : (
                <Pressable
                  onPress={() => { void payFromWallet(); }}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !!busy }}
                  disabled={!!busy}
                  testID="stellar-pay-wallet"
                  className={`items-center justify-center rounded-control bg-button-primary py-[14px] ${busy ? 'opacity-[0.45]' : 'opacity-[0.85]'}`}
                >
                  <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                    {busy === 'wallet' ? 'Processing...' : 'Pay via Wallet'}
                  </Text>
                </Pressable>
                )}
              </>
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
