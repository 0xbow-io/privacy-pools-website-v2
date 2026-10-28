import { formatUnits } from 'viem';
// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
import { useBalanceDisplay } from '@/hooks/use-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import { BalanceAmount } from '@/components/pools/balance-amount';
import { HoverHint } from '@/components/ui/hover-hint';
import { compactPhoneLayout } from '@/services/header-nav';
import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { destinationCallsVersion, reshieldDestinationStillValid, subscribeDestinationCalls } from '@/config/destination-calls';
import { statusBridgeFor } from '@/config/across-direct';
import { ENS_UNSUPPORTED_MESSAGE, isPotentialEnsName } from '@/services/ens';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { AlertCircleIcon, CaretDownIcon, CheckCircleIcon, CloseIcon } from '@/components/ui/modal-icons';
import { WEB_NO_OUTLINE } from '@/components/ui/web-style-shims';
import { View, Text, Pressable, Platform, useWindowDimensions, TextInput, Animated, ScrollView, Linking } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Circle } from 'react-native-svg';
import { useAccount } from 'wagmi';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { usePools } from '@/components/pools-provider';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { useRequireConnection } from '@/hooks/use-require-connection';
import { useDebug } from '@/components/debug-provider';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { useOpLock } from '@/hooks/use-op-lock';
import { useQueryClient } from '@tanstack/react-query';
import { ACTIVE_ENVIRONMENT } from '@/config/environments';
import { assertDepositCap, DepositCapError } from '@/services/deposit-cap';
import { lifiScanUrl } from '@/services/lifi-scan';
import { getPrice } from '@/services/price-service';
import { invalidateTransactionCaches } from '@/services/cache';
import { getChainConfig, getExplorerName, getExplorerTxUrl } from '@/config/chains';
import { useToast } from '@/components/toast-provider';
import { describeSwapContextChange } from '@/services/swap-context-change';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { TokenNetworkSelector } from '@/components/ui/token-network-selector';
import { sanitizeAmountInput, parseTokenAmount } from '@/services/token-amount';
import { NoteStatus } from '@/services/sdk-types';
import type { Address, Hex, Note, PoolSession, SwapStatusLike, TxReceiptLike } from '@/services/sdk-types';
import { recordOwnAction } from '@/services/own-actions-store';
import { recordWithdrawFee } from '@/services/withdraw-fees-store';
import { recordCrossChainDelivery, recordCrossChainSwap, recordSameChainSwap } from '@/services/swap-bookkeeping';
import { recordSwap, recordSwapDelivery } from '@/services/swap-records-store';
import {
  intentSwapsEnabledForChain,
  getSwapProcessorAddress,
  getSwapDestinationChains,
  getSwapDeliveryTokens,
  getSwapOutputTokens,
  getSwapInputTokens,
  intentSwapInputSupported,
  reshieldEnabledForChain,
  crossChainReshieldSupported,
  CROSS_CHAIN_DENY_EXCHANGES,
  SWAP_DENY_EXCHANGES,
  NATIVE_ASSET_ADDRESS,
  swapInputUnits,
} from '@/config/intent-swaps';
import { conversionFundingToken, intentTargetRefusal } from '@/config/intent-targets';
import { getConfiguredYieldDeploymentForAsset } from '@/config/yield';
import { conversionFundingUnits } from '@/services/shield-conversion-units';
import { sdkErrorText } from '@/services/sdk-error-amounts';
import { isRelayerNullifierInFlight, isRelayWaitTimeout, relayInFlightMessage } from '@/services/transfer-outcome';
import { isPendingRelayBlocked } from '@/services/pending-relays-core';
import { assertNoPendingRelay } from '@/services/pending-relays-store';
import { PendingRelayNotice } from '@/components/pending-relay-notice';
import { isRefundSubstatus, recoveredWhere, swapOutcomeTitle, swapResultIndicator } from '@/services/swap-outcome-copy';
import { reshieldConsentFloor } from '@/services/reshield-consent';
import { checkRecipientRegistration } from '@/components/deposit-modal-provider';
import { isCheckableRecipient, LEARN_MORE_UNREGISTERED_LABEL, UNREGISTERED_DEPOSIT_DOCS_URL } from '@/services/recipient-registration-hint';
import { swapSendUnregisteredNotice } from '@/services/recipient-registration-hint';
import { swapDepositRecipient } from '@/services/swap-deposit-recipient';
import { webRandomFill, type BackupCryptoLike, type BackupNoteComputationLike } from '@/services/blind-deposit-backup';
import { sealSwapSendClaim, type SwapSendClaim } from '@/services/swap-send-claim';
import { rekeyStoredClaim, storeSealedClaim } from '@/services/swap-send-claim-store';
import { buildSentReceiptUrl, previewNoteReceiptUrl } from '@/services/note-receipt';
import { useTabCloseGuard } from '@/hooks/use-tab-close-guard';
import { LinkLeaveConfirm } from '@/components/ui/link-leave-confirm';
import { CLAIM_LINK_INSTRUCTION, CLAIM_LINK_LEAVE, needsLeaveConfirm } from '@/services/link-leave-guard';
import { paintFrame } from '@/services/paint-frame';
import { isCustomSlippage, parseCustomSlippage, slippageLabel } from '@/services/custom-slippage';
import { isLegacyPlainToken } from '@/config/pool-paths';
import { getKnownTokenMetadata, getTokenMetadata } from '@/config/tokens';
import { visibleSwapSources } from '@/services/pool-slug';
import { displayTokenSymbol} from '@/services/share-display';
import { handoffRefused, resolveHandoffToken } from '@/services/swap-token-handoff';
import { friendlySwapError, relaySwapRefusalText } from '@/services/swap-error-copy';
import { sameSymbol } from '@/services/symbol-match';
import type { SwapTokenInfo } from '@/config/intent-swaps';
import { assertRelayerSwapProcessor } from '@/services/relayer-details';
import { registerSwapHandoff } from '@/services/swap-handoff';
import { noteShortfall, noteShortfallMessage } from '@/services/swap-note-shortfall';
import { OpShell } from '@/components/op-shell';
import { FlowProgress } from '@/components/ui/flow-progress';
import { useInlineOpsCapable } from '@/hooks/use-inline-ops-capable';
import {
  BRIDGE_POLL_MAX_MS,
  bridgePollIntervalFor,
  bridgeDeliveryOutcome,
  bridgeResyncDue,
  describeSwapStatus,
  estimateReshieldForReview,
  shapeReshieldForDisplay,
  runReshieldCrosschain,
  crossChainSendOutputSupported,
  requireTransferCrosschainSession,
  RESHIELD_DESTINATION_CHAIN_TYPE,
  type ReshieldCrosschainSessionLike,
  type DestinationDepositSessionLike,
  isTerminalSwapStatus,
  ReshieldPreflightError,
  ReshieldRateMovedError,
  ReshieldRevertedError,
  runReshield,
  type ReshieldDisplay,
  type ReshieldEstimateLike,
  type ReshieldSessionLike,
  assertReshieldNoteWorthIt,
} from '@/services/swap-flows';
import {
  buildRelayWithdrawAndSwapParams,
  buildSwapQuoteRequestKey,
  createSwapRequestGuard,
  formatTokenUnits,
  getPreparedQuoteExpiration,
  hasUsableCommitmentLifetime,
  isFreshCommitmentLive,
  InvalidSwapQuoteError,
  validateRefreshedSwapQuote,
  isNoRouteError,
  isSwapUnavailableError,
  isZeroAddress,
  prepareValidatedSwapQuote,
  resolveSwapDelivery,
  selectSwapInputNotes,
  type PreparedSwapQuoteLike,
  type SwapQuoteDisplay,
} from '@/services/intent-swaps';
import { useNativeMockBlock } from '@/hooks/use-native-mock-block';
import { useFeePricing } from '@/hooks/use-fee-pricing';
import { FeeWarning } from '@/components/fee-warning';
import { buildFeeBreakdown, gasCostUsd, quoteGas, splitRelayerFee, swapLossUsd, tokenUsd, type FeeGasReading } from '@/services/fee-warning';

// Intent swap (withdraw-and-swap): a private note leaves the pool, swaps
// through a LiFi route that is sealed inside the ZK proof, and the output
// lands at the recipient — same chain today, cross-chain once
// getSwapDestinationChains advertises more than one destination (the
// destination pane of the shared token/network selector is the chain
// picker). Gated by EXPO_PUBLIC_INTENT_SWAPS AND a configured RelaySwaps
// processor (config/intent-swaps.ts, fail closed) and hidden on Sui.
//
// Every number comes from the real SDK (session.prepareSwapQuote /
// relayWithdrawAndSwap), and every prepared quote is re-validated app-side
// (gross binding, zero addresses, mode minimums) before Review and again in
// the relay builder. Where the backend is missing — the deployed relayer
// has no /swap route yet — the flow fails closed with an explicit "swaps
// aren't available yet" state.

// Input side: the pool's own assets (the note being spent), for the ACTIVE
// chain. This used to be a hardcoded Sepolia list, which meant enabling another
// chain's processor would offer Sepolia's USDC/USDT addresses — junk contracts
// on any other chain. Derived per-chain instead, from the same registry the
// output list uses.
/** The refusal for an asset that holds notes but has no swap route on this chain. */
function swapUnavailableForToken(symbol: string): string {
  return `Swapping ${displayTokenSymbol(symbol)} is not available on this network. Withdraw or send it instead.`;
}

/**
 * What the given mode may receive on `destination` when the note is spent on
 * `source`. A reshield lands in a pool, so a same-chain yield share is a valid
 * target; a wallet swap is a LiFi payout to an address, which never is.
 */
function outputTokensFor(mode: SwapMode, source: number, destination: number): SwapTokenInfo[] {
  return mode === 'reshield'
    ? getSwapOutputTokens(destination, source)
    : getSwapDeliveryTokens(destination);
}

function inputTokensForChain(chainId: number): SwapTokenInfo[] {
  const tokens = getSwapInputTokens(chainId);
  if (tokens.length > 0) return tokens;
  // Native-only fallback so the form still renders coherently on a chain with
  // no configured assets; the availability gate keeps swaps dark there anyway.
  return [{ symbol: 'ETH', address: NATIVE_ASSET_ADDRESS, decimals: 18, isNative: true, name: 'Ether' }];
}

const SLIPPAGE_OPTIONS = [0.005, 0.01, 0.03];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// --- Icons ---




// --- Context ---

/**
 * `recipient` + `outputTokenAddress` exist so another flow can hand a swap off
 * fully specified — the Send widget's "Receive as" uses them to pay a third
 * party in a different token. Without them the modal defaults to your own
 * wallet and the first available output token, as before.
 */
export type OpenSwapModalOptions = {
  /**
   * The asset to spend, by ADDRESS. Prefer this: a symbol no longer identifies
   * a pool, because `displayTokenSymbol` renders ppETH as "ETH" and the legacy
   * plain ETH pool is also "ETH". `tokenSymbol` remains for callers that have
   * only a name. services/swap-token-handoff.ts resolves the pair.
   */
  tokenAddress?: string;
  tokenSymbol?: string;
  initialAmount?: string;
  recipient?: string;
  outputTokenAddress?: string;
  /**
   * Deliver on another chain (a cross-chain send handed over from the Send tab,
   * which has no cross-chain route of its own — this flow IS its route).
   * Validated against the offered destinations, so an unroutable pair falls back
   * to the pool chain rather than opening a quote that cannot be served.
   */
  destinationChainId?: number;
  /**
   * Draw inside the hub's inline host instead of as an overlay (desktop web
   * only; the hub decides). The hub card owns amount / tokens / destination /
   * recipient and pushes edits through `syncInlineForm`; this flow keeps the
   * mode, slippage, review and execution.
   */
  inline?: boolean;
  /**
   * Pin the mode. The hub's Swap tab is private-only (a swap that pays a
   * wallet is a withdrawal received as another asset: the Withdraw tab), so it
   * opens with 'reshield' and the To my wallet / Keep it private toggle is not
   * offered. Omit to keep the modal's own toggle (non-hub surfaces).
   *
   * A pinned reshield with a `recipient` is a PRIVATE swap-send: the output is
   * a shielded note FOR that registered account (reshield-and-transfer,
   * v2-monorepo #439), same chain only. Without one the note is the caller's.
   * Paying a third party in a public wallet is `mode: 'wallet'` with a
   * `recipient`.
   */
  mode?: 'wallet' | 'reshield';
};

/** One hub-card edit, pushed into the inline flow. Every field optional. */
export type InlineSwapFormPatch = {
  amount?: string;
  /** By address, for the reason on `OpenSwapModalOptions.tokenAddress`. */
  tokenAddress?: string;
  tokenSymbol?: string;
  /** null clears the output (nothing routable); undefined leaves it alone. */
  outputTokenAddress?: string | null;
  destinationChainId?: number;
  /** '' means "my own wallet". */
  recipient?: string;
  recipientOpen?: boolean;
};

/** DEV-511 copy. A registered recipient finds the note; an unregistered one needs the link. */
export const SWAP_SEND_NO_CLAIM = 'No claim link needed. They\u2019ll find it automatically.';
export const SWAP_SEND_CLAIM_WHY = 'They have no account to find it with, so the link is how they claim it.';

type SwapModalContextType = {
  /** True when the flow opened or deferred; false when it refused the request. */
  openSwapModal: (options?: OpenSwapModalOptions) => boolean;
  closeSwapModal: () => void;
  isOpen: boolean;
  /** True while the flow draws inside the hub's inline host (no overlay). */
  inlineActive: boolean;
  inlineStep: 'input' | 'review' | 'executing' | 'success';
  /** 'wallet' (payout) or 'reshield' (stays in the pool) — the hub hides its recipient row for a reshield. */
  inlineMode: 'wallet' | 'reshield';
  /**
   * True while the flow is the Send tab's private swap-send (opened inline with a
   * recipient). The hub keeps it on the Send tab instead of the Swap tab.
   */
  inlineSend: boolean;
  /** Registration of a recipient the hub's Swap tab pushed, for its row's hint (DEV-510). */
  inlineRecipientRegistration: 'idle' | 'checking' | 'registered' | 'unregistered' | 'unknown';
  syncInlineForm: (patch: InlineSwapFormPatch) => void;
};

const SwapModalContext = createContext<SwapModalContextType>({
  // Default refuses: an unmounted provider has taken responsibility for nothing.
  openSwapModal: () => false,
  closeSwapModal: () => {},
  isOpen: false,
  inlineActive: false,
  inlineStep: 'input',
  inlineMode: 'wallet',
  inlineSend: false,
  inlineRecipientRegistration: 'idle',
  syncInlineForm: () => {},
});

export function useSwapModal() {
  return useContext(SwapModalContext);
}

// --- Provider ---

type Step = 'input' | 'review' | 'executing' | 'success';

/**
 * Everything Review displayed and Confirm may use — captured atomically when
 * the validated quote arrives. Confirm NEVER reads live form state, so an
 * edit racing an in-flight quote can't change what gets relayed (the quote
 * request guard additionally discards stale responses).
 */
type QuoteSnapshot = {
  // The note-owning identity the quote priced (sessionAddress ?? address).
  identity: string;
  prepared: PreparedSwapQuoteLike;
  display: SwapQuoteDisplay;
  grossWei: bigint;
  amountText: string;
  fromToken: SwapTokenInfo;
  outputToken: SwapTokenInfo;
  recipient: Address;
  fallbackAddress?: Address;
  destinationChainId: number;
  destinationName: string;
  slippage: number;
  crossChain: boolean;
};

/**
 * `recovered` is its own state, not a flavour of `done`. LI.FI reports DONE for
 * a route whose destination call never ran and whose funds were handed to the
 * fallback address instead, so collapsing the two told a user their note had
 * landed while the money sat in their wallet on the other chain (QA,
 * 2026-09-23). `detail` is the destination transaction when there is one.
 */
type DeliveryState = {
  status: 'pending' | 'done' | 'recovered' | 'failed';
  detail?: string;
  refunded?: boolean;
  /** The provider that carried the route, for the status lookup (config/across-direct.ts). Unset for LiFi. */
  bridge?: string;
} | null;

/**
 * Where the swapped output lands.
 *
 *   'wallet'   — flow 2, withdraw-and-swap: the note exits the pool and the
 *                output is paid to an address. Already shipped.
 *   'reshield' — flow 3: the output is re-deposited as a new shielded note of
 *                a different asset on the SAME chain. Funds never touch a
 *                wallet, so there is no recipient.
 *              — flow 4 is the same mode with a DESTINATION chain picked: the
 *                note is withdrawn here, bridged and swapped through LiFi, and
 *                re-deposited into that chain's pool. Still no recipient, but it
 *                does need a fallback address the user controls over there,
 *                because the destination leg has no protocol-owned verifier.
 *                Gated per pair by crossChainReshieldSupported.
 */
type SwapMode = 'wallet' | 'reshield';

/** Status-lookup routing for a delivery whose route went to `swapTarget` (empty for LiFi). */
function withBridge(swapTarget: string | undefined | null): { bridge?: string } {
  const bridge = statusBridgeFor(swapTarget);
  return bridge ? { bridge } : {};
}

/**
 * Reshield's Review snapshot. Separate from QuoteSnapshot on purpose: a
 * reshield Review holds an ESTIMATE, not a signed fee commitment, because the
 * real quote can only be fetched after the deposit proof exists (guide §10
 * ordering). So there is nothing here to expire, and nothing that could be
 * mistaken for a prepared withdraw-and-swap quote.
 */
type ReshieldSnapshot = {
  // The note-owning identity the estimate priced (sessionAddress ?? address).
  identity: string;
  estimate: ReshieldEstimateLike;
  display: ReshieldDisplay;
  grossWei: bigint;
  amountText: string;
  fromToken: SwapTokenInfo;
  outputToken: SwapTokenInfo;
  slippage: number;
  /**
   * Where the new note lands. Equals the pool chain for the ordinary same-chain
   * reshield; a different chain is flow 4, which is a different SDK call and a
   * different set of risks, so Confirm reads this rather than live state.
   */
  destinationChainId: number;
  /**
   * Flow 4 only: where the destination pays out if its deposit cannot execute.
   * The destination leg has no protocol-owned verifier, so this is the user's
   * only recourse — an address they control on that chain, never a default.
   */
  fallbackAddress?: Address;
  /**
   * Swap-send: the registered account the new note is FOR (same chain only).
   * Absent for a reshield of your own, which is the ordinary case. Confirm reads
   * this, never the live form, so an edit after Review cannot redirect the note.
   */
  recipient?: Address;
  /**
   * DEV-511: the recipient had no viewing key at Review and the sender opted
   * into a claim link. Confirm then runs the blind form and stores the claim
   * before the relay.
   */
  recipientBlind?: boolean;
};

/**
 * Launch deposit cap on a reshield: the swap OUTPUT becomes a fresh pool note,
 * so it is a deposit the ASP will refuse above the cap. Surfaced as a preflight
 * error (nothing signed or spent), same channel as the too-small-note refusal.
 */
async function assertReshieldCap(noteValueWei: bigint, token: { symbol: string; decimals: number }): Promise<void> {
  try {
    await assertDepositCap({
      amountWei: noteValueWei,
      decimals: token.decimals,
      symbol: token.symbol,
      capUsd: ACTIVE_ENVIRONMENT.maxDepositUsd,
      fetchPrice: getPrice,
    });
  } catch (err) {
    if (err instanceof DepositCapError) throw new ReshieldPreflightError(err.message);
    throw err;
  }
}

export function SwapModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  // Phone web: the privacy note folds into a hint so the CTA stays above the fold.
  const tight = Platform.OS === 'web' && compactPhoneLayout(width);
  const isMobile = width <= 540;
  const isSheet = isMobile;
  const { log } = useDebug();
  const { data: poolsData, isLoading: poolsLoading } = usePools();
  // The chain this flow ACTS ON — the app's selection, like every other
  // action modal (deposit/withdraw/transfer/ragequit). This was useChainId(),
  // the wagmi config-store chain: on the multi-chain staging build it
  // initializes to the first configured chain and follows the WALLET, so the
  // swap modal gated (reshieldEnabledForChain), listed tokens, built its ASP
  // client and quoted fromChainId on a chain the rest of the app wasn't
  // showing whenever the selection and the wallet split.
  const chainId = useActiveEvmChain().id;
  const balanceDisplay = useBalanceDisplay(chainId);
  // The SESSION's chain (connector-first). Quotes select notes from the live
  // session, so a quote/review/confirm may only run while the session and the
  // app agree — see the context guards below and the invalidation effect.
  const sessionChainId = useSessionChainId();
  const withOpLock = useOpLock();
  const queryClient = useQueryClient();
  const chainRouter = useChainRouter();
  // Non-EVM chain (Sui or Stellar): the EVM-only surfaces below stay off.
  const isSui = chainRouter.isSui || chainRouter.isStellar;
  const { address } = useAccount();
  const {
    ensureInitialized, noteManager, refreshNotes, keysReady, identityMode, sessionAddress,
    createReshieldCrosschainSessions,
    sessionForChain,
    keystoreManager,
  } = usePoolSession();
  // The identity whose NOTES fund the swap: the SDK session owner (wallet or
  // imported account key), not the raw wagmi address — a same-chain account-key
  // A→B change flips sessionAddress while `address` stays untouched (codex).
  const noteIdentity = (sessionAddress ?? address ?? 'no-session').toLowerCase();
  const { toast } = useToast();
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const { openKeystoreRegistrationModal } = useKeystoreRegistrationModal();
  // Relayed flow: an account-key session can swap without a wallet
  // connection, exactly like relayed withdraw/transfer.
  const ensureConnected = useRequireConnection({ allowAccountKey: true });
  const keysReadyRef = useRef(keysReady);
  keysReadyRef.current = keysReady;

  const [step, setStep] = useState<Step>('input');
  // Mirror for effects that must read the CURRENT step without re-running on
  // every step change (the context-invalidation effect below).
  const stepRef = useRef<Step>('input');
  stepRef.current = step;
  // Operation epoch (codex P1-5): bumped whenever the modal context is torn
  // down (resetState covers open + context invalidation; close bumps too), so
  // an execution that outlived its session aborts pre-relay.
  const opEpochRef = useRef(0);
  // TRUE only once the current run has actually handed its payload to the
  // relayer (codex: 'executing' also covers pre-submit proving, which must be
  // invalidatable — only a SUBMITTED operation is immutable).
  const submittedRef = useRef(false);
  // 'reshield' is the only value this surface ever holds. Kept as state rather
  // than a constant so the existing isReshield branches read unchanged, and so
  // a future second PRIVATE mode has somewhere to go. It is never 'wallet':
  // see openSwapModal for the rule.
  const [mode, setMode] = useState<SwapMode>('reshield');
  // Modal-less presentation: when the hub opened this flow (options.inline) on
  // a surface that can host it. Mobile keeps the sheet for the terminal
  // states, same as withdraw: the form lives inline, progress/success do not.
  const inlineCapable = useInlineOpsCapable();
  const [inlinePreferred, setInlinePreferred] = useState(false);
  const inlineBase = inlinePreferred && inlineCapable;
  const inlineHubActive = inlineBase && !(isMobile && (step === 'executing' || step === 'success'));
  // The Send tab's private swap-send, run inline (Mike, #219 QA). The hub card
  // above is the Send card, so this form shows the recipient itself.
  const [inlineSendPreferred, setInlineSendPreferred] = useState(false);
  const inlineSend = inlineBase && inlineSendPreferred;
  const [reshieldSnapshot, setReshieldSnapshot] = useState<ReshieldSnapshot | null>(null);
  // Review disclosures. Collapsed by default so the default screen carries
  // only what the decision needs: what you pay, the relayer fee, and the note
  // you end up holding. Everything else is one tap away.
  const [reshieldDetailsOpen, setReshieldDetailsOpen] = useState(false);
  const [reshieldHintOpen, setReshieldHintOpen] = useState(false);
  // Set when the reshield confirmed on-chain but the new note could not be
  // stored locally. The funds are safe; the balance just needs a sync.
  const [reshieldSyncWarning, setReshieldSyncWarning] = useState(false);
  // Per-chain input assets (see inputTokensForChain): recomputed when the chain
  // changes so a chain switch can never leave another chain's token selected.
  const candidateInputTokens = useMemo(() => inputTokensForChain(chainId), [chainId]);
  // A legacy pool the user has emptied is a dead chip here: its deposits are
  // closed and there is nothing left to spend, so it is dropped exactly as the
  // balances list drops its row (services/pool-slug.ts, the shared rule). Held
  // until balances have loaded, because a zero read mid-load would blank the
  // picker, and never down to nothing: if every candidate is an emptied legacy
  // pool the form still renders and the availability gate is what speaks.
  const inputTokens = useMemo(() => {
    if (poolsLoading) return candidateInputTokens;
    const visible = visibleSwapSources(candidateInputTokens, (token) => {
      const address = token.address.toLowerCase();
      const pool = poolsData.myPools.find(
        (p) => p.chainId === chainId && p.tokenAddress.toLowerCase() === address,
      );
      const raw = (exact: string | undefined) => {
        if (!exact) return 0n;
        try { return parseTokenAmount(exact, token.decimals); } catch { return 0n; }
      };
      return {
        balanceRaw: raw(pool?.balanceTokenExact),
        pendingRaw: raw(pool?.pendingTokenExact),
        legacy: isLegacyPlainToken(getTokenMetadata(token.address, chainId), chainId),
      };
    });
    return visible.length > 0 ? visible : candidateInputTokens;
  }, [candidateInputTokens, chainId, poolsData.myPools, poolsLoading]);
  const [fromTokenChoice, setFromToken] = useState<SwapTokenInfo>(() => inputTokensForChain(chainId)[0]);
  // A default the picker itself would hide is its own bug: the form opens on
  // the first candidate before balances are known, so the source in force is
  // the choice when the list still offers it and the first row it does
  // otherwise. Derived, not snapped in an effect, so no render shows a source
  // that is not on the list.
  const fromToken = inputTokens.some((t) => t.address.toLowerCase() === fromTokenChoice.address.toLowerCase())
    ? fromTokenChoice
    : (inputTokens[0] ?? fromTokenChoice);
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  // The recipient is YOUR wallet by default and the field stays hidden — a
  // swap-to-self is the overwhelmingly common case, and an always-visible
  // address box invited pasting one in when none was needed. The wallet icon
  // reveals it for the "send the output somewhere else" case.
  const [recipientOpen, setRecipientOpen] = useState(false);
  // Opened from the Send tab as a private swap-send (reshield + a recipient).
  // On a cross-chain reshield the address field is the FALLBACK; only a send
  // handoff turns it into the recipient, so typing in the plain Swap form can
  // never quietly give the note to someone else.
  const [sendHandoff, setSendHandoff] = useState(false);
  // The hub's Swap tab drives the recipient through syncInlineForm (DEV-510).
  // Tracked apart so closing the hub's row resets only what the row set, never
  // a fallback address typed in the flow.
  const hubRecipientRef = useRef(false);
  const [destinationChainId, setDestinationChainId] = useState<number>(chainId);
  // Output token keyed by (destinationChainId, address): the same address
  // (e.g. the native sentinel) can exist on several chains with different
  // symbol/decimals, so destination metadata must always win.
  const [outputToken, setOutputToken] = useState<{ token: SwapTokenInfo; chainId: number } | null>(null);
  const [slippage, setSlippage] = useState(SLIPPAGE_OPTIONS[0]);
  // The Custom chip's editor. `customSlippageDraft` is what is typed, kept as a
  // string so a half-typed "12." is not parsed into something surprising.
  const [customSlippageDraft, setCustomSlippageDraft] = useState('');
  // Phone web: the slippage chips sit behind a disclosure showing the current value.
  const [slippageOpen, setSlippageOpen] = useState(false);
  const [customSlippageError, setCustomSlippageError] = useState<string | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<QuoteSnapshot | null>(null);
  const feePricing = useFeePricing(chainId);
  // Withdraw-and-swap: the relayer fee split into the gas it re-bills and its
  // margin, plus what the swap loses between the netted input and the output.
  const walletFeeBreakdown = useMemo(() => {
    if (!snapshot) return null;
    const { prepared, fromToken, outputToken, destinationChainId } = snapshot;
    const inUsd = feePricing.tokenUsdOf(chainId, fromToken.address, fromToken.symbol);
    const relayerFeeUsd = tokenUsd(BigInt(prepared.feeAmount || '0'), fromToken.decimals, inUsd);
    if (relayerFeeUsd === null) return null;
    const gas = quoteGas((prepared.selectedQuote as { quote?: unknown } | null)?.quote);
    const { networkUsd, serviceUsd } = splitRelayerFee(relayerFeeUsd, gas ? gasCostUsd(gas.gasUnits, gas.gasPriceWei, feePricing.nativeUsdOf(chainId)) : null);
    const readings: FeeGasReading[] = [{ chainId, gasPriceWei: gas?.gasPriceWei ?? feePricing.gasPriceOf(chainId) }];
    if (destinationChainId !== chainId) readings.push({ chainId: destinationChainId, gasPriceWei: feePricing.gasPriceOf(destinationChainId) });
    return buildFeeBreakdown({
      amountUsd: tokenUsd(snapshot.grossWei, fromToken.decimals, inUsd),
      networkUsd,
      serviceUsd,
      swapUsd: swapLossUsd(
        { amount: BigInt(prepared.netAmount), decimals: fromToken.decimals, usd: inUsd },
        { amount: BigInt(prepared.estimatedOutput || '0'), decimals: outputToken.decimals, usd: feePricing.tokenUsdOf(destinationChainId, outputToken.address, outputToken.symbol) },
      ),
      gas: readings,
    });
  }, [snapshot, chainId, feePricing]);
  // Reshield: the relayer fee is the gas it re-bills; a cross-chain one also
  // spends part of the input on the bridge's native fee, which is destination
  // gas. Everything else the input loses on the way to the new note is swap,
  // bridge and vetting cost.
  const reshieldFeeBreakdown = useMemo(() => {
    if (!reshieldSnapshot) return null;
    const { estimate, fromToken, outputToken, destinationChainId, grossWei } = reshieldSnapshot;
    const inUsd = feePricing.tokenUsdOf(chainId, fromToken.address, fromToken.symbol);
    const outUsd = feePricing.tokenUsdOf(destinationChainId, outputToken.address, outputToken.symbol);
    // Into a share pool the swap buys the underlying (or the coin) and the
    // router mints the share, so the swap's output is in the underlying's units.
    const funding = conversionFundingToken(outputToken.address, destinationChainId);
    const fundingUnits = conversionFundingUnits(getConfiguredYieldDeploymentForAsset(destinationChainId, outputToken.address), outputToken);
    const fundingUsd = funding.toLowerCase() === NATIVE_ASSET_ADDRESS
      ? feePricing.nativeUsdOf(destinationChainId)
      : feePricing.tokenUsdOf(destinationChainId, funding, fundingUnits.symbol);
    const feeWei = BigInt(estimate.feeAmount || '0');
    const amountUsd = tokenUsd(grossWei, fromToken.decimals, inUsd);
    const relayerFeeUsd = tokenUsd(feeWei, fromToken.decimals, inUsd);
    const outputUsd = tokenUsd(BigInt(estimate.estimatedOutput || '0'), fundingUnits.decimals, fundingUsd);
    if (amountUsd === null || relayerFeeUsd === null) return null;
    const crossChain = destinationChainId !== chainId;
    const shareInput = !!getKnownTokenMetadata(fromToken.address, chainId)?.yieldShare;
    const bridgeGasWei = crossChain && !shareInput ? grossWei - feeWei - BigInt(estimate.netSwapAmount || '0') : 0n;
    const bridgeGasUsd = bridgeGasWei > 0n ? tokenUsd(bridgeGasWei, fromToken.decimals, inUsd) ?? 0 : 0;
    const vettingUsd = tokenUsd(BigInt(estimate.vettingFee || '0'), outputToken.decimals, outUsd) ?? 0;
    const readings: FeeGasReading[] = [{ chainId, gasPriceWei: feePricing.gasPriceOf(chainId) }];
    if (crossChain) readings.push({ chainId: destinationChainId, gasPriceWei: feePricing.gasPriceOf(destinationChainId) });
    return buildFeeBreakdown({
      amountUsd,
      networkUsd: relayerFeeUsd + bridgeGasUsd,
      swapUsd: outputUsd === null ? null : Math.max(0, amountUsd - relayerFeeUsd - bridgeGasUsd - outputUsd) + vettingUsd,
      gas: readings,
    });
  }, [reshieldSnapshot, chainId, feePricing]);
  const [isQuoting, setIsQuoting] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  // Chain FROZEN at submission — explorer/polling must not follow a later
  // app-chain switch (codex round 3, P2).
  const [txChainId, setTxChainId] = useState<number | null>(null);
  const [swapUnavailable, setSwapUnavailable] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [executingLabel, setExecutingLabel] = useState('Preparing swap…');
  const [delivery, setDelivery] = useState<DeliveryState>(null);
  // The live "what the bridge is doing now" line, kept OUT of `delivery` on
  // purpose: `delivery` is a dependency of the polling effect, so writing this
  // into it would tear down and rebuild the interval on every substatus change.
  const [deliveryProgress, setDeliveryProgress] = useState<string | null>(null);
  // DEV-511: the claim link of a swap-send to an unregistered recipient. In
  // memory only; the durable copies are the sealed record on this device and
  // the encrypted backup in the deposit itself.
  const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [claimCopied, setClaimCopied] = useState(false);
  useEffect(() => { setClaimCopied(false); }, [claimUrl]);
  const [claimLeavePending, setClaimLeavePending] = useState<{ leave: () => void } | null>(null);
  const copyClaimLink = useCallback(async (): Promise<boolean> => {
    if (!claimUrl) return false;
    const { copyText } = await import('@/services/copy-text');
    const ok = await copyText(claimUrl);
    if (ok) setClaimCopied(true);
    return ok;
  }, [claimUrl]);
  // null = ASP association-set membership not resolved yet → quoting is
  // blocked (fail closed), mirroring the withdrawal flow's spendability gate.
  const [spendableCommitments, setSpendableCommitments] = useState<Set<string> | null>(null);

  // Async-quote race protection: a monotonic generation invalidated on
  // every relevant edit/close/reset; only the newest request commits state.
  const guardRef = useRef(createSwapRequestGuard());
  const invalidateQuoteRequests = useCallback(() => {
    guardRef.current.invalidate();
    setIsQuoting(false);
  }, []);

  // Destination network list — the chains the relayer + LiFi both support
  // (NOT ppv2's supportedChainIds; the receive-on chain is a new concept).
  // Re-derive the list when the relayer's destinationCallsSupported answer lands.
  const destinationCallsRev = useSyncExternalStore(subscribeDestinationCalls, destinationCallsVersion, destinationCallsVersion);
  const destinationChains = useMemo(
    // A reshield lands in a pool, so a chain the bridge cannot call into
    // (crossChainReshieldSupported, destinationCallsSupported) is not offered.
    () => getSwapDestinationChains(chainId)
      .filter((id) => mode !== 'reshield' || id === chainId || crossChainReshieldSupported(chainId, id))
      .map((id) => ({
        id,
        name: getChainConfig(id)?.displayName ?? `Chain ${id}`,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chainId, mode, destinationCallsRev],
  );

  // Output tokens for the selected destination, per MODE: a reshield lands in
  // a pool (a yield share is a valid target there, on its own chain), while a
  // wallet swap has LiFi pay the token out to an address, which no share can
  // be. The source chain is passed so a cross-chain destination drops the
  // shares the arriving flow cannot deposit into.
  // A same-token, same-chain "swap" is just a withdrawal — filter it out.
  const outputTokens = useMemo(
    () => outputTokensFor(mode, chainId, destinationChainId).filter(
      (t) => !(destinationChainId === chainId && t.address.toLowerCase() === fromToken.address.toLowerCase()),
    ),
    [destinationChainId, chainId, fromToken, mode],
  );

  // Keep the output selection valid when the input token or destination
  // flips, and re-default after resetState() nulls it on open. Keyed by
  // (chainId, address) so a destination change never retains stale metadata.
  useEffect(() => {
    if (
      outputToken
      && outputToken.chainId === destinationChainId
      && outputTokens.some((t) => t.address.toLowerCase() === outputToken.token.address.toLowerCase())
    ) return;
    setOutputToken(outputTokens[0] ? { token: outputTokens[0], chainId: destinationChainId } : null);
  }, [outputTokens, outputToken, destinationChainId]);

  // Exact-balance gate: the display string is rounded to 4 decimals, so
  // validation must use the raw base-unit value (balanceTokenExact).
  const balanceWei = useMemo(() => {
    // Chain-matched: the over-balance gate must weigh the notes this swap can
    // actually spend, not a same-symbol holding on another chain.
    const pool = poolsData.myPools.find((p) => sameSymbol(p.name, fromToken.symbol) && p.chainId === chainId);
    if (!pool?.balanceTokenExact) return 0n;
    try { return parseTokenAmount(pool.balanceTokenExact, fromToken.decimals); } catch { return 0n; }
    // chainId IS read above; without it in the deps one render after an app-
    // chain switch kept the previous chain's balance under the new context.
  }, [poolsData.myPools, fromToken, chainId]);
  /**
   * Units for any SDK error that interpolates raw wei, BOTH sides of it.
   * A relayer fee is taken from what you spend; a deposit minimum and a router
   * quote are sized in what you receive. Each rule says which side it means, so
   * a figure never takes its symbol from a different object than its number.
   * `humanizeSdkAmounts` leaves anything it does not recognise alone.
   */
  const errorUnits = useMemo(
    () => ({
      input: { decimals: fromToken.decimals, symbol: fromToken.symbol },
      // LiFi's leg consumes the redeemed underlying when the note is a share,
      // so its figures are on a different scale from the note's.
      swapInput: swapInputUnits(chainId, fromToken.address, {
        symbol: fromToken.symbol,
        decimals: fromToken.decimals,
      }),
      // The asset the deposit lands in. A minimum or a router quote is sized in
      // ITS units, and naming it after the input gave the right number under
      // the wrong name whenever both were 18 decimals.
      output: outputToken
        ? { decimals: outputToken.token.decimals, symbol: outputToken.token.symbol }
        : null,
      // What the destination's router is FUNDED with. For a share target that
      // is its underlying, and a router quote or budget is in those units, not
      // the share's: formatting them as the share printed a mainnet USDC budget
      // at 18 decimals. For a plain target it is the target itself.
      funding: outputToken
        ? swapInputUnits(destinationChainId, outputToken.token.address, {
          decimals: outputToken.token.decimals,
          symbol: outputToken.token.symbol,
        })
        : null,
    }),
    [fromToken.decimals, fromToken.symbol, fromToken.address, chainId, outputToken, destinationChainId],
  );
  const swapErrorText = useCallback(
    (err: unknown, fallback: string) => {
      const message = err instanceof Error ? err.message : String(err);
      // Broadcast but not in a block yet: pending, not failed (DEV-458).
      if (isRelayWaitTimeout(message)) {
        return 'The relayer accepted this swap, but it has not been included in a block yet. It has not failed and can still land, so these funds are held for it. Your balance and history update on their own once it settles; if it is still pending after 10 minutes, report it from the pending notice.';
      }
      if (isPendingRelayBlocked(message)) return message;
      if (isRelayerNullifierInFlight(message)) return relayInFlightMessage('swap');
      return relaySwapRefusalText(err) ?? sdkErrorText(err, errorUnits, fallback);
    },
    [errorUnits],
  );
  const amountWei = useMemo(() => {
    try { return parseTokenAmount(amount, fromToken.decimals); } catch { return 0n; }
  }, [amount, fromToken]);
  // Pools still loading → dash, not a false zero.

  const overBalance = amountWei > balanceWei;
  const trimmedRecipient = recipient.trim();
  const recipientValid = ADDRESS_RE.test(trimmedRecipient) && !isZeroAddress(trimmedRecipient);
  const isReshield = mode === 'reshield';
  /**
   * A reshield that crosses chains, which is the one private flow with an
   * address in it.
   *
   * The output is a note, so this form asks for no recipient. But the far leg
   * can fail, and LiFi then pays the bridged tokens to `fallbackAddress` ON THE
   * DESTINATION CHAIN rather than depositing them. That address used to be the
   * connected wallet with no say in it, which is how a user who swapped ETH to
   * BNB found the funds in the wallet he was signed in with (Mike, 2026-09-22).
   *
   * So the address becomes a decision. It defaults to the user's own, which is
   * what it was before, and anyone who would rather the failure landed somewhere
   * unlinked can say so.
   */
  const crossChainReshield = isReshield
    && destinationChainId !== chainId
    && crossChainReshieldSupported(chainId, destinationChainId);
  const reshieldAvailable = reshieldEnabledForChain(chainId) && !isSui;
  // A relayer answer can withdraw the destination already picked: drop back to
  // the source chain and its outputs, and refuse Review until that lands.
  const destinationWithdrawn = !reshieldDestinationStillValid(
    isReshield, chainId, destinationChainId, crossChainReshieldSupported(chainId, destinationChainId),
  );
  useEffect(() => {
    if (!destinationWithdrawn) return;
    invalidateQuoteRequests();
    setOutputToken(null);
    setDestinationChainId(chainId);
    // destinationCallsRev re-runs this when the relayer's answer lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationWithdrawn, chainId, destinationCallsRev, invalidateQuoteRequests]);
  const deliveryMode = resolveSwapDelivery({
    poolChainId: chainId,
    toChainId: destinationChainId,
    recipientAddress: (recipientValid ? trimmedRecipient : '0x0000000000000000000000000000000000000001') as Address,
  });
  // A reshield never leaves the pool, so cross-chain delivery and the whole
  // recipient concept do not apply to it.
  const crossChain = !isReshield && deliveryMode.mode === 'cross-chain';
  /**
   * Is the recipient / fallback field on screen? A cross-chain reshield always
   * shows it, on every surface: it is the one address such a swap can expose,
   * and the copy beside it asks the user to choose one. Everything else keeps
   * the collapsed default, which the inline hub does not render.
   */
  // A same-chain reshield whose recipient is someone else is a swap-send: the
  // output is a shielded note FOR them (reshield-and-transfer, v2-monorepo #439).
  // The inline hub's Swap tab draws its own recipient row and pushes it here
  // (DEV-510, grep [swap-deposit-recipient]); the modal surface shows the field.
  const sameChainReshield = isReshield && destinationChainId === chainId;
  const ownAddresses = [address, sessionAddress]
    .filter((a): a is string => !!a)
    .map((a) => a.toLowerCase());
  // The form shows a recipient field on this surface, so what is typed in it is
  // honoured or refused, never ignored: a reshield that quietly paid the user's
  // own account while the field named someone else would be the worst version
  // of this feature.
  // A cross-chain send handoff: the field names the recipient on the
  // destination chain (reshield-and-transfer-crosschain), and the fallback is
  // the connected wallet.
  const crossChainSendField = crossChainReshield && sendHandoff;
  const modalRecipientField = (sameChainReshield && (!inlineHubActive || inlineSend || sendHandoff)) || crossChainSendField;
  // The hub's Swap tab owns the recipient row on screen; this flow still
  // validates, checks registration and routes what it pushed.
  const hubRecipientDriven = inlineHubActive && !inlineSend && sendHandoff;
  const thirdPartyRecipient = modalRecipientField && recipientValid
    && !ownAddresses.includes(trimmedRecipient.toLowerCase());
  // Something typed that is not an address (or is the zero address) is not "my
  // own wallet": hold Review until it is fixed or cleared.
  const recipientTypedButInvalid = modalRecipientField && trimmedRecipient !== '' && !recipientValid;
  // Reshield-and-transfer delivers whatever a reshield can: this form only offers
  // reshield targets (a yield share or a plain pool asset), so a chosen output is
  // always one the private route takes. Still checked, so an empty pick refuses.
  // Across chains the SDK only delivers a configured yield share there.
  const swapSendOutputOk = !!outputToken
    && (!crossChainReshield || crossChainSendOutputSupported(outputToken.token.address, destinationChainId));
  const swapSend = thirdPartyRecipient && swapSendOutputOk;
  // The recipient must be registered where the note lands.
  const swapSendChainId = crossChainReshield ? destinationChainId : chainId;
  // Registration is checked while the address is typed, keyed on the exact
  // text + chain so a stale answer never paints (same shape as the Shield tab).
  const swapSendKey = swapSend && isCheckableRecipient(trimmedRecipient)
    ? `${swapSendChainId}:${trimmedRecipient.toLowerCase()}`
    : null;
  const [swapSendCheck, setSwapSendCheck] = useState<{ key: string; result: 'registered' | 'unregistered' | 'unknown' } | null>(null);
  // A lookup that could not answer ('unknown': an RPC or ASP blip) must not be
  // final, or the only way to retry would be editing the address. Re-ask a few
  // times, spaced out; the attempt count restarts with each new address.
  const [swapSendRetry, setSwapSendRetry] = useState(0);
  const swapSendAttemptsRef = useRef<{ key: string | null; count: number }>({ key: null, count: 0 });
  useEffect(() => {
    // Not while the modal is closed: a canceled recipient must not keep spending
    // RPC / ASP lookups, least of all the retries of an inconclusive one.
    if (!swapSendKey || !isOpen) return;
    if (swapSendAttemptsRef.current.key !== swapSendKey) swapSendAttemptsRef.current = { key: swapSendKey, count: 0 };
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const wanted = swapSendKey.slice(swapSendKey.indexOf(':') + 1) as Address;
    const timer = setTimeout(() => {
      const wantedChain = Number(swapSendKey.slice(0, swapSendKey.indexOf(':')));
      void checkRecipientRegistration(wantedChain, wanted as `0x${string}`).then((result) => {
        if (cancelled) return;
        setSwapSendCheck({ key: swapSendKey, result });
        if (result === 'unknown' && swapSendAttemptsRef.current.count < 4) {
          swapSendAttemptsRef.current.count += 1;
          retryTimer = setTimeout(() => setSwapSendRetry((n) => n + 1), 3000);
        }
      });
    }, swapSendAttemptsRef.current.count === 0 ? 350 : 0);
    return () => { cancelled = true; clearTimeout(timer); if (retryTimer) clearTimeout(retryTimer); };
  }, [swapSendKey, swapSendRetry, isOpen]);
  const swapSendRegistration: 'idle' | 'checking' | 'registered' | 'unregistered' | 'unknown' = !swapSendKey
    ? 'idle'
    : swapSendCheck?.key === swapSendKey ? swapSendCheck.result : 'checking';

  const showRecipientField = !hubRecipientDriven && (((!isReshield || crossChainReshield || (sameChainReshield && !inlineHubActive))
    && (crossChainReshield || !inlineHubActive))
    || (sameChainReshield && inlineSend));
  const customSelected = isCustomSlippage(slippage, SLIPPAGE_OPTIONS);
  const spendabilityResolved = spendableCommitments !== null;
  const canReview =
    !destinationWithdrawn
    && intentSwapInputSupported(chainId, fromToken.address)
    && amountWei > 0n
    && !overBalance
    // A cross-chain reshield needs one too: it is the only address the far
    // side can pay out to, and an invalid one would be discovered at failure.
    && (isReshield ? (!crossChainReshield || recipientValid) : recipientValid)
    // A swap-send needs a registered recipient, or an unregistered one the
    // sender opted to pay with a claim link (DEV-511).
    && (!swapSend || swapSendRegistration === 'registered' || swapSendRegistration === 'unregistered')
    // A third party the private route cannot serve for this output, or text in
    // the field that is not an address, is a refusal here and not a quiet
    // reshield to yourself (see the copy under the field).
    && (!thirdPartyRecipient || swapSendOutputOk)
    && !recipientTypedButInvalid
    && !!outputToken
    && !isQuoting
    && spendabilityResolved;

  // Entrance animation (same sheet/card treatment as the deposit modal).
  const sheetAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isOpen) {
      sheetAnim.setValue(0);
      Animated.timing(sheetAnim, { toValue: 1, duration: 220, useNativeDriver: Platform.OS !== 'web' }).start();
    }
  }, [isOpen, sheetAnim]);

  // ASP spendability resolution (fail closed while unresolved): an ACTIVE
  // note can still be awaiting association-set membership; every input of a
  // swap needs an ASP Merkle proof, so quoting from an unapproved lineage
  // would fail only after witness generation. Mirrors the withdrawal flow.
  useEffect(() => {
    if (!isOpen || isSui) return;
    let cancelled = false;
    setSpendableCommitments(null);
    (async () => {
      try {
        const activeNotes = (noteManager?.getNotes({ status: NoteStatus.ACTIVE }) ?? [])
          .filter((n) => BigInt(n.value) > 0n);
        if (activeNotes.length === 0) {
          if (!cancelled) setSpendableCommitments(new Set());
          return;
        }
        const { createASPClient, createHashService, createMerkleService } = await import('@/services/sdk-runtime');
        const hashService = await createHashService();
        const merkleService = createMerkleService(hashService);
        const aspClient = await createASPClient(chainId, merkleService);
        const next = new Set<string>();
        await Promise.all(activeNotes.map(async (note) => {
          try {
            const labelHash = hashService.hash([note.label]);
            if (!labelHash) return;
            await aspClient.getMerkleProof(labelHash);
            next.add(note.commitment);
          } catch {
            // No ASP proof for the label yet → not spendable.
          }
        }));
        if (!cancelled) setSpendableCommitments(next);
      } catch (err) {
        log('warn', 'Swap', 'Spendability resolution failed. Staying closed', { error: String(err) });
        // Leave null: quoting stays blocked rather than guessing.
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, isSui, chainId, noteManager, log]);

  // Fee-commitment countdown while reviewing (from the snapshot's signed
  // expiration). On expiry the quote is dead — back to input with an honest
  // message instead of relaying a proof the relayer will reject.
  useEffect(() => {
    if (step !== 'review' || !snapshot) return;
    const expiration = getPreparedQuoteExpiration(snapshot.prepared);
    if (!expiration) { setCountdown(null); return; }
    const tick = () => {
      const secondsLeft = Math.floor((expiration - Date.now()) / 1000);
      setCountdown(Math.max(0, secondsLeft));
      if (secondsLeft <= 0) {
        setSnapshot(null);
        setStep('input');
        setSwapError('The relayer quote expired. Review again for a fresh quote.');
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [step, snapshot]);

  // Cross-chain delivery tracking: the source receipt only proves the exit
  // + bridge dispatch. Poll LiFi (session.getSwapStatus) until DONE/FAILED
  // so "success" never overstates what actually happened.
  // The destination chain a still-pending delivery is headed for, whichever flow
  // produced it: flow 1 pays a wallet over there, flow 4 deposits into that
  // chain's pool. Both are one LiFi route off the same source transaction, so
  // both can be tracked the same way.
  const pendingDeliveryChainId = snapshot?.crossChain
    ? snapshot.destinationChainId
    : (reshieldSnapshot && reshieldSnapshot.destinationChainId !== chainId
      ? reshieldSnapshot.destinationChainId
      : null);
  // Stable across re-renders: the poll below must not be torn down and rebuilt
  // every time the provider renders, which restarts its clock and re-fires it
  // immediately. Reading these through refs keeps the effect's deps small
  // enough that its lifetime matches the DELIVERY, not the component.
  const ensureInitializedRef = useRef(ensureInitialized);
  const refreshNotesRef = useRef(refreshNotes);
  // Synced in an effect rather than during render: the poll reads these inside
  // an await, so a one-render lag cannot matter, and writing a ref while
  // rendering is what react-hooks/refs is about.
  useEffect(() => {
    ensureInitializedRef.current = ensureInitialized;
    refreshNotesRef.current = refreshNotes;
  }, [ensureInitialized, refreshNotes]);
  const deliveryStatus = delivery?.status ?? null;
  const deliveryBridge = delivery?.bridge;
  useEffect(() => {
    if (step !== 'success' || pendingDeliveryChainId === null || !txHash || deliveryStatus !== 'pending') return;
    let cancelled = false;
    const startedAt = Date.now();
    let lastResyncMs: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => { if (timer) clearTimeout(timer); timer = null; };
    const poll = async () => {
      const elapsed = Date.now() - startedAt;
      // Bounded by WALL CLOCK, not by a count of attempts: a counter measures
      // how long this loop has lived, which stopped being the same thing once
      // the effect could be rebuilt by an unrelated render.
      if (elapsed >= BRIDGE_POLL_MAX_MS) {
        setDeliveryProgress(
          "Still no bridge update after a while. Check the transaction on the destination chain's explorer.",
        );
        stop();
        return;
      }
      // The bridge can settle while LiFi's index lags, so after a few minutes
      // re-read the notes alongside the status. That is exactly what a manual
      // page refresh was doing by hand for a delivery that had already arrived.
      if (bridgeResyncDue(elapsed, lastResyncMs)) {
        lastResyncMs = elapsed;
        try { await refreshNotesRef.current(); } catch { /* best-effort */ }
        if (cancelled) return;
      }
      try {
        const session = (await ensureInitializedRef.current()) as PoolSession;
        const status: SwapStatusLike = await session.getSwapStatus({
          txHash: txHash as Hex,
          // The SOURCE chain of the submitted tx, not the live selection.
          fromChainId: txChainId ?? chainId,
          toChainId: pendingDeliveryChainId,
          // Ask the provider that carried it; unset keeps the LiFi lookup.
          ...(deliveryBridge ? { bridge: deliveryBridge } : {}),
        });
        if (cancelled) return;
        // isTerminalSwapStatus is the single definition of "stop polling"
        // (services/swap-flows, guide §9) — NOT_FOUND in particular means LiFi
        // hasn't indexed the source tx yet, not a failure.
        if (!isTerminalSwapStatus(status)) {
          setDeliveryProgress(describeSwapStatus(status).text);
          return;
        }
        // The SUBSTATUS decides, not the status. LI.FI says DONE both when the
        // destination call ran and when it did not and the bridged funds went to
        // the fallback address instead. `bridgeDeliveryOutcome` is the single
        // definition of that difference and the cross-chain shield already used
        // it; this poller branched on DONE alone and reported a deposit that
        // never happened as a success (QA, 2026-09-23).
        const outcome = bridgeDeliveryOutcome(status);
        const destinationTx = status.receiving?.txHash;
        // This device's record of the swap learns how it ended, so its row can
        // fold the delivered deposit in or read as recovered (services/swap-records-core.ts).
        try {
          recordCrossChainDelivery({
            sourceChainId: txChainId ?? chainId,
            txHash,
            outcome: outcome === 'deposited' ? 'deposited'
              : outcome === 'recovered' ? (isRefundSubstatus(status.substatus) ? 'refunded' : 'recovered')
                : 'failed',
            destinationTxHash: outcome === 'deposited' ? destinationTx ?? null : null,
          }, { recordOwnAction, recordWithdrawFee, recordSwapDelivery });
        } catch { /* best-effort */ }
        if (outcome === 'deposited') {
          setDelivery({ status: 'done', ...(destinationTx ? { detail: destinationTx } : {}) });
        } else if (outcome === 'recovered') {
          // REFUNDED went back to the SOURCE chain, PARTIAL to the destination (DEV-434).
          setDelivery({ status: 'recovered', refunded: isRefundSubstatus(status.substatus), ...(destinationTx ? { detail: destinationTx } : {}) });
        } else {
          setDelivery({ status: 'failed', ...(status.substatusMessage ? { detail: status.substatusMessage } : {}) });
        }
        // No destination sync here, on purpose. The note was never stored at
        // relay time, and scanning the destination chain the moment THIS
        // delivery lands would tell its RPC, by timing, that this client just
        // received a deposit. The note arrives with the next ordinary sweep
        // (reload, chain switch, sync all); the success copy says so.
      } catch {
        // Transient status failures: keep polling.
      }
    };
    // setTimeout rather than setInterval, so the cadence can widen: 7s while it
    // matters, then 30s, instead of one fixed rate that is either too chatty
    // later or too slow now.
    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => { void poll().finally(schedule); }, bridgePollIntervalFor(Date.now() - startedAt));
    };
    void poll().finally(schedule);
    return () => { cancelled = true; stop(); };
  }, [step, pendingDeliveryChainId, txHash, deliveryStatus, deliveryBridge, chainId, txChainId]);

  const resetState = useCallback((options?: OpenSwapModalOptions) => {
    const chainInputs = inputTokensForChain(chainId);
    const request = { tokenAddress: options?.tokenAddress, tokenSymbol: options?.tokenSymbol };
    const requestedSymbol = options?.tokenSymbol ?? '';
    const initial = resolveHandoffToken(request, chainInputs) ?? chainInputs[0];
    // A handed-off asset with no swap route here (prod plain USDC: withdraw-only,
    // not in the RelaySwaps output list) must NOT be silently swapped for the
    // first available token and quoted as if it were the user's pick (codex,
    // 2026-09-04). The form opens on the fallback but says so.
    //
    // Resolved by address, case-insensitively: the old `symbol.toUpperCase()`
    // compared against the raw symbol, so every mixed-case share ('ppUSDC' ->
    // 'PPUSDC') missed and the form announced "Swapping USDC is not available
    // on this network" for an asset that swaps fine (Mike and Pat, 2026-09-22).
    const requestedUnavailable = handoffRefused(request, chainInputs);
    opEpochRef.current += 1;
    submittedRef.current = false;
    guardRef.current.invalidate();
    setStep('input');
    // THE SWAP SURFACE IS ALWAYS PRIVATE TO PRIVATE. Never a public payout.
    //
    // Product rule, not a default (Pat, 2026-09-22): "swap tab should always be
    // private to private, always always, only withdraw is allowed to swap to
    // public wallet". Withdraw publishes and is named for it. A Swap that could
    // also publish put the two one toggle apart, and a cross-chain swap left the
    // pool and settled in a wallet on BNB Chain (bsc 0x13cb8a50) because this
    // opened on the payout and nobody pressed the toggle.
    //
    // So: no 'wallet' caller, no mode toggle, and no falling back to a payout
    // when the private route cannot serve a pair. The reshield TARGET list
    // (getSwapOutputTokens) is narrower than the payout list, and on mainnet the
    // plain assets are refused as deposit targets. When someone wants one of
    // those, the answer is Withdraw, or a wider target list. It is never a
    // public option here. Paying a third party is likewise Withdraw, because a
    // shielded output cannot be someone else's at all.
    setMode('reshield');
    setReshieldSnapshot(null);
    setFromToken(initial);
    setAmount(options?.initialAmount ? sanitizeAmountInput(options.initialAmount, initial.decimals) : '');
    // A caller-supplied recipient is a third party, so the field opens
    // expanded: an address someone else typed must be visible to be checked,
    // and the collapsed state reads as "goes to my own wallet".
    const handedOffRecipient = options?.recipient?.trim();
    setRecipient(handedOffRecipient || sessionAddress || address || '');
    setRecipientOpen(!!handedOffRecipient);
    setSendHandoff(!!handedOffRecipient && options?.mode === 'reshield');
    hubRecipientRef.current = false;
    // A handed-off destination is honoured only when this build can actually
    // route there; anything else stays on the pool chain, which is the same
    // same-chain flow as before rather than a quote nobody can serve.
    const handedOffDestination = options?.destinationChainId;
    const destination = handedOffDestination !== undefined
      && handedOffDestination !== chainId
      && getSwapDestinationChains(chainId).includes(handedOffDestination)
      // A pinned reshield only crosses for pairs the SDK serves (same gate as
      // the selector and syncInlineForm).
      && (options?.mode !== 'reshield' || crossChainReshieldSupported(chainId, handedOffDestination))
      ? handedOffDestination
      : (getSwapDestinationChains(chainId).find((id) => id === chainId
        || options?.mode !== 'reshield' || crossChainReshieldSupported(chainId, id)) ?? chainId);
    setDestinationChainId(destination);
    // Resolve a handed-off output token against the DESTINATION chain's list —
    // that is where the asset is delivered, and the same symbol is a different
    // address there. An OMITTED output is fine (the keyed-by-chain effect picks
    // the default). A SUPPLIED one that chain cannot serve (or that equals the
    // input on a same-chain route) is not: silently defaulting would open a swap
    // for a different pair than the caller specified, so openSwapModal rejects
    // the request instead (see the caller guard, which reports it rather than
    // closing the originating flow).
    const requestedOutput = options?.outputTokenAddress?.toLowerCase();
    const matchedOutput = requestedOutput
      ? outputTokensFor(options?.mode ?? 'wallet', chainId, destination).find(
        (t) => t.address.toLowerCase() === requestedOutput
          && (destination !== chainId || t.address.toLowerCase() !== initial.address.toLowerCase()),
      )
      : undefined;
    setOutputToken(matchedOutput ? { token: matchedOutput, chainId: destination } : null);
    setSlippage(SLIPPAGE_OPTIONS[0]);
    setCustomSlippageDraft('');
    setSlippageOpen(false);
    setCustomSlippageError(null);
    setSelectorOpen(false);
    setSnapshot(null);
    setIsQuoting(false);
    setSwapError(requestedUnavailable ? swapUnavailableForToken(requestedSymbol) : null);
    setSwapUnavailable(false);
    setCountdown(null);
    setTxHash(null);
    setTxChainId(null);
    setDelivery(null);
    setDeliveryProgress(null);
    setClaimUrl(null);
    // Per-attempt, like every other flag here: left set, one failed local note
    // write would tell the user every LATER reshield hadn't been recorded.
    setReshieldSyncWarning(false);
  }, [address, sessionAddress, chainId]);

  // Context invalidation (codex P1 on 4b2202a): this modal is STATEFUL —
  // fromToken/destinationChainId initialize once, and a review snapshot frozen
  // on chain A must never be confirmed against chain B's session/notes. When
  // the app chain, the session chain, or the account changes while the modal
  // is open, throw the whole state away and rebuild it for the new context
  // (the withdraw modal invalidates on context change the same way; deposit
  // switches-and-stops). resetState() also invalidates the in-flight quote
  // guard, so a stale quote's continuation can no longer commit its snapshot.
  const swapContextRef = useRef({ chainId, sessionChainId, address, noteIdentity });
  // One switch moves the app and the wallet in two renders; announce it once.
  const lastContextToastRef = useRef<{ chainId: number; at: number } | null>(null);
  useEffect(() => {
    const prev = swapContextRef.current;
    swapContextRef.current = { chainId, sessionChainId, address, noteIdentity };
    if (!isOpen) return;
    if (prev.chainId === chainId && prev.sessionChainId === sessionChainId && prev.address === address && prev.noteIdentity === noteIdentity) return;
    // Only PRE-submission state is dangerous to keep: a frozen review snapshot
    // must never confirm against the new chain's session. Once the source tx
    // is SUBMITTED (relayed / success) nothing can be confirmed anymore, and
    // the reset would tear down bridge-delivery tracking of an immutable,
    // already-broadcast transaction. 'executing' before submission is still
    // pre-submit proving — invalidate it like any other stale review (codex).
    if (stepRef.current === 'success' || (stepRef.current === 'executing' && submittedRef.current)) return;
    resetState();
    // A toast, not the red form error: the change is often the user's own (picking
    // a pool on another network moves the app there), so say what moved where.
    const next = { chainId, sessionChainId, noteIdentity };
    const target = prev.chainId !== chainId ? chainId : prev.sessionChainId !== sessionChainId ? sessionChainId : null;
    const last = lastContextToastRef.current;
    const now = Date.now();
    if (target === null || !last || last.chainId !== target || now - last.at > 5_000) {
      toast({
        title: describeSwapContextChange(prev, next, (id) => getChainConfig(id)?.displayName ?? `chain ${id}`),
        // The user's inputs were just discarded: not a success.
        variant: 'warning',
      });
      // An account-only change keeps the record, so the second half of a switch
      // that straddles it is still announced once.
      if (target !== null) lastContextToastRef.current = { chainId: target, at: now };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, sessionChainId, address, noteIdentity, isOpen]);

  /**
   * Returns whether the swap flow TOOK RESPONSIBILITY for the request:
   * `true` for opened-or-deferred (a seed signature is pending, after which it
   * opens), `false` for refused. A handoff caller keys off this — it must not
   * tear its own surface down for a request that was refused.
   */
  // Native mock mode: no real flow starts from the pretend account.
  const blockMockFlow = useNativeMockBlock();
  const openSwapModal = useCallback((options?: OpenSwapModalOptions): boolean => {
    if (blockMockFlow()) return false;
    // Gate: flag AND configured RelaySwaps processor AND EVM. Every entry
    // point is gated too, but the modal itself refuses to open so a stray
    // caller can't surface a flow whose proofs can't bind to anything real.
    if (!intentSwapsEnabledForChain(chainId) || isSui) {
      // Say why (the hub's auto-open retries quietly; a silent false here left
      // a flow-less Swap tab with nothing in the log to explain it).
      log('warn', 'Swap', 'Open refused: swaps are not enabled on this chain', { chainId, isSui, inline: !!options?.inline });
      return false;
    }
    if (options?.tokenSymbol && !getSwapInputTokens(chainId).some(
      (token) => token.symbol.toUpperCase() === options.tokenSymbol!.toUpperCase(),
    )) return false;
    if (options?.mode === 'reshield' && !reshieldEnabledForChain(chainId)) return false;
    if (options?.destinationChainId !== undefined && options.destinationChainId !== chainId
      && (!getSwapDestinationChains(chainId).includes(options.destinationChainId)
        || (options.mode === 'reshield' && !crossChainReshieldSupported(chainId, options.destinationChainId)))) return false;
    // A SUBMITTED execution is immutable — refuse to reset it (close refuses
    // mid-proof the same way); pre-submit runs are safely superseded by the
    // epoch bump inside resetState (codex).
    if (stepRef.current === 'executing' && submittedRef.current) {
      log('warn', 'Swap', 'Open refused: a submitted swap is still executing', { inline: !!options?.inline });
      return false;
    }
    // Inline (hub) opens show the FORM without the connect/unlock gates —
    // the hub gates on the unified connection, and requestReview walks the
    // gates when a session is actually needed (same contract as withdraw).
    if (!options?.inline && !ensureConnected()) return false;
    if (!keysReadyRef.current && !options?.inline) {
      // Resume through the LATEST openSwapModal (ref below), not this
      // render's closure — chain/identity may change while signing, and the
      // fresh callback re-checks every gate. Deferred, not refused.
      openSeedDerivationModal({ onSigned: () => openSwapModalRef.current(options) });
      return true;
    }
    // Fail closed on a SPECIFIED-but-unserviceable output: better to refuse the
    // handoff than to open a swap for a pair the caller did not ask for.
    if (options?.outputTokenAddress) {
      const wanted = options.outputTokenAddress.toLowerCase();
      const inputAddr = (
        inputTokensForChain(chainId).find((t) => sameSymbol(t.symbol, options.tokenSymbol))
        ?? inputTokensForChain(chainId)[0]
      ).address.toLowerCase();
      // Check the output against the chain that will DELIVER it. A cross-chain
      // handoff names an asset on the destination, which this chain's list does
      // not contain, so checking here would refuse every routable cross-chain
      // send. Only a same-chain route has the "different from the input" rule:
      // across chains, the same asset is a legitimate delivery.
      const deliveryChain = options.destinationChainId !== undefined
        && options.destinationChainId !== chainId
        && getSwapDestinationChains(chainId).includes(options.destinationChainId)
        ? options.destinationChainId
        : chainId;
      const serviceable = outputTokensFor(options?.mode ?? 'wallet', chainId, deliveryChain).some(
        (t) => t.address.toLowerCase() === wanted
          && (deliveryChain !== chainId || t.address.toLowerCase() !== inputAddr),
      );
      if (!serviceable) {
        log('warn', 'Swap', 'Refused a handoff for an unserviceable output token', {
          requested: options.outputTokenAddress,
          chainId,
          deliveryChain,
        });
        return false;
      }
    }
    resetState(options);
    setInlinePreferred(!!options?.inline);
    setInlineSendPreferred(!!options?.inline && !!options?.recipient?.trim() && options?.mode === 'reshield');
    setIsOpen(true);
    log('debug', 'Swap', 'Swap modal opened', {
      tokenSymbol: options?.tokenSymbol,
      handedOffRecipient: !!options?.recipient,
    });
    return true;
  }, [blockMockFlow, chainId, isSui, ensureConnected, openSeedDerivationModal, resetState, log]);
  const openSwapModalRef = useRef(openSwapModal);
  openSwapModalRef.current = openSwapModal;

  // Receive fully-specified swaps handed off from flows mounted OUTSIDE this
  // provider (the Send widget's "Receive as"), which therefore cannot use the
  // context. Reads through the ref so the handler is never a stale closure.
  useEffect(() => registerSwapHandoff((request) => openSwapModalRef.current(request)), []);

  // DEV-511: leaving the success card with the claim link uncopied asks first,
  // and closing the tab is guarded until it is copied.
  // A failed or fallback-paid delivery made no note, so its link is void: no guard.
  const claimLinkVoid = delivery?.status === 'recovered' || delivery?.status === 'failed';
  const claimLinkAtRisk = isOpen && step === 'success' && !claimLinkVoid && needsLeaveConfirm({ link: claimUrl, copied: claimCopied });
  const guardClaimLeave = useCallback((leave: () => void) => {
    if (claimLinkAtRisk) setClaimLeavePending({ leave });
    else leave();
  }, [claimLinkAtRisk]);
  useTabCloseGuard(claimLinkAtRisk, `${CLAIM_LINK_LEAVE.title} ${CLAIM_LINK_LEAVE.body}`);

  const closeSwapModal = useCallback(() => {
    if (step === 'executing') return; // a relayed swap can't be abandoned mid-proof
    guardClaimLeave(() => {
      opEpochRef.current += 1;
      invalidateQuoteRequests();
      setIsOpen(false);
    });
  }, [step, invalidateQuoteRequests, guardClaimLeave]);

  /**
   * Inline (hub) form: the card owns amount / input token / output token +
   * destination / recipient and pushes each edit here, so the flow validates
   * and quotes exactly what the card shows. Only the input step listens: a
   * review or a running execution is frozen and must not be edited under.
   */
  const syncInlineForm = useCallback((patch: InlineSwapFormPatch) => {
    if (!inlineBase || stepRef.current !== 'input') return;
    invalidateQuoteRequests();
    let nextFrom = fromToken;
    if (patch.tokenSymbol !== undefined || patch.tokenAddress !== undefined) {
      const wantedSymbol = patch.tokenSymbol ?? '';
      // Same resolution as the open hand-off: address first, case-insensitive.
      // The old uppercase-and-=== match here is why re-picking the token in the
      // form could not clear the refusal either.
      const t = resolveHandoffToken(
        { tokenAddress: patch.tokenAddress, tokenSymbol: patch.tokenSymbol },
        inputTokensForChain(chainId),
      );
      if (t && t.address.toLowerCase() !== fromToken.address.toLowerCase()) {
        nextFrom = t;
        setFromToken(t);
      }
      // Say why the card's pick did not take, instead of quoting the previous
      // token as if it had (a withdraw-only asset has no route here).
      if (!t) {
        setSwapError(swapUnavailableForToken(wantedSymbol));
        setAmount('');
        setOutputToken(null);
        return;
      }
      else setSwapError((prev) => (prev && prev.startsWith('Swapping ') ? null : prev));
    }
    if (patch.amount !== undefined) setAmount(sanitizeAmountInput(patch.amount, nextFrom.decimals));
    let dest = destinationChainId;
    if (patch.destinationChainId !== undefined) {
      const wanted = patch.destinationChainId;
      // Same gate as the selector: routable, and for a reshield a pair the
      // SDK can serve. Anything else stays on the pool chain.
      const routable = wanted === chainId
        || (getSwapDestinationChains(chainId).includes(wanted)
          && (!isReshield || crossChainReshieldSupported(chainId, wanted)));
      if (!routable) {
        setSwapError('Swapping to that network is not available yet.');
        setAmount('');
        setOutputToken(null);
        return;
      }
      dest = wanted;
      if (dest !== destinationChainId) setDestinationChainId(dest);
    }
    if (patch.outputTokenAddress !== undefined) {
      const wanted = patch.outputTokenAddress?.toLowerCase();
      const match = wanted
        ? outputTokensFor(isReshield ? 'reshield' : 'wallet', chainId, dest).find(
          (t) => t.address.toLowerCase() === wanted
            && (dest !== chainId || t.address.toLowerCase() !== nextFrom.address.toLowerCase()),
        )
        : undefined;
      setOutputToken(match ? { token: match, chainId: dest } : null);
    }
    if (patch.recipientOpen !== undefined) {
      // The hub's Swap tab recipient row (DEV-510): an open row names who the
      // shielded output is for, so it is a swap-send. Closing it is the plain
      // reshield again, and only then is the field reset to your own address.
      const typed = patch.recipientOpen ? (patch.recipient ?? '').trim() : '';
      const wasHub = hubRecipientRef.current;
      hubRecipientRef.current = !!typed;
      if (typed) {
        setRecipient(typed);
        setSendHandoff(true);
      } else if (wasHub) {
        setRecipient(sessionAddress || address || '');
        setSendHandoff(false);
      }
      setRecipientOpen(!!typed);
    } else if (patch.recipient !== undefined) {
      setRecipient(patch.recipient.trim() || sessionAddress || address || '');
    }
  }, [inlineBase, invalidateQuoteRequests, fromToken, chainId, destinationChainId, isReshield, sessionAddress, address]);

  // --- Form edit helpers (every edit invalidates in-flight quotes) ---

  const editAmount = useCallback((v: string) => {
    invalidateQuoteRequests();
    setAmount(sanitizeAmountInput(v, fromToken.decimals));
  }, [invalidateQuoteRequests, fromToken.decimals]);

  const editFromToken = useCallback((t: SwapTokenInfo) => {
    invalidateQuoteRequests();
    setFromToken(t);
    // Clamp the amount to the new token's decimals so the parsed value and
    // the displayed string can't diverge after an 18→6 decimals switch.
    setAmount((a) => sanitizeAmountInput(a, t.decimals));
  }, [invalidateQuoteRequests]);

  const editRecipient = useCallback((v: string) => {
    invalidateQuoteRequests();
    setRecipient(v);
  }, [invalidateQuoteRequests]);

  const editSlippage = useCallback((s: number) => {
    invalidateQuoteRequests();
    setSlippage(s);
  }, [invalidateQuoteRequests]);


  // --- Shared quote preflight (both modes) ---
  //
  // Withdraw-and-swap and reshield spend notes identically — same 5-input
  // transact (mixed labels allowed, one proof), same ASP-approval requirement,
  // same on-chain keystore record, same RelaySwaps processor binding. These two helpers hold
  // that gating once so the reshield path cannot drift from the reviewed
  // wallet path.

  /**
   * Pick approved, spendable notes covering `grossWei`, or return the user-
   * facing reason it is not possible. Returns null when the caller must abort
   * silently (a newer request superseded this one).
   */
  const selectApprovedNotes = useCallback((
    requestFromToken: SwapTokenInfo,
    grossWei: bigint,
  ): { notes: Note[] } | { error: string; reason: 'unresolved' | 'uncovered' } => {
    if (!spendableCommitments) {
      return {
        // A distinct reason, because confirm-time callers must NOT report this
        // as "your notes no longer cover the amount" — it is an approval-state
        // race, and misdiagnosing it sends the user looking at their balance.
        reason: 'unresolved',
        error: 'Note approval state is no longer available. Review again.',
      };
    }
    const heldNotes = (noteManager?.getNotes({ status: NoteStatus.ACTIVE }) ?? []).filter(
      (n: Note) =>
        String(n.tokenId).toLowerCase() === requestFromToken.address.toLowerCase()
        && BigInt(n.value) > 0n,
    );
    const activeNotes = heldNotes.filter((n: Note) => spendableCommitments.has(n.commitment));
    const selection = selectSwapInputNotes(activeNotes, grossWei);
    if (!selection.covered) {
      // Which of the three limits it is, rather than one number that could be
      // any of them. The sum is over the SAME note set each figure is about:
      // everything held, what the ASP approved, and what one proof can spend.
      const sum = (notes: Note[]) => notes.reduce((t: bigint, n: Note) => t + BigInt(n.value), 0n);
      return {
        reason: 'uncovered',
        error: noteShortfallMessage(
          noteShortfall({
            totalWei: sum(heldNotes),
            approvedWei: sum(activeNotes),
            selectableWei: selection.total,
          }),
          // Raw symbol: the message names the coin and marks share amounts
          // approximate itself (DEV-408).
          { symbol: requestFromToken.symbol, decimals: requestFromToken.decimals },
        ),
      };
    }
    return { notes: selection.notes };
  }, [spendableCommitments, noteManager]);

  /**
   * Make room for the registration modal without losing the form.
   *
   * The standalone modal hides while registration runs and comes back on
   * success or cancel, with its state intact. The inline hub is different: the
   * Swap tab's watchdog sees a closed flow and reopens it within 600ms, and an
   * open is a reset, so the "If this fails, send to" address the user pasted
   * became the connected wallet again behind the registration prompt (Mike,
   * OP ETH to Base USDC, DEV-516). Inline, the form is a card on the page, not
   * a modal, so it stays open under the registration prompt.
   */
  const hideForRegistration = useCallback(() => {
    if (!inlineBase) setIsOpen(false);
  }, [inlineBase]);

  /**
   * Session + active relayer bound to the deployed RelaySwaps processor, after
   * the one-time keystore registration.
   *
   * `'handled'` means this call already put the UI somewhere correct (an error,
   * the unavailable state, or the registration modal with `resume` wired) and
   * the caller must return without touching state.
   */
  const resolveSwapSession = useCallback(async (args: {
    isCurrent: () => boolean;
    resume: () => void;
  }): Promise<{ session: PoolSession; relayer: unknown } | 'handled'> => {
    const session = (await ensureInitialized()) as PoolSession;
    if (!args.isCurrent()) return 'handled';

    // Keystore-registration gate BEFORE fetching a short-lived quote —
    // registering after would guarantee a stale commitment.
    const registered = await session.isKeystoreRegistered();
    if (!args.isCurrent()) return 'handled';
    if (!registered) {
      if (!args.isCurrent()) return 'handled';
      if (identityMode === 'key') {
        setSwapError(
          'This account is not registered on-chain yet. Registration is a wallet transaction. Connect the owner wallet once to register, then retry from the account key.',
        );
        return 'handled';
      }
      hideForRegistration();
      openKeystoreRegistrationModal({
        title: 'Register before you swap',
        body:
          "Swapping privately needs a one-time on-chain record for your wallet. After this transaction confirms we'll fetch a fresh quote and continue with your swap.",
        primaryLabel: 'Register and continue',
        onSuccess: () => {
          setIsOpen(true);
          args.resume();
        },
        // "Not now" restores the swap modal instead of stranding it hidden.
        onCancel: () => {
          setIsOpen(true);
        },
      });
      return 'handled';
    }

    // The FAR chain has its own keystore, and a cross-chain reshield deposits
    // over there. Registered here and not there means the destination deposit
    // cannot land: LiFi pays the bridged tokens to the fallback address and the
    // user gets wallet tokens on a chain they did not choose to hold them on,
    // instead of the private note they asked for. Ask before the quote, for the
    // same reason the source check is here: registering after would strand a
    // short-lived commitment.
    // A swap-send deposits FOR the recipient, whose registration there is
    // checked separately, so the sender needs no account on that chain.
    if (crossChainReshield && !swapSend) {
      const destination = await sessionForChain(destinationChainId);
      if (!args.isCurrent()) return 'handled';
      const destinationName = getChainConfig(destinationChainId)?.displayName ?? `chain ${destinationChainId}`;
      if (!destination) {
        setSwapError(`Could not reach ${destinationName} to check your account there. Try again.`);
        return 'handled';
      }
      const registeredThere = await destination.isKeystoreRegistered();
      if (!args.isCurrent()) return 'handled';
      if (!registeredThere) {
        if (identityMode === 'key') {
          setSwapError(
            `This account is not registered on ${destinationName} yet, and registering is a wallet transaction. Connect the owner wallet once to register there, then retry from the account key.`,
          );
          return 'handled';
        }
        hideForRegistration();
        openKeystoreRegistrationModal({
          // Only the WALLET moves to the far chain for this transaction. The
          // app, and this form, stay where they are, so the swap resumes into
          // the amounts and the pair the user already chose.
          targetChainId: destinationChainId,
          title: `Register on ${destinationName} first`,
          body: `Your account is registered here but not on ${destinationName}, and this swap finishes over there. Register once on ${destinationName} and we'll come straight back to this swap. Your wallet switches networks for that one transaction; nothing here is lost.`,
          primaryLabel: `Register on ${destinationName}`,
          // The swap itself is a wallet transaction, so a relayer-paid
          // registration would spend shielded funds to unblock a flow that
          // still needs gas. Same reason the source gate gives.
          allowGasless: false,
          onSuccess: () => {
            setIsOpen(true);
            args.resume();
          },
          onCancel: () => {
            setIsOpen(true);
          },
        });
        return 'handled';
      }
    }

    // Bind the quote (LiFi fromAddress) and the proof to the deployed
    // RelaySwaps contract — never the transfer-signer default.
    const swapProcessor = getSwapProcessorAddress(chainId);
    if (!swapProcessor) {
      if (!args.isCurrent()) return 'handled';
      setSwapUnavailable(true);
      return 'handled';
    }
    // The relayer publishes the RelaySwaps it relays through; when it moved
    // (2026-09-18) the app kept binding quotes and proofs to the old one and
    // every swap reverted. Ask before the first quote; an unreadable answer
    // is "unknown" and the swap proceeds as before, only a contradiction stops it.
    try {
      await assertRelayerSwapProcessor(chainId, swapProcessor);
    } catch (drift) {
      if (!args.isCurrent()) return 'handled';
      setSwapError(drift instanceof Error ? drift.message : String(drift));
      return 'handled';
    }
    if (!args.isCurrent()) return 'handled';
    const { createRelayerInteractor } = await import('@/services/sdk-runtime');
    if (!args.isCurrent()) return 'handled';
    const relayerInteractor = createRelayerInteractor(chainId, swapProcessor);
    const relayers = await relayerInteractor.getRelayers();
    if (!args.isCurrent()) return 'handled';
    const relayer = relayers.find((r: { status?: string }) => r.status === 'active') ?? relayers[0];
    if (!relayer) throw new Error('No relayer is available for swaps right now.');
    return { session, relayer };
  }, [ensureInitialized, identityMode, openKeystoreRegistrationModal, chainId, crossChainReshield, swapSend, destinationChainId, sessionForChain, hideForRegistration]);

  // --- Quote (input → review) ---

  const getQuote = useCallback(async () => {
    if (!canReview || !outputToken) return;
    // The quote spends the SESSION's notes on the APP's chain — refuse to
    // start while they disagree (transient during a wallet switch; the
    // invalidation effect resets the form when it settles).
    if (sessionChainId !== chainId) {
      setSwapError('Your wallet is on a different network than the app. Switch networks and try again.');
      return;
    }
    // Freeze every request-defining value NOW; state may change during the
    // awaits below and must not leak into this request.
    const grossWei = amountWei;
    const requestIdentity = noteIdentity;
    const requestRecipient = trimmedRecipient as Address;
    const requestFromToken = fromToken;
    const requestOutputToken = outputToken.token;
    // NO conversion-target check here. `intentTargetRefusal` answers "can a
    // conversion END IN A DEPOSIT of this asset", and this path performs no
    // deposit: the note is spent and the swapped asset is transferred to the
    // recipient's address, exactly as a withdrawal received as another token.
    // Applying it here refused a plain payout because the asset's DEPOSITS on
    // that chain route through a yield vault, which says nothing about paying
    // someone in it: picking USDC on Ethereum answered "USDC deposits on this
    // network go through the yield vault" on a form whose recipient was a
    // wallet (QA, 2026-09-22). The reshield path keeps the check, because that
    // one really does end in a deposit (see getReshieldEstimate).
    const requestDestination = destinationChainId;
    const requestSlippage = slippage;
    const requestCrossChain = requestDestination !== chainId;
    const requestKey = buildSwapQuoteRequestKey({
      sessionKey: `${noteIdentity}:${chainId}`,
      poolChainId: chainId,
      inputToken: requestFromToken.address,
      grossWei,
      destinationChainId: requestDestination,
      outputToken: requestOutputToken.address,
      recipient: requestRecipient,
      ...(requestCrossChain ? { fallback: requestRecipient } : {}),
      slippage: requestSlippage,
    });
    const requestToken = guardRef.current.begin(requestKey);
    const isCurrent = () => guardRef.current.isCurrent(requestToken, requestKey);
    setIsQuoting(true);
    setSwapError(null);
    setSwapUnavailable(false);
    try {
      if (grossWei <= 0n) throw new Error('Enter an amount greater than zero.');

      // Spendability pre-check: a transact spends up to 5 inputs of any label,
      // and every input needs ASP approval. Fail before quoting.
      const picked = selectApprovedNotes(requestFromToken, grossWei);
      if ('error' in picked) {
        if (!isCurrent()) return;
        setSwapError(picked.error);
        return;
      }

      const resolved = await resolveSwapSession({
        isCurrent,
        resume: () => { void getQuoteRef.current(); },
      });
      if (resolved === 'handled') return;
      const { session, relayer } = resolved;

      log('info', 'Swap', 'Requesting swap quote', {
        gross: grossWei.toString(),
        tokenId: requestFromToken.address,
        outputToken: requestOutputToken.address,
        toChainId: requestDestination,
        crossChain: requestCrossChain,
        processor: getSwapProcessorAddress(chainId),
      });

      // Shared quote core (services/intent-swaps, also driven by the
      // withdraw modal's "Receive as" path): prepareSwapQuote for the gross,
      // app-side defense-in-depth re-validation (the 71263ca8 SDK asserts
      // the gross binding too), and display shaping. Throws
      // InvalidSwapQuoteError so an invalid commitment never reaches Review.
      const { prepared, display } = await prepareValidatedSwapQuote(session, {
        relayerInfo: relayer,
        poolChainId: chainId,
        grossWei,
        inputToken: { address: requestFromToken.address as Address, decimals: requestFromToken.decimals },
        outputToken: { address: requestOutputToken.address as Address, decimals: requestOutputToken.decimals },
        recipientAddress: requestRecipient,
        slippage: requestSlippage,
        ...(SWAP_DENY_EXCHANGES.length > 0 ? { denyExchanges: SWAP_DENY_EXCHANGES } : {}),
        ...(requestCrossChain ? { toChainId: requestDestination, fallbackAddress: requestRecipient } : {}),
      });

      // Only the newest request (with an unchanged form) may commit state.
      if (!isCurrent()) return;
      setSnapshot({
        identity: requestIdentity,
        prepared,
        display,
        grossWei,
        amountText: formatTokenUnits(grossWei, requestFromToken.decimals),
        fromToken: requestFromToken,
        outputToken: requestOutputToken,
        recipient: requestRecipient,
        ...(requestCrossChain ? { fallbackAddress: requestRecipient } : {}),
        destinationChainId: requestDestination,
        destinationName: getChainConfig(requestDestination)?.displayName ?? `Chain ${requestDestination}`,
        slippage: requestSlippage,
        crossChain: requestCrossChain,
      });
      setStep('review');
      log('info', 'Swap', 'Swap quote prepared', {
        net: prepared.netAmount,
        minOut: prepared.minOutputAmount,
        estOut: prepared.estimatedOutput,
        swapTarget: prepared.swapTarget,
      });
    } catch (err) {
      if (!isCurrent()) return;
      log('error', 'Swap', 'Swap quote failed', { error: String(err) });
      if (err instanceof InvalidSwapQuoteError) {
        // Rejected app-side: the commitment violated an invariant (gross
        // binding / zero address / mode minimums). Nothing was signed.
        setSwapError(swapErrorText(err, 'The swap failed.'));
      } else if (isSwapUnavailableError(err)) {
        // The quote endpoint is missing (404) or broken (5xx) for this chain.
        // Both are "you cannot swap here", and both land before any signature —
        // chain 10's relayer currently 500s on every quote type while chain 1
        // serves them, so this is a live state, not a legacy one.
        setSwapUnavailable(true);
      } else if (isNoRouteError(err)) {
        setSwapError(`No route found for ${displayTokenSymbol(requestFromToken.symbol)} → ${displayTokenSymbol(requestOutputToken.symbol)}. Try a different pair or amount.`);
      } else {
        setSwapError(swapErrorText(err, 'Failed to fetch a swap quote.'));
      }
    } finally {
      if (isCurrent()) setIsQuoting(false);
    }
  }, [canReview, outputToken, amountWei, trimmedRecipient, fromToken, destinationChainId, slippage, chainId, sessionChainId, address, noteIdentity, selectApprovedNotes, resolveSwapSession, log, swapErrorText]);
  const getQuoteRef = useRef(getQuote);
  getQuoteRef.current = getQuote;

  // --- Reshield estimate (input → review), guide flow 3 ---
  //
  // Review shows an ESTIMATE, not a signed commitment: the real quote can only
  // be requested after the redeposit proof exists, and proving takes tens of
  // seconds, so a quote fetched here would be dead before Confirm. That is why
  // there is no countdown on a reshield review — the numbers are explicitly
  // labelled as estimates and re-derived at Confirm.

  // `noticeOnSuccess` exists for the consent gate: its refusal sends the user
  // back to Review, so the message has to arrive on top of numbers that were
  // re-estimated, not the ones the refusal was about.
  const getReshieldEstimate = useCallback(async (noticeOnSuccess?: string) => {
    if (!canReview || !outputToken) return;
    // Same session/app agreement rule as getQuote — reshield both spends and
    // re-deposits within one chain's session.
    if (sessionChainId !== chainId) {
      setSwapError('Your wallet is on a different network than the app. Switch networks and try again.');
      return;
    }
    const grossWei = amountWei;
    const requestIdentity = noteIdentity;
    const requestFromToken = fromToken;
    const requestOutputToken = outputToken.token;
    const targetRefusal = intentTargetRefusal(requestOutputToken.address, destinationChainId, false, destinationChainId !== chainId);
    if (targetRefusal) { setSwapError(targetRefusal); return; }
    const requestSlippage = slippage;
    // Captured with the rest of the request: an estimate priced for one
    // destination must never be committed for another.
    const requestDestination = destinationChainId;
    const requestReshield = true;
    // Swap-send: captured with the rest of the request, like the destination.
    // An estimate priced for one recipient must never be committed for another.
    const requestSendTo = swapSend ? (trimmedRecipient as Address) : undefined;
    let requestBlind = false;
    // 'reshield:' prefix keeps this in a different request namespace from the
    // wallet-mode quote, so the guard can never treat one as the other.
    const requestKey = buildSwapQuoteRequestKey({
      sessionKey: `reshield:${noteIdentity}:${chainId}`,
      poolChainId: chainId,
      inputToken: requestFromToken.address,
      grossWei,
      destinationChainId: requestDestination,
      outputToken: requestOutputToken.address,
      recipient: requestSendTo ? requestSendTo.toLowerCase() : 'self',
      slippage: requestSlippage,
    });
    const requestToken = guardRef.current.begin(requestKey);
    const isCurrent = () => guardRef.current.isCurrent(requestToken, requestKey);
    setIsQuoting(true);
    setSwapError(null);
    setSwapUnavailable(false);
    try {
      // Swap-send only: the recipient must already be able to receive a private
      // note. Asked again here, not trusted from the form's live hint, because
      // that hint is debounced and Review is the point of no return for the
      // number. An unregistered or unreadable answer stops BEFORE any proof or
      // spend: its delivery route (a claim secret the sender must hand over) is
      // not served here, and a failed check must never be read as a yes.
      if (requestSendTo) {
        // Where the note lands: the destination chain for a cross-chain send.
        const registrationChain = requestDestination !== chainId ? requestDestination : chainId;
        const registration = await checkRecipientRegistration(registrationChain, requestSendTo as `0x${string}`);
        if (!isCurrent()) return;
        if (registration === 'unregistered') {
          requestBlind = true;
        } else if (registration !== 'registered') {
          setSwapError('Couldn’t check whether this address can receive a private swap. Try again in a moment.');
          return;
        }
      }
      const picked = selectApprovedNotes(requestFromToken, grossWei);
      if ('error' in picked) {
        if (!isCurrent()) return;
        setSwapError(picked.error);
        return;
      }

      const resolved = await resolveSwapSession({
        isCurrent,
        resume: () => { void getReshieldEstimateRef.current(); },
      });
      if (resolved === 'handled') return;
      const { session, relayer } = resolved;

      log('info', 'Swap', 'Requesting reshield estimate', {
        gross: grossWei.toString(),
        tokenId: requestFromToken.address,
        outputToken: requestOutputToken.address,
        processor: getSwapProcessorAddress(chainId),
      });

      // Flow 4 prices through the destination-attached session and its own SDK
      // call; flow 3 keeps the path it had. The two estimates are structurally
      // identical, so Review renders from the same shaper either way.
      const crossChainRequest = requestReshield
        && requestDestination !== chainId
        && crossChainReshieldSupported(chainId, requestDestination);
      let estimate: ReshieldEstimateLike;
      let display: ReshieldDisplay;
      let fallbackForReview: Address | undefined;
      if (crossChainRequest) {
        // The far leg's only recourse. A key-only session has no address the
        // user controls on the destination chain, so it cannot take this route.
        if (!address) {
          throw new ReshieldPreflightError(
            'Swapping to another network needs a connected wallet: it is the address the destination pays out to if the far side cannot complete.',
          );
        }
        // The address the user chose, defaulting to their own: the form
        // pre-fills the connected wallet, so doing nothing keeps exactly the
        // behaviour this had before the field existed.
        // A swap-send: the field is the recipient, so a failed far leg pays
        // the sender's own wallet instead.
        fallbackForReview = (requestSendTo ? address : (trimmedRecipient || address)) as Address;
        const sessions = await createReshieldCrosschainSessions({ destinationChainId: requestDestination });
        if (!sessions) {
          throw new ReshieldPreflightError('Swapping to that network is not available yet.');
        }
        if (requestSendTo && !crossChainSendOutputSupported(requestOutputToken.address, requestDestination)) {
          throw new ReshieldPreflightError('This asset cannot be sent privately to that network. Pick a pool share, or use Withdraw.');
        }
        const crossSource = sessions.source as unknown as ReshieldCrosschainSessionLike;
        // Same estimate the transfer flow runs at Confirm, so Review matches it.
        const crossEstimateFn = requestSendTo
          ? (() => { const t = requireTransferCrosschainSession(crossSource); return t.estimateReshieldTransferCrosschainAmount.bind(t); })()
          : crossSource.estimateReshieldCrosschainAmount.bind(crossSource);
        const crossEstimate = await crossEstimateFn({
            relayerInfo: relayer,
            amount: `0x${grossWei.toString(16)}` as Hex,
            tokenId: requestFromToken.address as Address,
            outputToken: requestOutputToken.address as Address,
            toChainId: requestDestination,
            toChainType: RESHIELD_DESTINATION_CHAIN_TYPE,
            fallbackAddress: fallbackForReview,
            slippage: requestSlippage,
            // The same route runReshieldCrosschain will take, so Review shows
            // the number Confirm executes.
            denyExchanges: [...CROSS_CHAIN_DENY_EXCHANGES],
          });
        // Refuse a note the far-side gas would reduce to a sliver (Pat's
        // 20 USDC -> mainnet reviewed as "0 ETH" and then failed at relay).
        assertReshieldNoteWorthIt(
          crossEstimate,
          { symbol: requestOutputToken.symbol, decimals: requestOutputToken.decimals },
          getChainConfig(requestDestination)?.displayName ?? `chain ${requestDestination}`,
        );
        estimate = crossEstimate;
        display = shapeReshieldForDisplay(
          crossEstimate,
          grossWei,
          { symbol: requestFromToken.symbol, decimals: requestFromToken.decimals },
          { symbol: requestOutputToken.symbol, decimals: requestOutputToken.decimals },
          swapInputUnits(
            chainId,
            requestFromToken.address,
            { symbol: requestFromToken.symbol, decimals: requestFromToken.decimals },
          ),
        );
      } else {
        const flow3 = await estimateReshieldForReview(
          session as unknown as ReshieldSessionLike,
          {
            relayerInfo: relayer,
            grossWei,
            inputToken: requestFromToken.address as Address,
            outputToken: requestOutputToken.address as Address,
            chainId,
            input: { symbol: requestFromToken.symbol, decimals: requestFromToken.decimals },
            output: { symbol: requestOutputToken.symbol, decimals: requestOutputToken.decimals },
            slippage: requestSlippage,
            ...(requestSendTo ? { transfer: true } : {}),
          },
        );
        estimate = flow3.estimate;
        display = flow3.display;
      }
      // Launch cap on the note this reshield would create (codex: the deposit
      // modal's check never sees this path).
      await assertReshieldCap(BigInt(estimate.noteValue), requestOutputToken);

      if (!isCurrent()) return;
      setReshieldSnapshot({
        identity: requestIdentity,
        estimate,
        display,
        grossWei,
        amountText: formatTokenUnits(grossWei, requestFromToken.decimals),
        fromToken: requestFromToken,
        outputToken: requestOutputToken,
        slippage: requestSlippage,
        destinationChainId: crossChainRequest ? requestDestination : chainId,
        ...(fallbackForReview ? { fallbackAddress: fallbackForReview } : {}),
        ...(requestSendTo ? { recipient: requestSendTo } : {}),
        ...(requestSendTo && requestBlind ? { recipientBlind: true } : {}),
      });
      setStep('review');
      if (noticeOnSuccess) setSwapError(noticeOnSuccess);
      log('info', 'Swap', 'Reshield estimate prepared', {
        net: estimate.netSwapAmount,
        noteValue: estimate.noteValue,
        estOut: estimate.estimatedOutput,
      });
    } catch (err) {
      if (!isCurrent()) return;
      log('error', 'Swap', 'Reshield estimate failed', { error: String(err) });
      if (err instanceof ReshieldPreflightError) {
        setSwapError(swapErrorText(err, 'The swap failed.'));
      } else if (isSwapUnavailableError(err)) {
        setSwapUnavailable(true);
      } else if (isNoRouteError(err)) {
        setSwapError(`No route found for ${displayTokenSymbol(requestFromToken.symbol)} → ${displayTokenSymbol(requestOutputToken.symbol)}. Try a different pair or amount.`);
      } else {
        // The SDK reports its amounts in base units, which is right for a log
        // and unreadable on screen: "needs 18623284 input but only 18623008
        // available" is two numbers that look identical and advice that reads
        // as nonsense. In the SWAP INPUT's units, which for a share is the
        // underlying it redeems to, it is a shortfall of 0.000276 USDC.
        //
        // The SDK's structured amounts come first: this is the path the Swap
        // form's estimate takes, and it used to know only the LiFi shortfall, so
        // a deposit below the pool minimum was shown in raw base units here
        // even after every other path read it in units (QA, Mike, image 48).
        const raw = err instanceof Error ? err.message : '';
        // Only when there is SDK text to improve on. A non-Error rejection has
        // none, and String(err) would put "[object Object]" in the form where
        // the generic fallback below belongs.
        const structured = raw ? swapErrorText(err, '') : '';
        const friendly = structured && structured !== raw
          ? structured
          : raw
            ? friendlySwapError(raw, swapInputUnits(chainId, requestFromToken.address, {
              decimals: requestFromToken.decimals,
              symbol: displayTokenSymbol(requestFromToken.symbol),
            }))
            : null;
        setSwapError(friendly ?? (raw || 'Failed to estimate this swap.'));
      }
    } finally {
      if (isCurrent()) setIsQuoting(false);
    }
  }, [canReview, outputToken, amountWei, fromToken, slippage, chainId, sessionChainId, address, trimmedRecipient, swapSend, noteIdentity, destinationChainId, createReshieldCrosschainSessions, selectApprovedNotes, resolveSwapSession, log, swapErrorText]);
  const getReshieldEstimateRef = useRef(getReshieldEstimate);
  getReshieldEstimateRef.current = getReshieldEstimate;

  /**
   * One reset for BOTH Back buttons. The reshield Back used to clear only the
   * snapshot and step, so a failed confirmation's error stayed rendered on the
   * input form — describing a transaction the user had already backed out of.
   */
  const backToInput = useCallback(() => {
    invalidateQuoteRequests();
    setSnapshot(null);
    setReshieldSnapshot(null);
    setReshieldDetailsOpen(false);
    setReshieldHintOpen(false);
    setSwapError(null);
    setSwapUnavailable(false);
    setCountdown(null);
    setStep('input');
  }, [invalidateQuoteRequests]);

  /** Review button — dispatches to whichever mode the form is in. */
  const requestReviewRef = useRef<() => void>(() => {});
  const requestReview = useCallback(() => {
    // Inline opens skipped the connect/unlock gates (see openSwapModal), so
    // the CTA is where a session gets established. Resume through the ref so
    // the post-signature call sees the current mode and refs.
    if (!ensureConnected()) return;
    if (!keysReadyRef.current) {
      openSeedDerivationModal({ onSigned: () => requestReviewRef.current() });
      return;
    }
    if (isReshield) void getReshieldEstimateRef.current();
    else void getQuoteRef.current();
  }, [isReshield, ensureConnected, openSeedDerivationModal]);
  requestReviewRef.current = requestReview;

  // --- Confirm (review → executing → success) ---

  /**
   * The relayer-side guard (assertNoPendingRelay in relayHooks.beforeRelay)
   * only rejects a relay right before it goes out — after the notes are
   * selected and the proof for this attempt is generated. A retry after a
   * relay wait timeout (DEV-458) would otherwise start proving again for
   * notes it already knows are held by the earlier, still-pending relay.
   * Checked here, right after selection and before anything is proved, so
   * that retry fails immediately instead of after another proof.
   */
  const refuseIfSelectionPendingRelay = useCallback(async (notes: readonly { commitment: string }[]) => {
    if (!keystoreManager || notes.length === 0) return;
    const { createNoteComputationService } = await import('@/services/sdk-runtime');
    const noteComputationService = await createNoteComputationService();
    const privateNullifyingKey = keystoreManager.getPrivateNullifyingKey();
    const nullifiers = notes.map((n) => noteComputationService.computeNullifier(privateNullifyingKey, n.commitment as `0x${string}`) as string);
    assertNoPendingRelay(chainId, nullifiers);
  }, [keystoreManager, chainId]);

  const confirmSwapUnlocked = useCallback(async () => {
    const snap = snapshot;
    if (!snap) return;
    // Confirm combines the frozen review snapshot with the LIVE session; the
    // invalidation effect clears the snapshot on any context change, and this
    // guard closes the same-render race where confirm fires before the effect.
    if (sessionChainId !== chainId) {
      setSwapError('Network changed since this review. Review again on the current network.');
      setStep('review');
      return;
    }
    // Identity binding (codex): the snapshot priced identity A's notes; a
    // same-chain account-key change to B must not execute it against B's
    // session. The invalidation effect resets on identity change — this closes
    // the same-render race, like the chain guard above.
    if (snap.identity !== noteIdentity) {
      setSnapshot(null);
      setStep('input');
      setSwapError('Account changed since this review. Review again for the current account.');
      return;
    }
    // Operation binding (codex P1-5): abort pre-relay if the modal moves on.
    const runEpoch = opEpochRef.current;
    const live = () => opEpochRef.current === runEpoch;
    // Fresh attempt: a PRIOR submitted-then-failed run must not lend this
    // retry's pre-submit proving its submitted-immunity (codex verification).
    submittedRef.current = false;
    // Confirm-time lifetime check with a proving safety window: the SDK
    // only re-checks expiry when POSTING to the relayer, after 30-60s of
    // proving — never burn a proof on a commitment that can't be submitted.
    // Same refresh-at-confirm as the withdraw flow: the relayer's commitments
    // live ~60s and review dwell eats into that. Re-price the same order and
    // only bounce the user when it moved against them (REFRESH_DRIFT_BPS).
    let activePrepared = snap.prepared;
    if (!hasUsableCommitmentLifetime(getPreparedQuoteExpiration(snap.prepared), Date.now())) {
      try {
        setStep('executing');
        setExecutingLabel('Refreshing relayer quote…');
        const { createRelayerInteractor } = await import('@/services/sdk-runtime');
        // The re-quote binds a fresh commitment to the processor too; the
        // relayer may have moved since the first quote a minute ago.
        await assertRelayerSwapProcessor(chainId, getSwapProcessorAddress(chainId));
        const relayerInteractor = createRelayerInteractor(chainId, getSwapProcessorAddress(chainId));
        const relayers = await relayerInteractor.getRelayers();
        const relayer = relayers.find((r: { status?: string }) => r.status === 'active') ?? relayers[0];
        if (!relayer) throw new Error('No relayer is available for swaps right now.');
        const session = (await ensureInitialized()) as PoolSession;
        const { prepared: fresh, display: freshDisplay } = await prepareValidatedSwapQuote(session, {
          relayerInfo: relayer,
          poolChainId: chainId,
          grossWei: snap.grossWei,
          inputToken: { address: snap.fromToken.address as Address, decimals: snap.fromToken.decimals },
          outputToken: { address: snap.outputToken.address as Address, decimals: snap.outputToken.decimals },
          recipientAddress: snap.recipient,
          slippage: snap.slippage,
          ...(SWAP_DENY_EXCHANGES.length > 0 ? { denyExchanges: SWAP_DENY_EXCHANGES } : {}),
          ...(snap.crossChain
            ? { toChainId: snap.destinationChainId, ...(snap.fallbackAddress ? { fallbackAddress: snap.fallbackAddress } : {}) }
            : {}),
        });
        if (!live()) return;
        const drift = validateRefreshedSwapQuote(snap.prepared, fresh);
        if (drift.length > 0) throw new InvalidSwapQuoteError(drift);
        if (!isFreshCommitmentLive(getPreparedQuoteExpiration(fresh), Date.now())) {
          throw new Error('The refreshed relayer quote had already expired when it arrived.');
        }
        activePrepared = fresh;
        setSnapshot({ ...snap, prepared: fresh, display: freshDisplay });
        log('info', 'Swap', 'Refreshed the swap commitment at confirm', { fee: fresh.feeAmount, estOut: fresh.estimatedOutput });
      } catch (refreshErr) {
        if (!live()) return;
        log('warn', 'Swap', 'Commitment refresh at confirm failed', { error: String(refreshErr) });
        setSnapshot(null);
        setStep('input');
        setSwapError(
          refreshErr instanceof InvalidSwapQuoteError
            ? 'The price moved while you were reviewing. Review again for the current quote.'
            : 'Not enough time left on the relayer quote to generate the proof. Review again for a fresh quote.',
        );
        return;
      }
    }
    setStep('executing');
    setSwapError(null);
    try {
      setExecutingLabel('Selecting notes…');
      // Yield so React can COMMIT the line above before the scan below.
      // selectApprovedNotes is synchronous and can run for seconds on a large
      // note set, and it was starting in the same tick as the state change, so
      // the browser never painted: pressing Confirm looked frozen, then the
      // screen jumped straight to a later stage (QA, 2026-09-22).
      await paintFrame();
      const picked = selectApprovedNotes(snap.fromToken, snap.grossWei);
      // Preserve the helper's own diagnosis: an unresolved approval state is a
      // refresh race, not an insufficient balance, and conflating them sends the
      // user to look at a balance that is fine.
      if ('error' in picked) throw new Error(picked.error);
      const selection = { notes: picked.notes };
      await refuseIfSelectionPendingRelay(selection.notes);

      const session = (await ensureInitialized()) as PoolSession;
      // buildRelayWithdrawAndSwapParams re-validates the whole quote (gross
      // binding, zero addresses, mode minimums) and THROWS on violation —
      // the last gate before proving.
      const relayParams = buildRelayWithdrawAndSwapParams({
        prepared: activePrepared,
        poolChainId: chainId,
        grossWei: snap.grossWei,
        inputCommitments: selection.notes.map((n) => n.commitment),
        tokenId: snap.fromToken.address as Address,
        outputToken: snap.outputToken.address as Address,
        recipientAddress: snap.recipient,
        ...(snap.fallbackAddress ? { fallbackAddress: snap.fallbackAddress } : {}),
      });

      setExecutingLabel('Generating proof & relaying…');
      log('info', 'Swap', 'Submitting withdraw-and-swap', {
        inputs: relayParams.inputCommitments.length,
        net: relayParams.amount,
        toChainId: relayParams.toChainId,
      });
      if (!live()) { log('warn', 'Swap', 'Stale run aborted before relay'); return; }
      submittedRef.current = true;
      const receipt: TxReceiptLike = await session.relayWithdrawAndSwap(relayParams);
      const hash = typeof receipt?.txHash === 'string' ? receipt.txHash : null;
      setTxHash(hash);
      setTxChainId(chainId);
      // A resolved receipt is NOT success: the SDK returns failed receipts
      // without persisting note updates. Only status === true is a swap.
      if (receipt?.status !== true) {
        log('error', 'Swap', 'Swap transaction reverted', { txHash: hash });
        setSwapError(
          'The swap transaction reverted on-chain. The exit, swap, and payout rolled back together and your notes were NOT spent. You can review and try again.',
        );
        setStep('review');
        return;
      }
      log('info', 'Swap', 'Swap executed', { txHash: hash });
      try { await refreshNotes(); } catch { /* balances refresh best-effort */ }
      // Confirmed write → refresh the shared tx/stats caches (codex round 1, P1).
      void invalidateTransactionCaches(queryClient);
      if (snap.crossChain) setDelivery({ status: 'pending', ...withBridge(snap.prepared.swapTarget) });
      if (live()) setStep('success');
    } catch (err) {
      // Deliberately NOT classified as route-unavailable: confirm-phase
      // failures (proof, notes, relay) must never masquerade as the relayer
      // lacking the /swap route.
      log('error', 'Swap', 'Swap failed', { error: String(err) });
      // The run is over — Review is retryable again, so drop its submitted
      // immunity (codex verification).
      submittedRef.current = false;
      // Stale runs must not repaint a reopened/reset modal (codex).
      if (!live()) return;
      setSwapError(swapErrorText(err, 'The swap failed.'));
      setStep('review');
    }
  }, [snapshot, selectApprovedNotes, ensureInitialized, chainId, sessionChainId, noteIdentity, refreshNotes, log, refuseIfSelectionPendingRelay]);

  // Same-tick double-press guard (shared lock) — see hooks/use-op-lock.ts.
  const confirmSwap = useMemo(() => withOpLock(confirmSwapUnlocked), [withOpLock, confirmSwapUnlocked]);

  /**
   * Confirm a reshield (guide flow 3). Unlike the wallet path, ALL four SDK
   * steps run here — estimate, deposit proof, relayer quote, relay — because
   * the quote must be requested with the proof already in hand and would
   * otherwise expire during proving. runReshield owns that ordering and
   * asserts the gross-vs-net rule before anything is submitted.
   */
  /**
   * DEV-511: the blind recipient for a swap-send to an unregistered address.
   * The SDK calls the note builder once the deposit is fixed and BEFORE the
   * proof; the claim is sealed to this sender's viewing key and stored right
   * there, and a failed store throws, which the SDK turns into a refusal before
   * anything is proved or relayed. The deposit's own noteData is the on-chain
   * backup of the same claim (services/blind-deposit-backup.ts).
   */
  const prepareBlindSwapSend = useCallback(async (recipient: Address, noteChainId: number, sourceChainId: number) => {
    const senderViewingPubKey = keystoreManager?.getViewingKeyPair().publicKey;
    if (!senderViewingPubKey) {
      throw new ReshieldPreflightError('Could not read this account\u2019s viewing key, so the claim link could not be backed up. Nothing was sent.');
    }
    const { createCryptoService, createNoteComputationService } = await import('@/services/sdk-runtime');
    const crypto = createCryptoService() as unknown as BackupCryptoLike & { generateSecret(): string };
    const noteComputation = await createNoteComputationService() as unknown as BackupNoteComputationLike;
    const owner = recipient.toLowerCase() as Hex;
    const noteSecret = crypto.generateSecret() as Hex;
    const depositSecret = crypto.generateSecret() as Hex;
    const noteAddressHash = noteComputation.computeNoteAddressHash(owner, noteSecret) as Hex;
    const built: { current: { id: string; claim: SwapSendClaim } | null } = { current: null };
    const spec = swapDepositRecipient({
      recipient: owner,
      blind: {
        noteSecret,
        depositSecret,
        senderViewingPubKey: String(senderViewingPubKey),
        noteAddressHash,
        noteComputation,
        crypto,
        randomFill: webRandomFill,
      },
      onNote: (_key, note) => {
        const claim: SwapSendClaim = {
          chainId: noteChainId,
          commitment: note.commitment,
          ownerAddress: owner,
          noteSecret,
          tokenId: note.tokenId,
          value: note.value,
          label: note.label,
        };
        const sealed = sealSwapSendClaim({ claim, sourceChainId, senderViewingPubKey: String(senderViewingPubKey), crypto, now: Date.now() });
        if (!storeSealedClaim(sealed)) {
          throw new ReshieldPreflightError('Could not save the claim link on this device, so nothing was sent. Check that site storage is allowed and try again.');
        }
        built.current = { id: sealed.id, claim };
      },
    });
    return {
      recipient: spec,
      /** On broadcast: re-key the stored claim with the relayed hash and show the link. */
      onBroadcast: (hash: string) => {
        const b = built.current;
        if (!b) return;
        try { rekeyStoredClaim(b.id, hash); } catch { /* the sealed record and the on-chain backup remain */ }
        setClaimUrl(buildSentReceiptUrl([{ ...b.claim, txHash: hash as Hex } as never]));
      },
    };
  }, [keystoreManager]);

  const confirmReshieldUnlocked = useCallback(async () => {
    const snap = reshieldSnapshot;
    if (!snap) return;
    // Same closing guard as confirmSwap: a reshield estimated on chain A must
    // not execute against chain B's fresh relayer/session (it could select
    // B notes an A review never priced, or burn a proof on a doomed relay).
    if (sessionChainId !== chainId) {
      setSwapError('Network changed since this review. Review again on the current network.');
      setStep('review');
      return;
    }
    // Identity binding (codex) — see confirmSwap for the rationale.
    if (snap.identity !== noteIdentity) {
      setReshieldSnapshot(null);
      setStep('input');
      setSwapError('Account changed since this review. Review again for the current account.');
      return;
    }
    // Operation binding (codex P1-5): abort pre-relay if the modal moves on.
    const runEpoch = opEpochRef.current;
    const live = () => opEpochRef.current === runEpoch;
    // Fresh attempt: a PRIOR submitted-then-failed run must not lend this
    // retry's pre-submit proving its submitted-immunity (codex verification).
    submittedRef.current = false;
    setClaimUrl(null);
    setStep('executing');
    setSwapError(null);
    try {
      setExecutingLabel('Selecting notes…');
      // Yield so React can COMMIT the line above before the scan below.
      // selectApprovedNotes is synchronous and can run for seconds on a large
      // note set, and it was starting in the same tick as the state change, so
      // the browser never painted: pressing Confirm looked frozen, then the
      // screen jumped straight to a later stage (QA, 2026-09-22).
      await paintFrame();
      const picked = selectApprovedNotes(snap.fromToken, snap.grossWei);
      // Preserve the helper's own diagnosis: an unresolved approval state is a
      // refresh race, not an insufficient balance, and conflating them sends the
      // user to look at a balance that is fine.
      if ('error' in picked) throw new Error(picked.error);
      await refuseIfSelectionPendingRelay(picked.notes);

      const relayerResolved = await resolveSwapSession({
        // Confirm is past the point where a stale request could win — the
        // snapshot is frozen — so this is always the current request.
        isCurrent: () => true,
        resume: () => { void confirmReshieldRef.current(); },
      });
      if (relayerResolved === 'handled') {
        setStep('review');
        return;
      }
      const { session, relayer } = relayerResolved;

      if (!live()) { log('warn', 'Swap', 'Stale run aborted before reshield relay'); return; }
      // Flow 4 diverges here: a different SDK call, two sessions, and the new
      // note lands on the OTHER chain. Everything is read from the snapshot, so
      // a destination changed after Review cannot redirect a reviewed reshield.
      if (snap.destinationChainId !== chainId) {
        if (!snap.fallbackAddress) {
          throw new ReshieldPreflightError('This swap was reviewed without a fallback address. Review it again.');
        }
        const sessions = await createReshieldCrosschainSessions({ destinationChainId: snap.destinationChainId });
        if (!sessions) throw new ReshieldPreflightError('Swapping to that network is not available yet.');
        let crossBroadcastAt: number | null = null;
        const crossBlind = snap.recipient && snap.recipientBlind
          ? await prepareBlindSwapSend(snap.recipient, snap.destinationChainId, chainId)
          : null;
        const crossResult = await runReshieldCrosschain(
          sessions.source as unknown as ReshieldCrosschainSessionLike,
          sessions.destination as unknown as DestinationDepositSessionLike,
          {
  inputUnits: { decimals: snap.fromToken.decimals, symbol: snap.fromToken.symbol },
            relayerInfo: relayer,
            shouldContinue: live,
            grossWei: snap.grossWei,
            inputToken: snap.fromToken.address as Address,
            outputToken: snap.outputToken.address as Address,
            toChainId: snap.destinationChainId,
            fallbackAddress: snap.fallbackAddress,
            inputCommitments: picked.notes.map((n) => n.commitment),
            slippage: snap.slippage,
            // A route that got worse after Review must ask again instead of
            // executing quietly. "Worse" is measured against the slippage the
            // user set, not against the reviewed figure exactly: a re-quote
            // moves the output between the two clicks essentially always, and
            // an exact floor refused every attempt (QA, 2026-09-22).
            minNoteValueWei: reshieldConsentFloor(snap.display.newNoteValueWei, snap.slippage),
        assertNoteValue: (wei) => assertReshieldCap(wei, snap.outputToken),
            outputUnits: { symbol: snap.outputToken.symbol, decimals: snap.outputToken.decimals },
            destinationName: getChainConfig(snap.destinationChainId)?.displayName ?? `chain ${snap.destinationChainId}`,
            // Swap-send: the note is FOR this account on the destination chain,
            // read from the reviewed snapshot. No pendingNote comes back.
            ...(snap.recipient ? { recipient: crossBlind ? crossBlind.recipient : { discoveryData: { evmAddress: snap.recipient } } } : {}),
            // DEV-433 / DEV-512: the record goes down when the relayer hands
            // back the hash, not after the receipt, so a receipt that times out
            // or a closed tab still labels the row. Local only, and the note is
            // not stored yet, so no own-action stamp here. Confirmation below
            // upserts the same record.
            onBroadcast: (hash, { quote, pendingNote }) => {
              crossBroadcastAt = Date.now();
              crossBlind?.onBroadcast(hash);
              try {
                recordCrossChainSwap({
                  sourceChainId: chainId,
                  destinationChainId: snap.destinationChainId,
                  txHash: hash,
                  inputToken: String(snap.fromToken.address),
                  outputToken: String(snap.outputToken.address),
                  feeAmount: quote.feeAmount,
                  note: pendingNote?.isOwned
                    ? { commitment: pendingNote.commitment ? String(pendingNote.commitment) : null, value: pendingNote.value ? String(pendingNote.value) : null }
                    : null,
                  noteStored: false,
                  sentToOther: !!snap.recipient,
                  now: crossBroadcastAt,
                }, { recordOwnAction, recordWithdrawFee, recordSwap });
              } catch { /* local bookkeeping is best-effort */ }
            },
            onStep: (stepName) => {
              if (stepName === 'relay') submittedRef.current = true;
              setExecutingLabel(
                stepName === 'estimate'
                  ? 'Refreshing the estimate…'
                  : stepName === 'proving'
                    ? 'Generating the deposit proof…'
                    : stepName === 'quote'
                      ? 'Getting the relayer quote…'
                      : 'Relaying…',
              );
            },
          },
        );
        const crossHash = typeof crossResult.receipt?.txHash === 'string' ? crossResult.receipt.txHash : null;
        setTxHash(crossHash);
        // The SOURCE chain: the explorer link and the delivery poller both
        // start from the leg that was actually submitted here.
        setTxChainId(chainId);
        // Arm the delivery tracker: the far leg is a separate, later event, and
        // the poller resolves it to done/failed instead of leaving the user with
        // "can take a few minutes".
        setDelivery({ status: 'pending', ...withBridge(crossResult.quote.swapTarget) });
        log('info', 'Swap', 'Cross-chain reshield relayed', {
          txHash: crossHash,
          destinationChainId: snap.destinationChainId,
          net: crossResult.quote.netAmount,
        });
        // The new note lands on the DESTINATION chain minutes after this source
        // leg, so it is not stored here: addNotes would resolve its commitment
        // against the destination pool, which always fails this early and is a
        // read naming the note. The swap record keeps the prepared commitment
        // and value; the note arrives with the next ordinary sync of that
        // chain, never a scan timed to this delivery.
        const crossNoteStored = false;
        try {
          recordCrossChainSwap({
            sourceChainId: chainId,
            destinationChainId: snap.destinationChainId,
            txHash: crossHash,
            inputToken: String(snap.fromToken.address),
            outputToken: String(snap.outputToken.address),
            feeAmount: crossResult.quote.feeAmount,
            note: crossResult.pendingNote?.isOwned
              ? { commitment: crossResult.pendingNote.commitment ? String(crossResult.pendingNote.commitment) : null, value: crossResult.pendingNote.value ? String(crossResult.pendingNote.value) : null }
              : null,
            noteStored: crossNoteStored,
            sentToOther: !!snap.recipient,
            now: crossBroadcastAt ?? Date.now(),
          }, { recordOwnAction, recordWithdrawFee, recordSwap });
        } catch { /* local bookkeeping is best-effort; the swap succeeded */ }
        try { await refreshNotes(); } catch { /* balances refresh best-effort */ }
        void invalidateTransactionCaches(queryClient);
        if (live()) setStep('success');
        return;
      }
      let broadcastAt: number | null = null;
      const sameBlind = snap.recipient && snap.recipientBlind
        ? await prepareBlindSwapSend(snap.recipient, chainId, chainId)
        : null;
      const { receipt, quote, pendingNote } = await runReshield(session as unknown as ReshieldSessionLike, {
        chainId,
  inputUnits: { decimals: snap.fromToken.decimals, symbol: snap.fromToken.symbol },
        relayerInfo: relayer,
        // Checked by runReshield immediately before the relayer submission —
        // the estimate/proof inside can outlive this modal session (codex).
        shouldContinue: live,
        grossWei: snap.grossWei,
        inputToken: snap.fromToken.address as Address,
        outputToken: snap.outputToken.address as Address,
        inputCommitments: picked.notes.map((n) => n.commitment),
        slippage: snap.slippage,
        // Bind execution to the figure shown on Review — a route that got worse
        // in the meantime must ask again rather than execute silently.
        minNoteValueWei: reshieldConsentFloor(snap.display.newNoteValueWei, snap.slippage),
        assertNoteValue: (wei) => assertReshieldCap(wei, snap.outputToken),
        // Swap-send: the new note is FOR this account. Read from the snapshot
        // Review showed, never from the live form.
        ...(snap.recipient ? { recipient: sameBlind ? sameBlind.recipient : { discoveryData: { evmAddress: snap.recipient } } } : {}),
        // DEV-433 / DEV-512: record at broadcast, not after the receipt. The
        // output note is not stored yet (noteStored false), so only a swap-send's
        // record lands here; confirmation upserts the rest, fee included.
        onBroadcast: (hash) => {
          broadcastAt = Date.now();
          sameBlind?.onBroadcast(hash);
          try {
            recordSameChainSwap({
              chainId,
              txHash: hash,
              inputToken: String(snap.fromToken.address),
              outputToken: String(snap.outputToken.address),
              // No fee at broadcast: a relay that reverts must not leave a fee
              // row. The confirmation write records it.
              feeAmount: null,
              noteStored: false,
              sentToOther: !!snap.recipient,
              now: broadcastAt,
            }, { recordOwnAction, recordWithdrawFee, recordSwap });
          } catch { /* local bookkeeping is best-effort */ }
        },
        onStep: (stepName) => {
          // 'relay' fires right as the payload is handed to the relayer — from
          // here the operation is SUBMITTED and immune to context resets.
          if (stepName === 'relay') submittedRef.current = true;
          setExecutingLabel(
            stepName === 'estimate'
              ? 'Refreshing the estimate…'
              : stepName === 'proving'
                ? 'Generating the deposit proof…'
                : stepName === 'quote'
                  ? 'Getting the relayer quote…'
                  : 'Relaying…',
          );
        },
      });

      // runReshield already rejected a reverted receipt (TxReceipt.status), so
      // reaching here means the transaction actually succeeded.
      const hash = typeof receipt?.txHash === 'string' ? receipt.txHash : null;
      setTxHash(hash);
      setTxChainId(chainId);
      log('info', 'Swap', 'Reshield relayed', { txHash: hash, net: quote.netAmount });

      // Register the NEW output note locally. relayReshield persists the spent
      // inputs and the input-asset change, but not the note the embedded
      // deposit created — without this the old balance disappears and the
      // reshielded one is absent until a full discovery run recovers it.
      // A swap-send has no pendingNote (the note is the recipient's), so this
      // block is skipped for it by construction: nothing of theirs is stored here.
      let noteStored = false;
      if (pendingNote?.isOwned && hash) {
        try {
          await (session as unknown as {
            addNotes: (p: { pendingNote: unknown; txHash: string }[]) => Promise<void>;
          }).addNotes([{ pendingNote, txHash: hash }]);
          noteStored = true;
        } catch (addErr) {
          // The transaction DID succeed — never report it as a failure here.
          // Say the balance needs a sync instead, which is the actual state.
          log('error', 'Swap', 'Reshield succeeded but the new note was not stored locally', { error: String(addErr) });
          setReshieldSyncWarning(true);
        }
      }
      try {
        recordSameChainSwap({
          chainId,
          txHash: hash,
          inputToken: String(snap.fromToken.address),
          outputToken: String(snap.outputToken.address),
          feeAmount: quote.feeAmount,
          noteStored,
          sentToOther: !!snap.recipient,
          now: broadcastAt ?? Date.now(),
        }, { recordOwnAction, recordWithdrawFee, recordSwap });
      } catch { /* local bookkeeping is best-effort; the swap succeeded */ }
      try { await refreshNotes(); } catch { /* balances refresh best-effort */ }
      // Confirmed write → refresh the shared tx/stats caches (codex round 1, P1).
      void invalidateTransactionCaches(queryClient);
      if (live()) setStep('success');
    } catch (err) {
      log('error', 'Swap', 'Reshield failed', { error: String(err) });
      // The run is over — Review is retryable again (codex verification).
      submittedRef.current = false;
      // Stale runs must not repaint a reopened/reset modal (codex). A revert's
      // hash record still lands below — it's the run's immutable outcome.
      if (err instanceof ReshieldRevertedError && err.txHash) { setTxHash(err.txHash); setTxChainId(chainId); }
      // A mined revert deposited nothing, so its claim link names no note.
      // An unknown outcome keeps it: the swap may have gone through.
      if (err instanceof ReshieldRevertedError && /reverted on-chain/.test(err.message)) setClaimUrl(null);
      if (!live()) return;
      // The consent gate compares the fresh estimate against the note value in
      // the snapshot, and the snapshot is what Review renders. Leaving both in
      // place would ask for a re-review while showing the superseded figures,
      // and would keep measuring every retry against a rate that has passed, so
      // the refusal could never clear on its own. Re-estimate first, then say
      // why, so the message lands on the numbers it is asking about.
      if (err instanceof ReshieldRateMovedError) {
        setStep('review');
        // Set here as well as through the notice: the re-estimate can bail out
        // early (nothing reviewable, another network), and a silent return to
        // Review would leave the user with no reason for it.
        setSwapError(swapErrorText(err, 'The swap failed.'));
        await getReshieldEstimateRef.current(err.message);
        return;
      }
      // A revert has a transaction to look up and cost gas; a preflight failure
      // has neither. Surfacing the hash matters for the former.
      if (err instanceof ReshieldRevertedError) {
        if (err.txHash) setTxHash(err.txHash);
        if (err.txHash) setTxChainId(chainId);
        setSwapError(swapErrorText(err, 'The swap failed.'));
      } else {
        setSwapError(swapErrorText(err, 'The swap failed.'));
      }
      setStep('review');
    }
  }, [reshieldSnapshot, selectApprovedNotes, resolveSwapSession, chainId, sessionChainId, noteIdentity, refreshNotes, createReshieldCrosschainSessions, queryClient, log, refuseIfSelectionPendingRelay, prepareBlindSwapSend]);

  // Same-tick double-press guard (shared lock) — see hooks/use-op-lock.ts.
  const confirmReshield = useMemo(() => withOpLock(confirmReshieldUnlocked), [withOpLock, confirmReshieldUnlocked]);
  const confirmReshieldRef = useRef(confirmReshield);
  confirmReshieldRef.current = confirmReshield;

  /** Confirm button — dispatches to whichever mode produced the snapshot. */
  const confirmActive = useCallback(() => {
    if (isReshield) void confirmReshieldRef.current();
    else void confirmSwap();
  }, [isReshield, confirmSwap]);

  const contextValue = useMemo(
    () => ({
      openSwapModal,
      closeSwapModal,
      isOpen,
      inlineActive: isOpen && inlineHubActive,
      inlineStep: step,
      inlineMode: mode,
      inlineSend: isOpen && inlineSend,
      inlineRecipientRegistration: isOpen ? swapSendRegistration : 'idle',
      syncInlineForm,
    }),
    [openSwapModal, closeSwapModal, isOpen, inlineHubActive, inlineSend, step, mode, swapSendRegistration, syncInlineForm],
  );

  const explorerUrl = txHash ? getExplorerTxUrl(txChainId ?? chainId, txHash) : null;
  // LI.FI Scan for the source leg while a cross-chain delivery is still in
  // flight, so a slow bridge can be watched (services/lifi-scan.ts).
  // LI.FI Scan only knows LI.FI routes; a direct Across deposit is not on it.
  const lifiScanLink = delivery?.status === 'pending' && !delivery.bridge ? lifiScanUrl(txHash) : null;
  // The chain the swap was SENT on, frozen with the tx: a refund lands there,
  // whatever the app's selection says now (#155 review).
  const sourceChainName = getChainConfig(txChainId ?? chainId)?.displayName ?? `chain ${txChainId ?? chainId}`;
  // The far leg has its own transaction on its own explorer, and the source
  // link cannot show it. `delivery.detail` carries that hash once the bridge
  // reports a terminal outcome, whether it deposited or paid the fallback
  // address (QA asked for both, 2026-09-23).
  const destinationExplorerUrl = pendingDeliveryChainId !== null
    && (delivery?.status === 'done' || delivery?.status === 'recovered')
    && delivery.detail?.startsWith('0x')
    ? getExplorerTxUrl(pendingDeliveryChainId, delivery.detail)
    : null;
  const destinationExplorerName = pendingDeliveryChainId !== null
    ? getChainConfig(pendingDeliveryChainId)?.displayName ?? `chain ${pendingDeliveryChainId}`
    : '';
  const destinationName = getChainConfig(destinationChainId)?.displayName ?? `Chain ${destinationChainId}`;

  return (
    <SwapModalContext.Provider value={contextValue}>
      {children}
      <LinkLeaveConfirm
        visible={!!claimLeavePending}
        copy={CLAIM_LINK_LEAVE}
        onCopy={copyClaimLink}
        onLeave={() => { const pending = claimLeavePending; setClaimLeavePending(null); setClaimCopied(true); pending?.leave(); }}
        onCancel={() => setClaimLeavePending(null)}
        testID="swap-claim-link-leave-confirm"
      />
      {isOpen && (
        <OpShell
          inline={inlineHubActive}
          isSheet={isSheet}
          isDark={colorScheme === 'dark'}
          sheetAnim={sheetAnim}
          onClose={closeSwapModal}
          // Conflicting box props (width/max-w/padding/radius) live in exactly ONE
          // branch so class order can't flip the RN style-array override result.
          cardClassName={`relative max-h-[92%] items-center gap-[16px] overflow-hidden border border-border bg-card-background ${
            isSheet
              ? 'w-full max-w-full mb-0 rounded-t-card rounded-b-none border-b-0 px-[16px] py-[24px] pt-[28px]'
              : isMobile
                ? 'w-[95%] max-w-[95%] rounded-card px-[16px] py-[24px]'
                : 'w-[504px] max-w-[95%] rounded-card px-[24px] py-[36px]'
          }`}
        >
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token — kept identical to reference providers */}
            {isSheet && !inlineHubActive && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-control" style={{ backgroundColor: colors.border }} />}
            {step !== 'executing' && !inlineHubActive && (
              <Pressable className="absolute right-[11px] top-[11px] z-[10] h-[24px] w-[24px] items-center justify-center" onPress={closeSwapModal}>
                {/* nw-keep(data-color): close glyph stroke color is the text theme token into the SVG icon prop */}
                <CloseIcon color={colors.text} />
              </Pressable>
            )}

            {step === 'input' && (
              <ScrollView className="w-full" contentContainerClassName="gap-[14px]" keyboardShouldPersistTaps="handled">
                {/* Inline, the hub card is the title and the inputs: only
                    what the card does not show (mode, slippage, review CTA)
                    draws here. */}
                {!inlineHubActive && (<>
                <Text className="w-full text-center text-[24px] text-text font-pp-sans-bold">Swap</Text>
                <Text className="w-full text-center text-[12px] text-text-muted font-pp-regular">
                  {isReshield
                    ? 'Swap one private balance into another. The funds never leave the pool.'
                    : 'Withdraw a note and receive a different token. The route is sealed in your proof.'}
                </Text>
                </>)}

                <PendingRelayNotice chainId={chainId} owner={sessionAddress ?? address} />

                {/* No mode toggle: this surface has one mode. See openSwapModal. */}

                {swapUnavailable && (
                  <View className="w-full rounded-legacy-8 border border-warning bg-warning-bg px-[12px] py-[10px]">
                    <Text className="text-[12px] leading-[17px] text-warning font-pp-medium">
                      Swaps aren&apos;t available on this network. The relayer isn&apos;t serving swap quotes here. No funds were moved.
                    </Text>
                  </View>
                )}
                {swapError && !swapUnavailable && (
                  <View className="w-full rounded-legacy-8 border border-danger bg-danger-bg px-[12px] py-[10px]">
                    <Text className="text-[12px] leading-[17px] text-danger font-pp-medium" testID="swap-error">{swapError}</Text>
                  </View>
                )}

                {!inlineHubActive && (<>
                {/* You swap */}
                <View className={`w-full gap-[10px] rounded-control border p-[16px] ${overBalance ? 'border-danger' : 'border-border'}`}>
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular">You swap</Text>
                    <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular">
                      Available: {(poolsLoading ? '—' : balanceDisplay(formatUnits(balanceWei, fromToken.decimals), fromToken.symbol, chainId).text)}
                    </Text>
                    {!poolsLoading ? <ShareCountHint hint={balanceDisplay(formatUnits(balanceWei, fromToken.decimals), fromToken.symbol, chainId).hint} /> : null}
                  </View>
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <TextInput
                      className={`min-w-[80px] grow shrink p-0 text-[24px] font-pp-regular ${amount ? 'text-text' : 'text-text-muted'}`}
                      // nw-keep(platform-css): web-only outlineStyle:'none' removes the focus ring — no className path; empty on native
                      style={WEB_NO_OUTLINE}
                      value={amount}
                      onChangeText={editAmount}
                      placeholder="0"
                      // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                      placeholderTextColor={colors.textMuted}
                      keyboardType="numeric"
                    />
                    <View className="flex-row gap-[6px]">
                      {inputTokens.map((t) => {
                        const selected = t.symbol === fromToken.symbol;
                        return (
                          <Pressable
                            key={t.symbol}
                            className={`flex-row items-center gap-[6px] rounded-legacy-8 border px-[10px] py-[6px] ${selected ? 'border-tint bg-background-secondary' : 'border-border bg-transparent'}`}
                            onPress={() => editFromToken(t)}
                          >
                            <TokenNetworkIcon symbol={t.symbol} chainId={chainId} size={16} />
                            <Text className={`text-[13px] text-text ${selected ? 'font-pp-bold' : 'font-pp-regular'}`}>{t.symbol === fromToken.symbol ? fromToken.symbol : displayTokenSymbol(t.symbol)}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                </View>

                {/* You receive — output token + destination network via the
                    shared deposit selector. */}
                <Text className="w-full text-[13px] text-text-muted font-pp-medium">
                  {isReshield ? 'You receive privately' : 'You receive'}
                </Text>
                <Pressable
                  className="h-[44px] w-full flex-row items-center gap-[12px] rounded-control border border-border bg-card-background px-[16px]"
                  onPress={() => setSelectorOpen(true)}
                >
                  <View className="flex-1 flex-row items-center gap-[8px]">
                    {outputToken ? (
                      <>
                        <TokenNetworkIcon symbol={outputToken.token.symbol} chainId={outputToken.chainId} size={24} />
                        <Text className="text-[15px] text-text font-pp-regular">
                          {/* A reshield is same-chain by construction, so the
                              chain name would be the only thing on offer and
                              reads as a choice the user doesn't have. */}
                          {isReshield
                            ? `${displayTokenSymbol(outputToken.token.symbol)}. Shielded`
                            : `${displayTokenSymbol(outputToken.token.symbol)} on ${destinationName}`}
                        </Text>
                      </>
                    ) : (
                      <Text className="text-[15px] text-text-muted font-pp-regular">Select token</Text>
                    )}
                  </View>
                  {/* nw-keep(data-color): caret fill is the text theme token into the SVG icon prop */}
                  <CaretDownIcon color={colors.text} />
                </Pressable>
                </>)}

                {inlineSend && inlineHubActive && (
                  <View className="w-full flex-row items-center justify-between gap-[8px]">
                    <Text className="flex-1 text-[13px] text-text-secondary font-pp-medium" testID="swap-send-inline-summary">
                      {outputToken ? `They receive ${displayTokenSymbol(outputToken.token.symbol)}, privately.` : 'Pick what they receive.'}
                    </Text>
                    <Pressable onPress={closeSwapModal} accessibilityRole="button" testID="swap-send-inline-back" hitSlop={8}>
                      <Text className="text-[13px] text-tint font-pp-medium">Edit</Text>
                    </Pressable>
                  </View>
                )}

                {/* Reshield has no recipient at all — the output is a new
                    shielded note owned by the same account, so there is no
                    address to show and nothing to get wrong. */}
                {isReshield && (
                  <View className="w-full flex-row items-start gap-[8px] rounded-legacy-8 border border-border bg-background-secondary px-[12px] py-[10px]">
                    {/* nw-keep(data-color): shield glyph color is a runtime theme token (vector-icon sink) */}
                    <Ionicons name="shield-checkmark-outline" size={14} color={colors.primary} />
                    {(() => {
                      const note = crossChainReshield && swapSend
                        ? `Stays private: the output is swapped and bridged, and deposited as a new shielded note for the recipient on ${destinationName}.`
                        : crossChainReshield
                        ? `Stays private: the output is re-deposited as a new shielded note in your account. No wallet address is involved unless the far side fails${showRecipientField ? ', and the address below is where that would land' : ''}.`
                        : swapSend
                          ? 'Stays private: the output is deposited as a new shielded note owned by the recipient. Nothing is paid to a wallet, and the recipient and amount are not published.'
                          : 'Stays private: the output is re-deposited as a new shielded note in your account. No wallet address is involved.';
                      return tight ? (
                        <HoverHint hint={note} wrap testID="swap-stays-private-hint">
                          <View className="min-w-0 shrink flex-row items-center gap-[4px]">
                            {/* The fallback wallet stays on screen: it is where a failed cross-chain leg lands. */}
                            <Text className="shrink text-[12px] leading-[17px] text-text-secondary font-pp-regular">
                              {crossChainReshield && !swapSend && showRecipientField && !crossChainSendField
                                ? 'Stays private. If the far side fails, it lands at the address below.'
                                : 'Stays private'}
                            </Text>
                            {/* nw-keep(data-color): glyph colour is a runtime theme token (vector-icon sink) */}
                            <Ionicons name="information-circle-outline" size={12} color={colors.textMuted} />
                          </View>
                        </HoverHint>
                      ) : (
                        <Text className="flex-1 text-[12px] leading-[17px] text-text-secondary font-pp-regular">{note}</Text>
                      );
                    })()}
                  </View>
                )}

                {/* Recipient — collapsed by default (defaults to your wallet).
                    Cross-chain always shows it, INCLUDING on the inline hub:
                    the payout lands on another chain, so the address is a
                    decision rather than a default, and the copy below tells the
                    user to make it. The hub used to suppress the field while
                    keeping that copy, so the one control the sentence is about
                    did not exist on the surface it was shown on (QA, Mike,
                    2026-09-23: "There is no field to set fallback option btw").
                    `showRecipientField` is what both now read, so they cannot
                    drift apart again. */}
                {showRecipientField && (
                <>
                <View className="w-full flex-row items-center gap-[8px]">
                  <Text className="flex-1 text-[13px] text-text-muted font-pp-medium">
                    {crossChainSendField
                      ? `Recipient (on ${destinationName})`
                      : crossChainReshield
                      ? `If this fails, send to (on ${destinationName})`
                      : `Recipient${crossChain ? ` (on ${destinationName})` : ''}`}
                  </Text>
                  {!crossChain && !crossChainReshield && (
                    <Pressable
                      onPress={() => {
                        setRecipientOpen((open) => {
                          // Collapsing returns the destination to your wallet,
                          // so a half-typed address can never be submitted
                          // from a hidden field.
                          if (open) editRecipient(sessionAddress ?? address ?? '');
                          return !open;
                        });
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: recipientOpen }}
                      accessibilityLabel={recipientOpen ? 'Send output to my wallet' : 'Send output to a different address'}
                      testID="swap-recipient-toggle"
                      hitSlop={8}
                      className={`h-[28px] w-[28px] items-center justify-center rounded-[8px] border ${recipientOpen ? 'border-tint bg-primary-soft' : 'border-border'}`}
                    >
                      {/* nw-keep(data-color): wallet glyph color is a runtime theme token (vector-icon sink) */}
                      <Ionicons
                        name="wallet-outline"
                        size={15}
                        color={recipientOpen ? colors.primary : colors.textMuted}
                      />
                    </Pressable>
                  )}
                </View>
                {recipientOpen || crossChain || crossChainReshield ? (
                  <TextInput
                    className={`w-full rounded-control border px-[14px] py-[11px] text-[14px] text-text font-pp-regular ${recipient && !recipientValid ? 'border-danger' : 'border-border'}`}
                    // nw-keep(platform-css): web-only outlineStyle:'none' removes the focus ring — no className path; empty on native
                    style={WEB_NO_OUTLINE}
                    value={recipient}
                    onChangeText={editRecipient}
                    placeholder="0x…"
                    // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                ) : (
                  <Text numberOfLines={1} className="w-full text-[13px] text-text-secondary font-pp-regular">
                    Your wallet{address ? ` · ${address.slice(0, 6)}…${address.slice(-4)}` : ''}
                  </Text>
                )}
                </>
                )}
                {thirdPartyRecipient && !swapSendOutputOk && (
                  <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular" testID="swap-send-output-unsupported">
                    {crossChainReshield
                      ? `Only a pool share can be sent privately to ${destinationName}. Pick one, or use Withdraw.`
                      : 'This asset can’t be sent privately to another address yet. Pick a different asset, or send to your own account.'}
                  </Text>
                )}
                {(recipientTypedButInvalid || (trimmedRecipient !== '' && isPotentialEnsName(trimmedRecipient))) && (
                  <Text className="text-[12px] leading-[17px] text-danger font-pp-regular" testID="swap-send-recipient-invalid">
                    {/* DEV-570: no ENS on any recipient field (never looked up). */}
                    {isPotentialEnsName(trimmedRecipient)
                      ? ENS_UNSUPPORTED_MESSAGE
                      : 'Enter a full wallet address, or clear it to keep the swap in your own account.'}
                  </Text>
                )}
                {swapSend && swapSendRegistration !== 'registered' && swapSendRegistration !== 'idle' && (
                  <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular" testID="swap-send-registration">
                    {swapSendRegistration === 'checking'
                      ? 'Checking whether this address can receive a private swap…'
                      : swapSendRegistration === 'unregistered'
                        ? `${swapSendUnregisteredNotice(getChainConfig(swapSendChainId)?.displayName)} ${SWAP_SEND_CLAIM_WHY}`
                        : 'Couldn’t check this address right now. Try again in a moment.'}
                  </Text>
                )}
                {swapSend && swapSendRegistration === 'unregistered' && swapSendKey && (
                  <View className="w-full gap-[6px]">
                    <Pressable onPress={() => { void Linking.openURL(UNREGISTERED_DEPOSIT_DOCS_URL); }} testID="swap-send-unregistered-learn-more">
                      <Text className="text-[12px] underline text-tint font-pp-medium">{LEARN_MORE_UNREGISTERED_LABEL}</Text>
                    </Pressable>
                  </View>
                )}
                {showRecipientField && crossChainReshield && crossChainSendField && (
                  <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular">
                    If the far side cannot complete, the bridged tokens go to your connected wallet on {destinationName}.
                  </Text>
                )}
                {crossChain && (
                  <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular">
                    Cross-chain delivery: the on-chain recipient is the zero-address sentinel. Your address is sealed in the proof-bound route and paid out on {destinationName}. If the destination swap fails, LiFi refunds bridged funds to your address there; certain bridge failures instead refund on the source chain to the RelaySwaps contract, where recovery needs relayer assistance.
                  </Text>
                )}
                {!spendabilityResolved && (
                  <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular">
                    Confirming which notes are approved to spend…
                  </Text>
                )}

                {/* Inline, the amount box (and its red border) is the hub's;
                    say why the CTA is off instead of leaving it grey. */}
                {inlineHubActive && overBalance && (
                  <Text className="w-full text-[12px] leading-[17px] text-danger font-pp-medium">
                    That is more {displayTokenSymbol(fromToken.symbol)} than you have shielded here.
                  </Text>
                )}

                {/* Slippage */}
                <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                  {tight ? (
                    <Pressable
                      className="w-full flex-row items-center justify-between"
                      onPress={() => setSlippageOpen((o) => !o)}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: slippageOpen || !!customSlippageError }}
                      testID="swap-slippage-toggle"
                    >
                      <Text className="text-[13px] text-text-muted font-pp-medium">Max slippage</Text>
                      <View className="flex-row items-center gap-[4px]">
                        <Text className="text-[13px] text-text font-pp-medium">{slippageLabel(slippage)}</Text>
                        {/* nw-keep(data-color): glyph colour is a runtime theme token (vector-icon sink) */}
                        <Ionicons name={slippageOpen || customSlippageError ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
                      </View>
                    </Pressable>
                  ) : (
                    <Text className="w-full text-[13px] text-text-muted font-pp-medium">Max slippage</Text>
                  )}
                  {(!tight || slippageOpen || !!customSlippageError) && <View className="flex-row gap-[6px]">
                    {SLIPPAGE_OPTIONS.map((s) => {
                      const selected = s === slippage;
                      return (
                        <Pressable
                          key={s}
                          className={`flex-row items-center gap-[6px] rounded-legacy-8 border px-[10px] py-[6px] ${selected ? 'border-tint bg-background-secondary' : 'border-border bg-transparent'}`}
                          onPress={() => {
                            setCustomSlippageDraft('');
                            setCustomSlippageError(null);
                            editSlippage(s);
                          }}
                        >
                          <Text className={`text-[13px] text-text ${selected ? 'font-pp-bold' : 'font-pp-regular'}`}>{(s * 100).toFixed(1)}%</Text>
                        </Pressable>
                      );
                    })}
                    {/* Custom is a field, not a chip that opens something. The
                        row has the width, and a number is faster to type than it
                        is to reach through a popup (Pat, 2026-09-22). It applies
                        as soon as what is typed is valid, so there is no Apply to
                        forget; an invalid or out-of-range value simply does not
                        apply and says why underneath. */}
                    <View className={`h-[33px] flex-row items-center rounded-legacy-8 border px-[10px] ${customSlippageError ? 'border-[#E53935]' : customSelected ? 'border-tint bg-background-secondary' : 'border-border'}`}>
                      <TextInput
                        testID="swap-slippage-custom-input"
                        className={`text-[13px] w-[46px] p-0 m-0 text-text ${customSelected ? 'font-pp-bold' : 'font-pp-regular'}`}
                        // nw-keep(platform-css): web-only outlineStyle:none removes the focus ring; empty on native
                        style={WEB_NO_OUTLINE}
                        value={customSlippageDraft}
                        onChangeText={(next) => {
                          setCustomSlippageDraft(next);
                          if (!next.trim()) { setCustomSlippageError(null); return; }
                          // Refused, never clamped: silently turning 300 into 30
                          // would authorise a number nobody agreed to.
                          const parsed = parseCustomSlippage(next);
                          if (!parsed.ok) { setCustomSlippageError(parsed.error); return; }
                          setCustomSlippageError(null);
                          editSlippage(parsed.fraction);
                        }}
                        placeholder="Custom"
                        placeholderTextColor="#999999"
                        keyboardType="decimal-pad"
                        inputMode="decimal"
                        autoCapitalize="none"
                        autoCorrect={false}
                        maxLength={6}
                      />
                      {!!customSlippageDraft.trim() && (
                        <Text className="text-[13px] text-text-secondary font-pp-regular">%</Text>
                      )}
                    </View>
                  </View>}
                  {customSlippageError && (
                    <Text className="text-[12px] text-[#E53935] font-pp-regular">{customSlippageError}</Text>
                  )}
                </View>

                <Pressable
                  className={`min-w-[160px] items-center rounded-control bg-button-primary px-[20px] py-[12px] ${(!canReview || isQuoting) ? 'opacity-50' : ''}`}
                  onPress={requestReview}
                  disabled={!canReview || isQuoting}
                >
                  <Text className="text-[14px] text-button-primary-text font-pp-medium">
                    {isQuoting
                      ? (isReshield ? 'Estimating…' : 'Fetching route…')
                      : 'Review swap'}
                  </Text>
                </Pressable>
              </ScrollView>
            )}

            {/* Reshield review (guide flow 3). Every figure is an estimate:
                the signed quote is only fetched at Confirm, after the deposit
                proof, so there is nothing here to count down. */}
            {step === 'review' && <PendingRelayNotice chainId={chainId} owner={sessionAddress ?? address} />}

            {step === 'review' && isReshield && reshieldSnapshot && (
              <ScrollView className="w-full" contentContainerClassName="gap-[14px]">
                <Text className="w-full text-center text-[24px] text-text font-pp-sans-bold">Review swap</Text>
                <View className="flex-row justify-center">
                  <View className="rounded-legacy-6 border border-success px-[8px] py-[3px]">
                    <Text className="text-[10px] tracking-[0.4px] text-success font-pp-semi-bold">
                      {reshieldSnapshot.destinationChainId !== chainId
                        ? 'STAYS PRIVATE · CROSSES CHAINS'
                        : 'STAYS PRIVATE · 1 TRANSACTION'}
                    </Text>
                  </View>
                </View>

                {/* What a cross-chain reshield does that the same-chain one does
                    not: two legs, and a far leg with no protocol-owned verifier,
                    so its failure recourse is a plain payout to the user's own
                    address on that chain. Saying this at Review is the only
                    place it can still change the decision. */}
                {reshieldSnapshot.destinationChainId !== chainId && (
                  <View className="w-full gap-[6px] rounded-legacy-8 border border-border bg-background-secondary px-[12px] py-[10px]">
                    <Text className="text-[12px] leading-[17px] text-text-secondary font-pp-regular">
                      The new note lands in the {getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`} pool. This chain&apos;s transaction confirms first; the deposit over there follows and can take a few minutes.
                    </Text>
                    {reshieldSnapshot.fallbackAddress && (
                      <Text className="text-[12px] leading-[17px] text-text-secondary font-pp-regular">
                        If the far side cannot deposit, the funds are paid to {reshieldSnapshot.fallbackAddress.slice(0, 6)}…{reshieldSnapshot.fallbackAddress.slice(-4)} on that chain as an ordinary transfer, which is public.
                      </Text>
                    )}
                  </View>
                )}

                {swapError && (
                  <View className="w-full rounded-legacy-8 border border-danger bg-danger-bg px-[12px] py-[10px]">
                    <Text className="text-[12px] leading-[17px] text-danger font-pp-medium" testID="swap-error">{swapError}</Text>
                  </View>
                )}

                {/* Grouped BY LEG, each group captioned with its own token.
                    The flat eight-row table read as inconsistent units ("why
                    is the relayer fee in USDC and the vetting fee in ETH?")
                    when both are correct and simply belong to different legs:

                      pool exit  → the relayer prices its 900k-gas relay in the
                                   token it withdraws (relayer
                                   evm.quote.service.ts quoteSwap: nativeToToken
                                   with assetConfig(asset).decimals), so the fee
                                   is in the token you spend;
                      deposit    → Entrypoint.deposit charges
                                   calcFee(_value, assetConfigs[_asset].
                                   vettingFeeBPS) on the asset being DEPOSITED
                                   (Entrypoint.sol:72), which on a reshield is
                                   the swap OUTPUT, so it is in the token you
                                   receive.

                    Symbols come from the same SwapTokenInfo the numbers were
                    formatted with (shapeReshieldForDisplay's input/output), so
                    a caption can never relabel the other leg's units. */}
                <View className="w-full gap-[8px] rounded-control border border-border p-[16px]">
                  <Text className="text-[10px] tracking-[0.4px] text-text-muted font-pp-semi-bold">
                    YOU PAY · {displayTokenSymbol(reshieldSnapshot.fromToken.symbol)}
                  </Text>
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">You swap</Text>
                    <BalanceAmount view={balanceDisplay(formatUnits(reshieldSnapshot.grossWei, reshieldSnapshot.fromToken.decimals), reshieldSnapshot.fromToken.symbol, chainId)} className="text-[13px] text-text font-pp-regular" />
                  </View>
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">Relayer fee</Text>
                    <BalanceAmount view={balanceDisplay(formatUnits(BigInt(reshieldSnapshot.estimate.feeAmount), reshieldSnapshot.fromToken.decimals), reshieldSnapshot.fromToken.symbol, chainId)} className="text-[13px] text-text font-pp-regular" />
                  </View>
                  <FeeWarning breakdown={reshieldFeeBreakdown} testID="reshield-fee-warning" />
                </View>

                <View className="w-full gap-[8px] rounded-control border border-border p-[16px]">
                  <Text className="text-[10px] tracking-[0.4px] text-text-muted font-pp-semi-bold">
                    YOU RECEIVE · {displayTokenSymbol(reshieldSnapshot.outputToken.symbol)}
                    {reshieldSnapshot.destinationChainId !== chainId
                      ? ` ON ${(getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `CHAIN ${reshieldSnapshot.destinationChainId}`).toUpperCase()}`
                      : ''}
                  </Text>
                  {/* The only line that says what the user ends up holding. It
                      is BELOW the swap minimum by design (an extra 1% safety
                      cut plus the vetting fee), so showing the swap minimum as
                      the outcome would promise more than the deposit creates. */}
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">
                      {reshieldSnapshot.recipient ? 'New shielded note for them (at least)' : 'New shielded note (at least)'}
                    </Text>
                    <BalanceAmount view={balanceDisplay(formatUnits(reshieldSnapshot.display.newNoteValueWei, reshieldSnapshot.outputToken.decimals), reshieldSnapshot.outputToken.symbol, reshieldSnapshot.destinationChainId)} className="text-[13px] text-text font-pp-bold" />
                  </View>
                  {reshieldSnapshot.recipient && (
                    <View className="flex-row flex-wrap items-center justify-between gap-[8px]" testID="swap-send-review-recipient">
                      <Text className="text-[13px] text-text-muted font-pp-medium">To</Text>
                      <Text className="text-[13px] text-text font-pp-regular">{reshieldSnapshot.recipient.slice(0, 6)}…{reshieldSnapshot.recipient.slice(-4)}</Text>
                    </View>
                  )}
                  {reshieldSnapshot.recipient && (
                    <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular" testID="swap-send-review-claim">
                      {reshieldSnapshot.recipientBlind ? SWAP_SEND_CLAIM_WHY : SWAP_SEND_NO_CLAIM}
                    </Text>
                  )}
                </View>

                {/* One line instead of a paragraph. The why sits behind the
                    (i), which toggles rather than hovers so it works on native
                    and on touch web. */}
                <View className="w-full flex-row items-center gap-[6px]">
                  <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular">Estimates until you confirm.</Text>
                  <Pressable
                    onPress={() => setReshieldHintOpen((open) => !open)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: reshieldHintOpen }}
                    accessibilityLabel="Why these are estimates"
                    testID="reshield-estimate-hint"
                    hitSlop={8}
                  >
                    {/* nw-keep(data-color): glyph color is a runtime theme token (vector-icon sink) */}
                    <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
                  </Pressable>
                </View>
                {reshieldHintOpen && (
                  <Text className="w-full text-[12px] leading-[17px] text-text-secondary font-pp-regular">
                    Confirming proves the deposit on your device and only then takes the relayer&apos;s final quote, so the exact amounts are fixed at submission. The transaction is atomic. If it fails, nothing leaves the pool.
                  </Text>
                )}

                {/* The rest of the breakdown, one tap away. Every row still
                    carries its own symbol, so a USDC line and an ETH line can
                    never be read as one currency. */}
                <Pressable
                  className="w-full flex-row items-center gap-[6px]"
                  onPress={() => setReshieldDetailsOpen((open) => !open)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: reshieldDetailsOpen }}
                  testID="reshield-details-toggle"
                  hitSlop={8}
                >
                  <Text className="text-[12px] text-text-secondary font-pp-medium">Details</Text>
                  <Text className="text-[12px] text-text-muted">{reshieldDetailsOpen ? '▴' : '▾'}</Text>
                </Pressable>
                {reshieldDetailsOpen && (
                  <View className="w-full gap-[8px] rounded-control border border-border p-[16px]" testID="reshield-details">
                    <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                      <Text className="text-[13px] text-text-muted font-pp-medium">Swapped after fee</Text>
                      <BalanceAmount view={balanceDisplay(formatUnits(BigInt(reshieldSnapshot.estimate.netSwapAmount), swapInputUnits(chainId, reshieldSnapshot.fromToken.address, reshieldSnapshot.fromToken).decimals), swapInputUnits(chainId, reshieldSnapshot.fromToken.address, reshieldSnapshot.fromToken).symbol, chainId)} className="text-[13px] text-text font-pp-regular" />
                    </View>
                    <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                      <Text className="text-[13px] text-text-muted font-pp-medium">Swap output (est.)</Text>
                      <BalanceAmount view={balanceDisplay(formatUnits(BigInt(reshieldSnapshot.estimate.estimatedOutput), reshieldSnapshot.outputToken.decimals), reshieldSnapshot.outputToken.symbol, reshieldSnapshot.destinationChainId)} className="text-[13px] text-text font-pp-regular" />
                    </View>
                    <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                      <Text className="text-[13px] text-text-muted font-pp-medium">Swap output (min.)</Text>
                      <BalanceAmount view={balanceDisplay(formatUnits(BigInt(reshieldSnapshot.estimate.estimatedMinOutput), reshieldSnapshot.outputToken.decimals), reshieldSnapshot.outputToken.symbol, reshieldSnapshot.destinationChainId)} className="text-[13px] text-text font-pp-regular" />
                    </View>
                    {/* Named for the leg that charges it. The Entrypoint takes
                        it on the DEPOSIT, so it is in the deposited token. */}
                    <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                      <Text className="text-[13px] text-text-muted font-pp-medium">Pool vetting fee on the new note</Text>
                      <BalanceAmount view={balanceDisplay(formatUnits(BigInt(reshieldSnapshot.estimate.vettingFee), reshieldSnapshot.outputToken.decimals), reshieldSnapshot.outputToken.symbol, reshieldSnapshot.destinationChainId)} className="text-[13px] text-text font-pp-regular" />
                    </View>
                    <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                      <Text className="text-[13px] text-text-muted font-pp-medium">Max slippage</Text>
                      <Text className="text-[13px] text-text font-pp-regular">{slippageLabel(reshieldSnapshot.slippage)}</Text>
                    </View>
                    {/* Guide §10 asks for dust to be surfaced even same-chain: the
                        swap output rarely matches the proven note value exactly, and
                        the remainder is swept to the relayer rather than returned. */}
                    <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular">
                      Dust, the small remainder between the swap output and the redeposited note, goes to the relayer.
                    </Text>
                  </View>
                )}

                <View className="w-full flex-row flex-wrap justify-center gap-[10px]">
                  <Pressable
                    className="min-w-[120px] items-center rounded-control border border-border px-[20px] py-[12px]"
                    onPress={backToInput}
                  >
                    <Text className="text-[14px] text-text font-pp-medium">Back</Text>
                  </Pressable>
                  <Pressable
                    className="min-w-[160px] items-center rounded-control bg-button-primary px-[20px] py-[12px]"
                    onPress={confirmActive}
                  >
                    <Text className="text-[14px] text-button-primary-text font-pp-medium">Confirm swap</Text>
                  </Pressable>
                </View>
              </ScrollView>
            )}

            {step === 'review' && !isReshield && snapshot && (
              <ScrollView className="w-full" contentContainerClassName="gap-[14px]">
                <Text className="w-full text-center text-[24px] text-text font-pp-sans-bold">Review swap</Text>
                <View className="flex-row justify-center">
                  <View className="rounded-legacy-6 border border-success px-[8px] py-[3px]">
                    <Text className="text-[10px] tracking-[0.4px] text-success font-pp-semi-bold">
                      {snapshot.crossChain ? `CROSS-CHAIN · TO ${snapshot.destinationName.toUpperCase()}` : 'SAME CHAIN · 1 TRANSACTION'}
                    </Text>
                  </View>
                </View>

                {swapError && (
                  <View className="w-full rounded-legacy-8 border border-danger bg-danger-bg px-[12px] py-[10px]">
                    <Text className="text-[12px] leading-[17px] text-danger font-pp-medium" testID="swap-error">{swapError}</Text>
                  </View>
                )}

                <View className="w-full gap-[8px] rounded-control border border-border p-[16px]">
                  {/* The asset you PAY, which the received side already handles
                      through tokenAmountLabel. These three are SHARE counts, so
                      approxUnderlyingText renames them to the underlying and
                      marks them approximate: the gap is the accrued rate, and it
                      understates rather than overstates. The share is named
                      nowhere the user reads. A plain symbol passes through. */}
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">You swap</Text>
                    <BalanceAmount view={balanceDisplay(snapshot.amountText, snapshot.fromToken.symbol, chainId)} className="text-[13px] text-text font-pp-regular" />
                  </View>
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">Relayer fee</Text>
                    <BalanceAmount view={balanceDisplay(snapshot.display.relayerFee, snapshot.fromToken.symbol, chainId)} className="text-[13px] text-text font-pp-regular" />
                  </View>
                  <FeeWarning breakdown={walletFeeBreakdown} testID="swap-fee-warning" />
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">Swapped after fee</Text>
                    <BalanceAmount view={balanceDisplay(snapshot.display.netSwapped, snapshot.fromToken.symbol, chainId)} className="text-[13px] text-text font-pp-regular" />
                  </View>
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">Estimated received</Text>
                    <Text className="text-[13px] text-text font-pp-regular">{balanceDisplay(snapshot.display.estimatedOutput, snapshot.outputToken.symbol, snapshot.destinationChainId).text}</Text>
                  </View>
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">Min received</Text>
                    <Text className="text-[13px] text-text font-pp-bold">{balanceDisplay(snapshot.display.minReceived, snapshot.outputToken.symbol, snapshot.destinationChainId).text}</Text>
                  </View>
                  {!!snapshot.display.rate && (
                    <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                      <Text className="text-[13px] text-text-muted font-pp-medium">Rate</Text>
                      <Text className="text-[13px] text-text font-pp-regular">1 {balanceDisplay('1', snapshot.fromToken.symbol, chainId).symbol} ≈ {Number(snapshot.display.rate) * balanceDisplay('1', snapshot.outputToken.symbol, snapshot.destinationChainId).amount / balanceDisplay('1', snapshot.fromToken.symbol, chainId).amount} {balanceDisplay('1', snapshot.outputToken.symbol, snapshot.destinationChainId).symbol}</Text>
                    </View>
                  )}
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">Max slippage</Text>
                    <Text className="text-[13px] text-text font-pp-regular">{slippageLabel(snapshot.slippage)}</Text>
                  </View>
                  <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                    <Text className="text-[13px] text-text-muted font-pp-medium">Recipient</Text>
                    <Text className="text-[13px] text-text font-pp-regular">{snapshot.recipient.slice(0, 6)}…{snapshot.recipient.slice(-4)}</Text>
                  </View>
                </View>

                {/* Route — proof-bound at quote time */}
                <View className="w-full gap-[8px] rounded-control border border-border p-[16px]">
                  <Text className="text-[10px] tracking-[0.4px] text-text-muted font-pp-semi-bold">
                    ROUTE · LOCKED AT QUOTE, SEALED IN YOUR PROOF
                  </Text>
                  <View className="flex-row flex-wrap items-center gap-[8px]">
                    {[
                      `${displayTokenSymbol(snapshot.fromToken.symbol)} · pool exit`,
                      `${statusBridgeFor(snapshot.prepared.swapTarget) ? 'Across' : 'LI.FI'} ${snapshot.prepared.swapTarget.slice(0, 6)}…${snapshot.prepared.swapTarget.slice(-4)}`,
                      snapshot.crossChain ? `bridge → ${snapshot.destinationName}` : `${displayTokenSymbol(snapshot.outputToken.symbol)} → recipient`,
                    ].map((hop, i, arr) => (
                      <React.Fragment key={hop}>
                        <View className="rounded-legacy-6 border border-border px-[8px] py-[3px]">
                          <Text className="text-[11px] text-text font-pp-regular">{hop}</Text>
                        </View>
                        {i < arr.length - 1 && <Text className="text-[11px] text-text-muted">→</Text>}
                      </React.Fragment>
                    ))}
                  </View>
                  <Text className="text-[12px] leading-[17px] text-text-muted font-pp-regular">
                    The relayer signed this exact routing (fee commitment). It cannot alter route, amounts, or recipient after your proof is generated.
                  </Text>
                </View>

                {countdown !== null && (
                  <Text className={`text-center text-[12px] leading-[17px] font-pp-medium ${countdown <= 10 ? 'text-danger' : 'text-text-muted'}`}>
                    Quote expires in {countdown}s
                  </Text>
                )}

                <View className="w-full flex-row gap-[10px]">
                  <Pressable
                    className="items-center rounded-control border border-border bg-card-background px-[20px] py-[12px]"
                    onPress={backToInput}
                  >
                    <Text className="text-[14px] text-text font-pp-medium">Back</Text>
                  </Pressable>
                  <Pressable
                    className="min-w-[160px] grow items-center rounded-control bg-button-primary px-[20px] py-[12px]"
                    onPress={confirmSwap}
                  >
                    <Text className="text-[14px] text-button-primary-text font-pp-medium">Confirm swap</Text>
                  </Pressable>
                </View>
              </ScrollView>
            )}

            {/* Reshield progress. Four real SDK steps run here (not one), so
                the stage list tracks executingLabel rather than pretending the
                route was locked earlier. It wasn't. */}
            {step === 'executing' && isReshield && reshieldSnapshot && (
              <View className="w-full items-center gap-[14px] py-[8px]">
                <Text className="w-full text-center text-[24px] text-text font-pp-sans-bold">Swapping…</Text>
                {/* Same stepped line Shield and Withdraw show while they run;
                    the phase follows the step labels (Pat, 2026-08-30). */}
                <FlowProgress message={executingLabel} showMessage={false} />
                <Text className="text-center text-[13px] text-text font-pp-bold">{executingLabel}</Text>
                <Text className="text-center text-[12px] leading-[17px] text-text-muted font-pp-regular">
                  Proof runs on your device and can take a while. The transaction is atomic. If any step fails, your notes are not spent and nothing leaves the pool.
                </Text>
              </View>
            )}

            {step === 'success' && isReshield && reshieldSnapshot && (
              <View className="w-full items-center gap-[14px] py-[8px]">
                {/* nw-keep(data-color): result mark stroke color is a theme token (success, muted or warning) into the SVG icon prop */}
                {swapResultIndicator(delivery, false).tone === 'warning'
                  ? <AlertCircleIcon color={colors.warning} />
                  : <CheckCircleIcon color={swapResultIndicator(delivery, false).tone === 'success' ? colors.success : colors.textMuted} />}
                <Text className="w-full text-center text-[24px] text-text font-pp-sans-bold">
                  {swapOutcomeTitle(delivery, sourceChainName, 'Swap submitted')}
                </Text>
                {reshieldSnapshot.recipient && !reshieldSnapshot.recipientBlind && !(delivery?.status === 'recovered' || delivery?.status === 'failed') && (
                  <Text className="w-full text-center text-[12px] text-text-muted font-pp-regular" testID="swap-send-success-no-claim">
                    {SWAP_SEND_NO_CLAIM}
                  </Text>
                )}
                {claimUrl && reshieldSnapshot.recipientBlind && (
                  delivery?.status === 'recovered' || delivery?.status === 'failed' ? (
                    /* DEV-425 class: the far side paid the fallback address
                       instead of depositing, so there is no note to claim. */
                    <Text className="w-full text-center text-[12px] leading-[17px] text-danger font-pp-regular" testID="swap-claim-link-void">
                      {delivery?.status === 'recovered'
                        ? 'No deposit was made for the recipient, so the claim link will not work. The funds went to your fallback address.'
                        : 'No deposit was made for the recipient, so the claim link will not work.'}
                    </Text>
                  ) : (
                    <View className="w-full gap-[10px] rounded-control border border-border bg-background-secondary p-[14px]">
                      <Text className="text-center text-[13px] leading-[19px] text-text font-pp-medium">
                        {CLAIM_LINK_INSTRUCTION}
                      </Text>
                      <Text className="text-center text-[12px] text-text-muted font-pp-regular" testID="swap-claim-link-chain">
                        Claimable on {getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`}.
                      </Text>
                      <Text numberOfLines={1} className="text-center text-[12px] text-text-secondary font-pp-regular" testID="swap-claim-link-preview">
                        {previewNoteReceiptUrl(claimUrl)}
                      </Text>
                      <Pressable
                        className="w-full items-center justify-center rounded-control bg-button-primary px-[16px] py-[14px]"
                        testID="swap-copy-claim-link"
                        onPress={() => {
                          void (async () => {
                            if (await copyClaimLink()) return;
                            toast({ title: 'Could not copy. The link is also on the transaction row, under Recover claim link.', variant: 'destructive' });
                          })();
                        }}
                      >
                        <Text className="text-[15px] text-button-primary-text font-pp-semi-bold">
                          {claimCopied ? 'Copied ✓' : 'Copy claim link'}
                        </Text>
                      </Pressable>
                    </View>
                  )
                )}
                {/* The promise of a new note is only true while the far leg can
                    still produce one. Once the bridge says it paid the fallback
                    address instead, repeating it is the false success QA hit. */}
                {!(delivery?.status === 'recovered' || delivery?.status === 'failed') && (
                  <Text className="w-full text-center text-[12px] text-text-muted font-pp-regular">
                    {reshieldSnapshot.destinationChainId !== chainId && reshieldSnapshot.recipient && delivery?.status === 'done'
                      ? `At least ${balanceDisplay(formatUnits(reshieldSnapshot.display.newNoteValueWei, reshieldSnapshot.outputToken.decimals), reshieldSnapshot.outputToken.symbol, reshieldSnapshot.destinationChainId).text} was deposited as a new shielded note for ${reshieldSnapshot.recipient.slice(0, 6)}…${reshieldSnapshot.recipient.slice(-4)} on ${getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`}. They will see it after their next sync.`
                      : reshieldSnapshot.destinationChainId !== chainId && reshieldSnapshot.recipient
                      ? `At least ${balanceDisplay(formatUnits(reshieldSnapshot.display.newNoteValueWei, reshieldSnapshot.outputToken.decimals), reshieldSnapshot.outputToken.symbol, reshieldSnapshot.destinationChainId).text} is being deposited as a new shielded note for ${reshieldSnapshot.recipient.slice(0, 6)}…${reshieldSnapshot.recipient.slice(-4)} on ${getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`}. The deposit follows this transaction and can take a few minutes.`
                      : reshieldSnapshot.destinationChainId !== chainId
                      ? `At least ${balanceDisplay(formatUnits(reshieldSnapshot.display.newNoteValueWei, reshieldSnapshot.outputToken.decimals), reshieldSnapshot.outputToken.symbol, reshieldSnapshot.destinationChainId).text} as a new shielded note on ${getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`}. The transaction above is this chain's leg; the deposit over there follows and can take a few minutes, and it becomes spendable once that pool's association set includes it.`
                      : reshieldSnapshot.recipient
                        ? `At least ${balanceDisplay(formatUnits(reshieldSnapshot.display.newNoteValueWei, reshieldSnapshot.outputToken.decimals), reshieldSnapshot.outputToken.symbol, reshieldSnapshot.destinationChainId).text} was deposited as a new shielded note for ${reshieldSnapshot.recipient.slice(0, 6)}…${reshieldSnapshot.recipient.slice(-4)}. They will see it after their next sync, and it becomes spendable once the pool's association set includes it.`
                        : `At least ${balanceDisplay(formatUnits(reshieldSnapshot.display.newNoteValueWei, reshieldSnapshot.outputToken.decimals), reshieldSnapshot.outputToken.symbol, reshieldSnapshot.destinationChainId).text} as a new shielded note. It becomes spendable once the pool's association set includes it.`}
                  </Text>
                )}
                {/* Live status of the far leg, same tracker flow 1 uses. Without
                    it a cross-chain reshield ended on "can take a few minutes"
                    and never said whether the deposit actually landed. */}
                {reshieldSnapshot.destinationChainId !== chainId && delivery && (
                  <Text className={`w-full text-center text-[12px] font-pp-regular ${delivery.status === 'failed' || delivery.status === 'recovered' ? 'text-danger' : 'text-text-muted'}`}>
                    {delivery.status === 'done'
                      ? `Deposited on ${getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`}.${reshieldSnapshot.recipient ? '' : ' Shows there after the next sync.'}`
                      : delivery.status === 'recovered'
                      ? `The deposit on ${getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`} did not run, so ${recoveredWhere(delivery.refunded, sourceChainName, getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`)}. It is in your wallet, not in the pool.`
                      : delivery.status === 'failed'
                        ? `The deposit on ${getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`} did not complete${delivery.detail ? `: ${delivery.detail}` : ''}. LI.FI pays the fallback address on that chain when the far side cannot deposit.`
                        : `${deliveryProgress ?? 'Tracking the bridge…'} Deposit pending on ${getChainConfig(reshieldSnapshot.destinationChainId)?.displayName ?? `chain ${reshieldSnapshot.destinationChainId}`}.`}
                  </Text>
                )}
                {swapResultIndicator(delivery, reshieldSyncWarning).showNoteSyncWarning && (
                  <View className="w-full rounded-legacy-8 border border-warning bg-warning-bg px-[12px] py-[10px]">
                    <Text className="text-[12px] leading-[17px] text-warning font-pp-medium">
                      The transaction succeeded, but this device couldn&apos;t record the new note. Your funds are safe. Reload or re-sync to pick the balance up.
                    </Text>
                  </View>
                )}
                {explorerUrl && (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => { void Linking.openURL(explorerUrl); }}>
                    <Text className="text-[13px] underline text-tint font-pp-medium">View transaction</Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={getExplorerName(txChainId ?? chainId)} />
                  </View>
                )}
                {lifiScanLink && (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => { void Linking.openURL(lifiScanLink); }} testID="bridge-lifi-scan-link">
                    <Text className="text-[13px] underline text-tint font-pp-medium">Track on LI.FI Scan</Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={'LI.FI Scan'} />
                  </View>
                )}
                {destinationExplorerUrl && (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => { void Linking.openURL(destinationExplorerUrl); }}>
                    <Text className="text-[13px] underline text-tint font-pp-medium">View on {destinationExplorerName}</Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={getExplorerName(pendingDeliveryChainId ?? chainId)} />
                  </View>
                )}
                <Pressable className="min-w-[160px] items-center rounded-control bg-button-primary px-[20px] py-[12px]" onPress={() => guardClaimLeave(() => setIsOpen(false))} testID="swap-success-done">
                  <Text className="text-[14px] text-button-primary-text font-pp-medium">Done</Text>
                </Pressable>
              </View>
            )}

            {step === 'executing' && !isReshield && snapshot && (
              <View className="w-full items-center gap-[14px] py-[8px]">
                <Text className="w-full text-center text-[24px] text-text font-pp-sans-bold">Swapping…</Text>
                {/* Same stepped line Shield and Withdraw show while they run;
                    the phase follows the step labels (Pat, 2026-08-30). */}
                <FlowProgress message={executingLabel} showMessage={false} />
                <Text className="text-center text-[13px] text-text font-pp-bold">{executingLabel}</Text>
                {snapshot.crossChain ? (
                  <Text className="text-center text-[12px] leading-[17px] text-text-muted font-pp-regular">
                    Then delivery on {snapshot.destinationName}, tracked once this transaction confirms.
                  </Text>
                ) : null}
                <Text className="text-center text-[12px] leading-[17px] text-text-muted font-pp-regular">
                  {snapshot.crossChain
                    ? 'Proof runs on your device. The source transaction is atomic. If it fails, funds never leave the pool. Bridge delivery is tracked separately after it confirms.'
                    : 'Proof runs on your device. If any on-chain step fails, the whole transaction reverts. Funds never leave the pool.'}
                </Text>
              </View>
            )}

            {step === 'success' && !isReshield && snapshot && (
              <View className="w-full items-center gap-[14px] py-[8px]">
                {/* nw-keep(data-color): result mark stroke color is a theme token (success, muted or warning) into the SVG icon prop */}
                {swapResultIndicator(delivery, false).tone === 'warning'
                  ? <AlertCircleIcon color={colors.warning} />
                  : <CheckCircleIcon color={swapResultIndicator(delivery, false).tone === 'success' ? colors.success : colors.textMuted} />}
                <Text className="w-full text-center text-[24px] text-text font-pp-sans-bold">
                  {swapOutcomeTitle(delivery, sourceChainName, snapshot.crossChain ? 'Source transaction confirmed' : 'Swap submitted')}
                </Text>
                {!snapshot.crossChain && (
                  <Text className="w-full text-center text-[12px] text-text-muted font-pp-regular">
                    Min {balanceDisplay(snapshot.display.minReceived, snapshot.outputToken.symbol, snapshot.destinationChainId).text} to your recipient.
                  </Text>
                )}
                {snapshot.crossChain && (
                  <Text className={`w-full text-center text-[12px] font-pp-regular ${delivery?.status === 'failed' || delivery?.status === 'recovered' ? 'text-danger' : 'text-text-muted'}`}>
                    {delivery?.status === 'recovered' && delivery.refunded
                      ? `The swap on ${snapshot.destinationName} did not run, so ${recoveredWhere(true, sourceChainName, snapshot.destinationName)}.`
                      : delivery?.status === 'done'
                      ? `Delivered on ${snapshot.destinationName} (min ${balanceDisplay(snapshot.display.minReceived, snapshot.outputToken.symbol, snapshot.destinationChainId).text}).`
                      : delivery?.status === 'recovered'
                      ? `The swap on ${snapshot.destinationName} did not run, so the bridge paid your address there in the token it carried rather than ${displayTokenSymbol(snapshot.outputToken.symbol)}.`
                      : delivery?.status === 'failed'
                        ? `Bridge delivery failed${delivery.detail ? `: ${delivery.detail}` : ''}. Destination-swap failures refund to your address on ${snapshot.destinationName}; certain bridge failures refund to the source-chain RelaySwaps contract and need relayer assistance to recover.`
                        : `${deliveryProgress ?? 'Tracking the bridge…'} Delivery pending on ${snapshot.destinationName}.`}
                  </Text>
                )}
                {explorerUrl && (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => { void Linking.openURL(explorerUrl); }}>
                    <Text className="text-[13px] underline text-tint font-pp-medium">View transaction</Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={getExplorerName(txChainId ?? chainId)} />
                  </View>
                )}
                {lifiScanLink && (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => { void Linking.openURL(lifiScanLink); }} testID="bridge-lifi-scan-link">
                    <Text className="text-[13px] underline text-tint font-pp-medium">Track on LI.FI Scan</Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={'LI.FI Scan'} />
                  </View>
                )}
                {destinationExplorerUrl && (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => { void Linking.openURL(destinationExplorerUrl); }}>
                    <Text className="text-[13px] underline text-tint font-pp-medium">View on {destinationExplorerName}</Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={getExplorerName(pendingDeliveryChainId ?? chainId)} />
                  </View>
                )}
                <Pressable className="min-w-[160px] items-center rounded-control bg-button-primary px-[20px] py-[12px]" onPress={() => setIsOpen(false)}>
                  <Text className="text-[14px] text-button-primary-text font-pp-medium">Done</Text>
                </Pressable>
              </View>
            )}
        </OpShell>
      )}

      {/* Output token + destination network — the SAME two-pane selector the
          deposit modal uses. The network pane IS the destination-chain
          picker; it lists one chain until cross-chain destinations exist. */}
      {isOpen && selectorOpen && (
        <TokenNetworkSelector
          tokens={outputTokens}
          networks={destinationChains}
          selectedTokenSymbol={outputToken?.token.symbol ?? ''}
          activeNetworkId={destinationChainId}
          onSelectToken={(t) => {
            const token = outputTokens.find((x) => x.address.toLowerCase() === t.address.toLowerCase());
            if (token) {
              invalidateQuoteRequests();
              setOutputToken({ token, chainId: destinationChainId });
            }
            setSelectorOpen(false);
          }}
          onSelectNetwork={(id) => {
            // A reshield CAN move chains now (flow 4), but only for a pair the
            // gate approves: anything else would build a request the SDK
            // cannot serve, so those selections are refused rather than
            // quoted. Returning to the pool chain is always allowed.
            if (isReshield && id !== chainId && !crossChainReshieldSupported(chainId, id)) return;
            invalidateQuoteRequests();
            setDestinationChainId(id);
          }}
          onClose={() => setSelectorOpen(false)}
          networkTitle="Destination network"
        />
      )}
    </SwapModalContext.Provider>
  );
}
