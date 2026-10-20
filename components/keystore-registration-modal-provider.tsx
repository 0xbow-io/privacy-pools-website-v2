import { approxUnderlyingText } from '@/services/share-display';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useOpLock } from '@/hooks/use-op-lock';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAccount, useConfig, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi';
import { getAccount } from 'wagmi/actions';
import type { Address as ViemAddress, Hex } from 'viem';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useNotes } from '@/hooks/use-notes';
import { useGaslessRegistration } from '@/hooks/use-gasless-registration';
import { isViewingKeyGasShort, usePublishViewingKey } from '@/hooks/use-publish-viewing-key';
import { useReceiveSetup } from '@/hooks/use-receive-setup';
import { FlowProgress } from '@/components/ui/flow-progress';
import { getChainConfig, isSupportedEvmChainId } from '@/config/chains';
import { registrationTopUpEnabled } from '@/config/cold-start';
import {
  describeInsufficientGas,
  classifyRegistrationError,
  collectErrorText,
  isAuthPolicyAlreadySetError,
  describeRegistrationError,
  REGISTRATION_TX_PENDING_MESSAGE,
  describeUnpayableWallet,
  GASLESS_REGISTRATION_CONFIRM_BODY,
  GASLESS_REGISTRATION_CONFIRM_BODY_TOP_UP,
  GASLESS_REGISTRATION_CONFIRM_PRIMARY,
  GASLESS_REGISTRATION_CONFIRM_TITLE,
  GASLESS_REGISTRATION_NOTICE,
  GASLESS_REGISTRATION_NOTICE_TITLE,
  GASLESS_REGISTRATION_PRIMARY,
  HIGH_FEE_WARNING,
  PUBLIC_PAYOUT_LABEL,
  isHighFeeShare,
  GASLESS_REGISTRATION_TOP_UP_NOTE,
  GASLESS_TOP_UP_CONFIRM_BODY,
  GASLESS_TOP_UP_CONFIRM_PRIMARY,
  GASLESS_TOP_UP_NOTICE,
  GASLESS_TOP_UP_NOTICE_TITLE,
  GASLESS_TOP_UP_PRIMARY,
  type GaslessRegistrationEligibility,
  type QuotedRegistrationPlan,
} from '@/services/gasless-registration';
import { getPendingRegistration, subscribePendingRegistration, trackPendingRegistration } from '@/services/pending-registration-tx';
import { formatGasTopUp } from '@/services/gas-top-up';
import {
  describeFinishSetupGas,
  describePublishViewingKey,
  FINISH_SETUP_BODY,
  FINISH_SETUP_PRIMARY,
  FINISH_SETUP_TITLE,
  PUBLISH_VIEWING_KEY_PRIMARY,
  PUBLISH_VIEWING_KEY_TITLE,
  receiveSetupFromIdentity,
  setReceiveSetup,
  VIEWING_KEY_GAS_LIMIT,
} from '@/services/receive-setup';
import { priceWalletTx, registrationOwnerUnchanged, walletTxFields, type FeeReadClient } from '@/services/wallet-tx-fees';

export const REGISTRATION_CLOSED_BEFORE_PROMPT = 'Registration was closed before the wallet prompt. Nothing was sent.';
export const REGISTRATION_OWNER_CHANGED =
  'The connected wallet or network changed, so nothing more was sent. Switch back and use Finish setup.';
import { getTokenMetadata } from '@/config/tokens';
import { formatUnits } from 'viem';
import { isSessionInitTimeout, withSessionInitTimeout } from '@/services/session-init-timeout';
import { beginWalletChainExcursion, cancelWalletChainExcursion, type WalletChainExcursion } from '@/services/wallet-chain-excursion';
import { useNativeMockBlock } from '@/hooks/use-native-mock-block';

// Self-service keystore registration modal. Opened in two ways:
//   1. The header "Register Keystore" menu item (manual opt-in).
//   2. Other flows (e.g. payment-request creation) call
//      `openKeystoreRegistrationModal({ onSuccess })` when they need
//      registration before proceeding; on success the callback fires
//      so the caller can continue without a re-click.
//
// Deposit and pay-via-transfer keep their own inline registration
// (they need to chain the registration tx with the deposit/transfer
// tx in a single user-visible flow); this modal exists for the cases
// where registration is the headline action, not a prerequisite.
//
// GASLESS PATH. Registration is normally a transaction the user pays for, which
// is impossible for a wallet holding no native currency — the cold start. The
// /import-note claim page already carries such a wallet, but it is only reached
// by opening a transfer link; the payee of a V3 payment request never sees it,
// because their note is auto-discovered. So this modal probes on every open
// (hooks/use-gasless-registration.ts) and, when the wallet genuinely cannot pay
// AND holds a note that covers a relayer's fee with something left over, swaps
// its primary action for a free signature the relayer turns into an on-chain
// `registerAndRelay`. Everything short of all those conditions keeps today's
// flow — see services/gasless-registration.ts for why the bar is set where it is.
//
// The gasless press is TWO steps, and both halves answer a real hazard. The
// open-time probe never contacts the relayer (a quote would disclose the
// wallet's address, asset and exact note total to a third party before the user
// asked for anything), so the fee is unknown until the press. The press quotes,
// shows what it costs, and waits for confirmation — and that confirmed fee is
// then a CEILING the submit refuses to exceed, so "Register without gas" can
// never turn into an unbounded charge against the user's shielded balance.
//
// `registerAndRelay` sets only the auth policy and `setViewingKey` is
// msg.sender-only, so the relay also forwards gas and the wallet publishes its
// viewing key as a last step.

type KeystoreRegistrationStatus = 'unknown' | 'registered' | 'unregistered';

/**
 * Why the caller got the cancel path. `registered: true` means the
 * registration DID land and only the resume did not happen (the wallet was not
 * switched back home). A caller must not treat that as "nothing happened".
 */
export type RegistrationCancelInfo = { registered: boolean };

type OpenOptions = {
  onSuccess?: () => void;
  /**
   * Fired when the user dismisses the modal without registering ("Not now",
   * Escape, backdrop). Lets a caller that parked an in-flight flow (e.g. a
   * deposit that closed itself to hand off here) restore its own state
   * instead of staying stuck mid-operation.
   */
  onCancel?: (info: RegistrationCancelInfo) => void;
  /** Override the modal title for caller-specific copy. */
  title?: string;
  /** Override the modal body for caller-specific copy. */
  body?: string;
  /** Override the primary button label. */
  primaryLabel?: string;
  /**
   * Whether the gasless (relayer-paid) registration may be offered here.
   * Defaults to true.
   *
   * Set it FALSE when the flow this modal is a prerequisite for needs the
   * wallet to pay for a transaction of its own — a deposit, a swap, a ragequit.
   * The gasless path takes a relayer's fee out of the user's shielded balance,
   * and spending that to unblock a flow that will then fail on
   * "insufficient funds for gas" charges them for nothing. Those callers show
   * the honest "this wallet can't pay" warning instead.
   */
  allowGasless?: boolean;
  /**
   * Register on ANOTHER chain, without moving the app to it.
   *
   * Registration is per chain. A cross-chain reshield deposits on the far side,
   * so an account registered here and not there signs a swap whose destination
   * deposit cannot land, and LiFi pays the bridged tokens to the fallback
   * address instead. The caller needs the user to register over there and then
   * carry on with the form they are already filling in, on THIS chain.
   *
   * So only the WALLET moves: it is switched for the one transaction, the app's
   * active chain is untouched, and the form the caller parked is still there
   * when this closes. Everything below that reads a chain reads
   * `effectiveChainId`, which is this when set.
   */
  targetChainId?: number;
};

/** `gasTopUpWei`: from the signed commitment; null when no top-up was delivered. */
type PublishStep = { gasTopUpWei: bigint | null };

const DEFAULT_TITLE = 'Register your wallet';
const DEFAULT_BODY =
  'A one-time on-chain setup lets others send you private payments and lets you spend what you receive. You only do this once per wallet.';
const DEFAULT_PRIMARY = 'Register now';

/**
 * How long the modal waits on a wallet that has been handed a transaction.
 *
 * Generous, because the prompt is user-paced: a person reads it, maybe unlocks
 * a hardware wallet first. It is a backstop against a prompt that never
 * ANSWERS — dismissed by the wallet's own UI, or refused because the account
 * cannot pay and the extension simply stops talking — which used to leave
 * `pending` true forever and, with it, both exits disabled.
 */
const WALLET_PROMPT_TIMEOUT_MS = 120_000;
/** DEV-566: re-reads of a stale "not registered" before the auth-policy leg. */
const AUTH_LAG_RETRIES = 2;
const AUTH_LAG_RETRY_MS = 1_500;

/** Says what to do, and never claims the transaction was cancelled. */
const WALLET_PROMPT_TIMEOUT_MESSAGE =
  'Your wallet did not answer. Open it and check for a pending request, then register again.';

/**
 * Shown under the spinner while a wallet prompt is outstanding.
 *
 * Closing the modal ends this app's wait. It cannot withdraw a transaction the
 * wallet has already been given, so the copy must not say "cancelled".
 */
const PENDING_ESCAPE_HINT =
  'You can close this. Your wallet prompt stays open, and the registration still goes through if you approve it.';

type KeystoreRegistrationModalContextType = {
  status: KeystoreRegistrationStatus;
  refreshStatus: () => Promise<void>;
  openKeystoreRegistrationModal: (options?: OpenOptions) => void;
  closeKeystoreRegistrationModal: () => void;
  /**
   * Imperatively mark registered (e.g. after deposit auto-registers), naming
   * the owner and chain registered. A flow can finish after an account or
   * network switch, so the mark applies only if they are still current.
   */
  markRegistered: (owner: string | null | undefined, chainId: number) => void;
  /** Open as "Finish setup": auth policy set, viewing key missing. */
  openFinishSetup: (options?: Pick<OpenOptions, 'onSuccess' | 'onCancel' | 'targetChainId'>) => void;
  /** Check before opening unprompted: an open replaces a running flow's callbacks. */
  isOpen: boolean;
};

const KeystoreRegistrationModalContext = createContext<KeystoreRegistrationModalContextType>({
  status: 'unknown',
  refreshStatus: async () => {},
  openKeystoreRegistrationModal: () => {},
  closeKeystoreRegistrationModal: () => {},
  markRegistered: () => {},
  openFinishSetup: () => {},
  isOpen: false,
});

export function useKeystoreRegistrationModal() {
  return useContext(KeystoreRegistrationModalContext);
}

export function KeystoreRegistrationModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  const { address } = useAccount();
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
  const activeChainId = useActiveEvmChain().id;
  // The app's chain as of now, for async runs (a run's closure holds the value
  // it started with), and the chain the caller set its flow up on, captured at
  // open. A caller only resumes while the app is still on the latter: a failed
  // cross-chain run whose switch back was declined leaves the app on the
  // target, and a retry there is a same-chain run that would otherwise resume
  // the caller on the wrong chain.
  const activeChainIdRef = useRef(activeChainId);
  const wagmiConfig = useConfig();
  useEffect(() => {
    activeChainIdRef.current = activeChainId;
  }, [activeChainId]);
  const openHomeRef = useRef<number | null>(null);
  // The chain this open is registering on: the caller's target when it named
  // one, otherwise wherever the app is. Nothing below should read the active
  // chain directly; a cross-chain open is about the OTHER one.
  const [targetChainId, setTargetChainId] = useState<number | null>(null);
  const chainId = targetChainId ?? activeChainId;
  const crossChainTarget = targetChainId !== null && targetChainId !== activeChainId;
  const withOpLock = useOpLock();
  const publicClient = usePublicClient({ chainId });
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const {
    poolSession,
    keysReady,
    identityMode,
    ensureInitialized,
    keystoreManager,
    sessionForChain,
    keystoreStatusForChain,
    sessionAddress,
  } = usePoolSession();
  // The gasless path acts on the chain this open registers on, not the app's:
  // a cross-chain open otherwise priced, spent and registered on the active
  // chain. The hook itself refuses when that chain is not the live session's.
  const { probeEligibility, quoteRegistration, submitRelayedRegistration } = useGaslessRegistration({ chainId });
  const { publishViewingKey, estimatePublishCost } = usePublishViewingKey(chainId);

  const [status, setStatus] = useState<KeystoreRegistrationStatus>('unknown');
  const [isOpen, setIsOpen] = useState(false);
  const [pending, setPendingState] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // True only while a registration transaction sits in the wallet, so the
  // "Check your wallet" hint never shows during a relayer or RPC wait.
  const [awaitingWallet, setAwaitingWallet] = useState(false);
  // A registration tx this wallet sent whose receipt never came back. Held
  // per owner + chain OUTSIDE the modal (services/pending-registration-tx),
  // so close + reopen cannot re-enable Register while it may still mine.
  const [, setPendingRegTick] = useState(0);
  useEffect(() => subscribePendingRegistration(() => setPendingRegTick((t) => t + 1)), []);
  const txUnconfirmed = !!getPendingRegistration(sessionAddress ?? address, chainId);
  // Only what the CALLER asked for. The effective copy is derived below,
  // because the gasless probe can change the primary label — merging the two at
  // open time would have frozen the label before the probe had an answer.
  const [copyOverrides, setCopyOverrides] = useState<{ title?: string; body?: string; primary?: string }>({});
  // Progress line for the relayed path only: it signs, quotes, proves and
  // relays over ~30s, where the self-funded path is a wallet prompt.
  const [statusMessage, setStatusMessage] = useState('');
  const onSuccessRef = useRef<(() => void) | null>(null);
  const onCancelRef = useRef<((info: RegistrationCancelInfo) => void) | null>(null);
  // Open generation (codex): open B can replace the refs while run A is
  // pending; A's terminal status/visibility writes must not close B's modal.
  const openGenRef = useRef(0);
  // The open generation the USER walked away from. Distinct from `openGenRef`,
  // which a newer open also bumps: a run superseded by a second open should
  // still deliver to the caller it was started for, but a run the user
  // dismissed must not resume anything (a deposit that pops back up minutes
  // after "close" is not what they asked for).
  const abandonedGenRef = useRef(-1);
  // `pending` for the close handler, which must stay referentially stable —
  // it is handed to callers through context and to Modal.onRequestClose.
  const pendingRef = useRef(false);
  const setPending = useCallback((value: boolean) => {
    pendingRef.current = value;
    setPendingState(value);
  }, []);

  // Whether the relayer can register this wallet — advisory copy, plus the plan
  // the submit re-validates. The submit re-checks registration, affordability
  // and note spendability from live state, so this value never decides
  // anything on its own; it only lets the modal promise the right thing before
  // the user commits, and saves re-pricing every candidate at press time.
  const [gasless, setGaslessState] = useState<GaslessRegistrationEligibility | null>(null);
  // Mirror of the above for the press handler, which closes over its own render.
  const gaslessRef = useRef<GaslessRegistrationEligibility | null>(null);
  const setGasless = useCallback((value: GaslessRegistrationEligibility | null) => {
    gaslessRef.current = value;
    setGaslessState(value);
  }, []);
  // `chainId:account` the probe has already answered for this open, and the
  // in-flight promise so a press that lands before it resolves can await the
  // same answer instead of racing a second probe. The key is also what makes
  // the cached answer safe to reuse: an account switch changes it, and an
  // answer about the PREVIOUS account must never route the press.
  const probedKeyRef = useRef<string | null>(null);
  const probePromiseRef = useRef<Promise<GaslessRegistrationEligibility> | null>(null);
  // Monotonic probe generation — only the newest probe may write its answer.
  const probeGenRef = useRef(0);
  // Bumped by every open() so the probe effect re-runs even when the modal was
  // already visible. Without it a second caller opening over the first sat at
  // gasless=null forever: the effect's other dependencies are all stable, so
  // clearing the latch alone could never re-trigger it.
  const [openNonce, setOpenNonce] = useState(0);
  // Whether the CALLER allows the relayer-paid path (see OpenOptions).
  const [gaslessAllowed, setGaslessAllowed] = useState(true);
  // The priced plan the user is being asked to confirm. Non-null == the modal
  // is showing the cost screen; confirming it is what authorises the fee.
  const [quotedPlan, setQuotedPlan] = useState<QuotedRegistrationPlan | null>(null);
  // Non-null: the relay landed and the modal is on the last step.
  const [publishStep, setPublishStep] = useState<PublishStep | null>(null);
  // The registration LANDED and only the optional viewing-key step is on
  // screen. Closing now ("Remind me later") must tell the caller it succeeded,
  // not that it was cancelled: the wallet is registered and a note was spent
  // (review of #130).
  const registeredAwaitingPublishRef = useRef(false);
  const [publishEstimate, setPublishEstimate] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!address || !isSupportedEvmChainId(chainId) || !poolSession || !keysReady) {
      setStatus('unknown');
      return;
    }
    try {
      // Reads the named chain's keystore, not the active session's. Also the
      // only load-time viewing-key read the receive prompts rely on.
      const identity = await keystoreStatusForChain(chainId);
      if (identity === 'unknown') throw new Error(`Registration on chain ${chainId} could not be read.`);
      setReceiveSetup(sessionAddress ?? address, chainId, receiveSetupFromIdentity(identity), 'onchain');
      // 'partial' and 'incompatible' both have an auth policy.
      const registered = identity !== 'unregistered';
      // Plain console: the e2e harness reads app console lines, and the Claim
      // callout depends on this answer.
      console.info('[KeystoreRegistration] status', { registered, chainId, identity });
      setStatus(registered ? 'registered' : 'unregistered');
    } catch (err) {
      console.warn('[KeystoreRegistration] status read failed', err instanceof Error ? err.message : String(err));
      setStatus('unknown');
    }
  }, [address, chainId, poolSession, keysReady, keystoreStatusForChain, sessionAddress]);

  // Re-check registration whenever the session is rebuilt (chain/wallet
  // change, fresh seed-derivation). The check is cheap (single RPC).
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // 'unknown' is fine while nothing depends on it, but once the session holds
  // notes the Claim callout (My balances) needs a real answer. A single failed
  // RPC read used to leave the status unknown for the rest of the session (CI
  // 2026-08-25: received funds, no Claim offered). Re-ask with a short delay
  // until it resolves.
  const { notes } = useNotes();
  useEffect(() => {
    if (status !== 'unknown' || !keysReady || !poolSession || notes.length === 0) return;
    const timer = setTimeout(() => { void refreshStatus(); }, 4000);
    return () => clearTimeout(timer);
  }, [status, keysReady, poolSession, notes.length, refreshStatus]);

  const bindingRef = useRef<{ owner: string | undefined; chainId: number }>({ owner: undefined, chainId });
  useEffect(() => {
    bindingRef.current = { owner: sessionAddress ?? address, chainId };
  }, [sessionAddress, address, chainId]);
  const markRegistered = useCallback((owner: string | null | undefined, registeredChainId: number) => {
    const current = bindingRef.current;
    if (!owner || owner.toLowerCase() !== current.owner?.toLowerCase() || registeredChainId !== current.chainId) return;
    setStatus('registered');
  }, []);

  // Native mock mode: no real flow starts from the pretend account.
  const blockMockFlow = useNativeMockBlock();
  const openKeystoreRegistrationModal = useCallback((options?: OpenOptions) => {
    if (blockMockFlow()) return;
    openGenRef.current += 1;
    setErrorMessage(null);
    setStatusMessage('');
    setAwaitingWallet(false);
    // A run orphaned by this open no longer clears the spinner (its writes are
    // gated on owning the UI), so the new modal must start un-pending or it
    // would open with both exits and the primary button disabled.
    setPending(false);
    onSuccessRef.current = options?.onSuccess ?? null;
    onCancelRef.current = options?.onCancel ?? null;
    registeredAwaitingPublishRef.current = false;
    openHomeRef.current = activeChainIdRef.current;
    setCopyOverrides({
      title: options?.title,
      body: options?.body,
      primary: options?.primaryLabel,
    });
    // Every open re-probes. Balances move and notes get spent between opens,
    // and a stale "no gas needed" would promise a path that no longer exists.
    probedKeyRef.current = null;
    probePromiseRef.current = null;
    setGasless(null);
    setQuotedPlan(null);
    setPublishStep(null);
    setPublishEstimate(null);
    setFinishing(false);
    setGaslessAllowed(options?.allowGasless ?? true);
    setTargetChainId(options?.targetChainId ?? null);
    setOpenNonce((n) => n + 1);
    setIsOpen(true);
  }, [blockMockFlow, setGasless, setPending]);

  const openFinishSetup = useCallback((options?: Pick<OpenOptions, 'onSuccess' | 'onCancel' | 'targetChainId'>) => {
    // Re-opening over a pending run would orphan it.
    if (pendingRef.current) return;
    openKeystoreRegistrationModal(options);
    setFinishing(true);
  }, [openKeystoreRegistrationModal]);

  const { partial: partialHere } = useReceiveSetup(chainId);
  const finishMode = finishing || publishStep !== null || (isOpen && partialHere);

  // Display only; the send re-checks. Runs once the user opened Finish setup
  // (or the post-relay publish step): gas price, latest block and the owner
  // wallet's own balance, nothing derived from a note.
  const showPublishEstimate = publishStep !== null || (isOpen && finishMode);
  useEffect(() => {
    if (!showPublishEstimate) return;
    let cancelled = false;
    void estimatePublishCost().then((cost) => {
      if (cancelled || !cost) return;
      const native = getChainConfig(chainId)?.nativeCurrency ?? { symbol: 'ETH', decimals: 18 };
      const shown = formatGasTopUp({ wei: cost.costWei, symbol: native.symbol, decimals: native.decimals });
      setPublishEstimate(shown?.amountText ?? null);
    });
    return () => { cancelled = true; };
  }, [showPublishEstimate, estimatePublishCost, chainId]);

  // Probe once per (open, chain, account). The probe SETS state, so without the
  // latch an unstable dependency — a fresh publicClient, a new log identity —
  // would spin: render → probe → setState → render. It also keeps two RPC reads,
  // a registration check and a relayer quote off every re-render.
  //
  // Superseding is generation-based, NOT an effect cleanup: `probeEligibility`
  // is rebuilt on most renders, so a cleanup that cancelled on every re-run
  // would throw away the answer of a probe the latch then refuses to re-issue,
  // leaving the modal permanently unprobed.
  //
  // It runs even when the caller set `allowGasless: false`. It used to bail on
  // that flag, which left `gasless` null for exactly the callers whose comments
  // rely on the "this wallet can't pay" warning (deposit, ragequit) — the
  // warning could never render, and their users met the dead end as an
  // "insufficient funds" rejection inside the wallet instead. The flag governs
  // the OFFER, not the diagnosis; `resolveGasless` still refuses to route a
  // press down the relayed path when it is false, and the probe itself
  // discloses nothing (local state and this app's own RPC, no relayer).
  useEffect(() => {
    if (!isOpen || !keysReady || !address || identityMode !== 'wallet') return;
    const key = `${chainId}:${address.toLowerCase()}`;
    if (probedKeyRef.current === key) return;
    probedKeyRef.current = key;
    const gen = ++probeGenRef.current;
    const run = probeEligibility();
    probePromiseRef.current = run;
    void run
      .then((result) => {
        // A re-open or an account/chain switch has issued a newer probe; its
        // answer wins regardless of which resolves first.
        if (probeGenRef.current === gen) setGasless(result);
      })
      .catch(() => {
        if (probeGenRef.current !== gen) return;
        // Clear the latch so a transient failure does not silence the advisory
        // — including the "this wallet is stuck" warning — for the whole open.
        probedKeyRef.current = null;
        probePromiseRef.current = null;
        setGasless(null);
      });
  }, [isOpen, openNonce, keysReady, address, identityMode, chainId, probeEligibility, setGasless]);

  /**
   * The eligibility answer to ACT on, awaiting an in-flight probe rather than
   * racing it. Returns null when there is no answer to be had, which routes the
   * press to the self-funded path — the behaviour this modal has always had.
   *
   * The cached answer is only reused when it belongs to the CURRENT
   * chain+account. A wallet-side account switch re-issues the probe, and for
   * the whole round trip the old answer is still in state; acting on it would
   * take a funded account down the gasless branch and hard-fail on the submit's
   * re-validation instead of quietly using the self-funded path that works.
   */
  const resolveGasless = useCallback(async (): Promise<GaslessRegistrationEligibility | null> => {
    if (!gaslessAllowed || !address) return null;
    const key = `${chainId}:${address.toLowerCase()}`;
    if (gaslessRef.current && probedKeyRef.current === key) return gaslessRef.current;
    const pending = probedKeyRef.current === key ? probePromiseRef.current : null;
    try {
      return pending ? await pending : await probeEligibility();
    } catch {
      return null;
    }
  }, [gaslessAllowed, address, chainId, probeEligibility]);

  const gaslessEligible = gaslessAllowed && gasless?.kind === 'eligible';
  const topUpEligible = gaslessEligible && gasless?.kind === 'eligible' && gasless.mode === 'top-up';
  // Caller copy wins; the gasless label only fills the slot the caller left
  // empty, so "Register and continue" from the withdraw flow stays intact.
  const copy = useMemo(() => {
    if (publishStep) {
      return { title: PUBLISH_VIEWING_KEY_TITLE, body: '', primary: PUBLISH_VIEWING_KEY_PRIMARY };
    }
    const title = finishMode ? FINISH_SETUP_TITLE : copyOverrides.title ?? DEFAULT_TITLE;
    const body = finishMode ? FINISH_SETUP_BODY : copyOverrides.body ?? DEFAULT_BODY;
    // The cost screen's own label always wins, including over a caller's:
    // "Register and continue" must not sit under a fee the user has not agreed
    // to yet.
    const primary = quotedPlan
      ? (quotedPlan.mode === 'top-up' ? GASLESS_TOP_UP_CONFIRM_PRIMARY : GASLESS_REGISTRATION_CONFIRM_PRIMARY)
      : topUpEligible
        ? GASLESS_TOP_UP_PRIMARY
        : finishMode
          ? FINISH_SETUP_PRIMARY
          : copyOverrides.primary ?? (gaslessEligible ? GASLESS_REGISTRATION_PRIMARY : DEFAULT_PRIMARY);
    return { title, body, primary };
  }, [copyOverrides, gaslessEligible, topUpEligible, quotedPlan, publishStep, finishMode]);

  const formatNative = useCallback((wei: bigint | null | undefined) => {
    const native = getChainConfig(chainId)?.nativeCurrency ?? { symbol: 'ETH', decimals: 18 };
    return formatGasTopUp({ wei, symbol: native.symbol, decimals: native.decimals })?.amountText ?? null;
  }, [chainId]);
  const quotedTopUp = quotedPlan ? formatNative(quotedPlan.gasTopUpWei) : null;
  // Static member read — Metro only inlines static process.env.EXPO_PUBLIC_*.
  const gaslessTopUpOn = registrationTopUpEnabled(chainId, process.env.EXPO_PUBLIC_REGISTRATION_TOP_UP_CHAINS);
  const receivedTopUp = publishStep ? formatNative(publishStep.gasTopUpWei) : null;

  // The quoted fee and what survives it, in the note's own asset. Both are
  // rendered as approximations: the fee is a ceiling the relayer may undercut,
  // so the remainder is a floor.
  const quotedAmounts = useMemo(() => {
    if (!quotedPlan) return null;
    const token = getTokenMetadata(quotedPlan.tokenId, chainId);
    const render = (wei: bigint) => {
      const exact = formatUnits(wei, token.decimals);
      // Trim to something a human reads, but never round a non-zero fee to 0.
      const [whole, frac = ''] = exact.split('.');
      const short = frac ? `${whole}.${frac.slice(0, 6).replace(/0+$/, '') || '0'}` : whole;
      return approxUnderlyingText(`${short === '0' && wei > 0n ? '<0.000001' : short} ${token.symbol}`, token.symbol);
    };
    return {
      fee: render(quotedPlan.quotedFeeWei),
      remaining: render(quotedPlan.changeWei),
      payout: quotedPlan.quotedPayoutWei > 0n ? render(quotedPlan.quotedPayoutWei) : null,
      total: render(quotedPlan.noteValueWei),
    };
  }, [quotedPlan, chainId]);

  // Said plainly rather than left as a button that dies inside the wallet: the
  // wallet cannot pay, and no relayer can carry it either. Null for every state
  // that is not a dead end (funded wallet, locked session, account key).
  const stuckMessage = useMemo(
    () => describeUnpayableWallet(
      gasless,
      getChainConfig(chainId)?.nativeCurrency.symbol ?? 'ETH',
      { gaslessAllowed },
    ),
    [gasless, chainId, gaslessAllowed],
  );

  /**
   * Escape, and it is UNCONDITIONAL.
   *
   * This used to early-return while `pending`, with both exits disabled on top
   * of it, so a wallet that could not sign (QA, 2026-09-21: no BNB, wallet
   * answering "insufficient funds") left the user in a modal reading
   * "Registering…" with no way out at all.
   *
   * Closing ends THIS APP's wait. It cannot withdraw a transaction the wallet
   * already holds, so the run is orphaned rather than cancelled: its UI writes
   * are dropped (the generation bump makes `ownsUi()` false) and it may not
   * resume the caller's flow (`abandonedGenRef`), but a registration that does
   * land is still recorded as registered. The pending copy says exactly that.
   */
  const closeKeystoreRegistrationModal = useCallback(() => {
    if (pendingRef.current) {
      abandonedGenRef.current = openGenRef.current;
      // An orphaned cross-chain run must not keep the app pinned home while
      // the wallet sits on the target for minutes, nor pop a switch-back
      // prompt nobody asked for when it finally ends. Dropping the excursion
      // makes that run skip the switch back, and the app follows the wallet.
      cancelWalletChainExcursion();
    }
    // Orphan any in-flight run so its late writes cannot re-open this modal or
    // clear a later run's spinner.
    openGenRef.current += 1;
    setPending(false);
    setStatusMessage('');
    setQuotedPlan(null);
    setAwaitingWallet(false);
    setPublishStep(null);
    setPublishEstimate(null);
    setFinishing(false);
    setIsOpen(false);
    const registered = registeredAwaitingPublishRef.current;
    registeredAwaitingPublishRef.current = false;
    const success = onSuccessRef.current;
    onSuccessRef.current = null;
    const cancel = onCancelRef.current;
    onCancelRef.current = null;
    // Registered, only the viewing-key step deferred: resume the caller.
    if (registered) {
      success?.();
      return;
    }
    // Dismissed without registering — let the caller restore whatever flow
    // it parked (e.g. the deposit modal it hid to hand off here).
    cancel?.({ registered: false });
  }, [setPending]);

  const handleRegisterUnlocked = useCallback(async () => {
    setErrorMessage(null);
    setPending(true);
    // Operation binding (codex P1-5): a NEW open overwrites the provider-global
    // callback refs — this run must deliver to the callbacks it was opened
    // with, and must never null out a newer open's refs.
    const runGen = openGenRef.current;
    const ownsUi = () => openGenRef.current === runGen;
    // A run the user CLOSED must not resume the flow that opened it. `ownsUi`
    // cannot answer this: a second open also makes it false, and that run's
    // callbacks are still the right ones to deliver to.
    const deliversToCaller = () => abandonedGenRef.current !== runGen;
    const runOnSuccess = onSuccessRef.current;
    const runOnCancel = onCancelRef.current;
    const clearRunRefs = () => {
      if (onSuccessRef.current === runOnSuccess) onSuccessRef.current = null;
      if (onCancelRef.current === runOnCancel) onCancelRef.current = null;
    };
    // A registration on ANOTHER chain moves only the wallet. Without the
    // excursion the app followed the switch: the session re-initialised on the
    // target, the caller's form reset, and the target session below came back
    // null in that gap ("Could not reach Ethereum to register there"). Opened
    // right before the switch, and always closed with the wallet sent back to
    // the app's chain first, so the flow that asked resumes where it was.
    let excursion: WalletChainExcursion | null = null;
    //
    // Bounded like the send legs: a wallet that never answers the switch-back
    // prompt must not hold the run, the op lock and the pin forever. Skipped
    // when the user picked a chain meanwhile (the excursion is no longer
    // current), so their choice is never reverted.
    //
    // Resolves whether the app is still where the caller left it. False when
    // the wallet would not come back, or the user picked another chain: the
    // caller's flow was set up on the home chain and must not resume there.
    let stranded = false;
    const returnHome = async (): Promise<boolean> => {
      const open = excursion;
      if (!open) return !stranded;
      excursion = null;
      if (!open.isCurrent()) {
        stranded = true;
        open.end();
        return false;
      }
      try {
        await withSessionInitTimeout(
          switchChainAsync({ chainId: open.homeChainId }),
          { timeoutMs: WALLET_PROMPT_TIMEOUT_MS },
        );
      } catch {
        // Declined, failed or unanswered: the wallet stays on the target, and
        // ending the excursion lets the app follow it there, which at least
        // tells the truth.
        stranded = true;
      } finally {
        open.end();
      }
      return !stranded;
    };
    // The registration landed either way. Resume the caller only when the app
    // is back where it set its flow up; otherwise hand it the cancel path so a
    // parked form is restored (and re-validates on the chain it is now on)
    // instead of resuming against the wrong one.
    const runHome = openHomeRef.current;
    const deliverRegistered = (home: boolean) => {
      if (!deliversToCaller()) return;
      const stillHome = runHome === null || activeChainIdRef.current === runHome;
      if (home && stillHome) runOnSuccess?.();
      else runOnCancel?.({ registered: true });
    };
    // Set while a sent registration tx has no receipt yet. A failure then
    // (a receipt-wait timeout, a dropped RPC) does not mean nothing was sent,
    // so the user must not be told to try again and send a duplicate.
    let sentUnconfirmed = false;
    let sentHash: Hex | null = null;
    // Keeps waiting on a hash THIS wallet broadcast (never a relayed one, see
    // the privacy rules), so the outcome is known even after the modal closes.
    const watchSentRegistration = (hash: Hex) => {
      const owner = sessionAddress ?? address;
      const client = publicClient;
      if (!client) return;
      void trackPendingRegistration(owner, chainId, hash, async (h, timeout) => {
        const receipt = await client.waitForTransactionReceipt({ hash: h as Hex, timeout });
        return receipt.status === 'success' ? 'success' : 'reverted';
      }).then(async (outcome) => {
        // Bound to the wallet + chain that sent it: if the user switched
        // meanwhile, nothing here may write into the new identity's state or
        // modal. The next open re-reads.
        const stillBound = () => {
          const current = bindingRef.current;
          return !!owner && owner.toLowerCase() === current.owner?.toLowerCase() && current.chainId === chainId;
        };
        if (!stillBound()) return;
        if (outcome === 'success') {
          // One leg may still be owed (keystore landed, viewing key not sent):
          // re-read rather than assume complete.
          setErrorMessage(null);
          try {
            const identity = await keystoreStatusForChain(chainId);
            // The read follows the CURRENT identity: only store it under the
            // captured owner if that is still who it read.
            if (stillBound()) setReceiveSetup(owner, chainId, receiveSetupFromIdentity(identity), 'onchain');
          } catch {
            // The next open re-reads it.
          }
        } else if (outcome === 'reverted') {
          setErrorMessage(describeRegistrationError('reverted on-chain', false, getChainConfig(chainId)?.displayName ?? 'this network'));
        } else {
          setErrorMessage(null);
        }
      });
    };
    try {
      if (identityMode === 'key') {
        throw new Error('To register, sign out of the account key and connect the owner wallet.');
      }
      // Never relays again from here.
      if (publishStep) {
        await publishViewingKey({
          onStatus: (message) => { if (ownsUi()) setStatusMessage(message); },
        });
        setStatus('registered');
        clearRunRefs();
        registeredAwaitingPublishRef.current = false;
        if (ownsUi()) {
          setIsOpen(false);
          setStatusMessage('');
          setPublishStep(null);
          setPublishEstimate(null);
          setFinishing(false);
        }
        if (deliversToCaller()) runOnSuccess?.();
        return;
      }
      // A plan already on screen means the user has SEEN the fee and pressed
      // confirm. That press is the authorisation, and the plan's quoted fee is
      // the ceiling the submit holds the relayer to.
      if (quotedPlan) {
        const { gasTopUpWei } = await submitRelayedRegistration({
          plan: quotedPlan,
          onStatus: (message) => { if (ownsUi()) setStatusMessage(message); },
        });
        setStatus('registered');
        // With a top-up, stay open for the viewing-key step; the caller is
        // notified when it completes. Without one there is no gas to pay it.
        if (quotedPlan.extraGas) {
          if (ownsUi()) {
            registeredAwaitingPublishRef.current = true;
            setStatusMessage('');
            setQuotedPlan(null);
            setPublishStep({ gasTopUpWei });
            setFinishing(true);
          }
          return;
        }
        clearRunRefs();
        if (ownsUi()) {
          setIsOpen(false);
          setStatusMessage('');
          setQuotedPlan(null);
        }
        if (deliversToCaller()) runOnSuccess?.();
        return;
      }
      // Gasless first, and awaited rather than read: a press that lands before
      // the probe resolves must still take the right branch, or a wallet with no
      // gas gets a wallet prompt it can only reject.
      const eligibility = await resolveGasless();
      if (eligibility?.kind === 'eligible') {
        // The first relayer contact of the whole flow, and only because the
        // user pressed. Price it, then STOP and show what it costs — nothing is
        // signed until they confirm the number.
        // No "relay"/"sign"/"wallet" in this string: FlowProgress derives its
        // stage from it, and this is not the registration flow yet.
        if (ownsUi()) setStatusMessage('Checking the fee…');
        const plan = await quoteRegistration(eligibility.candidates, eligibility.mode);
        if (ownsUi()) {
          setStatusMessage('');
          setQuotedPlan(plan);
        }
        return;
      }
      // Closed before anything reached the wallet (the gasless probe above can
      // take a while): stop here, so no excursion opens and no prompt appears.
      if (!deliversToCaller()) return;
      if (chainId && isSupportedEvmChainId(chainId)) {
        if (crossChainTarget && !excursion) excursion = beginWalletChainExcursion(activeChainId);
        await switchChainAsync({ chainId });
      }
      // The calldata has to be built against the chain it will be sent to: a
      // keystore contract lives at a different address on each chain, and the
      // active session would sign for the wrong one.
      const session = crossChainTarget
        ? await sessionForChain(chainId)
        : await ensureInitialized();
      if (!session) {
        throw new Error(`Could not reach ${getChainConfig(chainId)?.displayName ?? `chain ${chainId}`} to register there.`);
      }
      // DEV-566: an already-registered wallet was asked to call setAuthPolicy
      // again (it reverted with Keystore_AuthPolicyAlreadySet) because one read
      // of the registration came back stale. Re-read before EVER sending the
      // auth-policy leg, the same lag allowance the Finish-setup path uses.
      let registration = await session.prepareRegisterKeystore();
      for (let attempt = 0; attempt < AUTH_LAG_RETRIES && registration.keystoreCalldata; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, AUTH_LAG_RETRY_MS));
        registration = await session.prepareRegisterKeystore();
      }
      const finishAlreadyRegistered = async () => {
        // Race / external registration: mark and exit cleanly.
        setReceiveSetup(sessionAddress ?? address, chainId, 'complete', 'onchain');
        setStatus('registered');
        const home = await returnHome();
        clearRunRefs();
        if (ownsUi()) setIsOpen(false);
        deliverRegistered(home);
      };
      if (registration.alreadyRegistered) {
        await finishAlreadyRegistered();
        return;
      }
      const { keystoreCalldata } = registration;
      let { viewingKeyCalldata } = registration;
      // PARTIAL registration resume (codex round 2): the SDK returns
      // keystoreCalldata:null + viewingKeyCalldata:non-null when auth landed
      // earlier but the viewing key didn't — throwing on the null made that
      // recovery impossible. Each leg submits independently; only neither-leg
      // is an error.
      if (!keystoreCalldata && !viewingKeyCalldata) {
        throw new Error('Keystore registration is unavailable for this session.');
      }
      // Literal 'success' required before marking registered (codex round 1):
      // a REVERTED registration used to be marked registered locally, and the
      // caller resumed a flow whose proofs then fail on-chain. Require the
      // confirmation client BEFORE the first wallet send (codex round 2) —
      // failing after the send leaves an unconfirmable tx in flight.
      if (!publicClient) {
        throw new Error('Cannot confirm the registration transaction (no RPC client). Check the connection and try again.');
      }
      // BOUNDED. `sendTransactionAsync` resolves when the wallet answers, and a
      // wallet that cannot pay (or whose background worker was suspended) may
      // simply never answer — which pinned `pending` true for the life of the
      // page. Reuses services/session-init-timeout.ts: same shape (cap this
      // caller's wait, leave the underlying work alone, swallow a late
      // settlement), different sentence, because "preparing your account" is
      // not what is happening here.
      let registrationLegSent = false;
      const runOwner = address;
      // Captured with the owner: a switch mid-run must not move the marker.
      const runSetupKey = sessionAddress ?? address;
      const sendRegistrationLeg = async (calldata: { to: string; data: string; value: string | number | bigint }) => {
        const tx = {
          chainId,
          to: calldata.to as ViemAddress,
          data: calldata.data as Hex,
          value: BigInt(calldata.value),
        };
        // setAuthPolicy / setViewingKey: the shared wallet fee policy
        // (services/wallet-tx-fees.ts, DEV-542), not the wallet's own tier.
        const plan = await priceWalletTx(
          publicClient as unknown as FeeReadClient,
          { account: runOwner as ViemAddress, to: tx.to, data: tx.data, value: tx.value },
          calldata === viewingKeyCalldata ? VIEWING_KEY_GAS_LIMIT : null,
          chainId,
        );
        // Pricing awaited: a flow closed meanwhile must not open the FIRST
        // wallet prompt. Once a leg has gone out, the second one proceeds as
        // it always did, so the account is never left half-registered.
        if (!registrationLegSent && !deliversToCaller()) throw new Error(REGISTRATION_CLOSED_BEFORE_PROMPT);
        // The calldata belongs to the run's owner on the run's chain. A wallet
        // switched meanwhile must never send it: stop, and leave a leg already
        // sent as `partial` so Finish setup resumes it.
        const now = getAccount(wagmiConfig);
        if (!registrationOwnerUnchanged({ owner: runOwner, chainId, current: now })) {
          if (registrationLegSent) setReceiveSetup(runSetupKey, chainId, 'partial', 'local');
          throw new Error(REGISTRATION_OWNER_CHANGED);
        }
        registrationLegSent = true;
        if (ownsUi()) setAwaitingWallet(true);
        try {
          return await withSessionInitTimeout(
            sendTransactionAsync({ ...tx, account: runOwner as ViemAddress, ...walletTxFields(plan) }),
            { timeoutMs: WALLET_PROMPT_TIMEOUT_MS },
          );
        } catch (err) {
          if (isSessionInitTimeout(err)) throw new Error(WALLET_PROMPT_TIMEOUT_MESSAGE);
          throw err;
        } finally {
          if (ownsUi()) setAwaitingWallet(false);
        }
      };
      if (keystoreCalldata) {
        let keystoreHash: Hex | null = null;
        try {
          keystoreHash = await sendRegistrationLeg(keystoreCalldata);
        } catch (err) {
          // The wallet's simulation says the auth policy is already set
          // (Keystore_AuthPolicyAlreadySet, 0x70d48a55), so the reads above were
          // still stale. Nothing was sent: re-read and send only what is really
          // missing (the viewing key), or finish.
          if (!isAuthPolicyAlreadySetError(collectErrorText(err))) throw err;
          // The wallet refused before sending: nothing is half-registered.
          registrationLegSent = false;
          const fresh = await session.prepareRegisterKeystore();
          viewingKeyCalldata = fresh.alreadyRegistered ? null : fresh.viewingKeyCalldata;
          if (!viewingKeyCalldata) {
            await finishAlreadyRegistered();
            return;
          }
        }
        if (keystoreHash) {
          sentUnconfirmed = true;
          sentHash = keystoreHash;
          const keystoreReceipt = await publicClient.waitForTransactionReceipt({ hash: keystoreHash, timeout: 180_000 });
          sentUnconfirmed = false;
          if (keystoreReceipt.status !== 'success') {
            throw new Error(`Keystore registration reverted on-chain (tx ${keystoreHash}).`);
          }
        }
      }
      if (viewingKeyCalldata) {
        const viewingKeyHash = await sendRegistrationLeg(viewingKeyCalldata);
        sentUnconfirmed = true;
        sentHash = viewingKeyHash;
        const vkReceipt = await publicClient.waitForTransactionReceipt({ hash: viewingKeyHash, timeout: 180_000 });
        sentUnconfirmed = false;
        if (vkReceipt.status !== 'success') {
          throw new Error(`Viewing-key registration reverted on-chain (tx ${viewingKeyHash}).`);
        }
      }
      // Recorded first: a registration that landed stays registered whatever
      // the wallet does with the switch back.
      try {
        keystoreManager?.markRegistered(chainId);
      } catch {
        // SDK already has it; duplicate marker calls are harmless.
      }
      setReceiveSetup(sessionAddress ?? address, chainId, 'complete', 'onchain');
      setStatus('registered');
      // Back on the app's chain before the caller resumes.
      const home = await returnHome();
      clearRunRefs();
      if (ownsUi()) setIsOpen(false);
      deliverRegistered(home);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((/already/i.test(message) && /policy|registered/i.test(message)) || isAuthPolicyAlreadySetError(collectErrorText(err))) {
        // Keystore_AuthPolicyAlreadySet: another tab / a deposit got there
        // first. That race can land the auth policy without the viewing key,
        // so re-read the identity rather than assuming 'complete' — otherwise
        // useReceiveSetup is left at a stale 'unknown'/'partial' while this
        // caller resumes as if setup finished.
        try {
          const identity = await keystoreStatusForChain(chainId);
          setReceiveSetup(sessionAddress ?? address, chainId, receiveSetupFromIdentity(identity), 'onchain');
        } catch (readErr) {
          console.warn('[KeystoreRegistration] post-race identity re-read failed', readErr instanceof Error ? readErr.message : String(readErr));
        }
        setStatus('registered');
        const home = await returnHome();
        clearRunRefs();
        if (ownsUi()) setIsOpen(false);
        deliverRegistered(home);
      } else if (ownsUi() && isViewingKeyGasShort(err)) {
        // Re-probe: a short wallet is offered another top-up.
        const native = getChainConfig(chainId)?.nativeCurrency ?? { symbol: 'ETH', decimals: 18 };
        const need = formatGasTopUp({ wei: err.needWei, symbol: native.symbol, decimals: native.decimals })?.amountText;
        const have = formatGasTopUp({ wei: err.balanceWei, symbol: native.symbol, decimals: native.decimals })?.amountText
          ?? `0 ${native.symbol}`;
        setErrorMessage(`Publishing your viewing key needs about ${need ?? `a little ${native.symbol}`} in gas, and this wallet has ${have}. Nothing was sent.`);
        setPublishStep(null);
        setPublishEstimate(null);
        probedKeyRef.current = null;
        probePromiseRef.current = null;
        setGasless(null);
        setOpenNonce((n) => n + 1);
      } else if (ownsUi()) {
        // Error copy belongs to the open that started this run — a newer
        // open's modal must not display a stale run's failure (codex).
        //
        // "Insufficient funds" is the one the QA screenshot was full of, and
        // the raw wallet string names neither the chain nor a way forward. Say
        // what is missing and where.
        const insufficient = describeInsufficientGas(
          message,
          getChainConfig(chainId)?.nativeCurrency.symbol ?? 'ETH',
          getChainConfig(chainId)?.displayName ?? 'this network',
        );
        // Never a raw viem dump on screen: keep it in the console for
        // debugging and show one line the user can act on.
        const kind = classifyRegistrationError(message, sentUnconfirmed);
        if (kind !== 'plain' && kind !== 'rejected') console.warn('[KeystoreRegistration] registration failed', message);
        // A sent tx that may still land: Register stays off until its receipt
        // is seen (or the cap passes), across close and reopen.
        if (sentUnconfirmed && sentHash) watchSentRegistration(sentHash);
        setErrorMessage(kind === 'pending' || kind === 'rejected' || !insufficient
          ? describeRegistrationError(message, sentUnconfirmed, getChainConfig(chainId)?.displayName ?? 'this network')
          : insufficient);
      }
      // The gasless path cancels at a SIGNATURE prompt, so a failed run leaves
      // the modal open with a stale "Generating proof…" beneath the error.
      if (ownsUi()) setStatusMessage('');
      // Drop the confirmed plan on ANY failure. Its quoted fee is the ceiling
      // the submit enforces, so retrying against a stale one — after a
      // "the fee went up" abort especially — would refuse forever. The next
      // press re-quotes and shows a fresh number to confirm.
      if (ownsUi()) setQuotedPlan(null);
    } finally {
      // The failure path returns home here, after its error is already on
      // screen, so a slow switch-back prompt never hides what went wrong.
      await returnHome();
      // Only the run that still owns the modal may clear the spinner. A run the
      // user closed (or a second open superseded) already had `pending` reset
      // for it, and clearing again here would wipe a NEWER run's spinner.
      if (ownsUi()) setPending(false);
    }
  }, [
    activeChainId,
    crossChainTarget,
    sessionForChain,
    chainId,
    ensureInitialized,
    identityMode,
    keystoreManager,
    keystoreStatusForChain,
    publicClient,
    quotedPlan,
    publishStep,
    publishViewingKey,
    quoteRegistration,
    resolveGasless,
    sendTransactionAsync,
    sessionAddress,
    address,
    wagmiConfig,
    setGasless,
    setPending,
    submitRelayedRegistration,
    switchChainAsync,
  ]);

  // Same-tick double-press guard — see hooks/use-op-lock.ts.
  const handleRegister = useMemo(() => withOpLock(handleRegisterUnlocked), [withOpLock, handleRegisterUnlocked]);

  const value = useMemo(
    () => ({ status, refreshStatus, openKeystoreRegistrationModal, closeKeystoreRegistrationModal, markRegistered, openFinishSetup, isOpen }),
    [status, refreshStatus, openKeystoreRegistrationModal, closeKeystoreRegistrationModal, markRegistered, openFinishSetup, isOpen],
  );


  return (
    <KeystoreRegistrationModalContext.Provider value={value}>
      {children}
      <Modal animationType={isMobileSheet ? 'slide' : 'fade'} transparent visible={isOpen} onRequestClose={closeKeystoreRegistrationModal}>
        <View className={`flex-1 items-center bg-[rgba(0,0,0,0.5)] ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`}>
          <View className={`w-full gap-[14px] border border-border bg-card-background p-[24px] ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'max-w-[460px] rounded-card'}`}>
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            <View className="flex-row items-start justify-between gap-[12px]">
              <View className="flex-1 gap-[6px]">
                <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY POOLS V2</Text>
                <Text className="font-pp-bold text-[22px] leading-[26px] text-text">{copy.title}</Text>
              </View>
              {/* NEVER disabled. A wallet that cannot sign leaves this modal
                  pending forever, and a close button that does nothing is how
                  QA ended up trapped under "Registering…". */}
              <Pressable
                className="h-[36px] w-[36px] items-center justify-center rounded-control border border-border-light"
                onPress={closeKeystoreRegistrationModal}
                accessibilityLabel="Close"
              >
                {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>

            {/* Suppressed on the gasless path: every caller's body describes a
                transaction the user pays for, which is exactly what is NOT
                about to happen. The notice below says the whole thing instead. */}
            {!gaslessEligible && !quotedPlan && !publishStep && (
              <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">{copy.body}</Text>
            )}

            {/* DEV-554: name the native amount before the wallet prompt, the
                same figure the send is capped at. */}
            {finishMode && !gaslessEligible && !quotedPlan && !publishStep && publishEstimate && (
              <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                {describeFinishSetupGas({ estimate: publishEstimate, chainName: getChainConfig(chainId)?.displayName ?? 'this network' })}
              </Text>
            )}

            {/* The relayer will pay for this registration and take its fee out
                of the user's shielded balance — say so before they press. The
                exact number is not known yet: finding it out means telling the
                relayer what this wallet holds, which waits for the press. */}
            {gaslessEligible && !quotedPlan && !publishStep && (
              <View className="gap-[6px] rounded-control border border-border bg-success-bg px-[12px] py-[10px]">
                <Text className="font-pp-semi-bold text-[12px] text-success">
                  {topUpEligible ? GASLESS_TOP_UP_NOTICE_TITLE : GASLESS_REGISTRATION_NOTICE_TITLE}
                </Text>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                  {topUpEligible ? GASLESS_TOP_UP_NOTICE : GASLESS_REGISTRATION_NOTICE}
                </Text>
                {!topUpEligible && gaslessTopUpOn ? (
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                    {GASLESS_REGISTRATION_TOP_UP_NOTE}
                  </Text>
                ) : null}
              </View>
            )}

            {/* The cost screen. Nothing has been signed at this point; pressing
                the primary button below is what authorises this fee, and the
                submit refuses any final fee above it. */}
            {quotedPlan && quotedAmounts && (
              <View className="gap-[10px] rounded-control border border-border bg-background-secondary px-[12px] py-[12px]">
                <Text className="font-pp-semi-bold text-[12px] text-text">{GASLESS_REGISTRATION_CONFIRM_TITLE}</Text>
                <View className="gap-[6px]">
                  <View className="flex-row items-center justify-between gap-[12px]">
                    <Text className="font-pp-medium text-[12px] text-text-muted">Relayer fee (max)</Text>
                    <Text className="font-pp-semi-bold text-[12px] text-right text-text">{quotedAmounts.fee}</Text>
                  </View>
                  <View className="flex-row items-center justify-between gap-[12px]">
                    <Text className="font-pp-medium text-[12px] text-text-muted">Stays shielded</Text>
                    <Text className="font-pp-semi-bold text-[12px] text-right text-text">{quotedAmounts.remaining}</Text>
                  </View>
                  {/* DEV-482: the relayer's payout floor with a top-up. Leaves the pool, not part of the fee. */}
                  {quotedAmounts.payout ? (
                    <View testID="public-payout-row" className="flex-row items-center justify-between gap-[12px]">
                      <Text className="font-pp-medium text-[12px] text-text-muted">{PUBLIC_PAYOUT_LABEL}</Text>
                      <Text className="font-pp-semi-bold text-[12px] text-right text-text">{quotedAmounts.payout}</Text>
                    </View>
                  ) : null}
                  {/* The native gas top-up the relayer forwards; priced inside the fee above. */}
                  {quotedTopUp ? (
                    <View className="flex-row items-center justify-between gap-[12px]">
                      <Text className="font-pp-medium text-[12px] text-text-muted">Native gas sent to your wallet</Text>
                      <Text className="font-pp-semi-bold text-[12px] text-right text-text">{quotedTopUp}</Text>
                    </View>
                  ) : null}
                  <View className="flex-row items-center justify-between gap-[12px]">
                    <Text className="font-pp-medium text-[12px] text-text-muted">Gas you pay</Text>
                    <Text className="font-pp-semi-bold text-[12px] text-right text-success">None</Text>
                  </View>
                </View>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                  {quotedPlan.mode === 'top-up'
                    ? GASLESS_TOP_UP_CONFIRM_BODY
                    : quotedPlan.extraGas ? GASLESS_REGISTRATION_CONFIRM_BODY_TOP_UP : GASLESS_REGISTRATION_CONFIRM_BODY}
                </Text>
                {isHighFeeShare(quotedPlan.quotedFeeWei + quotedPlan.quotedPayoutWei, quotedPlan.noteValueWei) ? (
                  <View testID="high-fee-warning" className="rounded-control border border-warning bg-warning-bg px-[12px] py-[8px]">
                    <Text className="font-pp-medium text-[12px] leading-[18px] text-warning">{HIGH_FEE_WARNING}</Text>
                  </View>
                ) : null}
              </View>
            )}

            {publishStep && (
              <View className="gap-[10px] rounded-control border border-border bg-background-secondary px-[12px] py-[12px]">
                <View className="flex-row items-center gap-[6px]">
                  {/* nw-keep(data-color): status glyph uses the success theme token */}
                  <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                  <Text className="font-pp-semi-bold text-[12px] text-success">
                    {receivedTopUp ? `${receivedTopUp} received` : 'You can spend on this chain'}
                  </Text>
                </View>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                  {describePublishViewingKey({ received: receivedTopUp, estimate: publishEstimate })}
                </Text>
              </View>
            )}

            {/* No gas, and no relayer that can carry this wallet either. Better
                said here than discovered as an "insufficient funds" rejection. */}
            {!gaslessEligible && !quotedPlan && stuckMessage && (
              <View className="gap-[6px] rounded-control border border-warning bg-warning-bg px-[12px] py-[10px]">
                <Text className="font-pp-semi-bold text-[12px] text-warning">This wallet can&apos;t pay for registration</Text>
                <Text className="font-pp-regular text-[12px] leading-[18px] text-warning">{stuckMessage}</Text>
              </View>
            )}

            {/* Reopened while a sent registration is unconfirmed: say why Register is off. */}
            {!errorMessage && txUnconfirmed && (
              <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{REGISTRATION_TX_PENDING_MESSAGE}</Text>
            )}
            {errorMessage && (
              <View className="rounded-control border border-[#E11D48] px-[12px] py-[10px]">
                <Text className="font-pp-medium text-[12px] leading-[17px] text-[#E11D48]">{errorMessage}</Text>
              </View>
            )}

            {/* Staged progress for the relayed registration itself, which signs,
                quotes, proves and relays over ~30s. The pre-quote press is a
                single round trip and gets a plain line instead — the four-stage
                indicator would imply the flow had started. */}
            {pending && statusMessage
              ? (quotedPlan
                ? <FlowProgress message={statusMessage} />
                : <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{statusMessage}</Text>)
              : null}

            {/* The way out, said out loud while the wallet has the prompt. It
                promises nothing it cannot keep: closing ends this app's wait,
                not the wallet's transaction. */}
            {pending && awaitingWallet && (
              <Text className="font-pp-medium text-[13px] leading-[18px] text-text">Check your wallet</Text>
            )}
            {pending && (
              <Text className="font-pp-regular text-[12px] leading-[18px] text-text-muted">{PENDING_ESCAPE_HINT}</Text>
            )}

            <View className="mt-[6px] flex-row gap-[10px]">
              {/* Also never disabled while pending, and relabelled: "Not now"
                  reads as a cancel, and a transaction already in the wallet
                  cannot be cancelled from here. */}
              <Pressable
                className="items-center justify-center rounded-control border border-border-light px-[16px] py-[12px]"
                // From the cost screen this steps BACK rather than closing:
                // the user declined this fee, not the whole registration, and
                // dropping the plan makes the next press re-quote.
                onPress={quotedPlan && !pending
                  ? () => { setQuotedPlan(null); setErrorMessage(null); }
                  : closeKeystoreRegistrationModal}
              >
                <Text className="font-pp-medium text-[14px] text-text">
                  {pending ? 'Close' : quotedPlan ? 'Back' : finishMode ? 'Remind me later' : 'Not now'}
                </Text>
              </Pressable>
              <Pressable
                className={`flex-1 items-center justify-center rounded-control bg-button-primary py-[12px] ${pending || txUnconfirmed ? 'opacity-60' : 'opacity-100'}`}
                onPress={handleRegister}
                disabled={pending || txUnconfirmed}
              >
                <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">
                  {pending ? (publishStep ? 'Publishing…' : finishMode ? 'Finishing…' : 'Registering…') : copy.primary}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeystoreRegistrationModalContext.Provider>
  );
}
