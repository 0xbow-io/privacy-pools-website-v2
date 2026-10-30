// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
import { useBalanceDisplay } from '@/hooks/use-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { DOCS_URL, SUPPORT_FORM_URL, SUPPORT_TELEGRAM_URL } from '@/config/support';
import { CheckCircleIcon, CloseIcon, SpinnerIcon } from '@/components/ui/modal-icons';
import { WEB_FIXED_POSITION, WEB_BLUR_BACKDROP } from '@/components/ui/web-style-shims';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useOpLock } from '@/hooks/use-op-lock';
import { View, Text, Pressable, Platform, useWindowDimensions, Animated, Easing, Linking, ScrollView } from 'react-native';
import type { ViewStyle } from 'react-native';
import Svg, { Path, Circle, Ellipse } from 'react-native-svg';
import { useAccount, useConfig, useSendTransaction, usePublicClient } from 'wagmi';
import { getAccount, sendCalls, getCallsStatus } from '@wagmi/core';
import { walletCapabilities } from '@/services/wallet-signature-timeout';
import { submitAtomicBatch } from '@/services/wallet-batch';
import { buildRagequitUnwrapCalls, receivedWrappedNative, wrappedNativeWithdrawCall } from '@/services/ragequit-unwrap';
import { getPinnedYieldDeployments } from '@/config/yield';
import { unwrapTargetSymbol } from '@/services/loose-share-unwrap';
import { usePools } from '@/components/pools-provider';
import { useQueryClient } from '@tanstack/react-query';
import { NoteStatus, type Note } from '@/services/sdk-types';
import { invalidateTransactionCaches } from '@/services/cache';
import { redactNoteIdentifiers } from '@/services/debug-log-filter';
import { formatUnits } from 'viem';
import type { Hex as ViemHex } from 'viem';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useDebug } from '@/components/debug-provider';
import { useTxActivity } from '@/components/tx-activity-provider';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useNotes } from '@/hooks/use-notes';
import { getExplorerTxUrl, getExplorerName, getChainConfig, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { describeStellarStage, stellarErrorMessage } from '@/services/stellar/stellar-copy';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useSuiSession } from '@/hooks/use-sui-session';
import type { Transaction } from '@/components/pools-provider';

// react-native-web supports CSS properties (position:'fixed', backdropFilter, outlineStyle)
// that are absent from React Native's ViewStyle type definitions.
// These typed constants apply web-only styles without `as any`.

// --- Token display helpers ---

import { getTokenMetadata } from '@/config/tokens';

import { useBackHandler } from '@/hooks/use-back-handler';
import { useNativeMockBlock } from '@/hooks/use-native-mock-block';
import { HubErrorBoundary } from '@/components/home/hub-error-boundary';

const NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const TOKEN_META: Record<string, { symbol: string; decimals: number }> = {
  [NATIVE_ASSET_ADDRESS.toLowerCase()]: { symbol: 'ETH', decimals: 18 },
  ['0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'.toLowerCase()]: { symbol: 'USDC', decimals: 6 },
  ['0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0'.toLowerCase()]: { symbol: 'USDT', decimals: 6 },
};

function getTokenMeta(tokenId: string): { symbol: string; decimals: number } {
  return TOKEN_META[tokenId.toLowerCase()] ?? { symbol: 'TOKEN', decimals: 18 };
}

function truncateHash(hash: string): string {
  if (hash.length < 14) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.toLowerCase();
}

function resolvePreferredRagequitNote(notes: Note[], transaction: Transaction | null): Note | null {
  if (notes.length === 0) return null;
  if (notes.length === 1) return notes[0];
  if (!transaction) return null;

  const targetLabel = normalizeHex(transaction.label);
  const targetToken = normalizeHex(transaction.tokenAddress);
  const targetTxHash = normalizeHex(transaction.txHash);
  const targetAmount = transaction.rawAmount;

  const scored = notes
    .map((note) => {
      let score = 0;

      if (targetLabel && normalizeHex(note.label) === targetLabel) score += 10;
      if (targetTxHash && targetTxHash !== '0x0' && normalizeHex(note.txHash) === targetTxHash) score += 8;
      if (targetToken && normalizeHex(note.tokenId) === targetToken) score += 4;
      if (targetAmount && note.value === targetAmount) score += 4;

      return { note, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const [best, secondBest] = scored;
  if (best.score >= 10) return best.note;
  if (!secondBest || best.score > secondBest.score) return best.note;
  return null;
}

// --- Icons ---




// Decorative ellipse behind the modal content
function DecorativeEllipse({ strokeColor = '#D9D9D9' }: { strokeColor?: string }) {
  return (
    <Svg width={400} height={400} viewBox="0 0 400 400" fill="none">
      <Ellipse cx={200} cy={200} rx={199} ry={199} stroke={strokeColor} strokeWidth={1} fill="none" />
    </Svg>
  );
}

// --- Context ---

type RagequitModalContextType = {
  openRagequitModal: (transaction?: Transaction) => void;
  closeRagequitModal: () => void;
};

function missingProvider(): never {
  throw new Error('useRagequitModal must be used within a RagequitModalProvider');
}

const RagequitModalContext = createContext<RagequitModalContextType>({
  openRagequitModal: missingProvider,
  closeRagequitModal: missingProvider,
});

export function useRagequitModal() {
  return useContext(RagequitModalContext);
}

// --- Provider ---

export function RagequitModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const isDark = colorScheme === 'dark';
  const { width } = useWindowDimensions();
  const isMobile = width <= 540;
  // On a phone the modal presents as a bottom sheet.
  const isSheet = isMobile;

  // The chain this flow ACTS ON — the app's selection, not the wallet's.
  //
  // This was useChainId(), which returns wagmi's config state = the WALLET's
  // chain. Every wagmi hook already defaults its chainId to exactly that, so
  // reads here silently followed the wallet while the display surfaces
  // (pools-provider, action-hub) followed the app selection. The two agree
  // only while ChainProvider can keep them in sync — a wallet parked on an
  // unsupported chain with the switch prompt dismissed leaves them split, and
  // then the form showed "Wallet balance 446.4 USDT" beside "Insufficient
  // balance (0.0000 USDT available)".
  //
  // Sourcing it from the app selection also makes the `walletChainId !==
  // chainId` switch guard below meaningful: it used to compare the wallet's
  // chain against itself and could never fire.
  const chainId = useActiveEvmChain().id;
  const balanceDisplay = useBalanceDisplay(chainId);
  const withOpLock = useOpLock();
  // Chain FROZEN at submission (codex round 3, P2).
  const [txChainId, setTxChainId] = useState<number | null>(null);
  const { address: connectedAddress, connector } = useAccount();
  const wagmiConfig = useConfig();
  const { walletShareBalances } = usePools();
  // Sui chain branch: the ragequit modal is otherwise EVM-only (wagmi + EVM
  // SDK). On Sui we exit via the native Sui session instead — its notes live in
  // a separate local store the EVM NoteManager never sees.
  const { isSui: isSuiChain, isStellar } = useChainRouter();
  // Non-EVM chains (Sui, Stellar) skip the EVM session gates below; each
  // exits through its own session.
  const isSui = isSuiChain || isStellar;
  const suiSession = useSuiSession();
  const stellarSession = useStellarSession();
  // Key gate: prompt for the one-time signature on demand (no auto-open on
  // connect). Ref so the onSigned continuation re-enters with fresh state.
  const { keysReady, identityMode } = usePoolSession();
  const keysReadyRef = useRef(keysReady);
  keysReadyRef.current = keysReady;
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const queryClient = useQueryClient();
  const { sendTransactionAsync } = useSendTransaction();
  const { openKeystoreRegistrationModal } = useKeystoreRegistrationModal();
  const publicClient = usePublicClient({ chainId });
  const { noteManager, isInitialized, isInitializing, ensureInitialized, exportAccount, unconfirmedExitCommitments, clearUnconfirmedExit } = usePoolSession();
  const { notes, refetch: refetchNotes } = useNotes();
  const { beginTx, endTx } = useTxActivity();
  const { log } = useDebug();
  const noteManagerRef = useRef(noteManager);

  const [step, setStep] = useState<'select' | 'confirm' | 'loading' | 'success'>('select');
  // Operation epoch (codex P1-5): bumped on open/close so a run that outlived
  // its modal session aborts pre-broadcast and never writes the new session's UI.
  const opEpochRef = useRef(0);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [preferredTransaction, setPreferredTransaction] = useState<Transaction | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [exitResult, setExitResult] = useState<string | null>(null);
  const spinAnim = useRef(new Animated.Value(0)).current;

  // Entrance animation: bottom drawer slide-up on mobile, settle-in on desktop.
  const sheetAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isOpen) {
      sheetAnim.setValue(0);
      Animated.timing(sheetAnim, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    }
  }, [isOpen, sheetAnim]);

  useEffect(() => {
    noteManagerRef.current = noteManager;
  }, [noteManager]);

  const ragequittableNotes = useMemo(
    // REJECTED included: the SDK allows REJECTED -> EXITED, and ragequit is the
    // escape hatch for exactly the deposit the ASP pulled from its set.
    //
    // EXITED included WHEN THE CHAIN NEVER CONFIRMED THE EXIT. An `EXITED`
    // status can come from an unauthenticated row in the ASP's event snapshot,
    // and it is terminal — so one such row used to delete a note the user still
    // holds from the only screen that exists to get funds out. That is a
    // silent, permanent loss of access to a note that is still spendable on
    // chain. `unconfirmedExitCommitments` carries only the exits with no
    // finalized chain ragequit event behind them (services/unconfirmed-exits.ts);
    // a genuinely exited note keeps its proof and stays out of this list.
    //
    // Offering the note is the whole fix: the status gate lives in the SDK's
    // `prepareRageQuit`, not in the witness builder, so nothing here rewrites a
    // status the SDK treats as terminal. If the exit really did happen, the
    // attempt reverts on chain — which is the right way round, because the
    // alternative is the note staying invisible.
    //
    // The set is empty unless the vendored SDK can actually act on it (see
    // `sdkAllowsUnconfirmedExit` in services/sdk-setup.ts): listing a note
    // `prepareRageQuit` will refuse is a button that throws, which is a worse dead
    // end than the note being absent.
    () => notes.filter((note) => note.status === NoteStatus.PENDING
      || note.status === NoteStatus.ACTIVE
      || note.status === NoteStatus.REJECTED
      || ((note.status === NoteStatus.EXITED || note.status === NoteStatus.EXIT_PENDING)
        && unconfirmedExitCommitments.has(note.commitment))),
    [notes, unconfirmedExitCommitments],
  );


  const initializeSdkForRagequit = useCallback(async () => {
    // Sui notes come from the local Sui store (no EVM SDK init needed) — just
    // refresh them; initializing the EVM session here would error with no EVM
    // wallet connected.
    if (isSui) {
      setErrorMessage(null);
      refetchNotes();
      return;
    }
    try {
      setErrorMessage(null);
      const session = await ensureInitialized();
      exportAccount(session);
      refetchNotes();
      log('debug', 'Ragequit', 'SDK initialized for ragequit modal', {
        isInitialized: true,
        notesCount: notes.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(`SDK initialization failed: ${message}`);
      log('error', 'Ragequit', `SDK initialization failed: ${message}`, err);
    }
  }, [isSui, ensureInitialized, exportAccount, log, notes.length, refetchNotes]);

  // Spinner animation
  useEffect(() => {
    if (step === 'loading') {
      const loop = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: Platform.OS !== 'web',
        })
      );
      loop.start();
      return () => loop.stop();
    } else {
      spinAnim.setValue(0);
    }
  }, [step, spinAnim]);

  const spinInterpolate = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const explorerChainId = txChainId ?? (isStellar ? STELLAR_TESTNET_ID : isSuiChain ? SUI_TESTNET_ID : chainId);
  const explorerUrl = txHash ? getExplorerTxUrl(explorerChainId, txHash) : '';
  const explorerName = getExplorerName(explorerChainId);

  // SUI notes carry a random tokenId (not an EVM address), so the EVM-keyed
  // TOKEN_META lookup can't resolve them — fall back to the chain's native
  // currency (SUI / 9 decimals) instead of the "TOKEN" / 18-decimals default.
  const suiNative = getChainConfig(SUI_TESTNET_ID)?.nativeCurrency;
  const noteMeta = useCallback(
    (note: Note) => {
      if (isStellar) return { symbol: 'XLM', decimals: 7 };
      if (isSui) return { symbol: suiNative?.symbol ?? 'SUI', decimals: suiNative?.decimals ?? 9 };
      // CHAIN-AWARE registry first (kimi round 1): the local Sepolia-only map
      // rendered mainnet/OP USDC notes as "TOKEN" at 18 decimals (1 USDC →
      // "0.000000000001") and Citrea's native as "ETH" on the confirm screen.
      const known = getTokenMetadata(note.tokenId, chainId);
      // getTokenMetadata falls back to a truncated-address symbol for unknown
      // tokens; keep the legacy map as a second look before that.
      return known.symbol.startsWith('0X') ? getTokenMeta(note.tokenId) : known;
    },
    [isSui, isStellar, suiNative?.symbol, suiNative?.decimals, chainId],
  );
  const formatNote = useCallback(
    (note: Note) => {
      try { return formatUnits(BigInt(note.value), noteMeta(note).decimals); } catch { return '0'; }
    },
    [noteMeta],
  );

  const handleSelectNote = useCallback((note: Note) => {
    setSelectedNote(note);
    setErrorMessage(null);
    setStep('confirm');
    // No commitment, token or value. The debug buffer is collected whether or not
    // the overlay is on and is exported wholesale into bug reports, so a few of
    // these lines side by side reconstruct a portfolio. Stage names only.
    log('info', 'Ragequit', 'Note selected for ragequit', { status: note.status });
  }, [log]);

  const handleAcceptAndExitUnlocked = useCallback(async () => {
    if (!selectedNote) return;

    setStep('loading');
    setErrorMessage(null);
    setExitResult(null);
    // This attempt is accepted: drop the previous attempt's hash/chain pair so
    // the loading UI can never link the PRIOR failed transaction (codex).
    setTxHash(null);
    setTxChainId(null);
    // Operation binding (codex P1-5): abort pre-broadcast if the modal moved on.
    const runEpoch = opEpochRef.current;
    const live = () => opEpochRef.current === runEpoch;
    setLoadingMessage('Generating ragequit proof...');
    log('info', 'Ragequit', 'Starting ragequit flow');

    // Pause background polling (balances, ASP queries) while the tx
    // is in flight so we don't blast the RPC during the wait.
    beginTx();
    // Idempotent release — see deposit-modal-provider (codex round 1, P2).
    let txReleased = false;
    const releaseTx = () => { if (!txReleased) { txReleased = true; endTx(); } };
    try {
      // --- Stellar path: the SDK's rageQuit (public exit to this account) ---
      if (isStellar) {
        try {
          if (!live()) { log('warn', 'Ragequit', 'Stale run aborted before Stellar broadcast'); return; }
          const { txHash: hash } = await stellarSession.ragequit({
            commitment: selectedNote.commitment as `0x${string}`,
            shouldContinue: live,
            onStage: (stage) => { if (live()) setLoadingMessage(describeStellarStage(stage)); },
          });
          log('info', 'Ragequit', 'Stellar ragequit submitted', { txHash: hash });
          setTxHash(hash);
          setTxChainId(STELLAR_TESTNET_ID);
          refetchNotes();
          if (live()) setStep('success');
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          if (/Superseded/.test(raw)) return;
          throw new Error(/reject|denied|cancel|declined/i.test(raw) ? 'Transaction was rejected.' : stellarErrorMessage(raw));
        }
        return;
      }
      // --- Sui path: exit via the native Sui session ---
      if (isSui) {
        setLoadingMessage('Generating ragequit proof...');
        // Recover the original stored Sui note (with secrets + coinType) by
        // commitment — the UI Note only carries a hex-encoded commitment.
        const target = suiSession.loadNotes().find((n) => {
          try { return BigInt(n.commitment) === BigInt(selectedNote.commitment); } catch { return false; }
        });
        if (!target) throw new Error('Note not found in local Sui store.');
        if (!live()) { log('warn', 'Ragequit', 'Stale run aborted before Sui broadcast'); return; }
        setLoadingMessage('Submitting ragequit transaction...');
        const { txDigest } = await suiSession.ragequit({ note: target, coinType: target.coinType, shouldContinue: live });
        log('info', 'Ragequit', 'Sui ragequit submitted', { txDigest });
        setTxHash(txDigest);
        setTxChainId(SUI_TESTNET_ID);
        refetchNotes();
        await invalidateTransactionCaches(queryClient);
        if (live()) setStep('success');
        return;
      }

      const session = await ensureInitialized();
      const currentNoteManager = noteManagerRef.current;
      if (!currentNoteManager) {
        throw new Error('SDK note manager unavailable after initialization.');
      }
      if (identityMode === 'key') {
        throw new Error('Account-key sessions cannot ragequit directly because the on-chain exit must be sent by the owner wallet. Use Withdraw, or sign out of the account key and connect the owner wallet to exit.');
      }

      // Ragequit's circuit checks the user's keystore Merkle proof, so
      // the auth-policy leaf has to be on-chain before the proof can
      // be valid. Hand off to the shared registration modal so the
      // user sees a plain-English explanation, then replay this
      // handler after the registration tx confirms.
      //
      // Close the exit modal first — react-native-web's Modal
      // stacking renders the later-mounted overlay underneath, so we
      // can't trust the registration modal to appear on top while
      // this one is still open. State is preserved on this provider;
      // onSuccess reopens before re-firing the handler.
      const isRegistered = await session.isKeystoreRegistered();
      if (!isRegistered) {
        // Stale check after the RPC (codex): a ragequit closed during this await
        // must not pop the registration modal and replay the canceled exit.
        if (!live()) { releaseTx(); log('warn', 'Ragequit', 'Stale run aborted before registration handoff'); return; }
        log('info', 'Ragequit', 'Keystore not registered, prompting via modal');
        releaseTx();
        setLoadingMessage('');
        setIsOpen(false);
        openKeystoreRegistrationModal({
          title: 'Register before you exit',
          body:
            "Exiting (ragequit) needs a one-time on-chain record for your wallet. After this transaction confirms we'll continue with your exit automatically.",
          primaryLabel: 'Register and continue',
          // No relayer-paid registration here: the exit itself is a
          // wallet-signed transaction, so a wallet with no gas would pay a
          // relayer fee out of its shielded balance and still be unable to
          // exit. (Swap keeps the gasless path — it submits through
          // relayWithdrawAndSwap and needs no wallet gas.)
          allowGasless: false,
          onSuccess: () => {
            setIsOpen(true);
            void handleAcceptAndExit();
          },
          // "Not now" restores the exit modal instead of leaving it hidden in
          // a loading state (codex round 2).
          onCancel: () => {
            setIsOpen(true);
            setLoadingMessage('');
            // The step moved to 'loading' before the registration check —
            // restore Confirm or the reopened modal spins forever (codex r3).
            setStep('confirm');
          },
        });
        return;
      }

      // Step 1: Prepare the ragequit via SDK (generates ZK proof)
      log('debug', 'Ragequit', 'Calling prepareRageQuit');
      const result = await session.prepareRageQuit({
        commitment: selectedNote.commitment,
        // Only ever true for a note this client listed BECAUSE it could not
        // corroborate its exit against the chain. Without it prepareRageQuit
        // refuses on the local EXITED status and the row we deliberately put
        // back in the list would be a button that throws. The chain still
        // decides: a nullifier publishes once, so a real exit reverts.
        ...(selectedNote.status === NoteStatus.EXITED ? { allowUnconfirmedExit: true } : {}),
        // EXIT_PENDING needs no flag: the SDK only gates on EXITED, and a pending
        // exit is by definition one it has not settled.

      });
      //  is the pool, public and fixed. The nullifier and the recipient are not:
      // a nullifier is derived from the owner's key and, for a note whose exit was
      // only ever claimed, has never appeared on chain at all — this log line was
      // the one place it could escape the device.
      // `to` is the pool: public, fixed, and useful. The nullifier and the
      // recipient that used to be here are neither. A nullifier is derived from
      // the owner's key, and for a note whose exit was only ever CLAIMED it has
      // never appeared on chain at all, so this line was the one place it could
      // leave the device. The debug buffer is collected whether or not the
      // overlay is on and is exported wholesale into bug reports.
      log('info', 'Ragequit', 'prepareRageQuit succeeded', { to: result.ragequitTx.to });

      if (!publicClient || !connectedAddress) throw new Error('Connect the owner wallet to continue.');
      const owner = connectedAddress;
      const assertWallet = () => {
        const account = getAccount(wagmiConfig);
        if (!live() || account.address?.toLowerCase() !== owner.toLowerCase() || account.chainId !== chainId) {
          throw new Error('Wallet or network changed. Continue with the original wallet and network.');
        }
      };
      const deployment = getPinnedYieldDeployments(chainId).find(d => d.ppUSDC.toLowerCase() === selectedNote.tokenId.toLowerCase());
      const allowance = walletShareBalances?.chainId === chainId && walletShareBalances.owner.toLowerCase() === owner.toLowerCase()
        ? walletShareBalances.allowances[selectedNote.tokenId.toLowerCase()] : undefined;
      const calls = buildRagequitUnwrapCalls(result.ragequitTx, deployment, BigInt(selectedNote.value), owner, allowance);
      const send = async (call: typeof calls[number], label: string) => {
        assertWallet();
        setLoadingMessage(`Confirm ${label} in your wallet...`);
        const hash = await sendTransactionAsync({ account: owner, to: call.to as ViemHex, data: call.data as ViemHex, value: call.value ? BigInt(call.value) : 0n, chainId });
        if (live()) { setTxHash(hash); setTxChainId(chainId); setLoadingMessage(`Waiting for ${label} confirmation...`); }
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (receipt.status !== 'success') throw new Error(`${label} reverted.`);
        return receipt;
      };
      assertWallet();
      const batch = deployment ? await submitAtomicBatch({
        getCapabilities: async () => {
          const caps = await walletCapabilities(connector, owner);
          return (caps as Record<string, Record<string, unknown>> | null)?.[`0x${chainId.toString(16)}`];
        },
        sendCalls: async ({ calls: batchCalls }) => {
          assertWallet();
          setLoadingMessage('Confirm exit and unwrap in your wallet...');
          return sendCalls(wagmiConfig, { account: owner, chainId, forceAtomic: true, calls: batchCalls.map(call => ({ to: call.to as ViemHex, data: call.data as ViemHex, value: call.value ? BigInt(call.value) : 0n })) });
        },
        getCallsStatus: async id => {
          if (live()) setLoadingMessage('Waiting for exit and unwrap confirmation...');
          return getCallsStatus(wagmiConfig, { id });
        },
      }, { chainId, calls, onBroadcast: hash => { if (live()) { setTxHash(hash); setTxChainId(chainId); } } }) : null;
      if (batch && !batch.success) throw new Error('Exit and unwrap reverted. Nothing was exited.');
      const receipt = batch?.txHash
        ? await publicClient.waitForTransactionReceipt({ hash: batch.txHash as ViemHex, timeout: 180_000 })
        : await send(calls[0], 'exit');
      if (receipt.status !== 'success') throw new Error('Exit reverted. Nothing was exited.');
      const hash = receipt.transactionHash;
      log('info', 'Ragequit', 'Transaction confirmed', { txHash: hash });

      // This exit is the chain's now, not a claim — so drop it from the offered
      // set on the strength of the receipt ALONE, before anything that can fail.
      // The set is otherwise only recomputed at session init, so leaving it in
      // means the note we just exited keeps reappearing in the exit list for the
      // rest of the session. Putting this after the status write would make a
      // failed local write (a missing note, a changed SDK error shape) jump to the
      // catch and tell the user the exit failed while the chain says it succeeded.
      clearUnconfirmedExit(selectedNote.commitment);

      // Step 4: record the exit
      //
      // EXIT_PENDING rather than EXITED, for the same reason the SDK stopped
      // writing EXITED from a receipt: this says the transaction was MINED, not
      // that its block is settled, and EXITED has no way back. Writing it would
      // record irreversibly an exit a reorg could still undo, hiding a note the
      // user still owns — this change's own bug, reached through our success path.
      //
      // Gated, and the gate is load-bearing: NoteManager validates against its
      // transition table, and a vendored bundle without EXIT_PENDING THROWS. That
      // would report a failed ragequit to a user whose funds are already out,
      // which is worse than the problem. Falls back to today's behaviour until the
      // SDK is re-vendored, then switches itself on.
      //
      // The receipt block is passed explicitly. Without it NoteManager falls back
      // to the sync cursor, and settlement would later read back the wrong height
      // and restore a genuinely exited note.
      const { sdkSupportsProvisionalExit } = await import('@/services/sdk-runtime');
      const provisional = await sdkSupportsProvisionalExit();
      const exitBlock =
        receipt.blockNumber !== undefined
          ? (`0x${receipt.blockNumber.toString(16)}` as ViemHex)
          : undefined;
      currentNoteManager.updateNoteStatus(
        selectedNote.commitment,
        provisional ? NoteStatus.EXIT_PENDING : NoteStatus.EXITED,
        exitBlock,
      );
      log('info', 'Ragequit', provisional
        ? 'Note marked as exit-pending, awaiting settlement'
        : 'Note marked as EXITED (vendored SDK has no provisional state)');
      // Await the durable export (codex round 1, P2): fire-and-forget let a
      // fast close/reload race the persist of the status.
      await exportAccount(session);
      refetchNotes();

      // Refresh every page that shows transactions / events / stats.
      await invalidateTransactionCaches(queryClient);

      // The exit is recorded before any further wallet prompt. Cancelling an
      // unwrap must never offer the already-exited note for another ragequit.
      if (deployment) {
        let redeemed = !!batch;
        try {
          let redeemReceipt = receipt;
          if (!batch) {
            for (const call of calls.slice(1)) redeemReceipt = await send(call, call.to.toLowerCase() === deployment.ppUSDC.toLowerCase() && deployment.zap ? 'approval' : 'unwrap');
            redeemed = true;
          }
          if (live()) setExitResult(`Unwrapped to ${unwrapTargetSymbol(deployment)}`);
          if (deployment.zap && deployment.nativeMode && deployment.underlyingSymbol.toUpperCase() === 'WETH') {
            const weth = receivedWrappedNative(redeemReceipt.logs, deployment.underlying, owner);
            await send(wrappedNativeWithdrawCall(deployment.underlying, weth), 'ETH unwrap');
            if (live()) setExitResult('Unwrapped to ETH');
          }
        } catch {
          if (live()) setExitResult(redeemed
            ? deployment.nativeMode && deployment.zap
              ? 'Exit complete. Check your wallet for ETH or WETH.'
              : `Exit complete. Unwrapped to ${unwrapTargetSymbol(deployment)}.`
            : 'Exit complete. Finish unwrapping in Portfolio.');
        }
      }
      if (live()) setStep('success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The message goes to the screen in full (it is the user's own note, on the
      // user's own device) but into the debug buffer redacted. SDK errors name the
      // commitment they failed on, and that buffer is exported wholesale into bug
      // reports. The second argument is dropped for the same reason: it is the raw
      // error object, and its own fields carry the same identifiers.
      log('error', 'Ragequit', `Ragequit failed: ${redactNoteIdentifiers(message)}`);

      // Stale runs must not repaint a reopened modal (codex); a 'Superseded'
      // abort from inside the Sui method lands here silently.
      if (!live()) return;
      // User rejection — go back to confirm step
      if (
        message.includes('Superseded') ||
        message.includes('User rejected') ||
        message.includes('User denied') ||
        message.includes('User cancelled')
      ) {
        setStep('confirm');
        setErrorMessage(message.includes('Superseded') ? null : 'Transaction was rejected.');
        return;
      }

      setErrorMessage(`Ragequit failed: ${message}`);
      setStep('confirm');
    } finally {
      releaseTx();
    }
  }, [connector, wagmiConfig, walletShareBalances, selectedNote, sendTransactionAsync, publicClient, log, refetchNotes, ensureInitialized, identityMode, exportAccount, queryClient, chainId, connectedAddress, beginTx, endTx, openKeystoreRegistrationModal, isSui, isStellar, suiSession, stellarSession]);

  // Same-tick double-press guard — see hooks/use-op-lock.ts.
  const handleAcceptAndExit = useMemo(() => withOpLock(handleAcceptAndExitUnlocked), [withOpLock, handleAcceptAndExitUnlocked]);

  useEffect(() => {
    if (!isOpen || step !== 'select' || selectedNote || ragequittableNotes.length === 0) {
      return;
    }

    const matchedNote = resolvePreferredRagequitNote(ragequittableNotes, preferredTransaction);
    if (!matchedNote) {
      return;
    }

    log('info', 'Ragequit', 'Preselected ragequit note from transaction', {
      transactionId: preferredTransaction?.id ?? null,
      status: matchedNote.status,
    });
    handleSelectNote(matchedNote);
  }, [handleSelectNote, isOpen, log, preferredTransaction, ragequittableNotes, selectedNote, step]);

  // Native mock mode: no real flow starts from the pretend account.
  const blockMockFlow = useNativeMockBlock();
  const openRagequitModal = useCallback((transaction?: Transaction) => {
    if (blockMockFlow()) return;
    // Keys not derived yet → one-time signature first, then continue here. This
    // is the EVM pool-key gate; Sui derives its own keys inside the Sui ragequit
    // path, so don't force an EVM signature on a Sui user who happens to also
    // have a wagmi wallet auto-connected.
    if (!isSui && connectedAddress && !keysReadyRef.current) {
      openSeedDerivationModal({ onSigned: () => openRagequitModal(transaction) });
      return;
    }
    opEpochRef.current += 1;
    setStep('select');
    setSelectedNote(null);
    setPreferredTransaction(transaction ?? null);
    setTxHash(null);
    setTxChainId(null);
    setErrorMessage(null);
    setLoadingMessage('');
    setIsOpen(true);
    refetchNotes();
    initializeSdkForRagequit();
    log('debug', 'Ragequit', 'Ragequit modal opened');
  }, [blockMockFlow, initializeSdkForRagequit, log, refetchNotes, isSui, connectedAddress, openSeedDerivationModal]);

  const closeRagequitModal = useCallback(() => {
    opEpochRef.current += 1;
    setIsOpen(false);
    setPreferredTransaction(null);
  }, []);

  useEffect(() => {
    if (!isOpen || Platform.OS !== 'web') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRagequitModal();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeRagequitModal]);
  useBackHandler(isOpen, closeRagequitModal);

  useEffect(() => {
    if (!isOpen) return;

    log('debug', 'Ragequit', 'Ragequit modal state snapshot', {
      isInitialized,
      isInitializing,
      notesCount: notes.length,
      ragequittableNotesCount: ragequittableNotes.length,
      errorMessage,
      // A per-note dump of commitment, token, value and txHash — one line that
      // reconstructs the whole portfolio. The debug buffer is collected whether
      // or not the overlay is on and is exported wholesale into bug reports, so
      // this is a shape, not a listing.
      notesByStatus: notes.reduce<Record<string, number>>((acc, note) => {
        const status = String(note.status);
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      }, {}),
    });
  }, [errorMessage, isInitialized, isInitializing, isOpen, log, notes, ragequittableNotes.length]);

  // Loading/success centre the card (paddingTop 40 on desktop) — styling only.
  const isLoadingOrSuccess = step === 'loading' || step === 'success';

  return (
    <RagequitModalContext.Provider value={{ openRagequitModal, closeRagequitModal }}>
      {children}
      {isOpen && (
        <HubErrorBoundary onRetry={closeRagequitModal}>
        <View
          className={`inset-0 z-[999999] items-center ${isSheet ? 'justify-end' : 'justify-center'}`}
          // nw-keep(platform-css): web-only position:fixed anchors the overlay over scrolling content; empty object on native
          style={WEB_FIXED_POSITION as ViewStyle}
        >
          {/* Blur overlay */}
          <Pressable
            className={`absolute inset-0 ${isDark ? 'bg-[rgba(0,0,0,0.6)]' : 'bg-[rgba(255,255,255,0.6)]'}`}
            // nw-keep(platform-css): web-only backdrop blur; empty object on native
            style={WEB_BLUR_BACKDROP as ViewStyle}
            onPress={closeRagequitModal}
          />

          {/* Modal — bottom drawer on mobile, centered card on desktop */}
          <Animated.View
            className={`relative items-center justify-center gap-[20px] overflow-hidden border border-border bg-card-background ${
              isSheet
                ? 'w-full max-w-full rounded-t-card rounded-b-none border-b-0 px-[24px] pt-[40px] pb-[16px]'
                : isMobile
                  // Old flatten kept modal's edge paddings (pt 60/40, pb 20) OVER modalMobileClassic's
                  // paddingVertical: 24 (edge beats axis on native Yoga and RN-Web alike) — so the
                  // classic branch must split pt/pb, not collapse to py-[24px].
                  ? `w-[95%] max-w-[95%] rounded-card px-[16px] pb-[20px] ${isLoadingOrSuccess ? 'pt-[40px]' : 'pt-[60px]'}`
                  : `w-[504px] max-w-[95%] rounded-card px-[60px] pb-[20px] ${isLoadingOrSuccess ? 'pt-[40px]' : 'pt-[60px]'}`
            }`}
            // nw-keep(animated): entrance opacity + slide/scale are Animated values (sheet translateY / desktop scale)
            style={{
              opacity: sheetAnim,
              transform: isSheet
                ? [{ translateY: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }) }]
                : [{ scale: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }],
            }}
          >
            {isSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px] bg-border" />}
            {/* Decorative Ellipse */}
            <View className="absolute left-0 right-0 top-[12px] items-center opacity-100" pointerEvents="none">
              <DecorativeEllipse strokeColor={colors.borderLight} />
            </View>

            {/* Close Button */}

            <Pressable className="absolute right-[12px] top-[12px] z-[10] h-[24px] w-[24px] items-center justify-center" onPress={closeRagequitModal}>
              <CloseIcon color={colors.text} />
            </Pressable>

            {step === 'select' && (
              <>
                <View className="w-full items-center gap-[8px] pb-[32px]">
                  <Text className="font-pp-sans-bold text-[24px] text-center text-text">
                    Select Note to Exit
                  </Text>
                  <Text className="text-[14px] leading-[20px] text-center text-text">
                    <Text className="font-pp-regular">
                      Choose a note to exit. Funds return to this wallet, the note owner, without privacy.
                    </Text>
                  </Text>
                </View>

                {(!isSui && !isInitialized) ? (
                  <Text className="font-pp-regular text-[14px] leading-[20px] text-center text-[#737373]">
                    {errorMessage ?? (isInitializing ? 'Initializing SDK...' : 'Preparing SDK for ragequit...')}
                  </Text>
                ) : ragequittableNotes.length === 0 ? (
                  <Text className="font-pp-regular text-[14px] leading-[20px] text-center text-[#737373]">
                    No ragequittable notes available.
                  </Text>
                ) : (
                  <ScrollView className="w-full max-h-[240px]" contentContainerClassName="gap-[8px]">
                    {ragequittableNotes.map((note) => {
                      const meta = noteMeta(note);
                      // Only reachable for a note whose exit the chain never
                      // confirmed, so say why it is still listed rather than
                      // letting it look like an ordinary spendable note.
                      const exitUnconfirmed =
                        note.status === NoteStatus.EXITED || note.status === NoteStatus.EXIT_PENDING;
                      return (
                        <Pressable
                          key={note.commitment}
                          className="flex-row items-center justify-between rounded-control border border-border bg-primary-soft px-[16px] py-[12px]"
                          onPress={() => handleSelectNote(note)}
                        >
                          <View className="gap-[2px]">
                            <Text className="font-pp-medium text-[14px] text-text">
                              {balanceDisplay(formatNote(note), meta.symbol, chainId).text}
                            </Text>
                            <ShareCountHint hint={balanceDisplay(formatNote(note), meta.symbol, chainId).hint} />
                            <Text className="font-pp-regular text-[11px] text-[#737373]">
                              {truncateHash(note.commitment)}
                            </Text>
                            {exitUnconfirmed && (
                              <Text className="font-pp-regular text-[11px] text-[#737373]">
                                Exit reported by the operator, not confirmed on chain.
                              </Text>
                            )}
                          </View>
                          <Text className="text-[18px] text-text">→</Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                )}


                <Pressable
                  className="h-[38px] w-full items-center justify-center rounded-control border border-[#B8BBBF] bg-card-background px-[20px] py-[10px]"
                  onPress={closeRagequitModal}
                >
                  <Text className="font-pp-medium text-[14px] text-center text-text">
                    Cancel
                  </Text>
                </Pressable>
              </>
            )}

            {step === 'confirm' && selectedNote && (
              <>
                {/* Info Section */}
                <View className="w-full items-center gap-[8px] pb-[32px]">
                  <Text className="font-pp-sans-bold text-[24px] text-center text-text">
                    Ragequit Privacy Pools
                  </Text>
                  <Text className="text-[14px] leading-[20px] text-center text-text">
                    <Text className="font-pp-regular">
                      By exiting this Pool, you are withdrawing all funds you have shielded or pending to this account's wallet address, even for deposits someone else made for you.{' '}
                    </Text>
                    <Text className="font-pp-bold">
                      You will not gain any privacy
                    </Text>
                    <Text className="font-pp-regular">.</Text>
                    {'\n\n'}
                    <Text className="font-pp-regular">
                      Are you sure you want to continue?
                    </Text>
                  </Text>
                </View>

                {/* Selected note summary */}
                <View className="w-full items-center gap-[4px] border-y border-border py-[12px]">
                  <Text className="font-pp-regular text-[12px] text-[#737373]">
                    Exiting note
                  </Text>
                  <Text className="font-pp-medium text-[18px] text-text">
                    {balanceDisplay(formatNote(selectedNote), noteMeta(selectedNote).symbol, chainId).text}
                  </Text>
                  <Text className="font-pp-regular text-[11px] text-[#737373]">
                    {truncateHash(selectedNote.commitment)}
                  </Text>
                </View>

                {errorMessage && (
                  <Text className="font-pp-regular text-[13px] text-center text-[#DC2626]">
                    {errorMessage}
                  </Text>
                )}

                {/* Buttons */}
                <View className="w-full gap-[8px]">
                  {/* Primary: Accept and exit */}
                  <Pressable
                    className="h-[38px] w-full items-center justify-center rounded-control border border-text bg-text px-[20px] py-[10px]"
                    onPress={handleAcceptAndExit}
                  >
                    <Text className="font-pp-medium text-[14px] text-center text-card-background">
                      Accept and exit
                    </Text>
                  </Pressable>
                  {/* Secondary: Back */}
                  <Pressable
                    className="h-[38px] w-full items-center justify-center rounded-control border border-[#B8BBBF] bg-card-background px-[20px] py-[10px]"
                    onPress={() => { setStep('select'); setErrorMessage(null); }}
                  >
                    <Text className="font-pp-medium text-[14px] text-center text-text">
                      Back
                    </Text>
                  </Pressable>
                </View>
              </>
            )}

            {step === 'loading' && (
              <>
                <Text className="font-pp-sans-bold text-[24px] text-center text-text">
                  Processing Exit
                </Text>

                <View className="items-center gap-[16px] py-[20px]">
                  {/* nw-keep(animated): spinner rotation is an Animated interpolate */}
                  <Animated.View style={{ transform: [{ rotate: spinInterpolate }] }}>
                    <SpinnerIcon color={colors.text} />
                  </Animated.View>
                  <Text className="font-pp-regular text-[14px] text-center text-[#737373]">
                    {loadingMessage || 'Withdrawing all funds...'}
                  </Text>
                </View>

                {txHash && explorerUrl ? (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(explorerUrl)}>
                    <Text className="font-pp-medium text-[14px] text-[#3B82F6] underline">
                      View on {explorerName}
                    </Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={explorerName} />
                  </View>
                ) : null}
              </>
            )}

            {step === 'success' && (
              <>
                <Text className="font-pp-sans-bold text-[24px] text-center text-text">
                  Exit Successful
                </Text>

                <View className="items-center gap-[16px] py-[20px]">
                  <CheckCircleIcon color={colors.success} />
                  <Text className="font-pp-medium text-[16px] text-center text-success">
                    All funds withdrawn
                  </Text>
                  {selectedNote && (
                    <Text className="font-pp-regular text-[14px] text-center text-[#737373]">
                      {exitResult ?? `${balanceDisplay(formatNote(selectedNote), noteMeta(selectedNote).symbol, chainId).text} returned to this wallet`}
                    </Text>
                  )}
                </View>

                {txHash && explorerUrl ? (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(explorerUrl)}>
                    <Text className="font-pp-medium text-[14px] text-[#3B82F6] underline">
                      View on {explorerName}
                    </Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={explorerName} />
                  </View>
                ) : null}

                <Pressable
                  className="h-[38px] w-full items-center justify-center rounded-control border border-[#B8BBBF] bg-card-background px-[20px] py-[10px]"
                  onPress={closeRagequitModal}
                >
                  <Text className="font-pp-medium text-[14px] text-center text-text">
                    Done
                  </Text>
                </Pressable>
              </>
            )}

            {/* Footer */}
            <View className="flex-row items-center gap-[16px] pt-[40px]">
              <Pressable onPress={() => Linking.openURL(DOCS_URL)}>
                <Text className="font-pp-regular text-[12px] text-[#4D4D4D]">
                  FAQ
                </Text>
              </Pressable>
              <View className="h-[12px] w-[1px] bg-[#4D4D4D]" />
              <Pressable onPress={() => Linking.openURL(SUPPORT_FORM_URL)}>
                <Text className="font-pp-regular text-[12px] text-[#4D4D4D]">
                  Support
                </Text>
              </Pressable>
              <View className="h-[12px] w-[1px] bg-[#4D4D4D]" />
              <Pressable onPress={() => Linking.openURL(SUPPORT_TELEGRAM_URL)}>
                <Text className="font-pp-regular text-[12px] text-[#4D4D4D]">
                  Telegram
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
        </HubErrorBoundary>
      )}
    </RagequitModalContext.Provider>
  );
}
