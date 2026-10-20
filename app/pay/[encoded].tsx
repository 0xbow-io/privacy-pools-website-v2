import { payRelayUnknownMessage } from '@/services/pay-relay-guard';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';

import { useTheme } from '@/components/theme-provider';
import { usePaymentRequestModal } from '@/components/payment-request-modal-provider';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { useSupportedWalletConnection } from '@/hooks/use-supported-wallet-connection';
import { INLINE_OP_HOST_ID } from '@/components/inline-op-portal';
import { useInlineOpsCapable } from '@/hooks/use-inline-ops-capable';
import { usePaymentRequestExpired } from '@/hooks/use-payment-request-expired';
import { Colors } from '@/constants/theme';
import { getChainConfig, getExplorerAddressUrl, getExplorerName, getExplorerTxUrl } from '@/config/chains';
import { linkAmountLabel } from '@/services/link-token-registry';
import { receiptChain } from '@/services/receipt-chain-registry';
import { requestWalletRefusalFor } from '@/services/request-wallet-availability';
import { ReceiptWrongNetworkCopy } from '@/components/receipt-wrong-network';
import { resolveEnsName } from '@/services/ens';
import { getStoredPaymentRequestRecord, reloadPaymentRequestsInSession, restorePaymentRequestFromPayload } from '@/services/payment-request-recovery';
import {
  decodePaymentRequestPayloadFromUrl,
  PAYMENT_REQUEST_EXPIRED_MESSAGE,
  verifyPaymentRequestSignature,
  type PaymentRequestPayload,
  type PaymentRequestPayloadV2,
  type PaymentRequestPayloadV3,
} from '@/services/payment-requests';
import type { Hex } from '@/services/sdk-types';
import { isStellarRequestLink } from '@/services/stellar/stellar-request';
import { StellarPayRequestScreen } from '@/components/stellar-pay-request';

/**
 * A seller-supplied display name, rendered so it cannot be mistaken for a
 * verified identity.
 *
 * Capped because the field is unbounded free text: an untruncated name is a
 * layout break and a spoofing surface (trailing whitespace plus a fake badge).
 * Quoted and prefixed because the signature proves only that the signer CHOSE
 * this string, never that it is true.
 */
const SELLER_NAME_MAX = 32;
function formatSellerClaim(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  const clipped = name.length > SELLER_NAME_MAX ? `${name.slice(0, SELLER_NAME_MAX - 1)}\u2026` : name;
  return `claims to be \u201c${clipped}\u201d`;
}

function formatRequestCode(requestId: string | null | undefined): string {
  if (!requestId) return 'Pending';
  const clean = requestId.replace(/[^a-zA-Z0-9]/g, '');
  if (clean.length <= 8) return clean;
  return `${clean.slice(0, 5)}...${clean.slice(-4)}`;
}

function isSignablePaymentRequest(
  request: PaymentRequestPayload | null | undefined,
): request is PaymentRequestPayloadV2 | PaymentRequestPayloadV3 {
  return !!request && (request.kind === 'ppv2-sdk-payment-request' || request.version === 2);
}

/** Stellar request links (`xlm.…`) have their own page; everything else is the EVM one. */
export default function PayRequestScreen() {
  const params = useLocalSearchParams<{ encoded?: string | string[] }>();
  const encoded = Array.isArray(params.encoded) ? params.encoded[0] : params.encoded;
  if (isStellarRequestLink(encoded)) return <StellarPayRequestScreen encoded={encoded as string} />;
  return <EvmPayRequestScreen />;
}

function EvmPayRequestScreen() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { openPayRequestModal, openPayViaTransferModal, isOpen: payFlowOpen, inlineActive: payFlowInline, busyAction: payFlowBusyAction, mode: payFlowMode, lastPaid, payRelayLatchFor } = usePaymentRequestModal();
  // busyAction, not isBusy: `isBusy` is shared by every flow in the provider,
  // so a create-request opened from the header made these Pay buttons read
  // "Processing..." while nothing was being paid (code review 2026-08-27).
  // Only the two pay handlers set busyAction.
  const payFlowBusy = payFlowBusyAction !== null;
  // The wallet's ACTUAL chain (connector), falling back to the wagmi store
  // when disconnected. The `request.chainId !== chainId` switch guard below
  // must compare against where the wallet REALLY is — raw useChainId() is
  // the store, which doesn't follow the connector, so the guard prompted
  // spuriously or skipped a needed switch when the two split. (The sends in
  // the payment provider pin chainId per-call regardless, so this guard is
  // UX, not money-safety.)
  const { address, chainId: connectorChainId } = useAccount();
  const storeChainId = useChainId();
  const chainId = connectorChainId ?? storeChainId;
  const { switchChainAsync } = useSwitchChain();
  const { ensureInitialized, exportAccount, poolSession, refreshNotes, identityMode, sessionAddress } = usePoolSession();
  const { selectChain } = useChainRouter();
  const sessionChainId = useSessionChainId();
  const { connectWallet } = useSupportedWalletConnection();
  // The flow renders INLINE into this page's card when the runtime supports
  // it (web, non-classic) — the overlay modal duplicated the page 1:1.
  const inlineCapable = useInlineOpsCapable();
  const flowActive = payFlowOpen && payFlowInline && payFlowMode === 'pay';
  const params = useLocalSearchParams<{ encoded?: string | string[] }>();

  const encoded = Array.isArray(params.encoded) ? params.encoded[0] : params.encoded;

  const request = useMemo(() => {
    if (!encoded) return null;
    try {
      return decodePaymentRequestPayloadFromUrl(encoded);
    } catch {
      return null;
    }
  }, [encoded]);

  // Past the SDK deadline the link carries: the requester no longer scans for
  // it, so both Pay buttons go off. A link without a deadline never expires.
  const expired = usePaymentRequestExpired(request);

  // Paid THIS request in this session: the page must render a terminal card,
  // never the pristine "Ready + Pay" one - after a confirmed payment the
  // inline flow can unmount and the fallback card invited paying twice
  // (Mike, QA 2026-08-25; reproduced by the unregistered-payee e2e).
  const thisRequestPaid = !!(lastPaid && request
    && lastPaid.requestKey === (request.kind === 'ppv2-sdk-payment-request' ? request.paymentId : request.requestId));

  const [signatureStatus, setSignatureStatus] = useState<'unsigned' | 'checking' | 'valid' | 'invalid'>('unsigned');
  const [signerEnsName, setSignerEnsName] = useState<string | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoverStatus, setRecoverStatus] = useState<string | null>(null);
  /**
   * What the Status row says to the SELLER.
   *
   * It used to be the literal "Ready" for everyone. To a payer that is a fair
   * description of the link; to the seller looking at their own request it
   * answers a question nobody asked, while the one they DID ask (have I been
   * paid?) sat behind the Track button (Pat, 2026-08-31). Read from the local
   * record, which is the same thing Track re-checks.
   */
  const [sellerStatus, setSellerStatus] = useState<{ text: string; color: string } | null>(null);
  const [statusRefresh, setStatusRefresh] = useState(0);
  const [recoverError, setRecoverError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isSignablePaymentRequest(request) || !request.signature) {
      setSignatureStatus('unsigned');
      return;
    }
    setSignatureStatus('checking');
    verifyPaymentRequestSignature(request)
      .then((valid) => {
        if (!cancelled) setSignatureStatus(valid ? 'valid' : 'invalid');
      })
      .catch(() => {
        if (!cancelled) setSignatureStatus('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    const signer = isSignablePaymentRequest(request) ? request.signature?.signer : null;
    setSignerEnsName(null);
    if (!signer) return;
    resolveEnsName(signer).then((name) => {
      if (!cancelled) setSignerEnsName(name);
    });
    return () => {
      cancelled = true;
    };
  }, [request]);

  // Any environment's registry, never a guessed 18 decimals (DEV-484).
  // DEV-485: a request made on a chain only another environment serves (OP on
  // staging-mainnet, opened on Prod) used to fail only after Pay was pressed,
  // with "Unsupported chain in payment request (chainId 10)". Name the chain
  // and the environment up front, and offer the switch instead.
  const linkChain = request ? receiptChain(request.chainId) : null;
  const linkElsewhere = !!linkChain && (!linkChain.supported || !!linkChain.otherEnvironment);
  const chainName = request ? (linkChain?.name ?? `Chain ${request.chainId}`) : 'Sepolia';
  const amountLabel = request ? linkAmountLabel(BigInt(request.amount), request.tokenId, request.chainId) : null;
  const senderLabel = useMemo(() => {
    if (!isSignablePaymentRequest(request)) return null;
    const sig = request.signature;
    if (!sig) return { text: 'Unsigned request', color: colors.textMuted };
    if (signatureStatus === 'checking') return { text: 'Checking wallet signature...', color: colors.textMuted };
    if (signatureStatus === 'invalid') return { text: 'Signature failed', color: '#C24131' };
    const name = sig.sellerName?.trim();
    // Muted, quoted and qualified. The verified fact is the signer address,
    // which the badge and the Verified wallet row below both carry.
    return name
      ? { text: formatSellerClaim(name), color: colors.textMuted }
      : { text: 'Signed request', color: colors.success };
  }, [colors.success, colors.textMuted, request, signatureStatus]);
  const verifiedWalletLabel = useMemo(() => {
    if (!isSignablePaymentRequest(request) || !request.signature) return null;
    if (signatureStatus !== 'valid') return null;
    const signer = request.signature.signer;
    return signerEnsName ? `${signerEnsName} (${formatRequestCode(signer)})` : formatRequestCode(signer);
  }, [request, signatureStatus, signerEnsName]);
  const verifiedWalletUrl = isSignablePaymentRequest(request) && request.signature
    ? getExplorerAddressUrl(request.chainId, request.signature.signer)
    : '';
  // Effective identity — the handler already accepts a key session
  // (sessionAddress); the RENDER gate must match or an account-key-only
  // owner sees payer controls and never reaches Track/Recover (codex).
  const sellerIdentity = sessionAddress ?? address ?? null;
  const isSellerByAddress = !!request
    && !!request.recipientAddress
    && !!sellerIdentity
    && request.recipientAddress.toLowerCase() === sellerIdentity.toLowerCase();
  // Set once the local record confirms it. Unsigned links carry no address,
  // so this is the ONLY way their owner is recognised.
  const [isSellerByRecord, setIsSellerByRecord] = useState(false);
  const isSeller = isSellerByAddress || isSellerByRecord;

  useEffect(() => {
    if (!request || request.kind !== 'ppv2-sdk-payment-request' || !sellerIdentity) {
      setSellerStatus(null);
      setIsSellerByRecord(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const record = await getStoredPaymentRequestRecord(
          request.chainId, request.paymentId as Hex, sellerIdentity,
        );
        if (cancelled) return;
        setIsSellerByRecord(!!record);
        if (!record) {
          // Not this browser's request. For a SIGNED link the address still
          // says the viewer owns it, and then the honest status is that
          // nothing local can say whether it was paid.
          setSellerStatus(isSellerByAddress
            ? { text: 'Not on this browser', color: colors.textMuted }
            : null);
          return;
        }
        const paid = (record as { fulfilledByCommitments?: unknown[] }).fulfilledByCommitments?.length;
        setSellerStatus(paid
          ? { text: 'Paid', color: colors.success }
          : { text: 'No payment yet', color: colors.textMuted });
      } catch {
        if (!cancelled) setSellerStatus(null);
      }
    })();
    return () => { cancelled = true; };
  }, [isSeller, request, sellerIdentity, colors.success, colors.textMuted, statusRefresh]);

  const signatureNotice = useMemo(() => {
    // A broken seal outranks the deadline: it says the deadline itself may be forged.
    if (expired && signatureStatus !== 'invalid') return PAYMENT_REQUEST_EXPIRED_MESSAGE;
    if (!isSignablePaymentRequest(request)) {
      return 'Review the amount before paying.';
    }
    if (!request.signature) {
      return 'This request is unsigned. You can still pay it, but the app cannot prove who created the link.';
    }
    if (signatureStatus === 'valid') {
      return 'These payment details were signed by the wallet shown above. That address is verified; any display name is only what the signer chose to call themselves.';
    }
    if (signatureStatus === 'invalid') {
      return 'Signature failed: these payment details may have been changed. Ask the sender for a fresh link.';
    }
    return 'Checking the sender wallet signature...';
  }, [expired, request, signatureStatus]);

  // Connect-first pay launch (codex/QA): a disconnected click used to open
  // the pay modal, which the URL bridge then judged un-openable and closed —
  // a flash. Open the wallet picker instead, remember the intent, and resume
  // the SAME action once a connection (or key session) lands.
  const [pendingPay, setPendingPay] = useState<'wallet' | 'transfer' | null>(null);
  const payIdentity = sessionAddress ?? address ?? null;
  // === Pay lock (QA 2026-08-27: "ux is still bad") =======================
  // The two Pay buttons below used to gate ONLY on the tampered-signature
  // signal, so they stayed live and full-opacity while a payment ran. Two
  // windows make that reachable:
  //
  //  1. Any surface where the flow is NOT inline. `flowActive` needs
  //     `inlineActive`, and the provider only goes inline when the OPENER
  //     asked AND useInlineOpsCapable() holds -- which is
  //     `Platform.OS === 'web'`. On a native build the flow is the <Modal>
  //     overlay and these buttons stay mounted and enabled for the whole run.
  //     A press there re-enters the opener, which calls resetState() ->
  //     opEpochRef bump -> the in-flight run aborts at its next live() gate.
  //     That is the same invariant closePaymentRequestModal refuses to break,
  //     and it can strand a run the user already paid approval gas for.
  //  2. The connect detour in launchPay below: the flow never opens, so
  //     `flowActive` is false for the whole picker session. Nothing is
  //     running yet there, so this half is presentation only.
  //
  // Gate on the provider's real state, never on `flowActive`: payFlowOpen
  // covers the whole open lifetime (including the armed window where
  // pendingAutoAction is set but no handler has started), payFlowBusy covers
  // a run that outlives a surface change, pendingPay covers window 2.
  //
  // `pendingPay` is deliberately NOT part of this (code review 2026-08-27).
  // It is set when the wallet picker is opened and cleared ONLY by the resume
  // effect below, which needs `satisfied` to become true -- so a user who
  // dismisses the picker without connecting leaves it set forever. Folding it
  // into `disabled` therefore killed both buttons permanently, labelled
  // "Waiting for your wallet..." with no wallet ever arriving, recoverable
  // only by reload. That is precisely the hazard the provider's own progress
  // rail comment warns about: never gate `disabled` on a flag that can fail
  // to clear. Nothing is running during that detour anyway, and pressing
  // again just reopens the picker, which is the useful behaviour. It still
  // drives the LABEL below, where a stuck value is merely stale text.
  const payLocked = (payFlowOpen && payFlowMode === 'pay') || payFlowBusy;
  // Dim MIRRORS disabled and nothing else -- opacity never says WHICH action
  // is running (that is the label's job). Same rule as the provider's own pay
  // buttons and as the Track / Recover button below.
  // A relay of this request may still land (DEV-486): the page buttons call
  // the openers, which the provider's op lock cannot see, so they gate here.
  const relayLatch = payRelayLatchFor(request ? (request.kind === 'ppv2-sdk-payment-request' ? request.paymentId : request.requestId) : null);
  // The latch lapses by time; re-render then so the buttons come back.
  const [, setLatchExpiryTick] = useState(0);
  const relayLatchUntil = relayLatch?.until ?? null;
  useEffect(() => {
    if (relayLatchUntil === null) return;
    const timer = setTimeout(() => setLatchExpiryTick((n) => n + 1), Math.max(0, relayLatchUntil - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [relayLatchUntil]);
  const payDisabled = payLocked || signatureStatus === 'invalid' || !!relayLatch || linkElsewhere || expired;
  // Same decision the wallet handler enforces, so the button never looks live
  // for a request it refuses (DEV-422).
  const walletRefusal = useMemo(() => (request ? requestWalletRefusalFor(request) : null), [request]);
  const launchPay = (kind: 'wallet' | 'transfer') => {
    // 'wallet' needs a wagmi wallet (it signs the depositFor tx); 'transfer'
    // is relayed, so an account-key session is enough.
    const satisfied = kind === 'wallet' ? !!address : !!payIdentity;
    if (!satisfied) {
      setPendingPay(kind);
      void connectWallet();
      return;
    }
    if (kind === 'wallet') openPayRequestModal(encoded, { inline: inlineCapable });
    else openPayViaTransferModal(encoded, { inline: inlineCapable });
  };
  useEffect(() => {
    if (!pendingPay || !encoded) return;
    const satisfied = pendingPay === 'wallet' ? !!address : !!payIdentity;
    if (!satisfied) return;
    const kind = pendingPay;
    setPendingPay(null);
    if (kind === 'wallet') openPayRequestModal(encoded, { inline: inlineCapable });
    else openPayViaTransferModal(encoded, { inline: inlineCapable });
  }, [pendingPay, address, payIdentity, encoded, openPayRequestModal, openPayViaTransferModal]);

  const handleRecoverPaymentRequest = async () => {
    if (!request) return;
    // Effective identity: an account-key session owns its requests too — the
    // recover gate must not demand a wagmi wallet it doesn't have (codex).
    const recoverIdentity = sessionAddress ?? address;
    if (!recoverIdentity) {
      setRecoverError('Connect the seller wallet (or sign in with your account key) first.');
      return;
    }
    if (request.recipientAddress && request.recipientAddress.toLowerCase() !== recoverIdentity.toLowerCase()) {
      setRecoverError('Connect the wallet that created this payment request.');
      return;
    }

    setIsRecovering(true);
    setRecoverStatus(null);
    setRecoverError(null);
    try {
      // Align through ChainProvider, and against the SESSION chain (codex):
      // raw switchChainAsync only moves wagmi state — for a disconnected
      // account key that leaves the ChainProvider selection (which the SDK
      // session follows) on the old chain, so recovery would discover there.
      if (request.chainId !== sessionChainId) {
        const outcome = await selectChain(request.chainId);
        setRecoverStatus(outcome === 'committed'
          ? 'Switched network. Click recover again to continue on the request’s chain.'
          : outcome === 'superseded'
            ? 'Another network change took over. Check the selector, then click recover again.'
            : 'The network switch was declined. Switch manually, then click recover again.');
        return;
      }

      const restored = request.kind === 'ppv2-sdk-payment-request'
        ? await restorePaymentRequestFromPayload(request, recoverIdentity)
        : 'exists';

      const session = await ensureInitialized();
      if (request.kind === 'ppv2-sdk-payment-request') {
        await reloadPaymentRequestsInSession(poolSession ?? session);
      }

      const fromBlock = getChainConfig(request.chainId)?.contracts?.fromBlock;
      const discovered = await session.discoverNotes(
        fromBlock ? { fromBlock: `0x${BigInt(fromBlock).toString(16)}` as Hex } : undefined,
      );
      await exportAccount(session);
      refreshNotes();

      setStatusRefresh((n) => n + 1);
      const verb = restored === 'exists' ? 'checked' : 'restored';
      setRecoverStatus(
        discovered.length > 0
          ? request.kind === 'ppv2-sdk-payment-request'
            ? `Request ${verb}. Imported ${discovered.length} received note(s).`
            : `Wallet-key request checked. Imported ${discovered.length} received note(s).`
          : restored === 'missing-private-key'
            ? 'This link is not a backup, so it cannot restore the request on its own. Import your payment-request backup while signed in with this wallet.'
            : request.kind === 'ppv2-sdk-payment-request'
              ? `Request ${verb}. No payment found yet; try again after the payer sends it.`
              : 'Wallet-key request checked. No payment found yet; try again after the payer sends it.',
      );
    } catch (error) {
      setRecoverError(error instanceof Error ? error.message : 'Failed to recover payment request.');
    } finally {
      setIsRecovering(false);
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
        Double-blind private payment on {chainName}
      </Text>

      <View className="w-full max-w-[560px] gap-[18px] rounded-card border border-border-light bg-card-background px-[24px] py-[24px]">
        {/* While the pay flow runs, IT owns this card: the flow content
            renders inline into the host below instead of an overlay modal
            duplicating the same summary and buttons (QA, 2026-08-16). */}
        {flowActive ? (
          <View nativeID={INLINE_OP_HOST_ID} className="w-full justify-start" />
        ) : thisRequestPaid ? (
          <View className="items-center gap-[10px] py-[8px]">
            <Text className="font-pp-bold text-[16px] text-success">Payment sent ✓</Text>
            <Text className="text-center font-pp-regular text-[13px] text-text-secondary">
              {lastPaid!.hadReceipt
                ? 'This request is paid. Copy the receipt from the payment flow (or the transaction row menu) and send it to the recipient.'
                : 'This request is paid. The recipient discovers the payment automatically on their next sync. No receipt link is needed.'}
            </Text>
            <View className="flex-row items-center gap-[6px]">
<Pressable
              onPress={() => Linking.openURL(getExplorerTxUrl(lastPaid!.chainId, lastPaid!.txHash))}
              accessibilityRole="link"
              accessibilityLabel="View this transaction on the block explorer"
              testID="pay-tx-explorer-link"
              hitSlop={8}
            >
              <Text className="font-pp-medium text-[12px] underline text-primary">
                Tx: {lastPaid!.txHash.slice(0, 10)}…{lastPaid!.txHash.slice(-8)}
              </Text>
            </Pressable>
              <ExplorerPrivacyHint explorerName={getExplorerName(lastPaid!.chainId)} />
            </View>
          </View>
        ) : request && amountLabel ? (
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
                <Text className="font-pp-medium text-[12px] text-right text-text-secondary">{formatRequestCode(request.kind === 'ppv2-sdk-payment-request' ? request.paymentId : request.requestId)}</Text>
              </View>
              <View className="flex-row items-center justify-between gap-[12px]">
                <Text className="font-pp-medium text-[12px] text-text-muted">Recipient</Text>
                {/* True again as of 2026-08-31: the share link no longer carries
                    recipientAddress. It cannot be recovered from what remains
                    either, since the address is bound inside
                    noteAddressHash = Poseidon(ownerAddress, noteSecret) and the
                    secrets ship zeroed. A SIGNED request is the exception and
                    names its signer in the rows below, by the seller's choice. */}
                <Text className="font-pp-medium text-[12px] text-right text-text-secondary">hidden (double-blind)</Text>
              </View>
              <View className="flex-row items-center justify-between gap-[12px]">
                <Text className="font-pp-medium text-[12px] text-text-muted">Status</Text>
                {sellerStatus ? (
                  /* nw-keep(data-color): seller status color is a runtime theme token */
                  <Text className="font-pp-medium text-[12px] text-right" style={{ color: sellerStatus.color }}>
                    {sellerStatus.text}
                  </Text>
                ) : signatureStatus === 'invalid' ? (
                  /* "Ready" sat in green immediately above "Signature failed"
                     in red, on a payload whose Pay buttons are disabled. Say
                     what is actually true of it (Pat, 2026-08-31). */
                  <Text className="font-pp-medium text-[12px] text-right text-warning">Not payable</Text>
                ) : expired ? (
                  <Text className="font-pp-medium text-[12px] text-right text-text-muted">Expired</Text>
                ) : (
                  <Text className="font-pp-medium text-[12px] text-right text-success">Ready</Text>
                )}
              </View>
              {senderLabel ? (
                <View className="flex-row items-center justify-between gap-[12px]">
                  <Text className="font-pp-medium text-[12px] text-text-muted">Sender</Text>
                  {/* nw-keep(data-color): sender status color is a runtime union (theme token or signature-fail literal), no class token */}
                  <Text className="font-pp-medium text-[12px] text-right" style={{ color: senderLabel.color }}>{senderLabel.text}</Text>
                </View>
              ) : null}
              {verifiedWalletLabel ? (
                <View className="flex-row items-center justify-between gap-[12px]">
                  <Text className="font-pp-medium text-[12px] text-text-muted">Verified wallet</Text>
                  <Pressable
                    disabled={!verifiedWalletUrl}
                    onPress={() => verifiedWalletUrl && Linking.openURL(verifiedWalletUrl)}
                  >
                    <Text className="font-pp-medium text-[12px] text-right underline text-primary">{verifiedWalletLabel}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

            <View className={`gap-[6px] rounded-inner border border-border px-[14px] py-[12px] ${signatureStatus === 'invalid' || expired ? 'bg-warning-bg' : 'bg-success-bg'}`}>
              <Text className={`font-pp-semi-bold text-[13px] ${signatureStatus === 'invalid' || expired ? 'text-warning' : 'text-success'}`}>
                {expired && signatureStatus !== 'invalid'
                  ? 'Request expired'
                  : signatureStatus === 'valid'
                  ? `Signed by ${formatRequestCode(isSignablePaymentRequest(request) ? request.signature?.signer : null)}`
                  : signatureStatus === 'invalid' ? 'Signature failed' : 'Double-blind payment'}
              </Text>
              <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{signatureNotice}</Text>
            </View>

            {linkElsewhere && linkChain ? (
              <View className="gap-[6px] rounded-inner border border-warning bg-warning-bg px-[14px] py-[12px]" testID="pay-wrong-environment">
                <Text className="font-pp-semi-bold text-[13px] text-warning">Wrong network</Text>
                <ReceiptWrongNetworkCopy chain={linkChain} noun="request" textClassName="font-pp-regular text-[12px] leading-[18px] text-warning" />
              </View>
            ) : null}

            {relayLatch && !isSeller ? (
              <Text className="font-pp-regular text-[12px] leading-[18px] text-warning">
                {payRelayUnknownMessage(relayLatch.heard)}
              </Text>
            ) : null}

            {isSeller ? (
              <>
                <View className="gap-[6px] rounded-inner border border-border-light px-[14px] py-[12px]">
                  <Text className="font-pp-semi-bold text-[13px] text-text">This is your payment request</Text>
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                    {request.kind === 'ppv2-sdk-payment-request'
                      ? 'This link is not a backup. It only lets the payer pay you. To use this request in another browser, sign in with this wallet and import your payment-request backup.'
                      : 'This request uses your registered viewing key. Connect the seller wallet here to check for received payments from any browser.'}
                  </Text>
                </View>
                {recoverStatus ? <Text className="font-pp-medium text-[12px] leading-[18px] text-primary">{recoverStatus}</Text> : null}
                {recoverError ? <Text className="font-pp-medium text-[12px] leading-[18px] text-[#C24131]">{recoverError}</Text> : null}
                <Pressable
                  className={`items-center justify-center rounded-control bg-button-primary py-[14px] ${isRecovering ? 'opacity-[0.6]' : 'opacity-100'}`}
                  onPress={handleRecoverPaymentRequest}
                  disabled={isRecovering}
                >
                  <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                    {isRecovering ? 'Checking...' : 'Track / Recover Payment'}
                  </Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                className={`items-center justify-center rounded-control bg-button-primary py-[14px] ${payDisabled ? 'opacity-[0.45]' : 'opacity-100'}`}
                onPress={() => launchPay('transfer')}
                disabled={payDisabled}
              >
                <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                  {payFlowBusyAction === 'transfer'
                    ? 'Processing...'
                    : pendingPay === 'transfer'
                      ? 'Waiting for your wallet...'
                      : 'Pay via Private Transfer'}
                </Text>
              </Pressable>
            )}
            {/* The SDK-native exclusion is gone (a80b9e9 hid this button because
                depositFor could not carry the request tag; the SDK's path-A
                noteData now can, see services/payment-request-deposit.ts). It
                mattered: every request this app creates is SDK-native, so the
                exclusion made wallet-pay dead code and left a payer with no
                shielded balance -- the case this button exists for -- with no
                way to pay at all. Key sessions stay excluded: they have no
                wallet to sign the deposit. */}
            {!isSeller && identityMode !== 'key' && walletRefusal ? (
              <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{walletRefusal}</Text>
            ) : !isSeller && identityMode !== 'key' ? (
              <Pressable
                // Gated on the SAME tampered-signature signal as the private-
                // transfer button above — this is the button the bug left
                // enabled. The handler refuses a tampered request regardless
                // (that is the real guard), but leaving the button live would
                // invite the click and then error, so disable it here too. An
                // 'unsigned' or 'valid' request stays payable.
                // ...and on `payLocked` as well (QA 2026-08-27): both buttons
                // share ONE provider and one op lock, so "pay via wallet"
                // must not be pressable while a private transfer is running,
                // exactly as the provider's own pair. The 0.85 base opacity is
                // this control's secondary emphasis, not a state; 0.45 is the
                // disabled dim.
                className={`items-center justify-center rounded-control bg-button-primary py-[14px] ${payDisabled ? 'opacity-[0.45]' : 'opacity-[0.85]'}`}
                onPress={() => launchPay('wallet')}
                disabled={payDisabled}
              >
                <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                  {payFlowBusyAction === 'wallet'
                    ? 'Processing...'
                    : pendingPay === 'wallet'
                      ? 'Waiting for your wallet...'
                      : 'Pay via Wallet'}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <>
            <Text className="font-pp-bold text-[16px] text-center text-text">Invalid payment link</Text>
            <Text className="font-pp-regular text-[13px] text-center leading-[20px] text-text-secondary">
              This request link could not be decoded. Ask the sender to create a new one.
            </Text>
          </>
        )}
      </View>
    </ScrollView>
  );
}
