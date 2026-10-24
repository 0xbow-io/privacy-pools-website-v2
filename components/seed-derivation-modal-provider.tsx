import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAccount, useConfig, useDisconnect } from 'wagmi';
import { getAccount } from 'wagmi/actions';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { usePoolSession } from '@/hooks/use-pool-session';
import { KeySourceChangedError } from '@/components/sdk-provider';
import { AccountUnlockHelp } from '@/components/account-unlock-help';
import { useChainRouter } from '@/hooks/use-chain-router';
import {
  peekAutoSignArm, shouldAutoSignAfterConnect, subscribeAutoSignArm, takeAutoSignArm,
} from '@/services/auto-sign-after-connect';
import { isCoinbaseWalletIdentity, resolveWalletIdentity } from '@/services/wallet-signature-timeout';
import { BASE_APP_NOTICE_BODY, BASE_APP_NOTICE_TITLE, BASE_APP_USE_ANOTHER_WALLET, isBaseAppCannotSign } from '@/services/base-app-passkey-choice';
import { waitForReconnectSettled, walletErrorLine } from '@/services/wallet-reconnect';
import { useWalletConnectModal } from '@/components/wallet-connect-modal-provider';

/** After this long without a wallet answer, say so and let the user close. */
const SLOW_SIGN_HINT_MS = 30_000;

// Mostly on-demand. The one automatic case is DEV-522: right after the user
// connects a wallet from the picker, the signature is requested straight away
// (services/auto-sign-after-connect.ts decides when). Otherwise it appears when a
// flow that actually needs the derived keys starts (deposit, withdraw, send,
// request, ragequit — those providers gate their opens on keysReady) or when
// opened from the header menu. Pass `onSigned` to continue the interrupted
// action right after a successful signature.

type SeedDerivationModalContextType = {
  openSeedDerivationModal: (options?: { onSigned?: () => void }) => void;
  closeSeedDerivationModal: () => void;
  /** Whether the unlock dialog is showing — the modal URL bridge watches this
   *  to detect a cancelled unlock and retire stale deep-link entries. */
  isOpen: boolean;
};

const SeedDerivationModalContext = createContext<SeedDerivationModalContextType>({
  openSeedDerivationModal: () => {},
  closeSeedDerivationModal: () => {},
  isOpen: false,
});

export function useSeedDerivationModal() {
  return useContext(SeedDerivationModalContext);
}

export function SeedDerivationModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  const { address, status, connector } = useAccount();
  const [walletIdentity, setWalletIdentity] = useState<{ connector: typeof connector; address: typeof address; coinbase: boolean } | null>(null);
  // A generic injected/WalletConnect connector is not the wallet's identity.
  // Wait for its local provider metadata before consuming the connect arm.
  // Key the result to this connection so a late answer cannot classify another.
  const isCoinbaseWallet = walletIdentity && walletIdentity.connector === connector && walletIdentity.address === address
    ? walletIdentity.coinbase : null;
  useEffect(() => {
    if (status !== 'connected') {
      setWalletIdentity(null);
      return;
    }
    let cancelled = false;
    void resolveWalletIdentity(connector).then((identity) => {
      if (!cancelled) setWalletIdentity({ connector, address, coinbase: isCoinbaseWalletIdentity(identity) });
    });
    return () => { cancelled = true; };
  }, [connector, address, status]);
  // The wallet the open prompt belongs to: a rejection that arrives after a
  // wallet switch must not paint the new wallet's dialog. Read the CURRENT
  // account synchronously from the wagmi store, not from a ref mirrored by a
  // passive effect that may not have flushed yet (codex on 7bedb0a).
  const wagmiConfig = useConfig();
  const {
    keysReady, ensureInitialized, error, passkeyActive, isInitializing, identityMode,
    isSmartWallet, smartWalletProbeSettled, passkeyPreviewEnabled, signerRefusedDerivation, sessionTarget,
    choosePasskeyForRefusedSigner, baseAppCannotSign,
  } = usePoolSession();
  const { disconnectAsync } = useDisconnect();
  const walletPicker = useWalletConnectModal();

  const [isOpen, setIsOpen] = useState(false);
  // DEV-576: wagmi is restoring the connection (MetaMask mobile injects its
  // provider late). Sign in waits instead of failing; the provider also waits
  // for the reconnect to settle before it asks for the signature.
  const walletReconnecting = status === 'reconnecting' && !passkeyActive;
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Continuation for the action that triggered the prompt (e.g. reopening
  // the deposit modal once the signature lands).
  const onSignedRef = useRef<(() => void) | null>(null);
  // Synchronous mirror of isOpen: two openers in the SAME effect flush (the
  // deep link's open-with-continuation, then the landing's bare auto-prompt)
  // run before React re-renders, so a render-time mirror would still read
  // "closed" for the second call. Set/cleared alongside every setIsOpen.
  const isOpenRef = useRef(false);

  // Wallet gone → nothing to prompt for, and any pending continuation dies
  // with it. Keys becoming ready also closes the modal, but deliberately
  // WITHOUT clearing the continuation: that transition is usually caused by
  // handleSign itself, which still needs the ref to resume the action that
  // triggered the prompt (e.g. reopening the deposit modal).
  useEffect(() => {
    // DEV-576: 'reconnecting' with an address is the same wallet coming back
    // (MetaMask mobile injects late); keep the sheet and its sign-in open.
    if ((status !== 'connected' && status !== 'reconnecting') || !address) {
      setIsOpen(false);
      isOpenRef.current = false;
      onSignedRef.current = null;
      return;
    }
    if (keysReady) {
      setIsOpen(false);
      isOpenRef.current = false;
    }
  }, [status, address, keysReady]);

  const openSeedDerivationModal = useCallback((options?: { onSigned?: () => void }) => {
    setErrorMessage(null);
    // A bare re-open while the prompt is already showing (the landing's
    // auto sign-in racing a deep link's openDepositModal) must not drop the
    // continuation the first opener parked here; the user would sign and
    // nothing would happen. A fresh open (closed prompt) still starts clean.
    if (options?.onSigned) onSignedRef.current = options.onSigned;
    else if (!isOpenRef.current) onSignedRef.current = null;
    isOpenRef.current = true;
    setIsOpen(true);
  }, []);

  // A wallet that never answers (DEV-427 style hang, a backgrounded wallet
  // app) must not trap the user behind a disabled close button forever.
  const [slowSign, setSlowSign] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setSlowSign(true), SLOW_SIGN_HINT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  // Bumped by every sign attempt and by closing a slow one: a wallet answer
  // that arrives after the user gave up belongs to an ABANDONED attempt and
  // must not touch the dialog, its pending state or a newer continuation.
  const signAttemptRef = useRef(0);

  const closeSeedDerivationModal = useCallback(() => {
    if (pending && !slowSign) return;
    if (pending) {
      signAttemptRef.current += 1;
      setPending(false);
      setSlowSign(false);
    }
    setIsOpen(false);
    isOpenRef.current = false;
    onSignedRef.current = null;
  }, [pending, slowSign]);

  const handleSign = useCallback(async () => {
    const attempt = ++signAttemptRef.current;
    const isCurrent = () => signAttemptRef.current === attempt;
    setErrorMessage(null);
    setPending(true);
    setSlowSign(false);
    // Capture before the await: the keysReady state flush inside
    // ensureInitialized re-renders the provider mid-flight, and anything
    // that clears the ref during that window must not lose the follow-up.
    const continuation = onSignedRef.current;
    const promptOwner = address;
    try {
      // ensureInitialized() — NOT initializeKeys(). initializeKeys only
      // derives the keystore manager (the signature step); it never
      // builds the PoolSession. After it the app has `keysReady=true`
      // but `isInitialized=false` / `poolSession=null`, so any flow
      // that checks `isInitialized` (transfers) hard-fails with "SDK
      // not initialized" even though the user just signed.
      // ensureInitialized does the signature AND builds the session.
      // DEV-576: a tap during wagmi's reconnect waits here (button shows the
      // waiting label) and signs once the wallet is back, no second tap.
      // Passkey and account-key unlocks never sign through wagmi: no wait.
      if (!passkeyActive && identityMode !== 'key') await waitForReconnectSettled({
        getStatus: () => wagmiConfig.state.status,
        subscribe: (listener) => wagmiConfig.subscribe((state) => state.status, listener),
      });
      console.log('[SeedDerivationModal] handleSign: calling ensureInitialized');
      await ensureInitialized();
      console.log('[SeedDerivationModal] handleSign: ensureInitialized resolved, session built');
      if (!isCurrent()) {
        // Signed after the user closed a slow prompt. The keys are good; if a
        // newer opener parked a continuation (deposit while this hung), run
        // THAT one, never the stale capture.
        const parked = isOpenRef.current ? onSignedRef.current : null;
        setIsOpen(false);
        isOpenRef.current = false;
        onSignedRef.current = null;
        if (parked) setTimeout(parked, 0);
        return;
      }
      setIsOpen(false);
      isOpenRef.current = false;
      onSignedRef.current = null;
      // Defer past the keysReady state flush so the continuation's own
      // key gate sees the fresh value and doesn't re-prompt.
      if (continuation) setTimeout(continuation, 0);
    } catch (err) {
      const message = walletErrorLine(err);
      // The raw wallet error (wagmi/viem dump included) goes to the console only.
      console.warn('[SeedDerivationModal] handleSign failed:', err);
      if (!isCurrent()) return; // abandoned: the user already closed this prompt
      if (getAccount(wagmiConfig).address !== promptOwner) return; // the wallet changed under the prompt
      // An interrupted derivation (wallet, chain or unlock source changed) is a
      // retry, not a failure (codex on PR #36).
      // The Base app cannot sign: the dialog shows the use-another-wallet notice.
      if (isBaseAppCannotSign(err)) {
        setErrorMessage(null);
        return;
      }
      if (err instanceof KeySourceChangedError) {
        setErrorMessage('Sign-in was interrupted by a wallet or network change. Tap Sign in again.');
        return;
      }
      // Wallet rejections are routine; word it that way.
      if (/user rejected|user denied|user cancel/i.test(message)) {
        setErrorMessage('Signature cancelled in your wallet. You can sign later from the header menu.');
      } else {
        setErrorMessage(message);
      }
    } finally {
      if (isCurrent()) {
        setPending(false);
        setSlowSign(false);
      }
    }
  }, [ensureInitialized, address, wagmiConfig, passkeyActive, identityMode]);

  // DEV-522: sign right after a user-initiated connect. The picker arms it,
  // this consumes it at most once. A decline lands in handleSign's catch and
  // leaves the dialog open with its Sign in button; nothing re-arms, so there
  // is no second automatic prompt.
  const { isSui, isStellar } = useChainRouter();
  const nonEvmChain = isSui || isStellar;
  const keysAddress = sessionTarget?.address ?? null;
  const [armTick, setArmTick] = useState(0);
  useEffect(() => subscribeAutoSignArm(() => setArmTick((t) => t + 1)), []);
  const [pageVisible, setPageVisible] = useState(() => (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  ));
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const onVisibility = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  const handleSignRef = useRef(handleSign);
  useEffect(() => { handleSignRef.current = handleSign; }, [handleSign]);
  useEffect(() => {
    const arm = peekAutoSignArm();
    if (!arm) return;
    const decision = shouldAutoSignAfterConnect({
      arm, now: Date.now(), status, address, identityMode, nonEvmChain,
      keysReady, keysAddress, isInitializing, passkeyActive, pageVisible, smartWalletProbeSettled, isSmartWallet, isCoinbaseWallet,
    });
    if (decision === 'wait') return;
    takeAutoSignArm();
    if (decision === 'drop') return;
    console.log('[SeedDerivationModal] sign-in after connect:', decision);
    openSeedDerivationModal();
    if (decision === 'sign') void handleSignRef.current();
  }, [armTick, status, address, identityMode, nonEvmChain, keysReady, keysAddress, isInitializing, passkeyActive, pageVisible, smartWalletProbeSettled, isSmartWallet, isCoinbaseWallet, openSeedDerivationModal]);

  // No unlock-method switch to CHOOSE between: a smart-contract wallet unlocks
  // with a passkey and nothing else, every other wallet signs. One unlock per
  // wallet, nothing to remember.
  //
  // The exception is a wallet that has just proved it cannot do the signature
  // half — a hardware wallet or signer that returns a different signature each
  // time. It fails the determinism proof, and before this it had nowhere to go
  // but another wallet. Offer it the passkey, once, and only after the refusal
  // was actually observed for the connected address.
  // Base / Coinbase app signer: it cannot sign here, so the only way on is
  // another wallet. No passkey offer.
  const showBaseNotice = baseAppCannotSign && !pending;
  const switchWallet = useCallback(async () => {
    closeSeedDerivationModal();
    try {
      await disconnectAsync();
    } catch (e) {
      console.warn('[SeedDerivationModal] disconnect failed:', e);
    }
    void walletPicker.open();
  }, [closeSeedDerivationModal, disconnectAsync, walletPicker]);
  const offerPasskeyInstead = passkeyPreviewEnabled && signerRefusedDerivation && !passkeyActive && !pending && !baseAppCannotSign;
  const takePasskeyOffer = useCallback(() => {
    choosePasskeyForRefusedSigner();
    // The mode flips in a state update, so this tap cannot also carry the
    // WebAuthn prompt (it would lose the user activation). Say what to do next
    // rather than leaving a dialog that looks unchanged.
    setErrorMessage('Passkey unlock is on for this wallet. Tap Sign in to continue.');
  }, [choosePasskeyForRefusedSigner]);

  return (
    <SeedDerivationModalContext.Provider value={{ openSeedDerivationModal, closeSeedDerivationModal, isOpen }}>
      {children}
      <Modal animationType={isMobileSheet ? 'slide' : 'fade'} transparent visible={isOpen} onRequestClose={closeSeedDerivationModal}>
        <View className={`flex-1 items-center bg-[rgba(0,0,0,0.5)] ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`}>
          <View className={`w-full gap-[14px] border border-border bg-card-background p-[24px] ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'max-w-[460px] rounded-card'}`}>
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            <View className="flex-row items-start justify-between gap-[12px]">
              <View className="flex-1 gap-[6px]">
                <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY POOLS V2</Text>
                <Text className="font-pp-bold text-[22px] leading-[26px] text-text">{passkeyActive ? 'Unlock with passkey' : 'Unlock your account'}</Text>
              </View>
              <Pressable
                className="h-[36px] w-[36px] items-center justify-center rounded-control border border-border-light"
                onPress={closeSeedDerivationModal}
                disabled={pending && !slowSign}
              >
                {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>

            <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
              {passkeyActive
                ? (isSmartWallet
                  ? 'Use your wallet’s passkey to unlock its private balance.'
                  : 'Use your passkey to unlock your private balance.')
                : 'Sign this message to decrypt your private balances and payment history.'}
            </Text>
            {passkeyActive ? <AccountUnlockHelp /> : null}

            {showBaseNotice && (
              <View className="gap-[6px] rounded-control border border-border px-[12px] py-[10px]" testID="seed-derivation-base-notice">
                <Text className="font-pp-semi-bold text-[14px] text-text">{BASE_APP_NOTICE_TITLE}</Text>
                <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">{BASE_APP_NOTICE_BODY}</Text>
              </View>
            )}

            {!showBaseNotice && (errorMessage ?? error) && (
              <View className="rounded-control border border-[#E11D48] px-[12px] py-[10px]">
                <Text className="font-pp-medium text-[12px] leading-[17px] text-[#E11D48]">{errorMessage ?? error}</Text>
              </View>
            )}

            {showBaseNotice ? (
              <View className="mt-[6px] gap-[10px]">
                <Pressable
                  className="items-center justify-center rounded-control bg-button-primary py-[12px]"
                  onPress={() => { void switchWallet(); }}
                  testID="seed-derivation-base-another-wallet"
                >
                  <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">{BASE_APP_USE_ANOTHER_WALLET}</Text>
                </Pressable>
              </View>
            ) : (
            <View className="mt-[6px] flex-row gap-[10px]">
              <Pressable
                className={`flex-1 items-center justify-center rounded-control bg-button-primary py-[12px] ${pending ? 'opacity-60' : 'opacity-100'}`}
                onPress={handleSign}
                disabled={pending}
              >
                <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">
                  {walletReconnecting ? 'Waiting for your wallet…' : pending ? (passkeyActive ? 'Check your device…' : 'Check your wallet…') : 'Sign in'}
                </Text>
              </Pressable>
            </View>
            )}

            {pending && slowSign && (
              <Text className="text-center font-pp-regular text-[12px] leading-[17px] text-text-secondary">
                No answer yet. Open your wallet app to approve, or close and sign in later.
              </Text>
            )}

            {offerPasskeyInstead && (
              <Pressable
                className="items-center justify-center rounded-[10px] border border-border py-[12px]"
                onPress={takePasskeyOffer}
                testID="seed-derivation-use-passkey"
              >
                <Text className="font-pp-semi-bold text-[14px] text-text">Use a passkey instead</Text>
              </Pressable>
            )}

          </View>
        </View>
      </Modal>
    </SeedDerivationModalContext.Provider>
  );
}
