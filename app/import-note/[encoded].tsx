import { PUBLIC_PAYOUT_LABEL } from '@/services/gasless-registration';
import React, { useCallback, useMemo, useState } from 'react';
import { ReceiptWrongNetworkCopy } from '@/components/receipt-wrong-network';
import { receiptChain } from '@/services/receipt-chain-registry';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAccount } from 'wagmi';

import { getChainConfig, defaultChainId } from '@/config/chains';
import { linkToken } from '@/services/link-token-registry';
import { linkAmountText } from '@/services/link-token';
import { decodeNoteReceiptFromUrl } from '@/services/note-receipt';
import { isStellarClaimLink } from '@/services/stellar/stellar-claim';
import { StellarClaimNoteScreen } from '@/components/stellar-claim-note';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { useNoteImport } from '@/hooks/use-note-import';
import { useLinkApproval } from '@/hooks/use-link-approval';
import { isBlockedApproval, LINK_APPROVAL_COPY } from '@/services/link-approval-rules';
import { useTabCloseGuard } from '@/hooks/use-tab-close-guard';
import { FlowProgress } from '@/components/ui/flow-progress';
import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useSupportedWalletConnection } from '@/hooks/use-supported-wallet-connection';
import { useReceiveSetup } from '@/hooks/use-receive-setup';
import { isViewingKeyGasShort, usePublishViewingKey } from '@/hooks/use-publish-viewing-key';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { formatGasTopUp } from '@/services/gas-top-up';
import { FeeWarning } from '@/components/fee-warning';
import { useWalletTokens } from '@/components/wallet-tokens-provider';
import { NATIVE_ASSET_ADDRESS } from '@/config/environments';
import { useFeePricing } from '@/hooks/use-fee-pricing';
import { useTransferFeeEstimate } from '@/hooks/use-transfer-fee-estimate';
import { decideRegistrationPath } from '@/services/cold-start-claim';
import { relayedSpendBreakdown } from '@/services/fee-warning';
import { SHIELDED_TRANSFER_GAS } from '@/services/transfer-fee-estimate';
import { RegisterWalletOffer, registerOfferGasText } from '@/components/register-wallet-offer';
import {
  CLAIM_FINISH_SETUP_BODY,
  CLAIM_FINISH_SETUP_BODY_NO_GAS,
  CLAIM_ONE_STEP_LEFT,
  FINISH_SETUP_PRIMARY,
  markFinishSetupFromClaim,
} from '@/services/receive-setup';

/** Stellar claim links (`xlmn.…`) have their own page; everything else is the EVM one. */
export default function ImportNoteScreen() {
  const params = useLocalSearchParams<{ encoded?: string | string[] }>();
  const encoded = Array.isArray(params.encoded) ? params.encoded[0] : params.encoded;
  if (isStellarClaimLink(encoded)) return <StellarClaimNoteScreen encoded={encoded as string} />;
  return <EvmImportNoteScreen />;
}

function EvmImportNoteScreen() {
  const params = useLocalSearchParams<{ encoded?: string | string[] }>();
  const router = useRouter();
  const { address } = useAccount();
  const { keysReady, sessionAddress, identityMode } = usePoolSession();
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const { connectWallet } = useSupportedWalletConnection();
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  // Device-only import lives behind this toggle — expert affordance.
  const {
    status,
    statusMessage,
    errMessage,
    busy,
    done,
    hasUnanchoredLocalNote,
    approvalBlock,
    claimGasTopUpWei,
    claimSplit,
    importToDevice,
    importOnChain,
    registerOffer,
    registerState,
    registerWalletOnly,
    dismissRegisterOffer,
  } = useNoteImport();

  // Until the note is anchored on-chain it exists only in this browser's
  // storage. `hasUnanchoredLocalNote` is durable — it keeps the warning armed
  // after a partially failed anchor (note imported locally, then the fallible
  // registration/relay work errored), which `status === 'error'` would drop.
  useTabCloseGuard(
    busy || hasUnanchoredLocalNote,
    'Only in this tab. The link restores it.',
  );

  const encoded = Array.isArray(params.encoded) ? params.encoded[0] : params.encoded;

  const receipt = useMemo(() => {
    if (!encoded) return null;
    return decodeNoteReceiptFromUrl(encoded);
  }, [encoded]);
  // The receipt's OWN chain when the envelope carries one (the native-token
  // sentinel is ambiguous across chains — a Citrea cBTC receipt must not
  // display as ETH); legacy envelopes fall back to the default chain.
  const receiptChainId = receipt?.chainId ?? defaultChainId;

  // A relayed claim sets the auth policy but not the viewing key, so the claim
  // isn't finished until the viewing key is published.
  const { partial: setupPartial } = useReceiveSetup(receiptChainId);
  const { publishViewingKey } = usePublishViewingKey(receiptChainId);
  const { openFinishSetup } = useKeystoreRegistrationModal();
  const [finish, setFinish] = useState<{ busy: boolean; message: string; error: string | null; gasShort: boolean }>(
    { busy: false, message: '', error: null, gasShort: false },
  );
  const oneStepLeft = status === 'anchored' && setupPartial && identityMode === 'wallet';

  // Leaving the claim page for the app. Same intent as the native header's back
  // arrow (this route deliberately keeps its header for that reason —
  // app/_layout.tsx). The app is served from this very origin, so this is
  // in-app navigation, not an external URL.
  //
  // Always My balances, never router.back() and never bare '/'.
  //
  // The destination the user wants after claiming is the money they just
  // claimed, and '/' is the marketing home, which does not show it. back() is
  // worse than either: a receipt link is normally opened in a COLD tab from a
  // chat or an email, so the previous entry is either nothing or somewhere off
  // this site entirely, and when there IS history it is whatever they were
  // reading before rather than anywhere in the app.
  //
  // replace, not push, so the claim page does not sit in history behind them.
  //
  // Leaving while partial makes My Pools open Finish setup immediately.
  //
  // Blocked while `runFinishSetup` is in flight (wallet prompt or receipt
  // wait): marking for auto-open here would let My Balances start a SECOND
  // publish-viewing-key flow while this page's transaction is still pending,
  // racing the same on-chain write from two places at once.
  const leaveClaimPage = useCallback(() => {
    if (finish.busy) return;
    if (oneStepLeft) markFinishSetupFromClaim();
    router.replace('/?panel=balances');
  }, [router, oneStepLeft, finish.busy]);

  const runFinishSetup = useCallback(async () => {
    setFinish({ busy: true, message: '', error: null, gasShort: false });
    try {
      await publishViewingKey({
        onStatus: (message) => setFinish((prev) => ({ ...prev, message })),
      });
      setFinish({ busy: false, message: '', error: null, gasShort: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFinish({
        busy: false,
        message: '',
        gasShort: isViewingKeyGasShort(err),
        error: isViewingKeyGasShort(err)
          ? 'This wallet does not have enough gas to publish its viewing key. A relayer can send some first.'
          : /user rejected|user denied|user cancel/i.test(message)
            ? 'Transaction cancelled in your wallet. You can finish setup any time.'
            : message,
      });
    }
  }, [publishViewingKey]);

  // A two-lineage transfer packs one note per lineage; import them ALL, or the
  // recipient loses the value of every note after the first. `note` (the first)
  // is still used for the identity/commitment display; amount is the sum.
  const notes = receipt?.notes ?? [];
  const note = notes[0] ?? null;
  // Chain-SCOPED lookup when the envelope names the chain: the any-chain
  // helper scans every registry first, so the shared native sentinel hit ETH
  // before Citrea's cBTC (codex). Any-chain only for legacy receipts.
  // Any environment's registry, and never a guessed 18 decimals (DEV-484):
  // an OP USDC claim opened on Prod read "0.000000000003 0X0B2C".
  const token = note ? linkToken(note.tokenId, receipt?.chainId) : null;
  // A wallet that can pay its own registration has the relayer anchor each
  // note in its own transfer; one that cannot gets a single relayed claim over
  // the whole receipt. The path is decided at press, so a wallet whose gas is
  // not known yet is priced as the single claim: never more than it pays.
  const feePricing = useFeePricing(receiptChainId);
  const transferFeeFor = useTransferFeeEstimate(receiptChainId);
  const walletTokensOn = useWalletTokens();
  const claimFeeBreakdown = useMemo(() => {
    if (!note || !token?.known) return null;
    const perNote = transferFeeFor(note.tokenId);
    if (perNote === null) return null;
    const claimed = receipt?.notes ?? [];
    const gasPriceWei = feePricing.gasPriceOf(receiptChainId);
    const nativeWei = walletTokensOn(receiptChainId).find((t) => t.address.toLowerCase() === NATIVE_ASSET_ADDRESS)?.balance;
    const walletPays = nativeWei !== undefined && gasPriceWei !== null
      && decideRegistrationPath({ supported: true, balanceWei: nativeWei, gasPriceWei }).reason === 'funded';
    const count = walletPays ? BigInt(claimed.length) : 1n;
    return relayedSpendBreakdown({
      chainId: receiptChainId,
      amountWei: claimed.reduce((sum, n) => sum + BigInt(n.value), 0n),
      feeWei: perNote * count,
      decimals: token.decimals,
      tokenUsd: feePricing.tokenUsdOf(receiptChainId, note.tokenId, token.symbol),
      gasUnits: SHIELDED_TRANSFER_GAS * count,
      gasPriceWei,
      nativeUsd: feePricing.nativeUsdOf(receiptChainId),
    });
  }, [note, receipt, token, transferFeeFor, feePricing, receiptChainId, walletTokensOn]);
  const receiptChainInfo = receiptChain(receiptChainId);
  const chainName = receiptChainInfo.name;
  const nativeCurrency = getChainConfig(receiptChainId)?.nativeCurrency ?? { symbol: 'ETH', decimals: 18 };
  const claimTopUpText = formatGasTopUp({
    wei: claimGasTopUpWei,
    symbol: nativeCurrency.symbol,
    decimals: nativeCurrency.decimals,
  })?.amountText ?? null;
  const amountLabel = notes.length > 0 && token
    ? linkAmountText(notes.reduce((sum, n) => sum + BigInt(n.value), 0n), token)
    : null;

  // The owner of the note is the recipient. Match it against the active
  // identity (an account-key session's address, falling back to the
  // connected wallet) — not the raw wallet, so key sessions match too.
  const effectiveAddress = sessionAddress ?? address ?? null;
  // A send-time receipt names its recipient. A claim RECOVERED from the
  // sender's on-chain backup does not (it carries only what the SDK itself
  // announces, so the sender's record names nobody), and is claimed by
  // whoever is signed in. That is safe to allow: the import path recomputes
  // the commitment from the claimant's address, and only the true recipient's
  // address reproduces the one the deposit committed to. A stranger with the
  // link imports a note that is not in the tree and cannot spend it.
  const expectedRecipient = note?.ownerAddress ?? effectiveAddress ?? null;
  const recipientMatches = expectedRecipient && effectiveAddress
    ? expectedRecipient.toLowerCase() === effectiveAddress.toLowerCase()
    : false;

  // The on-chain anchor registers a keystore, which must be signed by the
  // owner wallet. An account-key session has no wallet to send that tx,
  // so anchoring is wallet-only; key sessions can still import to-device.
  const canAnchorOnChain = identityMode === 'wallet';
  const shortRecipient = expectedRecipient
    ? `${expectedRecipient.slice(0, 6)}…${expectedRecipient.slice(-4)}`
    : 'this address';

  // Signed in == keys derived this session. Notes never persist across a
  // reload (durability comes from the on-chain anchor or a backup), so a
  // fresh load always starts locked and the user re-signs to unlock.
  const locked = recipientMatches && !keysReady;
  // Gate against the SESSION chain — the import mutates the SDK session's
  // NoteManager, and the session follows the connector-first chain, not the
  // display selection (codex). Legacy receipts without a chainId keep the
  // old behavior.
  const sessionChainId = useSessionChainId();
  const chainMismatch = receipt?.chainId !== undefined && receipt.chainId !== sessionChainId;
  const baseDisabled = !recipientMatches || !keysReady || busy || chainMismatch;

  // A note is spendable only once the ASP approves the sender's deposit. Read
  // from data the app already polls, before sign-in too. The claim re-checks
  // before anything is signed; its refusal stands until the read has an answer.
  // A legacy receipt is read on the default chain but claimed on the session's,
  // whose leaves never answer for it, so there the claim's own check decides.
  const legacyChainScopeMismatch = !!receipt && receipt.chainId === undefined && receiptChainId !== sessionChainId;
  const linkApproval = useLinkApproval(notes, receiptChainId, !!receipt && !chainMismatch && !legacyChainScopeMismatch);
  const liveApproval = legacyChainScopeMismatch ? 'unknown' : linkApproval;
  const approval = done ? null
    : liveApproval !== null && liveApproval !== 'unknown' ? liveApproval
    : (approvalBlock ?? liveApproval);
  const approvalBlocked = isBlockedApproval(approval) ? approval : null;
  const approvalCopy = approvalBlocked ? LINK_APPROVAL_COPY[approvalBlocked] : null;
  const approvalChecking = !done && !!receipt && !chainMismatch && approval === null;
  // Device import is one-shot (repeating it is a no-op merge).
  const deviceDisabled = baseDisabled || done;
  // The anchor must stay available AFTER a device import — the whole point of
  // the device path's "anchor on-chain to keep it" hint is that you can upgrade.
  // Only a completed anchor disables it.
  const anchorDisabled = baseDisabled || status === 'anchored' || !!approvalBlocked || approvalChecking;

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="items-center gap-[16px] px-[24px] py-[32px]"
    >
      {/* The way out, in EVERY state. This route used to lean on the native
          stack header's back arrow, which was the last unstyled bar in the app
          (Pat, 2026-08-31). Removing it would have stranded the states a
          receipt link actually opens in — invalid link, no wallet, wrong
          account, locked session, mid-claim — because the in-body button below
          renders only once a claim has SUCCEEDED. So the exit moves up here,
          outside every conditional, and is themed like the rest of the app. */}
      <View className="w-full max-w-[560px]">
        <Pressable
          className={`flex-row items-center gap-[6px] self-start py-[4px] ${finish.busy ? 'opacity-40' : 'active:opacity-60'}`}
          onPress={leaveClaimPage}
          disabled={finish.busy}
          accessibilityRole="button"
          accessibilityLabel="Back to Privacy Pools"
          testID="import-note-back"
        >
          {/* nw-keep(data-color): arrow tint is the secondary text theme token into the vector-icon sink */}
          <Ionicons name="arrow-back" size={15} color={colors.textSecondary} />
          <Text className="font-pp-medium text-[13px] text-text-secondary">Back to Privacy Pools</Text>
        </Pressable>
      </View>

      <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY POOLS V2</Text>
      <Text className="font-pp-bold text-[20px] text-center text-text">Receive Private Transfer</Text>
      <Text className="font-pp-regular text-[12px] text-center text-text-secondary">
        Import a one-time transfer on {chainName}
      </Text>

      <View className="w-full max-w-[560px] gap-[18px] border border-border-light bg-card-background px-[24px] py-[24px]">
        {receipt && note && amountLabel ? (
          <>
            <View className="gap-[4px]">
              <Text className="font-pp-bold text-[16px] text-text">Transfer Receipt</Text>
              <Text className="font-pp-regular text-[12px] text-text-muted">One-time link from the sender</Text>
            </View>

            <View className="flex-row items-center justify-between">
              <Text className="font-pp-bold text-[16px] text-text">Amount</Text>
              <Text className="font-pp-bold text-[16px] text-text">{amountLabel}</Text>
            </View>

            <View className="gap-[8px]">
              <View className="flex-row items-center justify-between gap-[12px]">
                <Text className="font-pp-medium text-[12px] text-text-muted">Owner</Text>
                <Text className="font-pp-medium text-[12px] text-right text-text-secondary">
                  {expectedRecipient ? shortRecipient : '—'}
                </Text>
              </View>
              <View className="flex-row items-center justify-between gap-[12px]">
                <Text className="font-pp-medium text-[12px] text-text-muted">{notes.length > 1 ? 'Notes' : 'Commitment'}</Text>
                <Text className="font-pp-medium text-[12px] text-right text-text-secondary">
                  {notes.length > 1
                    ? `${notes.length} notes`
                    : note.commitment
                      ? `${note.commitment.slice(0, 8)}…${note.commitment.slice(-6)}`
                      // A claim recovered from the sender's backup has no
                      // commitment until the import derives it from the
                      // signed-in address.
                      : 'Derived on claim'}
                </Text>
              </View>
              <View className="flex-row items-center justify-between gap-[12px]">
                <Text className="font-pp-medium text-[12px] text-text-muted">Status</Text>
                <Text className={`font-pp-medium text-[12px] text-right ${done ? 'text-success' : 'text-text-secondary'}`}>
                  {oneStepLeft ? 'Added to your shielded balance · 1 step left'
                    : status === 'anchored' ? 'Added to your shielded balance'
                    : approvalCopy ? approvalCopy.status
                    : status === 'imported' ? 'In this tab only'
                    : hasUnanchoredLocalNote ? 'In this tab only'
                    : approvalChecking ? 'Checking approval…'
                    : 'Ready to add'}
                </Text>
              </View>
            </View>

            {chainMismatch ? (
              <View className="gap-[6px] border border-warning bg-warning-bg px-[14px] py-[12px]">
                <Text className="font-pp-semi-bold text-[13px] text-warning">Wrong network</Text>
                <ReceiptWrongNetworkCopy chain={receiptChainInfo} textClassName="font-pp-regular text-[12px] leading-[18px] text-warning" />
              </View>
            ) : !effectiveAddress ? (
              <View className="gap-[6px] border border-border bg-success-bg px-[14px] py-[12px]">
                <Text className="font-pp-semi-bold text-[13px] text-success">Connect your wallet</Text>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                  Connect the wallet that owns {shortRecipient} to claim the transfer.
                </Text>
              </View>
            ) : !recipientMatches ? (
              <View className="gap-[6px] border border-warning bg-warning-bg px-[14px] py-[12px]">
                <Text className="font-pp-semi-bold text-[13px] text-warning">Wrong account</Text>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-warning">
                  The current account doesn&apos;t match the recipient on this receipt. Switch to {shortRecipient} to import.
                </Text>
              </View>
            ) : locked ? (
              <View className="gap-[6px] border border-warning bg-warning-bg px-[14px] py-[12px]">
                <Text className="font-pp-semi-bold text-[13px] text-warning">You&apos;re not signed in</Text>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-warning">
                  Sign in to claim this payment. Sign-in only lasts for this session.
                </Text>
              </View>
            ) : approvalCopy ? (
              <View testID="claim-approval-blocked" className="gap-[6px] border border-warning bg-warning-bg px-[14px] py-[12px]">
                <Text className="font-pp-semi-bold text-[13px] text-warning">{approvalCopy.title}</Text>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-warning">{approvalCopy.body}</Text>
              </View>
            ) : (
              <View className="gap-[6px] border border-border bg-success-bg px-[14px] py-[12px]">
                <Text className="font-pp-semi-bold text-[13px] text-success">You&apos;ve been sent a private payment</Text>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                  Add it to your shielded balance to use it from any device with your wallet.
                </Text>
              </View>
            )}

            {/* Ungated on `status` (code review 2026-08-27): the hook's
                  re-entrancy refusal sets errMessage WITHOUT moving status off
                  'anchoring', because moving it dropped `busy` and re-enabled
                  the button mid-proof. Gating the render on status === 'error'
                  made that refusal invisible here, which is the silent dead
                  click the hook comment says it is fixing. */}
              {errMessage && !approvalBlock && (
              <Text className="font-pp-regular text-[12px] leading-[18px] text-[#BA6B5D]">
                {errMessage}
                {hasUnanchoredLocalNote ? ' Your funds are safe on this device. You can retry.' : ''}
              </Text>
            )}
            <RegisterWalletOffer
              offered={!!registerOffer}
              state={registerState}
              gasText={registerOfferGasText(registerOffer)}
              onRegister={() => { void registerWalletOnly(); }}
              onDismiss={dismissRegisterOffer}
            />

            {/* On-chain add = the same staged flow as shield/send, so it gets
                the same horizontal progress. The quick device merge keeps a
                plain status line. */}
            {status === 'anchoring' ? (
              <FlowProgress message={statusMessage} />
            ) : busy && statusMessage ? (
              <Text className="font-pp-regular text-[12px] leading-[18px] text-primary">{statusMessage}</Text>
            ) : null}

            {status === 'imported' && (
              <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                Saved to this tab. This link is your backup.
              </Text>
            )}

            {/* Account-state action: get the user to an identity that can
                import (connect, switch wallet, or sign in). The import
                buttons below stay greyed until the account is unlocked. */}
            {!effectiveAddress ? (
              <Pressable
                className="items-center justify-center bg-button-primary py-[14px]"
                onPress={() => connectWallet()}
              >
                <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                  Connect wallet
                </Text>
              </Pressable>
            ) : !recipientMatches ? (
              <Pressable className="items-center justify-center border border-[#B8BBBF] bg-transparent py-[12px]" onPress={() => connectWallet()}>
                <Text className="font-pp-medium text-[14px] text-text">Connect a different wallet</Text>
              </Pressable>
            ) : locked ? (
              <Pressable
                className="items-center justify-center bg-button-primary py-[14px]"
                onPress={() => openSeedDerivationModal()}
              >
                <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                  Sign in to claim payment
                </Text>
              </Pressable>
            ) : null}

            {recipientMatches && (
              <>
                {oneStepLeft ? (
                  <View testID="claim-one-step-left" className="gap-[10px]">
                    <View className="gap-[6px] border border-warning bg-warning-bg px-[14px] py-[12px]">
                      <Text className="font-pp-semi-bold text-[13px] text-warning">{CLAIM_ONE_STEP_LEFT}</Text>
                      <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                        {claimGasTopUpWei ? CLAIM_FINISH_SETUP_BODY : CLAIM_FINISH_SETUP_BODY_NO_GAS}
                      </Text>
                      {claimTopUpText ? (
                        <Text className="font-pp-medium text-[12px] leading-[18px] text-text-secondary">
                          Native gas received: {claimTopUpText}
                        </Text>
                      ) : null}
                      {claimSplit && token ? (
                        <View testID="claim-split" className="gap-[2px]">
                          <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                            Fee: {linkAmountText(claimSplit.feeWei, token)}
                          </Text>
                          {claimSplit.payoutWei > 0n ? (
                            <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                              {PUBLIC_PAYOUT_LABEL}: {linkAmountText(claimSplit.payoutWei, token)}
                            </Text>
                          ) : null}
                          <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                            Stays shielded: {linkAmountText(claimSplit.changeWei, token)}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    {finish.error ? (
                      <Text className="font-pp-regular text-[12px] leading-[18px] text-[#BA6B5D]">{finish.error}</Text>
                    ) : null}
                    {finish.busy && finish.message ? (
                      <Text className="font-pp-regular text-[12px] leading-[18px] text-primary">{finish.message}</Text>
                    ) : null}
                    <Pressable
                      className={`items-center justify-center py-[14px] ${finish.busy ? 'bg-[#B8BBBF]' : 'bg-button-primary'}`}
                      onPress={finish.gasShort
                        // The modal can relay a gas top-up first.
                        ? () => openFinishSetup({ targetChainId: receiptChainId })
                        : () => { void runFinishSetup(); }}
                      disabled={finish.busy}
                      accessibilityRole="button"
                      testID="claim-finish-setup"
                    >
                      <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                        {finish.busy ? 'Finishing…' : finish.gasShort ? 'Get gas and finish' : FINISH_SETUP_PRIMARY}
                      </Text>
                    </Pressable>
                  </View>
                ) : canAnchorOnChain && (
                  <Pressable
                    className={`items-center justify-center py-[14px] ${anchorDisabled ? 'bg-[#B8BBBF]' : 'bg-button-primary'}`}
                    onPress={() => importOnChain(notes, { expectedChainId: receipt?.chainId })}
                    disabled={anchorDisabled}
                  >
                    <Text className="font-pp-semi-bold text-[15px] text-button-primary-text">
                      {status === 'anchored' ? 'Payment claimed ✓'
                        : status === 'anchoring' ? 'Claiming…'
                        : approvalCopy ? approvalCopy.button
                        : approvalChecking ? 'Checking approval…'
                        : 'Claim Payment'}
                    </Text>
                  </Pressable>
                )}

                {/* Say the fee exists BEFORE the button is pressed. A tester
                    claimed 0.001 ETH and lost 55% of it, having been told
                    nothing: the relayer's cost is a fixed ~21000 gas plus 0.1%,
                    so it is negligible at scale and brutal on a test amount.
                    The exact figure would be better still, but the fee
                    commitment lives ~60s, so quoting here and confirming later
                    risks an expiry - tracked separately. */}
                {canAnchorOnChain && !done && !approvalBlocked && (
                  <Text className="px-[16px] pt-[8px] font-pp-regular text-[11px] leading-[15px] text-text-secondary">
                    A relayer submits this for you, so your address stays private. Its fee is 0.1% plus gas.
                  </Text>
                )}
                {canAnchorOnChain && !done && !approvalBlocked && claimFeeBreakdown && claimFeeBreakdown.level !== 'none' && (
                  <View className="px-[16px] pt-[8px]">
                    <FeeWarning breakdown={claimFeeBreakdown} testID="claim-fee-warning" />
                  </View>
                )}

                {/* On success the CTA above turns into an inert "Payment claimed
                    ✓", and the only exit left was the native header's back
                    arrow — easy to miss, and a no-op on the cold tab a receipt
                    link usually opens in. Give the same action a real button in
                    the body, at the terminal state where it is the one thing
                    left to do. */}
                {done && (
                  <Pressable
                    className="flex-row items-center justify-center gap-[8px] border border-border bg-transparent py-[13px] active:opacity-60"
                    onPress={leaveClaimPage}
                    accessibilityRole="button"
                    accessibilityLabel="Back to Privacy Pools"
                    testID="import-note-leave"
                  >
                    {/* nw-keep(data-color): arrow tint is the text theme token into the vector-icon sink */}
                    <Ionicons name="arrow-back" size={15} color={colors.text} />
                    <Text className="font-pp-semi-bold text-[14px] text-text">Back to Privacy Pools</Text>
                  </Pressable>
                )}

                {/* DEV-569: wallet sessions get one path, Claim Payment, and no
                    device-only import. Account-key sessions cannot claim
                    onchain, so for them keeping it in this tab IS the path. */}
                {!canAnchorOnChain && (
                  <>
                    <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                      Keeps it in this tab only. The link is your backup.
                    </Text>
                    <Pressable
                      className={`items-center justify-center border border-[#B8BBBF] py-[12px] ${deviceDisabled ? 'bg-[#B8BBBF]' : 'bg-transparent'}`}
                      onPress={() => importToDevice(notes, { expectedChainId: receipt?.chainId })}
                      disabled={deviceDisabled}
                    >
                      <Text className={`font-pp-medium text-[14px] ${deviceDisabled ? 'text-[#4D4D4D]' : 'text-text'}`}>
                        {status === 'imported' ? 'Kept in this tab ✓'
                          : status === 'importing' ? 'Adding…'
                          : 'Keep on this device only'}
                      </Text>
                    </Pressable>
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <Text className="font-pp-bold text-[16px] text-center text-text">Invalid receipt link</Text>
            <Text className="font-pp-regular text-[13px] text-center leading-[20px] text-text-secondary">
              This receipt couldn&apos;t be decoded. Ask the sender to copy the link again.
            </Text>
          </>
        )}
      </View>
    </ScrollView>
  );
}
