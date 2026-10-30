import { spendableBalanceLabel } from '@/services/spendable-balance-label';
import { presetExceedsWithdrawMax } from '@/services/withdraw-preset-guard';
import { useShareAmountField } from '@/hooks/use-share-amount-field';
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
import { compactPhoneLayout } from '@/services/header-nav';
import { HoverHint } from '@/components/ui/hover-hint';
import { crossFlowsEnabled } from '@/config/intent-lockdown';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { usesNativeWithdrawPresets } from '@/services/withdraw-preset-rule';
import { usePools } from '@/components/pools-provider';
import { hubTokenCatalog, heldSymbolsFor, preferredHubToken, emptySpendToken } from '@/services/hub-token-catalog';
import { poolDisplayLabel } from '@/config/pool-paths';
import React, { createContext, useContext, useState, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useMemo } from 'react';
import { KeySourceChangedError } from '@/components/sdk-provider';
import { normalizeHex, truncateAddress } from '@/services/hex-format';
import { FlowProgress } from '@/components/ui/flow-progress';
import { staleBundleMessage } from '@/services/stale-bundle';
import { reportErrorReport } from '@/services/error-reports';
import { classifyFailure } from '@/services/error-reports-cause';
import type { ErrorReportStage } from '@/services/error-reports-failure';
import {
  DEFAULT_DUST_THRESHOLD,
  DUST_THRESHOLD,
  WITHDRAW_MAX_INPUTS,
  selectWithdrawInputs,
} from '@/services/withdraw-note-selection';
import { CaretDownIcon, CaretUpIcon, CheckCircleIcon, CloseIcon, ModalInfoIcon, SpinnerIcon } from '@/components/ui/modal-icons';
import { DROPDOWN_SHADOW, WEB_FIXED_POSITION, WEB_BLUR_BACKDROP, WEB_NO_OUTLINE } from '@/components/ui/web-style-shims';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useOpLock } from '@/hooks/use-op-lock';
import { View, Text, Pressable, Platform, useWindowDimensions, TextInput, Animated, Easing, Linking } from 'react-native';
import type { ViewStyle, TextStyle } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSignTypedData } from 'wagmi';
import { isAddress, formatUnits } from 'viem';
import { NoteStatus, type Address, type Hex, type Note, type PendingNote, type PoolSession, type TxReceiptLike } from '@/services/sdk-types';
import { Colors, TokenHues } from '@/constants/theme';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/components/theme-provider';
import { useToast } from '@/components/toast-provider';
import { useDebug } from '@/components/debug-provider';
import { useTxActivity } from '@/components/tx-activity-provider';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { getChainConfig, getExplorerName, getExplorerTxUrl, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { estimateStellarRelayFee, maxStellarWithdrawForInputs } from '@/config/stellar-deployment';
import { describeStellarStage, stellarErrorMessage } from '@/services/stellar/stellar-copy';
import { SUI_TESTNET_RELAYER_URL } from '@/config/sui-deployment';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useSuiSession } from '@/hooks/use-sui-session';
import { useLeafGate } from '@/hooks/use-leaf-gate';
import { selectSuiNotes, maxSuiLineageTotal, SUI_SINGLE_NOTE_ERROR, type SuiNoteSelection } from '@/services/sui-witness/note-selection';
import type { StoredSuiNote } from '@/services/sui-witness/note-store';
import { ChainLogo, chainLogoChainFor } from '@/components/ui/chain-logo';
import { BATCH_WITHDRAWALS_ENABLED, LEGACY_CONFIG, TEST_MODE } from '@/config/env';
import {
  batchProgressFraction,
  batchProgressMessage,
  classifyBatchRelayError,
  countFullWithdrawGroups,
  createBatchProgressTracker,
  describeBatchFailure,
  findUnspendableActiveNotes,
  isFullBalanceRequest,
  BatchChangedSinceReviewError,
  BatchPartiallyWithdrawnError,
  planBatchWithdraw,
  withdrawGroupsWithinWindow,
  type BatchFailureStage,
  type BatchProgress,
  type SelectGroupsFn,
} from '@/services/batch-withdrawals';
import { subscribeProofProgress } from '@/services/proof-progress';
import { isFeeCommitmentExpired } from '@/services/fee-commitment';
import { isReprovableRelayRefusal } from '@/services/relayed-transfer';
import { getActionableTokens, getKnownTokenMetadata, getTokenMetadataBySymbol, getTokenMetadata, isStablecoin, formatTokenBalance as sharedFormatTokenBalance } from '@/config/tokens';

import { assertRelayerSwapProcessor } from '@/services/relayer-details';
import { viewOnExplorerLabel } from '@/services/explorer-label';
import { resolveRelayerFee, feeSanity, feeSanityMessage } from '@/services/relayer-fee';
import {
  getWithdrawalProcessorAddress,
  rebindProcessor,
} from '@/config/relayer';
import { supportsColdStartClaim } from '@/config/cold-start';
import {
  buildRegistrationDeadline,
  describeRelayedClaim,
  readRegistrationPath,
  type RegistrationPathDecision,
} from '@/services/cold-start-claim';
import { useNotes } from '@/hooks/use-notes';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useRequireConnection } from '@/hooks/use-require-connection';
import { useRelayerQuote, type WithdrawalQuote } from '@/hooks/use-relayer';
import type { Transaction } from '@/components/pools-provider';
import { resolveConfiguredEntrypoint } from '@/services/pool-entrypoint';
import { invalidateTransactionCaches } from '@/services/cache';
import { recordWithdrawFee } from '@/services/withdraw-fees-store';
import { recordReceiveAs } from '@/services/swap-bookkeeping';
import { recordOwnWithdrawal } from '@/services/withdraw-bookkeeping';
import { recordWithdrawRecipient } from '@/services/withdraw-recipients-store';
import { recordSwap } from '@/services/swap-records-store';
import { fitAmountFontSize, parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import { ENS_UNSUPPORTED_MESSAGE, isPotentialEnsName, normalizeEnsName } from '@/services/ens';
import { FULL_WITHDRAWAL_GUARD_ENABLED } from '@/config/yield';
import {
  FULL_WITHDRAWAL_ESCAPE_TAB,
  guardBlocksCta,
  guardNext,
  INITIAL_GUARD_STATE,
  isFullWithdrawalSelectionWei,
} from '@/services/yield-math';
import { FullWithdrawalGuard } from '@/components/yield/full-withdrawal-guard';
import { useTabCloseGuard } from '@/hooks/use-tab-close-guard';
import {
  intentSwapsEnabledForChain,
  getSwapProcessorAddress,
  getSwapDeliveryTokens,
  intentSwapInputSupported,
  getSwapDestinationChains,
  SWAP_DENY_EXCHANGES,
  type SwapTokenInfo,
  swapInputUnits,
} from '@/config/intent-swaps';
import {
  buildRelayWithdrawAndSwapParams,
  createSwapRequestGuard,
  formatTokenUnits,
  getPreparedQuoteExpiration,
  hasUsableCommitmentLifetime,
  isFreshCommitmentLive,
  InvalidSwapQuoteError,
  validateRefreshedSwapQuote,
  isNoRouteError,
  isSuccessfulSwapReceipt,
  isSwapExitSelection,
  isSwapUnavailableError,
  prepareValidatedSwapQuote,
  selectSwapInputNotes,
  type PreparedSwapQuoteLike,
  type SwapQuoteDisplay,
} from '@/services/intent-swaps';
import {
  buildWithdrawQuoteKey,
  topNAcrossLabels,
  resolveGrossLeavingWei,
  resolveRemainingBalanceWei,
  resolveDisplayAvailableWei,
  resolveEffectiveReceiveExact,
  resolveSingleProofMaxInputWei,
  resolveWithdrawPercentSelection,
  resolveWithdrawMode,
  reviewContextMatches,
  type WithdrawReviewContext,
} from '@/services/withdraw-quotes';
import { floorToDisplayPrecision } from '@/services/swap-flows';
import {
  buildWithdrawSpendabilityKey,
  partitionSuiWithdrawNotes,
  resolveWithdrawSpendableCommitments,
  type WithdrawSpendabilityResolution,
} from '@/services/withdraw-spendability';
import { shouldAutoPickWithdrawToken } from '@/services/withdraw-token-selection';
import { fetchLifiExactInQuote } from '@/services/lifi-quote';
import { swapExitEstimateInputWei, formatSwapExitEstimate } from '@/services/swap-exit-estimate';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { PairArrow } from '@/components/ui/pair-arrow';
import { TokenSelectSheet } from '@/components/ui/token-select-sheet';
import { CopyIconButton } from '@/components/ui/copy-address';
import { OpShell } from '@/components/op-shell';
import { useInlineOpsCapable } from '@/hooks/use-inline-ops-capable';
import { isRelayerNullifierInFlight, isRelayerOutOfGas, isRelayerRateLimited, isRelayerUnreachable, isRelayWaitTimeout, relayerOutOfGasMessage, relayerRateLimitedMessage, relayInFlightMessage, timedOutRelayTxHash } from '@/services/transfer-outcome';
import { aspBusyMessage } from '@/services/asp-backoff';
import { aspBackoff } from '@/services/egress-fetch';
import { onRelayedTxHash } from '@/services/relayed-receipt';
import { isPendingRelayBlocked, landedTxHash } from '@/services/pending-relays-core';
import { createPendingRelaySettleWatch } from '@/services/pending-relays-store';
import { PendingRelayNotice } from '@/components/pending-relay-notice';
import { getYieldDeploymentForAsset } from '@/config/yield';
import { recordOwnAction } from '@/services/own-actions-store';
import { describeRedemption, planYieldRedemption, type YieldRedemptionPlan } from '@/services/yield-redemption';
import { feeWithinReviewed, relayerFeeJitterAllowance } from '@/services/relayer-fee-jitter';
import { quoteMatchesSignedCommitment } from '@/services/relayer-quote-integrity';
import { decodeGasTopUpWei, formatGasTopUp } from '@/services/gas-top-up';
import { setReceiveSetup } from '@/services/receive-setup';
import { tokenAmountLabel, displayTokenSymbol, isShareSymbol, netSharesWei, previewReceiveFigure, shareRedemptionDisclosure, shareReviewHeadline } from '@/services/share-display';
import { sdkErrorText, type ErrorUnits } from '@/services/sdk-error-amounts';
import { RelayFeeIncreasedError, relayWithdrawalWithFreshQuote } from '@/services/relayed-withdrawal';
import { PREVIEW_REDEEM_ABI } from '@/services/deposit-limits';
import { useBackHandler } from '@/hooks/use-back-handler';
import { useNativeMockBlock } from '@/hooks/use-native-mock-block';
import { useFeePricing } from '@/hooks/use-fee-pricing';
import { FeeWarning } from '@/components/fee-warning';
import { buildFeeBreakdown, gasCostUsd, quoteGas, splitRelayerFee, swapLossUsd, type FeeGasReading } from '@/services/fee-warning';

const WITHDRAW_RELAY_METHOD = /^relay(Withdrawal|RegisterAndWithdrawal|WithAnnounce)$/;
const SWAP_EXIT_PENDING_MESSAGE = 'The relayer accepted this withdrawal, but it has not been included in a block yet. It has not failed and can still land, so these funds are held for it. Your balance and history update on their own once it settles; if it is still pending after 10 minutes, report it from the pending notice.';
const WITHDRAW_PENDING_MESSAGE = 'The relayer accepted this withdrawal, but it has not been included in a block yet. It has not failed and can still land. This screen, your balance and your history update on their own when it does. Do not withdraw these funds again: they are held for this withdrawal until it settles.';

// react-native-web supports CSS properties (position:'fixed', backdropFilter, outlineStyle)
// that are absent from React Native's ViewStyle/TextStyle type definitions.
// These typed constants apply web-only styles without `as any`.

// Native asset address constant
const NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';



// --- Icons ---







// === Staged progress feedback (proof generation takes many seconds) ==========
// The three real phases a withdrawal walks through, in order. NOT a timed
// animation: the stage is DERIVED from the flow's own status message
// (`loadingMessage`), which the confirm path already sets at every real await
// boundary (prepare → prove, incl. the batch tracker's "proof i of N" ticks
// from services/proof-progress → relayer submit). A stage therefore only reads
// as complete once the flow itself has posted a message belonging to a later
// phase, and any failure leaves `step === 'loading'` immediately, so nothing
// keeps "progressing" behind an error.

/**
 * Phase index for a live status message. Prefix rules run BEFORE the proof
 * keyword on purpose: the batch submit message mentions "proofs"
 * ("Submitting batch (3 proofs) via relayer...") and the prepare message
 * mentions "proof" ("Preparing withdrawal proof..."). Unknown text falls back
 * to the first stage so the tracker can never over-claim progress.
 */

/**
 * Compact stage rail. The ACTIVE row renders the flow's live message verbatim
 * (so specifics like "Generating proof 2 of 5" survive); the others render the
 * canonical phase name. Static — no animation, nothing for the
 * visual-regression harness (or a reduced-motion user) to see as
 * nondeterministic.
 */

function CheckboxIcon({ checked, color = '#999999' }: { checked: boolean; color?: string }) {
  if (checked) {
    return (
      <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
        <Rect x={0.5} y={0.5} width={15} height={15} rx={2} stroke={color} fill="none" />
        <Path d="M4 8L7 11L12 5" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Rect x={0.5} y={0.5} width={15} height={15} rx={2} stroke={color} fill="none" />
    </Svg>
  );
}

// --- Context ---

type WithdrawModalContextType = {
  openWithdrawModal: (transaction?: Transaction, opts?: { tokenSymbol?: string; amount?: string; inline?: boolean; receiveTokenAddress?: string; receiveChainId?: number; targetAddress?: string }) => void;
  closeWithdrawModal: () => void;
  /** Whether the modal is currently shown — consumed by the URL bridge. */
  isOpen: boolean;
  /** True while the flow draws inside the hub's inline host (no overlay). */
  inlineActive: boolean;
  /** Current flow step — the hub disables its amount card past the form. */
  inlineStep: 'withdraw' | 'review' | 'loading' | 'success' | 'error';
  /** Inline mode: push the hub input's amount into the flow. */
  syncInlineAmount: (text: string) => void;
  /**
   * True while the association set is still loading, so nothing is provably
   * spendable YET. The hub's tap-to-max and the form's max/percent selection
   * wait on it instead of judging amounts against a balance of 0
   * (Pat, 2026-08-28: "the withdraw form should be in loading state").
   */
  spendabilityLoading: boolean;
  /** Verification failed (distinct from loading and a verified zero balance). */
  spendabilityError: string | null;
  /** Retry the shared association-set verification after an error. */
  retrySpendability: () => void;
  /** Current association-set-gated balance for a token, or null while pending/unavailable. */
  getSpendableBalanceWei: (tokenSymbol: string) => bigint | null;
  /** Route-usable Max for a token, or null while spendability is pending/unavailable. */
  getWithdrawMaxWei: (tokenSymbol: string) => bigint | null;
  /**
   * The amount the flow is working with. Inline the hub owns the visible
   * input, so it needs this to adopt an amount it never typed (a launcher's
   * prefill) instead of reading 0 beside a receive row showing the real one.
   */
  inlineAmount: string;
  /** The pool token the flow is spending (DEV-531: the hub keeps it equal to its card token). */
  inlineToken: string;
  /** Inline mode: switch the flow to the hub card's pool token (form step only). */
  syncInlineToken: (symbol: string) => void;
};

function missingProvider(): never {
  throw new Error('useWithdrawModal must be used within a WithdrawModalProvider');
}

const WithdrawModalContext = createContext<WithdrawModalContextType>({
  openWithdrawModal: missingProvider,
  closeWithdrawModal: missingProvider,
  isOpen: false,
  inlineActive: false,
  inlineStep: 'withdraw',
  syncInlineAmount: () => {},
  inlineAmount: '',
  inlineToken: '',
  syncInlineToken: () => {},
  spendabilityLoading: false,
  spendabilityError: null,
  retrySpendability: () => {},
  getSpendableBalanceWei: () => null,
  getWithdrawMaxWei: () => null,
});

export function useWithdrawModal() {
  return useContext(WithdrawModalContext);
}

// --- Token helpers ---

const TOKEN_DECIMALS: Record<string, number> = {
  ETH: 18,
  USDC: 6,
  USDT: 6,
  DAI: 18,
  WETH: 18,
  SUI: 9, // MIST base units
  XLM: 7, // stroops. Missing here, every shared XLM figure read 18 decimals
  cBTC: 18, // Citrea native. Missing here made the prefill gate reject it
};

// Quick-amount presets shown as tappable chips under the amount input.
// Native (ETH) vs stablecoins (USDC/USDT). Display is K-abbreviated.
const QUICK_AMOUNTS_NATIVE = ['0.1', '1', '5', '10', '100'];
const QUICK_AMOUNTS_STABLE = ['100', '1000', '5000', '10000', '100000'];
const formatQuickAmount = (v: string) => {
  const n = Number(v);
  return n >= 1000 ? `${n / 1000}K` : v;
};


// DEV-233: relayer options for the withdrawal. Only one relayer exists today;
// the disabled placeholder signals more are coming. Hardcoded for now —
// swap for an ASP endpoint when it returns the relayer set.
type WithdrawRelayer = { id: string; name: string; available: boolean };
const WITHDRAW_RELAYERS: WithdrawRelayer[] = [
  { id: '0xbow', name: 'Fast Relay', available: true },
  { id: 'coming-soon', name: 'More relayers coming soon', available: false },
];

const TOKEN_SYMBOL_BY_ADDRESS: Record<string, string> = {
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 'ETH',
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': 'USDC',
  '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0': 'USDT',
};


function normalizeHashValue(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('0x') || value.startsWith('0X')) {
    return value.toLowerCase();
  }

  try {
    return `0x${BigInt(value).toString(16)}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function resolvePreferredWithdrawNote(notes: Note[], transaction: Transaction | null): Note | null {
  if (notes.length === 0 || !transaction) return null;

  const targetLabel = normalizeHex(transaction.label);
  const targetToken = normalizeHex(transaction.tokenAddress);
  const targetTxHash = normalizeHex(transaction.txHash);
  let targetAmountHex: string | null = null;

  try {
    targetAmountHex = `0x${BigInt(transaction.rawAmount).toString(16)}`.toLowerCase();
  } catch {
    targetAmountHex = null;
  }

  const scored = notes
    .map((note) => {
      let score = 0;

      if (targetLabel && normalizeHex(note.label) === targetLabel) score += 10;
      if (targetTxHash && targetTxHash !== '0x0' && normalizeHex(note.txHash) === targetTxHash) score += 8;
      if (targetToken && normalizeHex(note.tokenId) === targetToken) score += 4;
      if (targetAmountHex && note.value.toLowerCase() === targetAmountHex) score += 6;

      return { note, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const [best, secondBest] = scored;
  if (best.score >= 16) return best.note;
  if (!secondBest || best.score > secondBest.score) return best.note;
  return null;
}




// Full-balance batch withdrawal (flag-gated, EXPO_PUBLIC_BATCH_WITHDRAWALS):
// what the review step captured so confirm can verify the prepared batch
// against exactly what the user approved. See services/batch-withdrawals.ts.
type BatchPlan = {
  tokenId: `0x${string}`;
  groupCount: number;
  totalOutWei: bigint;
  totalFeeWei: bigint;
  expiration: number;
  /** The gas price and units the relayer priced the batch at. */
  gasPrice: string;
  txCost: string;
};

// === "Receive as" (spec C5) — compose a swap into the exit ==================
// Fixed max slippage for the withdraw composition: this surface stays
// minimal (the full swap modal exposes a slippage picker). Matches the swap
// modal's default (0.5%).
const RECEIVE_AS_SLIPPAGE = 0.005;

/**
 * Immutable snapshot captured when a validated "Receive as" swap quote
 * arrives. Review renders from it and Confirm relays from it — NEVER live
 * form state — so an edit racing an in-flight quote can't change what gets
 * relayed (the request guard additionally discards stale responses).
 * Bound to the reviewed context: pool chain, session identity, and the
 * modal-operation epoch — Confirm refuses to execute it anywhere else.
 */
type WithdrawSwapSnapshot = {
  prepared: PreparedSwapQuoteLike;
  display: SwapQuoteDisplay;
  grossWei: bigint;
  inputToken: { symbol: string; address: Address; decimals: number };
  outputToken: SwapTokenInfo;
  recipient: Address;
  slippage: number;
  /** Chain the quote was prepared on — Confirm relays HERE, never live chainId. */
  poolChainId: number;
  /** Where the output lands. Equals poolChainId for the ordinary same-chain exit. */
  destinationChainId: number;
  /**
   * Cross-chain only: where the destination pays out if its leg cannot execute.
   * Carried in the snapshot because Confirm must relay the address that was
   * REVIEWED, and the relay builder re-validates the quote against it.
   */
  fallbackAddress?: Address;
  /** Owner identity (lowercased address:chain) the quote belongs to. */
  sessionKey: string;
  /** Modal-operation epoch at quote time (bumped on every open/close). */
  epoch: number;
};

function resolveTokenSymbol(tokenId: string, chainId?: number): string {
  // Per-chain registry first (mainnet USDC/USDT, Citrea cBTC on the staging
  // build); the legacy Sepolia map stays as the no-chain fallback so the
  // mainline build resolves exactly as before.
  if (chainId != null) {
    const known = getKnownTokenMetadata(tokenId, chainId);
    if (known) return known.symbol;
  }
  return TOKEN_SYMBOL_BY_ADDRESS[tokenId.toLowerCase()] || tokenId.slice(0, 6);
}


/**
 * A pool asset's decimals ON THIS CHAIN.
 *
 * TOKEN_DECIMALS is keyed by symbol alone, and one symbol is not one scale:
 * USDT is 6 on mainnet and 18 on BNB Chain, where the legacy pool stays open
 * for withdrawals. Reading the map there showed a balance in the trillions and
 * parsed a typed "5" as about 5e-12 USDT. The per-chain registry decides; the
 * map is only the fallback for a symbol the registry does not carry.
 */
function withdrawTokenDecimals(symbol: string, chainId: number, isSui: boolean): number {
  // Sui and Stellar share the alt path; each has its own native scale.
  if (isSui) return symbol === 'XLM' ? TOKEN_DECIMALS.XLM : TOKEN_DECIMALS.SUI;
  return getTokenMetadataBySymbol(symbol, chainId)?.decimals ?? TOKEN_DECIMALS[symbol] ?? 18;
}

function tokenBalanceNum(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

// --- Provider ---

/**
 * Message for a quote step that could not reach the relayer (DEV-370).
 *
 * Names the relayer rather than the flow, and states what is true of the user's
 * money. Unlike a transfer there is no disclosed alternative here — every
 * withdrawal goes through a relayer — so the only honest way forward is to
 * retry, and offering anything else would be a lie.
 */
/**
 * `message` is the RAW error text and only drives the classification: the
 * unreachable check matches the transport's own wording. `shown` is what the
 * user reads, with any SDK figures in human units (sdkErrorText).
 */
function quoteFailureMessage(message: string, shown: string = message): string {
  if (isRelayerRateLimited(message)) return relayerRateLimitedMessage('withdrawal');
  if (!isRelayerUnreachable(message)) return `Failed to get fee quote: ${shown}`;
  return `Could not reach the relayer to price this withdrawal, so nothing was sent and your balance is unchanged. Try again in a moment. (${message.split('\n')[0]})`;
}

export function WithdrawModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const isDark = colorScheme === 'dark';
  const { width } = useWindowDimensions();
  // Phone web: compact receive card so the CTA stays above the fold.
  const tight = Platform.OS === 'web' && compactPhoneLayout(width);
  const isMobile = width <= 540;
  // On a phone the modal presents as a bottom sheet.
  const isSheet = isMobile;
  // Modal-less presentation: when the hub opened this flow (opts.inline) on a
  // surface that can host it, the card re-parents into the hub instead of
  // rendering the overlay. The OPENER decides, so deep links / pool pages /
  // mobile keep the modal.
  const inlineCapable = useInlineOpsCapable();
  const [inlinePreferred, setInlinePreferred] = useState(false);
  const inlineBase = inlinePreferred && inlineCapable;
  const { log } = useDebug();

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
  const spendableLabel = (exact: string, symbol: string, cid: number) =>
    spendableBalanceLabel(exact, symbol, () => balanceDisplay(exact, symbol, cid).text);
  const withOpLock = useOpLock();
  // Chain FROZEN at submission — explorer links must not follow a later
  // app-chain switch (codex round 3, P2).
  const [txChainId, setTxChainId] = useState<number | null>(null);
  // Sui/EVM branch follows the app-wide chain SELECTION (the single routing
  // truth) — ChainProvider auto-selects Sui when a Sui wallet connects, and
  // useSuiSession/usePrivacyPool read their deployment config from the same
  // selection, so display and submit can never disagree.
  const { isSui: isSuiChain, isStellar } = useChainRouter();
  // "Not an EVM chain": Sui and Stellar share every non-EVM branch below (no
  // relayer quote, no leaf gate over the EVM ASP, no swaps or batches). The
  // asset, the account and the submit call differ, via the alt* values here.
  const isSui = isSuiChain || isStellar;
  const suiSession = useSuiSession();
  const stellarSession = useStellarSession();
  const suiStoredNotes = suiSession.notes.notes;
  const altSymbol = isStellar ? 'XLM' : 'SUI';
  const altDecimals = isStellar ? 7 : TOKEN_DECIMALS.SUI;
  const altScale = 10 ** altDecimals;
  const altChainId = isStellar ? STELLAR_TESTNET_ID : SUI_TESTNET_ID;
  const altAccount = isStellar
    ? (stellarSession.wallet.isConnected ? stellarSession.wallet.address ?? undefined : undefined)
    : suiSession.account?.address;
  const altRecipientPattern = isStellar ? /^G[A-Z2-7]{55}$/ : /^0x[0-9a-fA-F]{64}$/;
  const queryClient = useQueryClient();
  const currentChainName = isStellar
    ? 'Stellar Testnet'
    : isSui
    ? 'Sui Testnet'
    : getChainConfig(chainId)?.displayName || `Chain ${chainId}`;

  // Off the public-feed grid, not a query. This was an unscoped getAllPrices()
  // in a useQuery: a cache scope the scheduler never warms, so it fetched on
  // mount and on every window focus past its staleTime — including the focus
  // that lands when the user returns from signing, putting price traffic either
  // side of a withdrawal. Merged across chains because this file reads foreign
  // symbols for cross-chain swap output, with the active chain winning ties.
  const priceMap = useAllChainsPriceMap(chainId);
  const feePricing = useFeePricing(chainId);

  // DEV-367: a second copy of the WHOLE association set used to be fetched here
  // (its own query key, so it did not even share the SDK provider's cache) for
  // one purpose: the leaf count as a fallback figure in the removed "Your
  // anonymity set" line. With the line gone the download goes too — it is
  // ~376 KB / 4.7k leaves per withdraw-modal mount for nothing.

  const { notes, refetch: refetchNotes, isLoading: isLoadingNotes } = useNotes();
  const { poolSession, noteManager, keystoreManager, isInitialized: sdkReady, isInitializing, exportAccount, ensureInitialized, getBatchWithdrawSession, isSyncing, retryAssociationSetLeaves } = usePoolSession();
  const { address: walletAddress } = useAccount();
  // Relayed flow: an account-key session is enough — no wallet tx is posted.
  const ensureConnected = useRequireConnection({ allowAccountKey: true });
  // Key gate: actions that need the derived keys prompt for the one-time
  // signature on demand (the modal no longer auto-opens on connect). Read
  // through a ref so the onSigned continuation re-enters with fresh state.
  const { keysReady, sessionAddress, identityMode } = usePoolSession();
  // Owner identity for the flow: the SESSION identity (key wins over a
  // connected payer wallet; wallet when no key). Relayed flows never post
  // a wallet tx.
  const connectedAddress = (sessionAddress ?? walletAddress ?? undefined) as `0x${string}` | undefined;
  const keysReadyRef = useRef(keysReady);
  keysReadyRef.current = keysReady;
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const publicClient = usePublicClient({ chainId });
  const { openKeystoreRegistrationModal, markRegistered } = useKeystoreRegistrationModal();
  const { beginTx, endTx } = useTxActivity();
  // Cold-start claim signs an EIP-712 SetAuthPolicy payload instead of sending
  // a registration transaction — a signature costs the wallet nothing.
  const { signTypedDataAsync } = useSignTypedData();

  // Relayer hooks
  const { getQuote, reset: resetRelayerQuoteMutation } = useRelayerQuote();
  // Only a response accepted by this modal's canonical request guard may feed
  // fee math. React Query's mutation data can still be populated by a late
  // response after an edit/reset, so it is deliberately not rendered directly.
  const [relayerQuote, setRelayerQuote] = useState<WithdrawalQuote | null>(null);
  const [isQuoteLoading, setIsQuoteLoading] = useState(false);
  const resetQuote = useCallback(() => {
    resetRelayerQuoteMutation();
    setRelayerQuote(null);
    setIsQuoteLoading(false);
  }, [resetRelayerQuoteMutation]);
  const isRelaying = false;

  const [step, setStep] = useState<'withdraw' | 'review' | 'loading' | 'success' | 'error'>('withdraw');
  // The relayer broadcast this withdrawal and it has not been seen on-chain
  // yet (DEV-458). Shown on the error step as pending, not failed, until its
  // pending-relay record settles.
  const [withdrawPending, setWithdrawPending] = useState(false);
  const stopHearingWithdrawSettleRef = useRef<(() => void) | null>(null);
  // Mobile: the FORM lives inline like desktop; the sheet only appears while
  // the operation actually runs (progress/success).
  const inlineHubActive = inlineBase && !(isMobile && (step === 'loading' || step === 'success'));

  // Warn before the tab closes while the proof/relay is in flight — a batch
  // withdrawal may be mid-way through its sequence of transactions.
  useTabCloseGuard(
    step === 'loading',
    'A withdrawal is in progress. Closing this tab may interrupt it.',
  );

  const [txHash, setTxHash] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [amountFieldWidth, setAmountFieldWidth] = useState(0);
  // DEV-229: "Recipient receives the exact amount" (default on). The SDK
  // releases `amount + fee` from the pool and the recipient nets `amount`
  // (PoolSessionWithdraw: amountOut = amount + feeAmount). So checked = the
  // entered value is the recipient's net, fee added on top; unchecked = the
  // entered value is the gross total leaving the pool (recipient nets
  // entered − fee).
  const [receiveExact, setReceiveExact] = useState(true);
  // DEV-233: relayer selection (UI only for now — one relayer available).
  const [relayerSelectorOpen, setRelayerSelectorOpen] = useState(false);
  const [selectedRelayerId, setSelectedRelayerId] = useState(WITHDRAW_RELAYERS[0].id);
  const selectedRelayer = WITHDRAW_RELAYERS.find((r) => r.id === selectedRelayerId) ?? WITHDRAW_RELAYERS[0];
  const [dollarValue, setDollarValue] = useState('$0.00');
  const [selectedTab, setSelectedTab] = useState<string | null>(null);
  // Explicit full-balance intent: set ONLY by the 100% tab (never inferred
  // from a typed amount's closeness to the balance). Drives the batch route.
  const [maxSelected, setMaxSelected] = useState(false);
  const [gasTokenChecked, setGasTokenChecked] = useState(false);
  const [feeExpanded, setFeeExpanded] = useState(false);
  // FullWithdrawalGuard (privacy spec A3). Production consumes the tested
  // guardNext reducer (codex finding 10) so its trip/ack/escape semantics are
  // pinned. Every selection change dispatches 'selection', which clears the
  // acknowledgment (codex finding 7 — consent is never stale). A monotonic
  // selection generation lets the async Review handler refuse to advance if the
  // selection changed while it was awaiting registration/quote work.
  const [guardState, dispatchGuard] = useReducer(guardNext, INITIAL_GUARD_STATE);
  const guardStateRef = useRef(guardState);
  guardStateRef.current = guardState;
  const selectionGenRef = useRef(0);
  // Bumped on every user selection action (typed amount, tab, quick chip, token
  // change, modal open). Drives the guard's per-selection ack reset and lets the
  // async Review handler detect a selection that changed under it.
  const [selectionNonce, setSelectionNonce] = useState(0);
  const bumpSelection = useCallback(() => {
    selectionGenRef.current += 1;
    setSelectionNonce((n) => n + 1);
  }, []);
  const [countdown, setCountdown] = useState(0);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const { toast: errorToast } = useToast();
  // Every flow error ALSO surfaces as a destructive toast — visible even
  // when the inline error line is below the fold or the modal is closing.
  // The token state is declared below this reporter and a ref reads across
  // that order without moving either. Kept current by a plain assignment
  // during render, next to the state itself.
  const diagnosticTokenRef = useRef('ETH');
  // The stage the running withdrawal last entered, for the failure report.
  const withdrawPhaseRef = useRef<ErrorReportStage>('unknown');
  const reportWithdrawError = useCallback((rawMsg: string | null, cause?: unknown, stage?: string) => {
    // An ASP throttle (or our own backoff refusing to send while one lasts)
    // reads as such, with the wait, whatever stage it surfaced in.
    const causeText = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
    const msg = rawMsg && (aspBusyMessage(causeText, aspBackoff.blockedForMs()) ?? aspBusyMessage(rawMsg, aspBackoff.blockedForMs()))
      || rawMsg;
    setWithdrawError(msg);
    if (msg) errorToast({ title: msg, variant: 'destructive' });
    // The reporter is told THAT a withdrawal failed and WHAT KIND of failure
    // it was, never `msg` itself: these strings quote amounts, tokens,
    // addresses and relayer responses. The values below ride in a separate bag
    // that only a staging build sends - services/error-reports.ts decides.
    if (msg) {
      reportErrorReport('withdraw-failed', { testMode: TEST_MODE === true, ...classifyFailure(msg, cause) }, {
        ...(stage ? { stage } : {}),
        detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : msg,
        ...(connectedAddress ? { address: connectedAddress } : {}),
        ...(amount ? { amount } : {}),
        asset: diagnosticTokenRef.current,
        chainId,
      }, undefined, {
        stage,
        phase: withdrawPhaseRef.current,
        error: cause,
        chainId,
        asset: diagnosticTokenRef.current,
        isYield: isShareSymbol(diagnosticTokenRef.current),
      });
    }
  }, [errorToast, connectedAddress, amount, chainId]);
  const { data: sourcePools } = usePools();
  const sourceHoldings = useMemo(() => ({ symbols: heldSymbolsFor(sourcePools.myPools, chainId), ready: sourcePools.holdingsReady }), [sourcePools.myPools, sourcePools.holdingsReady, chainId]);
  const sourceTokens = useMemo(() => hubTokenCatalog('withdraw', chainId, sourceHoldings), [chainId, sourceHoldings]);
  const defaultSourceSymbol = (preferredHubToken(sourceTokens, sourceHoldings) ?? emptySpendToken(chainId))?.symbol;
  const [selectedToken, setSelectedToken] = useState(defaultSourceSymbol ?? 'ETH');
  // Read by reportWithdrawError, which is defined above this state. Written in
  // an EFFECT, not during render: a render-time write is visible to a render
  // React later throws away (StrictMode's double pass, an interrupted
  // concurrent render), which would let an abandoned attempt relabel the token
  // on a failure that already happened. Committing it means the ref always
  // holds a token the user actually saw.
  useEffect(() => { diagnosticTokenRef.current = selectedToken; }, [selectedToken]);
  // Set when a launcher or user action explicitly names the pool token. The
  // largest-balance default must not override that choice; default/auto/
  // transaction selections clear it.
  const explicitTokenPinRef = useRef(false);
  const selectWithdrawToken = useCallback((token: string, explicit = false) => {
    explicitTokenPinRef.current = explicit;
    setSelectedToken(token);
  }, []);
  const [targetInput, setTargetInput] = useState('');
  const [targetAddress, setTargetAddress] = useState('');
  const [resolvedTargetName, setResolvedTargetName] = useState<string | null>(null);
  const [targetEnsResolving, setTargetEnsResolving] = useState(false);
  const [targetEnsError, setTargetEnsError] = useState<string | null>(null);
  const [loadingMessage, setLoadingMessage] = useState('Preparing withdrawal...');
  const [activeFeeCommitment, setActiveFeeCommitment] = useState<WithdrawalQuote['feeCommitment'] | null>(null);
  // Set during Review when this wallet is unregistered AND cannot afford
  // registration gas on a chain whose relay implements registerAndRelay.
  // Confirm then routes through the gasless register-and-withdraw instead of
  // prepareWithdraw + relayWithdraw. Null = today's self-funded path.
  const [coldStartClaim, setColdStartClaim] = useState<RegistrationPathDecision | null>(null);
  // Full-balance batch route (flag-gated): reviewed plan + live proving progress.
  const [batchPlan, setBatchPlan] = useState<BatchPlan | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  // === "Receive as" (spec C5) — compose a swap into the exit ===
  // null = the pool asset = plain withdrawal (default, UNCHANGED behavior).
  // A different token routes through the REAL swap plumbing
  // (prepareSwapQuote → relayWithdrawAndSwap), same-chain only. Gated below
  // by intentSwapsEnabledForChain && !isSui — when unavailable the control
  // never renders and every path below is byte-for-byte the plain flow.
  const [receiveAsset, setReceiveAsset] = useState<SwapTokenInfo | null>(null);
  const [receiveSelectorOpen, setReceiveSelectorOpen] = useState(false);
  // Destination chain for the exit. Defaults to the pool chain, which is the
  // ordinary withdrawal and the only behaviour this modal had before: every
  // path below is byte-for-byte the old one while this equals `chainId`.
  const [receiveChainId, setReceiveChainId] = useState<number>(chainId);
  const [swapSnapshot, setSwapSnapshot] = useState<WithdrawSwapSnapshot | null>(null);
  // A share note redeemed to its underlying through the PPRouter this run
  // (services/yield-redemption.ts): what the success screen says was paid out.
  const [yieldRedemption, setYieldRedemption] = useState<{ underlyingSymbol: string; underlyingDecimals: number; quotedOut: bigint; minOut: bigint } | null>(null);
  const [isSwapQuoting, setIsSwapQuoting] = useState(false);
  // ONE shared async-quote guard across ALL quote modes (plain / batch /
  // swap): a monotonic generation invalidated on every quote-defining edit;
  // only the newest request (with an unchanged canonical key — see
  // services/withdraw-quotes buildWithdrawQuoteKey, which includes mode +
  // output token + recipient + session + modal epoch) may commit state.
  // handleReviewWithdrawal registers the request BEFORE its first await and
  // re-checks after every await, so a stale continuation can never advance
  // to Review or be presented as a different mode.
  const quoteGuardRef = useRef(createSwapRequestGuard());
  const invalidateQuoteRequests = useCallback(() => {
    quoteGuardRef.current.invalidate();
    setIsSwapQuoting(false);
    // Clear the accepted quote synchronously with the edit. A superseded
    // mutation may still resolve internally, but no stale fee can re-enter
    // gross/cap validation because this provider never reads mutation.data.
    resetQuote();
  }, [resetQuote]);
  // Modal-operation epoch: bumped on every open/close. Quotes/snapshots carry
  // the epoch they were created under; Confirm and completion writes refuse
  // to act across an epoch boundary, so an old operation can never overwrite
  // a reopened flow.
  const modalEpochRef = useRef(0);
  // TRUE only once the current run handed its payload to the wallet/relayer —
  // a submitted operation is immutable: context changes must not supersede it
  // or clear its outcome snapshot (codex).
  const submittedRef = useRef(false);
  // What Review committed to (mode / chain / session / recipient / epoch).
  // Review renders its recipient from this; Confirm verifies it still
  // matches the live context before executing anything.
  const [reviewContext, setReviewContext] = useState<WithdrawReviewContext | null>(null);
  const [noteDropdownOpen, setNoteDropdownOpen] = useState(false);
  const [tokenDropdownOpen, setTokenDropdownOpen] = useState(false);
  const [selectedPA, setSelectedPA] = useState<string | null>(null);
  const [preferredTransaction, setPreferredTransaction] = useState<Transaction | null>(null);
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

  // Resolve the token address for the selected token symbol — CHAIN-AWARE
  // (kimi round-1 CRITICAL): this was a hardcoded Sepolia map, so on
  // mainnet/OP the relayer quotes, the batch note filter, and the swap-exit
  // filter all ran against the Sepolia test
  // token address — zero notes matched and withdrawals were impossible off
  // Sepolia. Resolve from the per-chain registry like the transfer modal.
  const selectedTokenAddress = useMemo(
    () => getTokenMetadataBySymbol(selectedToken, chainId)?.address ?? NATIVE_ASSET_ADDRESS,
    [selectedToken, chainId],
  );
  const supportsGasTokenOption = selectedTokenAddress.toLowerCase() !== NATIVE_ASSET_ADDRESS.toLowerCase();
  // The assets an SDK error's figures can be in, for sdkErrorText. Held in a ref
  // like diagnosticTokenRef so the many callbacks below read the current ones
  // without each growing a dependency. The note is the selected pool asset; a
  // share's swap leg runs in its underlying; a receive-as swap lands in
  // receiveAsset, which is a plain token (a share is never delivered).
  const errorUnitsRef = useRef<ErrorUnits>({});
  useEffect(() => {
    // Chain-aware: TOKEN_DECIMALS is keyed by symbol alone and says USDT is 6,
    // while the legacy USDT pool on BNB Chain is 18 (review on #122).
    const note = {
      symbol: selectedToken,
      decimals: withdrawTokenDecimals(selectedToken, chainId, isSui),
    };
    const received = receiveAsset ? { symbol: receiveAsset.symbol, decimals: receiveAsset.decimals } : null;
    errorUnitsRef.current = {
      input: note,
      swapInput: swapInputUnits(chainId, selectedTokenAddress, note),
      output: received,
      funding: received,
    };
  }, [selectedToken, selectedTokenAddress, chainId, isSui, receiveAsset]);
  /** A caught error as the user should read it: SDK figures in human units. */
  const shownError = useCallback((err: unknown) => sdkErrorText(err, errorUnitsRef.current), []);
  // "Receive as" gate (spec C5), fail closed: master flag AND a configured
  // RelaySwaps processor for this chain AND EVM (intent swaps are LiFi-only).
  const receiveAsAvailable = !isSui && crossFlowsEnabled() && intentSwapInputSupported(chainId, selectedTokenAddress);
  // Visibility is deliberately WIDER than availability. Hiding the control
  // outright when intents aren't live for the chain made the feature look
  // deleted rather than pending — so the row still renders, disabled, with the
  // reason. It must NOT open the picker in that state: selecting a different
  // asset while isSwapExit can't be true would relay a PLAIN withdrawal of the
  // pool asset under a label promising another token.
  const receiveAsVisible = !isSui;
  // Swap exit iff a genuinely different output token is picked; the pool
  // asset (or no pick) is the plain withdrawal, untouched.
  // Destinations this exit can deliver to. Same single-entry list as before
  // whenever the chain pair cannot route (getSwapDestinationChains returns just
  // the pool chain), so the network pane stays a no-op exactly where it was.
  // Where the output lands, named. Same as the pool chain unless a destination
  // was picked, so every existing label reads exactly as it did.
  const receiveChainName = useMemo(
    () => (receiveChainId === chainId
      ? currentChainName
      : getChainConfig(receiveChainId)?.displayName || `Chain ${receiveChainId}`),
    [receiveChainId, chainId, currentChainName],
  );
  const receiveDestinations = useMemo(
    () => (receiveAsAvailable ? getSwapDestinationChains(chainId) : [chainId]),
    [receiveAsAvailable, chainId],
  );
  const crossChainReceive = receiveAsAvailable
    && receiveChainId !== chainId
    && receiveDestinations.includes(receiveChainId);
  // A cross-chain exit is ALWAYS a swap exit, even for the same asset: the note
  // leaves the pool through the LiFi route either way. Address comparison alone
  // would miss it, because the native-asset sentinel is the same address on
  // every chain, which would relay a plain same-chain withdrawal under a label
  // promising another network.
  const isSwapExit = receiveAsAvailable
    && (crossChainReceive
      ? !!receiveAsset
      : isSwapExitSelection(receiveAsset?.address, selectedTokenAddress));
  // Picker rows: the pool asset first (= plain withdrawal), then the chain's
  // swap output tokens. Synthesizes the pool-asset row if the output list
  // doesn't carry it, so "back to plain" is always offered.
  const receiveTokens = useMemo<SwapTokenInfo[]>(() => {
    if (!receiveAsAvailable) return [];
    const outputs = getSwapDeliveryTokens(receiveChainId);
    // Cross-chain has no "plain withdrawal" row to fall back to: every option
    // is a LiFi route, so the list is exactly what the destination accepts.
    if (receiveChainId !== chainId) return outputs;
    const pool = outputs.find((t) => t.address.toLowerCase() === selectedTokenAddress.toLowerCase())
      ?? {
        // The plain-withdrawal row of a share reads as its UNDERLYING: that is
        // what the router pays out (Pat, 2026-09-05). Display only; the row is
        // matched by address, and decimals stay the share's.
        symbol: displayTokenSymbol(selectedToken),
        address: selectedTokenAddress as `0x${string}`,
        decimals: withdrawTokenDecimals(selectedToken, chainId, isSui),
        isNative: selectedTokenAddress.toLowerCase() === NATIVE_ASSET_ADDRESS.toLowerCase(),
      };
    return [pool, ...outputs.filter((t) => t.address.toLowerCase() !== selectedTokenAddress.toLowerCase())];
  }, [receiveAsAvailable, receiveChainId, chainId, selectedTokenAddress, selectedToken, isSui]);
  // What a share note actually pays out. The flow now TRIES the PPRouter
  // redemption (share in, underlying out) whenever the note is a verified
  // share and the exit is plain — see the yield branch in the submit handler —
  // and only falls back to the ordinary share payout when the relayer refuses
  // the router as processor. That refusal is not known until after Confirm, so
  // the review states both outcomes instead of promising the share token the
  // router no longer pays (codex, 2026-09-04).
  // A share note ALWAYS leaves as its underlying through the PPRouter (Pat,
  // 2026-09-05: "withdrawing ppUSDC should always unwrap to USDC"). Every
  // surface below names the underlying, the gas top-up is unavailable for a
  // share (the router route carries no native gas), and the submit path
  // refuses rather than paying the share the UI never promised.
  const selectedIsShare = isShareSymbol(selectedToken);
  const shareUnderlyingSymbol = displayTokenSymbol(selectedToken);
  const sharePayoutDisclosure = selectedIsShare && !swapSnapshot ? shareRedemptionDisclosure(selectedToken) : null;
  const targetEnsName = useMemo(() => {
    // Sui recipients are raw addresses; there is no ENS on Sui.
    if (isSui) return null;
    const trimmed = targetInput.trim();
    if (!trimmed || isAddress(trimmed)) return null;
    return normalizeEnsName(trimmed);
  }, [targetInput, isSui]);

  const handleTargetInputChange = useCallback((value: string) => {
    const trimmed = value.trim();
    // Sui addresses are 32 bytes (0x + 64 hex); EVM keeps viem's isAddress.
    const isValidRecipient = isSui ? altRecipientPattern.test(trimmed) : isAddress(trimmed);
    const nextAddress = trimmed && isValidRecipient ? trimmed : '';
    const nextEnsName = (nextAddress || isSui) ? null : normalizeEnsName(trimmed);
    setTargetInput(value);
    // Recipient is part of the swap-quote key — drop any in-flight quote.
    invalidateQuoteRequests();
    if (nextEnsName && nextEnsName === targetEnsName) return;
    setResolvedTargetName(null);
    setTargetEnsError(null);
    setTargetEnsResolving(false);
    setTargetAddress(nextAddress);
  }, [targetEnsName, isSui, altRecipientPattern, invalidateQuoteRequests]);

  // DEV-570: ENS is not supported, for privacy. A typed name is never looked
  // up (no request names the counterparty); it only gets the message.
  useEffect(() => {
    if (!targetEnsName) return;
    setTargetAddress('');
    setResolvedTargetName(null);
    setTargetEnsResolving(false);
    setTargetEnsError(ENS_UNSUPPORTED_MESSAGE);
  }, [targetEnsName]);

  const targetError = useMemo(() => {
    const trimmed = targetInput.trim();
    if (isSui) {
      // Recipient is optional on Sui (defaults to the connected wallet).
      if (!trimmed || altRecipientPattern.test(trimmed)) return null;
      return isStellar ? 'Invalid Stellar address (G…)' : 'Invalid Sui address';
    }
    if (!trimmed || isAddress(trimmed)) return null;
    if (isPotentialEnsName(trimmed)) return ENS_UNSUPPORTED_MESSAGE;
    return 'Invalid Ethereum address';
  }, [targetInput, targetEnsError, isSui, isStellar, altRecipientPattern]);

  const targetHelperText = useMemo(() => {
    if (targetEnsResolving) return 'Resolving ENS name...';
    if (resolvedTargetName && targetAddress) return `Resolved to ${truncateAddress(targetAddress)}`;
    return null;
  }, [targetEnsResolving, resolvedTargetName, targetAddress]);

  // Sui has no EVM association-set request here. Its local note store carries a
  // per-note ASP verdict; derive explicit approvals synchronously, while an
  // undefined verdict remains a real loading state rather than being trusted.
  const suiSpendability = useMemo(() => {
    if (!isSui) return {
      commitments: new Set<string>(),
      totalWei: 0n,
      maxSingleWei: 0n,
      approvalPending: false,
      storedNotes: [] as StoredSuiNote[],
    };
    if (isStellar) {
      // The Stellar SDK marks a note ACTIVE only once its label is in the
      // association set, so ACTIVE is the approval verdict. Until the first
      // sync after unlock, nothing is provably spendable yet.
      const active = notes.filter((n) => String(n.status) === 'ACTIVE');
      const commitments = new Set<string>();
      let totalWei = 0n;
      for (const note of active) {
        const commitment = normalizeHashValue(note.commitment);
        if (commitment) commitments.add(commitment);
        totalWei += BigInt(note.value);
      }
      // One withdrawal proof spends up to WITHDRAW_MAX_INPUTS notes of any
      // label, and the relayer fee comes out of those same notes on top of
      // the amount, so the cap (Max, 100%) is the most whose amount + fee fits.
      const maxInputsWei = [...active]
        .map((n) => BigInt(n.value))
        .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
        .slice(0, WITHDRAW_MAX_INPUTS)
        .reduce((sum, v) => sum + v, 0n);
      const maxSingleWei = maxStellarWithdrawForInputs(maxInputsWei);
      return {
        commitments,
        totalWei,
        maxSingleWei,
        approvalPending: stellarSession.unlocked && stellarSession.lastSyncedAt === null,
        storedNotes: [] as StoredSuiNote[],
      };
    }
    const { approvedNotes, approvalPending } = partitionSuiWithdrawNotes(suiStoredNotes);
    const commitments = new Set<string>();
    let totalWei = 0n;
    for (const note of approvedNotes) {
      const commitment = normalizeHashValue(note.commitment);
      if (commitment) commitments.add(commitment);
      totalWei += BigInt(note.value);
    }
    return {
      commitments,
      totalWei,
      maxSingleWei: maxSuiLineageTotal(approvedNotes),
      approvalPending,
      storedNotes: suiStoredNotes,
    };
  }, [isSui, isStellar, notes, stellarSession.unlocked, stellarSession.lastSyncedAt, suiStoredNotes]);

  // Bind an association-set answer to the exact chain/session/note topology
  // that produced it. Without this key, a resolved empty/old Set remained
  // visible while a new chain or newly discovered notes were still fetching.
  // On Sui, include the explicit per-note ASP verdict so approval revocation
  // invalidates an already committed Review too.
  const spendabilityKey = useMemo(() => buildWithdrawSpendabilityKey({
    chainId,
    isSui,
    owner: isSui ? altAccount : connectedAddress,
    notes: isSuiChain ? suiSpendability.storedNotes : notes,
  }), [chainId, connectedAddress, isSui, isSuiChain, notes, altAccount, suiSpendability.storedNotes]);
  const spendabilityKeyRef = useRef(spendabilityKey);
  // A layout effect closes the stale-topology window before the user can
  // trigger Review, without mutating a ref during render.
  useLayoutEffect(() => {
    spendabilityKeyRef.current = spendabilityKey;
  }, [spendabilityKey]);

  const leafGate = useLeafGate(notes, { topologyKey: spendabilityKey, enabled: !isSui });
  const spendabilityError = !isSui && leafGate.status === 'error'
    ? leafGate.error
    : null;
  // Keyed exactly as before (codex): an answer is only accepted for the
  // chain/session/note topology that produced it, so a resolved set cannot
  // linger across a chain switch or newly discovered notes.
  const spendabilityResolution = useMemo<WithdrawSpendabilityResolution | null>(
    () => (leafGate.status === 'ready'
      ? { key: spendabilityKey, commitments: new Set(leafGate.confirmed) }
      : null),
    [leafGate, spendabilityKey],
  );
  const spendableCommitments = isSui
    ? suiSpendability.commitments
    : resolveWithdrawSpendableCommitments(spendabilityResolution, spendabilityKey);

  // The EVM answer now comes from the ONE shared gate (hooks/use-leaf-gate.ts).
  //
  // This used to be a ~120-line effect that fetched the whole association set
  // itself on every notes change and matched with an UNPADDED hash normaliser,
  // while the balance surfaces hashed the session's leaves with a PADDED one.
  // Two sources and two normalisers meant the two could disagree about the
  // same note, which is what let a hub balance contradict this form's error
  // (Artem, QA 2026-08-28). Sharing the session's leaves also drops the
  // duplicate ~376KB download.
  //
  // The POLICY here is unchanged and still deliberately fail-closed. Loading
  // and failure stay distinct: neither can select a note, but a terminal fetch
  // failure is shown as retryable unavailability rather than loading forever or
  // masquerading as a verified empty wallet.

  // No discovery pass when the modal opens, even for a deposit whose note is
  // not ACTIVE yet: a pass timed to opening Withdraw tells the ASP and the RPC
  // provider that this client is about to withdraw. Approval promotes the note
  // locally, and the grid's discovery picks up anything else.

  // Build the SDK session when the Withdraw modal opens. The session is
  // otherwise only built lazily on an explicit action (deposit / "Review
  // Withdrawal"), so opening Withdraw on a fresh page load — before the
  // seed-derivation Sign — left the note selector stuck on "Loading notes…":
  // `sdkReady` never flips and `syncFromSnapshot` no-ops without a session
  // (which is why no RPC/backend request is ever made). If keys are already
  // derived this reuses them (no new signature); otherwise it drives the
  // normal sign flow. Guarded per address:chain so it fires at most once per
  // open and can't loop while `ensureInitialized` is in flight.
  const autoInitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen) {
      autoInitKeyRef.current = null;
      return;
    }
    if (sdkReady || isInitializing || !connectedAddress) return;
    const key = `${connectedAddress.toLowerCase()}:${chainId}`;
    if (autoInitKeyRef.current === key) return;
    autoInitKeyRef.current = key;
    log('info', 'Withdraw', 'Building session on withdraw open (sdk not ready)', { chainId });
    ensureInitialized().catch((err) => {
      // Do NOT clear the guard here. If the user rejects the seed-derivation
      // signature, `isInitializing` flips back to false and this effect would
      // re-run; clearing the guard let it immediately re-prompt, producing an
      // endless sign prompt that only stopped when the modal closed (QA-5).
      // The guard is reset on close (and is per address:chain), so reopening
      // re-attempts; the Get-Quote/Withdraw actions also call
      // ensureInitialized() directly when the user explicitly retries.
      const message = err instanceof Error ? err.message : String(err);
      // Superseded by the sign-in that created this session: expected, and the
      // once-guard has to be released or the retry never happens and the flow
      // sits in an error state over a race that already resolved.
      if (err instanceof KeySourceChangedError) {
        autoInitKeyRef.current = null;
        log('debug', 'Withdraw', `Session init superseded, retrying: ${message}`);
        return;
      }
      log('error', 'Withdraw', `Session init on open failed: ${message}`, err);
      if (identityMode === 'key') {
        reportWithdrawError(`Couldn't initialize the account-key session: ${message}`);
        submittedRef.current = false;
        setStep('error');
      }
    });
  }, [isOpen, sdkReady, isInitializing, connectedAddress, chainId, ensureInitialized, identityMode, log]);

  // Compute user balances from notes grouped by token
  const tokenBalances = useMemo(() => {
    const byToken = new Map<string, { active: bigint; pending: bigint; total: bigint; count: number }>();
    for (const note of notes) {
      const tokenAddr = String(note.tokenId || '');
      // Sui notes carry random 160-bit tokenIds; force the SUI symbol so they
      // aggregate under the one asset the Sui pool serves.
      const symbol = isSui ? altSymbol : resolveTokenSymbol(tokenAddr, chainId);
      const entry = byToken.get(symbol) || { active: 0n, pending: 0n, total: 0n, count: 0 };
      const val = BigInt(note.value);
      const status = String(note.status);
      const isSpendableActive = (status === 'active' || status === 'ACTIVE' || note.status === NoteStatus.ACTIVE)
        && spendableCommitments?.has(note.commitment);
      const isUnspendableActive = (status === 'active' || status === 'ACTIVE' || note.status === NoteStatus.ACTIVE)
        && !spendableCommitments?.has(note.commitment);
      if (isSpendableActive) {
        entry.active += val;
      } else if (status === 'pending' || status === 'PENDING' || note.status === NoteStatus.PENDING || isUnspendableActive) {
        entry.pending += val;
      }
      entry.total += val;
      entry.count++;
      byToken.set(symbol, entry);
    }
    return byToken;
  }, [notes, spendableCommitments, isSui, altSymbol, chainId]);

  // Group active notes by label to form pool accounts for the selected token.
  // Skip 0-value change notes — the SDK adds one per lineage even after a
  // full withdrawal, which would otherwise surface an unusable "0.0000 ETH"
  // pool account in the picker.
  const tokenAccounts = useMemo(() => {
    const activeForToken = notes.filter((n) => {
      const isActive = n.status === NoteStatus.ACTIVE || String(n.status) === 'active' || String(n.status) === 'ACTIVE';
      if (!isActive) return false;
      if (BigInt(n.value) === 0n) return false;
      const tokenAddr = String(n.tokenId || '');
      return spendableCommitments?.has(n.commitment) && (isSui ? altSymbol : resolveTokenSymbol(tokenAddr, chainId)) === selectedToken;
    });
    const byLabel = new Map<string, { label: string; notes: typeof activeForToken; totalValue: bigint }>();
    for (const note of activeForToken) {
      const label = String(note.label || 'default');
      const entry = byLabel.get(label) || { label, notes: [], totalValue: 0n };
      entry.notes.push(note);
      entry.totalValue += BigInt(note.value);
      byLabel.set(label, entry);
    }
    // Drop lineages whose remaining active balance is 0 (defensive — the
    // value filter above already handles the common case).
    return Array.from(byLabel.values()).filter((entry) => entry.totalValue > 0n);
  }, [notes, selectedToken, spendableCommitments, isSui, altSymbol, chainId]);

  const activeNotesForSelectedToken = useMemo(() => {
    return notes.filter((note) => {
      const status = String(note.status);
      const isActive = status === 'active' || status === 'ACTIVE' || note.status === NoteStatus.ACTIVE;
      if (!isActive) return false;
      if (BigInt(note.value) === 0n) return false;
      const tokenAddr = String(note.tokenId || '');
      return spendableCommitments?.has(note.commitment) && (isSui ? altSymbol : resolveTokenSymbol(tokenAddr, chainId)) === selectedToken;
    });
  }, [notes, selectedToken, spendableCommitments, isSui, altSymbol, chainId]);

  const preferredWithdrawNote = useMemo(
    () => resolvePreferredWithdrawNote(activeNotesForSelectedToken, preferredTransaction),
    [activeNotesForSelectedToken, preferredTransaction],
  );

  // Diagnostic: trace why tokenAccounts is empty while the modal is open.
  useEffect(() => {
    if (!isOpen) return;
    if (tokenAccounts.length > 0) return;
    const spendableList = spendableCommitments ? Array.from(spendableCommitments) : null;
    log('warn', 'Withdraw', 'tokenAccounts is empty. Diagnosing', {
      selectedToken,
      totalNotes: notes.length,
      spendableResolved: spendableCommitments !== null,
      spendableCount: spendableCommitments?.size ?? 0,
      spendableCommitments: spendableList,
      isSyncing,
      notes: notes.map((n) => ({
        commitment: n.commitment,
        status: String(n.status),
        tokenSymbol: resolveTokenSymbol(String(n.tokenId || ''), chainId),
        inSpendableSet: spendableCommitments?.has(n.commitment) ?? null,
        isActive: n.status === NoteStatus.ACTIVE || String(n.status) === 'active' || String(n.status) === 'ACTIVE',
      })),
    });
  }, [isOpen, tokenAccounts.length, selectedToken, notes, spendableCommitments, isSyncing, log]);

  // Auto-select pool account when there is only one option
  useEffect(() => {
    if (tokenAccounts.length === 1) {
      setSelectedPA(tokenAccounts[0].label);
    } else if (tokenAccounts.length === 0) {
      setSelectedPA(null);
    } else if (selectedPA && !tokenAccounts.find(a => a.label === selectedPA)) {
      setSelectedPA(null);
    }
  }, [tokenAccounts, selectedPA]);

  const preferredTransactionPinsToken = !!(
    preferredTransaction?.asset
    && preferredTransaction.chainId === chainId
    && getTokenMetadataBySymbol(preferredTransaction.asset, chainId)
  );

  useEffect(() => {
    if (!isOpen || !preferredTransactionPinsToken || !preferredTransaction?.asset) return;
    if (preferredTransaction.asset !== selectedToken) {
      selectWithdrawToken(preferredTransaction.asset);
    }
  }, [isOpen, preferredTransaction, preferredTransactionPinsToken, selectedToken, selectWithdrawToken]);

  // On open, default to the asset with the largest spendable USD value so
  // the user lands on the pool that actually has funds. Skip if a
  // preferredTransaction asset is already pinned (e.g. user clicked a row
  // in the activity feed), or a launcher/user explicitly picked a token.
  const didAutoPickRef = useRef(false);
  const autoPickContextKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const autoPickContextKey = `${chainId}|${isSui ? 1 : 0}|${(connectedAddress ?? '').toLowerCase()}|${(altAccount ?? '').toLowerCase()}`;
    if (!isOpen) {
      didAutoPickRef.current = false;
      autoPickContextKeyRef.current = autoPickContextKey;
      return;
    }
    if (submittedRef.current) return;
    if (autoPickContextKeyRef.current !== autoPickContextKey) {
      didAutoPickRef.current = false;
      autoPickContextKeyRef.current = autoPickContextKey;
    }
    if (isSui) {
      if (selectedToken !== altSymbol) selectWithdrawToken(altSymbol);
      return;
    }
    const selectedTokenRegistered = !!getTokenMetadataBySymbol(selectedToken, chainId);
    const explicitTokenPinActive = explicitTokenPinRef.current && selectedTokenRegistered;
    if (explicitTokenPinRef.current && !selectedTokenRegistered) {
      explicitTokenPinRef.current = false;
    }
    if (!shouldAutoPickWithdrawToken({
      isOpen,
      didAutoPick: didAutoPickRef.current,
      hasPreferredTransactionAsset: preferredTransactionPinsToken,
      hasExplicitTokenPin: explicitTokenPinActive,
    })) return;
    // The chain's ACTUAL asset list — hardcoding ETH/USDC/USDT skipped cBTC
    // entirely on Citrea (auto-pick could never land on the only asset).
    const candidates = getActionableTokens(chainId).map((t) => t.symbol);
    let best: { symbol: string; usd: number } | null = null;
    for (const sym of candidates) {
      const bal = tokenBalances.get(sym);
      if (!bal || bal.active === 0n) continue;
      const tokenAmount = tokenBalanceNum(bal.active, withdrawTokenDecimals(sym, chainId, isSui));
      const usd = tokenAmount * (priceMap[sym] || (sym === 'USDC' || sym === 'USDT' ? 1 : 0));
      if (!best || usd > best.usd) best = { symbol: sym, usd };
    }
    const fallback = defaultSourceSymbol;
    const nextToken = best?.symbol ?? (!selectedTokenRegistered || !sourceTokens.some((t) => t.symbol === selectedToken) ? fallback : null);
    if (nextToken && nextToken !== selectedToken) {
      selectWithdrawToken(nextToken);
    }
    if (best) didAutoPickRef.current = true;
  }, [
    isOpen,
    preferredTransactionPinsToken,
    tokenBalances,
    sourceTokens,
    defaultSourceSymbol,
    priceMap,
    selectedToken,
    chainId,
    isSui,
    altSymbol,
    connectedAddress,
    altAccount,
    selectWithdrawToken,
  ]);

  useEffect(() => {
    if (!isOpen) return;

    const preferredLabel = preferredWithdrawNote?.label ?? preferredTransaction?.label ?? null;
    if (!preferredLabel) return;

    const normalizedPreferredLabel = String(preferredLabel);
    const hasMatchingAccount = tokenAccounts.some((account) => account.label === normalizedPreferredLabel);
    if (hasMatchingAccount && selectedPA !== normalizedPreferredLabel) {
      setSelectedPA(normalizedPreferredLabel);
    }
  }, [isOpen, preferredTransaction, preferredWithdrawNote, selectedPA, tokenAccounts]);

  useEffect(() => {
    if (!isOpen) return;

    log('debug', 'Withdraw', 'Withdraw modal state snapshot', {
      chainId,
      selectedToken,
      selectedPA,
      preferredTransaction: preferredTransaction ? {
        id: preferredTransaction.id,
        txHash: preferredTransaction.txHash,
        label: preferredTransaction.label,
        rawAmount: preferredTransaction.rawAmount,
        tokenAddress: preferredTransaction.tokenAddress,
        asset: preferredTransaction.asset,
        status: preferredTransaction.status,
      } : null,
      preferredWithdrawNote: preferredWithdrawNote ? {
        commitment: preferredWithdrawNote.commitment,
        label: preferredWithdrawNote.label,
        value: preferredWithdrawNote.value,
        tokenId: preferredWithdrawNote.tokenId,
        txHash: preferredWithdrawNote.txHash,
        status: preferredWithdrawNote.status,
      } : null,
      activeNotesForSelectedToken: activeNotesForSelectedToken.map((note) => ({
        commitment: note.commitment,
        label: note.label,
        value: note.value,
        tokenId: note.tokenId,
        txHash: note.txHash,
        status: note.status,
      })),
      spendableCommitments: spendableCommitments ? Array.from(spendableCommitments) : null,
      tokenAccounts: tokenAccounts.map((account) => ({
        label: account.label,
        totalValue: account.totalValue.toString(),
        noteCount: account.notes.length,
        commitments: account.notes.map((note) => note.commitment),
      })),
    });
  }, [activeNotesForSelectedToken, chainId, isOpen, log, preferredTransaction, preferredWithdrawNote, selectedPA, selectedToken, spendableCommitments, tokenAccounts]);

  useEffect(() => {
    if (!supportsGasTokenOption && gasTokenChecked) {
      setGasTokenChecked(false);
    }
  }, [gasTokenChecked, supportsGasTokenOption]);

  const currentBalance = tokenBalances.get(selectedToken) || { active: 0n, pending: 0n, total: 0n, count: 0 };
  // The association set hasn't answered yet, so nothing is provably spendable
  // YET — as opposed to provably nothing. While this is true the form is in a
  // loading state: max/percent selection waits, and the amount errors don't
  // judge the entry against a balance of 0 (Pat, 2026-08-28). A fetch failure is
  // a separate retryable state; it is neither loading nor a verified empty set.
  const spendabilityLoading = isSui
    ? suiSpendability.approvalPending
    : (isLoadingNotes || leafGate.status === 'loading');
  const spendabilityBlocked = spendabilityLoading || spendabilityError !== null;
  const getSpendableBalanceWei = useCallback((tokenSymbol: string): bigint | null => {
    if (spendabilityBlocked) return null;
    if (isSui) return tokenSymbol === altSymbol ? suiSpendability.totalWei : 0n;
    return tokenBalances.get(tokenSymbol)?.active ?? 0n;
  }, [isSui, altSymbol, spendabilityBlocked, suiSpendability.totalWei, tokenBalances]);
  const getWithdrawMaxWei = useCallback((tokenSymbol: string): bigint | null => {
    if (spendabilityBlocked) return null;
    if (isSui) return tokenSymbol === altSymbol ? suiSpendability.maxSingleWei : 0n;
    // EVM inline Max is the full spendable balance: the plain 100% route keeps
    // its existing batch semantics when one proof cannot carry everything.
    return tokenBalances.get(tokenSymbol)?.active ?? 0n;
  }, [isSui, altSymbol, spendabilityBlocked, suiSpendability.maxSingleWei, tokenBalances]);

  // Keep BOTH caps materialized. `availableWei` is the current route's
  // single-proof cap, while route-change handlers need the destination route's
  // cap before React has committed that route change.
  const mixedLabelCapWei = useMemo(
    () => topNAcrossLabels(activeNotesForSelectedToken, WITHDRAW_MAX_INPUTS),
    [activeNotesForSelectedToken],
  );
  // Both routes are one proof over up to 5 notes of ANY label (the circuit
  // takes labels per input; the SDK mints a change note per label). The swap
  // exit used to pin itself to one label, which refused a 0.005 ETH swap over
  // two 0.004 ETH deposits (Pat, prod 2026-09-04); what it still cannot do is
  // BATCH several proofs, so the full-balance batch bypass stays withdraw-only.
  const availableWei = mixedLabelCapWei;
  const availableNum = useMemo(
    () => tokenBalanceNum(availableWei, withdrawTokenDecimals(selectedToken, chainId, isSui)),
    [availableWei, selectedToken, chainId, isSui],
  );
  // Total spendable across ALL lineages — the same leaf-gated figure the home
  // screen shows. `availableNum` above is the current route's one-proof cap;
  // showing it as "Balance" hid notes beyond that cap and made the
  // two screens disagree (#214).
  const selectedTokenDecimals = useMemo(
    () => withdrawTokenDecimals(selectedToken, chainId, isSui),
    [selectedToken, chainId, isSui],
  );
  const spendableNum = tokenBalanceNum(currentBalance.active, selectedTokenDecimals);
  const pendingNum = tokenBalanceNum(currentBalance.pending, selectedTokenDecimals);
  const totalNum = tokenBalanceNum(currentBalance.total, selectedTokenDecimals);
  // Same $1 fallback the balance views apply: a legacy stable the price feed
  // no longer lists must not review as "$0.00" (codex, 2026-09-04).
  const currentPrice = priceMap[selectedToken] || (isStablecoin(selectedToken) ? 1 : 0);
  // Native-gas top-up the relay will attach, read from the SIGNED commitment
  // (services/gas-top-up.ts). Null unless the box is ticked and the routing
  // carries a non-zero nativeGas, so the two screens render nothing otherwise.
  const gasTopUp = useMemo(() => {
    if (!gasTokenChecked || isSui || !activeFeeCommitment?.data) return null;
    const native = getChainConfig(chainId)?.nativeCurrency ?? { symbol: 'ETH', decimals: 18 };
    return formatGasTopUp({
      wei: decodeGasTopUpWei(activeFeeCommitment.data),
      symbol: native.symbol,
      decimals: native.decimals,
      priceUsd: priceMap[native.symbol],
    });
  }, [gasTokenChecked, isSui, activeFeeCommitment, chainId, priceMap]);
  const poolName = `${poolDisplayLabel(selectedToken, chainId)} Pool`;

  // Derived values using real relayer fee data
  const enteredAmount = parseFloat(amount) || 0;
  const tokenDecimalsForDisplay = selectedTokenDecimals;

  // The withdraw form asks the ASP nothing about the amount being withdrawn.
  //
  // This block used to run three lookups against
  // `deposits-larger-than?amount=<wei>`: the entered amount plus two "blend
  // in" candidates, with no debounce — the query key was the amount itself, so
  // each distinct value typed fired immediately. The amount sent is the same
  // integer that appears in the withdrawal on chain minutes later, and the
  // requests came from a session the ASP can tie to the caller, so the pair
  // links a depositor to a withdrawal. This breaks the privacy the pool is
  // meant to provide, so the requests and the nudge they fed are gone.
  //
  // Restoring the nudge needs the amount distribution as a caller-independent
  // feed the client can count against locally (asp-v2#127,
  // /public/deposit-amounts), fetched with the other public feeds at load
  // rather than when this form opens: a request made only when a withdrawal is
  // imminent reveals that even when its contents do not.

  /**
   * The fee, in the asset the QUOTE says it is charged in.
   *
   * This used to be `feeAmount / 10 ** TOKEN_DECIMALS[selectedToken]` — it
   * assumed the fee is denominated in the asset being withdrawn and never
   * checked, while the quote carries `feeCommitment.asset`. A fee charged in
   * one asset and scaled by another's decimals is off by 10**(d1-d2), which is
   * how a 5 USDC withdrawal showed "Relayer fee: 499312.7542 USDC" next to a
   * live Confirm (Artem, QA 2026-08-28). See services/relayer-fee.ts.
   */
  const resolvedFee = useMemo(() => resolveRelayerFee({
    // The BUDGETED fee (quoted + re-quote allowance): what Confirm actually
    // reserves and, in gross mode, subtracts. Review figures derive from it so an
    // amount Review accepts is one Confirm accepts (codex on 54a6eb5). The
    // allowance is 1 ppb, invisible at display precision.
    feeAmount: relayerQuote ? BigInt(relayerQuote.feeAmount) + relayerFeeJitterAllowance(BigInt(relayerQuote.feeAmount)) : 0n,
    feeAsset: relayerQuote?.feeCommitment?.asset ?? null,
    withdrawToken: {
      symbol: selectedToken,
      decimals: tokenDecimalsForDisplay,
      address: getTokenMetadataBySymbol(selectedToken, chainId)?.address ?? null,
    },
    lookupAsset: (address) => {
      const meta = getTokenMetadata(address, chainId);
      return meta ? { symbol: meta.symbol, decimals: meta.decimals } : undefined;
    },
  }), [relayerQuote, selectedToken, tokenDecimalsForDisplay, chainId]);
  const relayerFee = relayerQuote ? resolvedFee.amount : 0;
  const feeBPS = relayerQuote && enteredAmount > 0
    ? Math.round((relayerFee / enteredAmount) * 10000)
    : 0;
  const receivedAmount = Math.max(0, enteredAmount - relayerFee);
  const enteredAmountWei = useMemo(() => {
    try {
      return parseTokenAmount(amount, tokenDecimalsForDisplay);
    } catch {
      return 0n;
    }
  }, [amount, tokenDecimalsForDisplay]);
  // Live LiFi preview for a swap exit on the FORM, before Review. The form
  // used to show a dash here until Review, which reads as "no quote" (Pat,
  // 2026-08-29). Same pattern as the Shield tab's cross-pay preview: a direct
  // li.quest estimate, debounced, sequence-guarded, aborted on change. It is
  // an estimate only — the binding figure is still the SDK quote at Review —
  // so it renders with a "~". services/swap-exit-estimate.ts.
  const [swapExitEstimate, setSwapExitEstimate] = useState<
    { status: 'idle' | 'loading' | 'ok' | 'none'; toAmount?: bigint }
  >({ status: 'idle' });
  const swapExitEstimateSeqRef = useRef(0);
  const swapExitEstimateFromAddress = getSwapProcessorAddress(chainId) ?? connectedAddress ?? null;
  useEffect(() => {
    const seq = ++swapExitEstimateSeqRef.current;
    if (!isOpen || step !== 'withdraw' || !isSwapExit || !receiveAsset || !swapExitEstimateFromAddress) {
      setSwapExitEstimate({ status: 'idle' });
      return;
    }
    const inputWei = swapExitEstimateInputWei({
      grossWei: enteredAmountWei,
      feeWei: (() => {
        // The relayer quote only exists once Review has run; the form estimate
        // usually runs on the gross. When one is present, mirror the SDK's net.
        if (!relayerQuote) return null;
        try { return BigInt(relayerQuote.feeAmount); } catch { return null; }
      })(),
    });
    if (inputWei <= 0n) { setSwapExitEstimate({ status: 'idle' }); return; }
    setSwapExitEstimate({ status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchLifiExactInQuote({
        chainId,
        toChainId: receiveChainId,
        fromToken: selectedTokenAddress,
        toToken: receiveAsset.address,
        fromAmountWei: inputWei,
        fromAddress: swapExitEstimateFromAddress,
        signal: controller.signal,
      }).then((q) => {
        if (swapExitEstimateSeqRef.current !== seq) return;
        setSwapExitEstimate(q ? { status: 'ok', toAmount: q.toAmount } : { status: 'none' });
      }).catch(() => {
        if (swapExitEstimateSeqRef.current === seq) setSwapExitEstimate({ status: 'none' });
      });
    }, 450);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [isOpen, step, isSwapExit, receiveAsset, receiveChainId, chainId, selectedTokenAddress, enteredAmountWei, relayerQuote, swapExitEstimateFromAddress]);
  const swapExitEstimateText = swapExitEstimate.status === 'ok' && swapExitEstimate.toAmount !== undefined && receiveAsset
    ? `~${formatSwapExitEstimate(swapExitEstimate.toAmount, receiveAsset.decimals)}`
    : null;
  // Full-balance intent (explicit Max/100% or a to-the-wei match): the
  // relayer fee comes OUT of the final amount — "receive exact" cannot add a
  // fee on top of a balance with nothing left on top. The batch route already
  // works this way; this extends the same semantics to the single-proof full
  // withdrawal so tapping the balance is always a reviewable entry. Never on
  // the swap exit (its amount is the quote input, capped at one proof).
  const fullBalanceIntent = !isSui && !isSwapExit && isFullBalanceRequest({
    requestedWei: enteredAmountWei,
    totalActiveWei: currentBalance.active,
    maxSelected,
  });
  // The 100% of a one-proof route is also a gross maximum: adding a fee above
  // it is mathematically impossible. This keeps the 100% tab reviewable for a
  // swap exit and for a plain cap smaller than the total balance.
  const singleProofMaxIntent = !isSui
    && !fullBalanceIntent
    && enteredAmountWei > 0n
    && enteredAmountWei === availableWei;
  const maxGrossIntent = fullBalanceIntent || singleProofMaxIntent;
  const effectiveReceiveExact = !isSui && !isSwapExit && resolveEffectiveReceiveExact({
    requestedReceiveExact: receiveExact,
    enteredWei: enteredAmountWei,
    totalBalanceWei: currentBalance.active,
    singleProofCapWei: availableWei,
  });
  /**
   * An impossible fee is not a display problem. Whatever produced it (relayer
   * bug, unit error, stale quote), a fee that eats the whole withdrawal must
   * not sit next to a working Confirm button, which is what the old card did.
   *
   * Order and scope (codex on 8a2b5e6):
   * 1. the implausible-scale class first, from the float helper, in every mode
   *    (a 100x fee is always also >= the entry, so it must win);
   * 2. receive-exact: the fee rides ON TOP of the entry and the quote admission
   *    already requires entry + budgeted fee <= available, so no consuming check;
   * 3. gross mode, fee in the withdrawn asset: EXACT, the budgeted fee against
   *    the entered wei, the same comparison Confirm makes;
   * 4. a fee quoted in another asset never reaches this point:
   *    the quote admission refuses it before Review, so units are comparable here.
   */
  const feeSanityFloat: ReturnType<typeof feeSanity> = relayerQuote
    ? feeSanity({ feeAmount: resolvedFee.amount, withdrawAmount: enteredAmount })
    : 'ok';
  const feeBudgetForVerdictWei = relayerQuote
    ? BigInt(relayerQuote.feeAmount) + relayerFeeJitterAllowance(BigInt(relayerQuote.feeAmount))
    : 0n;
  const feeVerdict: ReturnType<typeof feeSanity> = !relayerQuote
    ? 'ok'
    : feeSanityFloat === 'implausible'
      ? 'implausible'
      : effectiveReceiveExact
        ? 'ok'
        : enteredAmountWei > 0n && feeBudgetForVerdictWei >= enteredAmountWei ? 'exceeds-amount' : 'ok';
  const feeRefusal = feeSanityMessage(feeVerdict, { ...resolvedFee, text: balanceDisplay(resolvedFee.text.split(' ')[0], resolvedFee.symbol, chainId).text });
  // DEV-229: split the entered value into the pool-leaving total vs the
  // recipient's net, depending on the "receive exact amount" toggle.
  const grossWithdrawn = effectiveReceiveExact ? enteredAmount + relayerFee : enteredAmount;
  const netReceived = effectiveReceiveExact ? enteredAmount : receivedAmount;
  // Gross amount LEAVING the selected lineage, in token base units — the exact
  // quantity the full-withdrawal guard compares against the cap (codex finding
  // 6). Receive-exact adds the relayer fee (known only after the quote), so the
  // guard re-evaluates once the fee arrives.
  const feeWei = relayerQuote ? BigInt(relayerQuote.feeAmount) : 0n;
  // What Confirm actually budgets: the quoted fee plus the re-quote allowance
  // (services/relayer-fee-jitter.ts). Caps, the remaining balance, Max and the
  // share net preview all read this so Review describes what Confirm executes.
  const feeBudgetWei = feeWei + relayerFeeJitterAllowance(feeWei);
  const grossLeavingWei = resolveGrossLeavingWei({
    enteredWei: enteredAmountWei,
    feeWei: feeBudgetWei,
    receiveExact: effectiveReceiveExact,
  });
  const singleProofMaxInputWei = resolveSingleProofMaxInputWei({
    singleProofCapWei: availableWei,
    feeWei: feeBudgetWei,
    receiveExact: effectiveReceiveExact,
  });
  // === Full-balance batch withdrawal (flag-gated) ===
  // The SDK's batch flow withdraws the ENTIRE active balance of an asset —
  // the only shape it supports — so the batch route applies exactly when the
  // user asks for their whole balance (100% tab / typed full amount) and a
  // single 5-input proof can't cover it. Everything the single-proof path can
  // serve keeps taking the single-proof path, untouched.
  // Never for a share: the batch route is a PLAIN payout of the asset, and a
  // share always leaves as its underlying through the PPRouter. With batching
  // on, Max on a share balance spanning several proofs went straight to
  // prepareBatchWithdraw and paid ppUSDC under a USDC label (codex P1 on
  // d6abfcd). Until batch redemption exists, a share is single-proof only.
  const batchEnabled = BATCH_WITHDRAWALS_ENABLED && !isSui && !selectedIsShare;
  // A full-balance withdrawal needs batching only when its exact note topology
  // spans more than one proof (one lineage of >5 notes, or several lineages).
  // Derived from note counts, never float amounts.
  const fullWithdrawGroupCount = useMemo(() => {
    if (!batchEnabled) return 0;
    return countFullWithdrawGroups({
      notes,
      tokenId: selectedTokenAddress,
      maxInputs: WITHDRAW_MAX_INPUTS,
    });
  }, [batchEnabled, notes, selectedTokenAddress]);
  // Full-balance intent (explicit Max, or a to-the-wei match) AND a topology
  // that a single proof can't serve. No numeric-closeness inference. NEVER
  // true on the swap-exit route: a withdraw+swap is a single proof capped at
  // 5 notes (any labels) — batch semantics don't exist there (codex P2),
  // so the batch bypass below must not admit an amount the swap route will
  // deterministically fail to select.
  const fullBalanceRequested =
    batchEnabled &&
    !isSwapExit &&
    fullWithdrawGroupCount > 1 &&
    isFullBalanceRequest({
      requestedWei: enteredAmountWei,
      totalActiveWei: currentBalance.active,
      maxSelected,
    });
  // === Sui review gate ===
  // Mirror the confirm-time lineage-first (single-input-capped) selection so
  // review can never accept an amount the submit path must reject, and so the
  // change display matches what will actually be spent.
  const suiWithdraw = useMemo(() => {
    if (!isSui) return { want: 0n, selection: null as SuiNoteSelection | null, activeTotal: 0n, maxSingle: 0n };
    let want = 0n;
    try { want = parseTokenAmount(amount, altDecimals); } catch { want = 0n; }
    if (isStellar) {
      // Same mixed-label, five-input rule the EVM withdraw uses; the shape is
      // reduced to "does one proof cover it" for the shared review gate.
      // The relayer fee is added on top, so the inputs must cover both.
      const gross = want > 0n ? want + estimateStellarRelayFee(want) : 0n;
      const picked = want > 0n
        ? selectWithdrawInputs(notes.filter((n) => String(n.status) === 'ACTIVE'), gross, 0n)
        : null;
      return {
        want,
        selection: picked && picked.total >= gross ? ({} as SuiNoteSelection) : null,
        activeTotal: suiSpendability.totalWei,
        maxSingle: suiSpendability.maxSingleWei,
      };
    }
    const { approvedNotes } = partitionSuiWithdrawNotes(suiSpendability.storedNotes);
    return {
      want,
      selection: want > 0n ? selectSuiNotes(approvedNotes, want) : null,
      activeTotal: suiSpendability.totalWei,
      maxSingle: suiSpendability.maxSingleWei,
    };
  }, [amount, isSui, isStellar, altDecimals, notes, suiSpendability.maxSingleWei, suiSpendability.storedNotes, suiSpendability.totalWei]);
  // Stellar: the relayer fee leaves the pool on top of the amount, so Review's
  // "Unshielding" and "left after" figures include it.
  const stellarFeeWei = isStellar && suiWithdraw.want > 0n ? estimateStellarRelayFee(suiWithdraw.want) : 0n;
  const suiAmountError = useMemo(() => {
    if (!isSui || suiWithdraw.want <= 0n || suiWithdraw.selection) return null;
    if (suiWithdraw.want > suiWithdraw.activeTotal) {
      // Funds that exist but are not approved yet are not "insufficient".
      if (isStellar && stellarSession.pendingTotal > 0n && suiWithdraw.want <= suiWithdraw.activeTotal + stellarSession.pendingTotal) {
        return `${(Number(stellarSession.pendingTotal) / altScale).toFixed(4)} ${altSymbol} is waiting for ASP approval. You can withdraw it once approved.`;
      }
      return `Insufficient ${isStellar ? 'Stellar' : 'Sui'} balance (${(Number(suiWithdraw.activeTotal) / altScale).toFixed(4)} ${altSymbol} available)`;
    }
    return isStellar
      ? `One withdrawal can spend up to ${WITHDRAW_MAX_INPUTS} notes (${(Number(suiWithdraw.maxSingle) / altScale).toFixed(4)} ${altSymbol}). Withdraw that first, then the rest.`
      : SUI_SINGLE_NOTE_ERROR;
  }, [isSui, isStellar, altScale, altSymbol, suiWithdraw, stellarSession.pendingTotal]);
  // Remaining means the WHOLE approved shielded balance, not just the selected
  // inputs' change. With mixed labels (or notes beyond the five-input cap),
  // subtracting from `availableWei` hid untouched notes on Review.
  const remainingAmount = tokenBalanceNum(resolveRemainingBalanceWei({
    totalBalanceWei: currentBalance.active,
    grossLeavingWei: isSui ? suiWithdraw.want + stellarFeeWei : grossLeavingWei,
  }), selectedTokenDecimals);
  // What one Sui withdrawal can actually move: the largest single active note
  // (single-input transact cap). EVM: route-specific (codex P2) — the swap
  // exit is a single proof over up to 5 notes of any label, so it advertises
  // that single-proof cap even with batching on; batch-eligible plain
  // withdrawals advertise the full active balance.
  const amountField = useShareAmountField({ amount, symbol: selectedToken, chainId, maxSharesExact: formatUnits(getWithdrawMaxWei(selectedToken) ?? 0n, selectedTokenDecimals), capKnown: !spendabilityBlocked, onAmountResolved: (shares) => applyShareAmount(shares), underlyingEntry: !isSui });
  const amountDollarLabel = useCallback((sharesExact: string) => {
    if (isShareSymbol(selectedToken)) {
      const view = balanceDisplay(sharesExact, selectedToken, chainId);
      return view.converted ? `$${view.usd.toFixed(2)}` : '';
    }
    return `$${((parseFloat(sharesExact) || 0) * currentPrice).toFixed(2)}`;
  }, [selectedToken, balanceDisplay, chainId, currentPrice]);
  const displayAvailableNum = isSui
    ? Number(suiWithdraw.maxSingle) / altScale
    : tokenBalanceNum(
        resolveDisplayAvailableWei({
          isSwapExit,
          batchEnabled,
          spendableWei: currentBalance.active,
          singleProofCapWei: availableWei,
        }),
        selectedTokenDecimals,
      );
  // Gate in exact wei: parseFloat(formatUnits(w)) and Number(w)/10**d are two
  // different double-roundings of the same rational and disagree for ~2.6% of
  // wei values (GLM review, bug 2) — a to-the-wei full-balance entry must not
  // bounce off a 3e-4 float artifact. A full balance that fits the current
  // mixed-label proof has grossLeavingWei === availableWei; larger 100%
  // requests go through the existing batch route or are genuinely over-cap.
  const canReviewWithdrawal = !spendabilityBlocked
    && !isQuoteLoading
    && enteredAmount > 0
    && (grossLeavingWei <= availableWei || fullBalanceRequested)
    && !!targetAddress
    && !targetError
    && !targetEnsResolving;
  // Batch review figures: gross = full balance leaving the pool, net = gross
  // minus the aggregate batch fee. These override the single-quote display
  // values only while a batch plan is active.
  const batchGrossNum = batchPlan ? Number(batchPlan.totalOutWei) / 10 ** tokenDecimalsForDisplay : 0;
  const batchFeeNum = batchPlan ? Number(batchPlan.totalFeeWei) / 10 ** tokenDecimalsForDisplay : 0;
  const reviewGross = batchPlan
    ? batchGrossNum
    : isStellar ? grossWithdrawn + Number(stellarFeeWei) / altScale : grossWithdrawn;
  const reviewNet = batchPlan ? Math.max(0, batchGrossNum - batchFeeNum) : netReceived;
  // Stellar bypasses the EVM quote, so its fee comes from the relay estimate
  // that the total above already includes.
  const reviewFee = batchPlan ? batchFeeNum : isStellar ? Number(stellarFeeWei) / altScale : relayerFee;
  // A share's net figure is a SHARE count; what arrives is the vault's
  // previewRedeem of those shares (the router pays that, the relayer fee
  // already taken out in shares). Read it for the review/success headline so
  // "USDC" is never a relabelled share count understated by (rate − 1): at
  // 1.05× that is 5% (codex P2 on d6abfcd). Shown as an estimate ("≈"); the
  // quote at submit is final and the success step names it.
  // The argument is the same bigint arithmetic submit uses, never the
  // re-parsed float (codex P3 on 0cea0b3): entered − fee in gross mode, the
  // entered amount in receive-exact mode. Null until the fee is known.
  // Plain bigint arithmetic, no memo: bigints compare by value, so nothing
  // downstream churns, and the React Compiler could not preserve a memo keyed
  // on the quote object.
  const reviewNetWei: bigint | null = selectedIsShare && (effectiveReceiveExact || !!relayerQuote)
    ? netSharesWei(enteredAmountWei, feeBudgetWei, effectiveReceiveExact)
    : null;
  const reviewShareDeployment = selectedIsShare ? getYieldDeploymentForAsset(chainId, selectedTokenAddress) : undefined;
  const reviewRedeemEnabled = !isSui && !!publicClient && reviewNetWei != null && !!reviewShareDeployment;
  const { data: reviewNetUnderlying, isError: reviewRedeemFailed } = useQuery({
    queryKey: ['withdraw-review-preview-redeem', chainId, selectedTokenAddress, reviewNetWei?.toString()],
    enabled: reviewRedeemEnabled,
    staleTime: 30_000,
    queryFn: async () => {
      const assets = await publicClient!.readContract({
        address: selectedTokenAddress as `0x${string}`,
        abi: PREVIEW_REDEEM_ABI,
        functionName: 'previewRedeem',
        args: [reviewNetWei!],
      });
      return (assets as bigint).toString();
    },
  });
  const reviewNetUnderlyingNum = reviewShareDeployment && reviewNetUnderlying != null
    ? Number(formatUnits(BigInt(reviewNetUnderlying), reviewShareDeployment.underlyingDecimals))
    : null;
  // Headline for the net figure (services/share-display.ts): the redeemed
  // underlying once read, "Estimating USDC…" while the read is in flight, and
  // the honest share count labelled as the SHARE when it cannot be read.
  // Never a share count labelled USDC (codex P2 on 0cea0b3).
  const reviewNetLabel = shareReviewHeadline({
    isShare: selectedIsShare,
    shares: reviewNet,
    shareSymbol: selectedToken,
    underlyingSymbol: shareUnderlyingSymbol,
    underlying: reviewNetUnderlyingNum,
    pending: reviewRedeemEnabled && !reviewRedeemFailed && reviewNetUnderlyingNum == null,
    format: sharedFormatTokenBalance,
  });
  // The greyed receive figure on the form, before Review: the same redeemed
  // underlying, never the share count under the coin's name.
  const previewNet = previewReceiveFigure({ isShare: selectedIsShare, amount: reviewNet, underlying: reviewNetUnderlyingNum });
  // The dollar total beside it: the redeemed underlying at the underlying's
  // price, never shares × that price (codex P2 on 0cea0b3). Null hides the
  // line while the conversion is unknown.
  const reviewNetUsd: number | null = !selectedIsShare
    ? reviewNet * currentPrice
    : reviewNetUnderlyingNum != null
      ? reviewNetUnderlyingNum * (priceMap[shareUnderlyingSymbol] || (isStablecoin(shareUnderlyingSymbol) ? 1 : 0))
      : null;
  // Success headline: the router quote captured at submit, which is what was
  // actually paid out (the disclosure under it names the guaranteed minimum).
  const successNetLabel = yieldRedemption
    ? `≈ ${sharedFormatTokenBalance(Number(formatUnits(yieldRedemption.quotedOut, yieldRedemption.underlyingDecimals)), displayTokenSymbol(yieldRedemption.underlyingSymbol))} ${displayTokenSymbol(yieldRedemption.underlyingSymbol).toUpperCase()}`
    : reviewNetLabel;
  // Swap-exit Review/Success figures come SOLELY from the immutable quote
  // snapshot (codex P1) — never live selectedToken/amount, which the user
  // may have edited since the quote was locked.
  const swapReviewInputSymbol = swapSnapshot?.inputToken.symbol ?? selectedToken;
  const swapReviewGrossNum = swapSnapshot
    ? Number(formatUnits(swapSnapshot.grossWei, swapSnapshot.inputToken.decimals))
    : 0;
  const swapReviewInputPrice = swapSnapshot
    ? (priceMap[swapSnapshot.inputToken.symbol] || 0)
    : currentPrice;
  // Every relayed EVM withdrawal: the relayer fee split into the gas it
  // re-bills and its margin, plus what a "Receive as" swap loses on the way.
  const withdrawFeeBreakdown = useMemo(() => {
    if (isSui || isStellar || (!relayerQuote && !swapSnapshot && !batchPlan)) return null;
    const poolChain = swapSnapshot?.poolChainId ?? chainId;
    // A yield share is priced through its vault rate; the price map alone reads it as $0.
    const inputUsd = swapSnapshot
      ? feePricing.tokenUsdOf(poolChain, swapSnapshot.inputToken.address, swapSnapshot.inputToken.symbol) ?? swapReviewInputPrice
      : feePricing.tokenUsdOf(chainId, selectedTokenAddress, selectedToken) ?? currentPrice;
    const amountUsd = (swapSnapshot ? swapReviewGrossNum : reviewGross) * inputUsd;
    // A fee in another token with no price is unknown, not worth the input's price.
    const feeTokenUsd = swapSnapshot || batchPlan || resolvedFee.symbol === selectedToken
      ? inputUsd
      : priceMap[resolvedFee.symbol] ?? (isStablecoin(resolvedFee.symbol) ? 1 : undefined);
    if (!feeTokenUsd || feeTokenUsd <= 0) return null;
    const relayerFeeUsd = (swapSnapshot ? parseFloat(swapSnapshot.display.relayerFee) || 0 : reviewFee) * feeTokenUsd;
    const gas = quoteGas(swapSnapshot ? (swapSnapshot.prepared.selectedQuote as { quote?: unknown } | null)?.quote : batchPlan ?? relayerQuote);
    const gasUsd = gas ? gasCostUsd(gas.gasUnits, gas.gasPriceWei, feePricing.nativeUsdOf(poolChain)) : null;
    const { networkUsd, serviceUsd } = splitRelayerFee(relayerFeeUsd, gasUsd);
    const readings: FeeGasReading[] = [{ chainId: poolChain, gasPriceWei: gas?.gasPriceWei ?? feePricing.gasPriceOf(poolChain) }];
    let swapUsd: number | null | undefined;
    if (swapSnapshot) {
      const { prepared, inputToken, outputToken, destinationChainId } = swapSnapshot;
      swapUsd = swapLossUsd(
        { amount: BigInt(prepared.netAmount), decimals: inputToken.decimals, usd: inputUsd },
        { amount: BigInt(prepared.estimatedOutput || '0'), decimals: outputToken.decimals, usd: feePricing.tokenUsdOf(destinationChainId, outputToken.address, outputToken.symbol) },
      );
      if (destinationChainId !== poolChain) readings.push({ chainId: destinationChainId, gasPriceWei: feePricing.gasPriceOf(destinationChainId) });
    }
    return buildFeeBreakdown({ amountUsd, networkUsd, serviceUsd, swapUsd, gas: readings });
  }, [isSui, isStellar, relayerQuote, swapSnapshot, batchPlan, chainId, swapReviewGrossNum, swapReviewInputPrice, reviewGross, currentPrice, reviewFee, priceMap, resolvedFee.symbol, feePricing, selectedTokenAddress, selectedToken]);
  // Sui withdraw gates on a positive amount, a well-formed optional recipient
  // AND the same note selection the submit path will run (suiAmountError), so
  // review can't accept an amount that confirm must reject.
  const reviewWithdrawalDisabled = isSui
    ? (spendabilityLoading || enteredAmount <= 0 || !!targetError || !!suiAmountError)
    : !canReviewWithdrawal;
  // FullWithdrawalGuard (privacy spec A3): withdrawing the ENTIRE balance in one
  // transaction is trivially linkable — trip a hard warning at 100% selection.
  // Own flag + EVM-only (codex finding 8). `full` is exact and fee-aware in base
  // units (codex finding 6) and re-evaluates once the relayer fee is known.
  const guardActive = FULL_WITHDRAWAL_GUARD_ENABLED && !isSui;
  const fullSelectionNow = guardActive
    && isFullWithdrawalSelectionWei({ grossLeavingWei, totalBalanceWei: currentBalance.active });
  // Sync the reducer's tripped state to the derived selection and, crucially,
  // clear the acknowledgment on every selection change or fee-driven
  // re-evaluation (codex finding 7). `selectionNonce` covers same-value
  // re-selections (e.g. tapping 100% again) that leave `fullSelectionNow`
  // unchanged; the ack checkbox dispatches 'ack' only and never bumps these
  // deps, so it isn't clobbered.
  useEffect(() => {
    dispatchGuard({ type: 'selection', full: fullSelectionNow });
  }, [fullSelectionNow, selectionNonce]);
  const fullWithdrawalTripped = guardState.tripped;
  // A locked wallet session cannot decrypt its notes, so the visible balance is
  // 0, every amount fails `grossLeavingWei <= availableWei`, and the CTA sat
  // permanently disabled. That left the inline (hub) flow with NO way to reach
  // the one-time signature, breaking the contract the inline open documents
  // ("the flow's own actions walk the gates when a session is needed") and
  // removing the unlock prompt QA expects from pressing Withdraw. So while
  // locked the CTA stays pressable and its press asks for the signature.
  // Stellar keeps its keys in its own session, never in the EVM one, so the
  // EVM test read every Stellar session as locked and left the CTA pressable
  // past an amount error.
  const sessionLocked = isStellar
    ? !stellarSession.unlocked
    : !keysReady && identityMode !== 'key';
  const withdrawCtaDisabled = sessionLocked
    ? false
    : reviewWithdrawalDisabled || guardBlocksCta(guardState) || isSwapQuoting;
  // Review-step "To:" line — rendered from the IMMUTABLE review snapshot
  // (the recipient the quote was actually prepared for), never live form
  // state: an edit racing an in-flight quote must not make Review show a
  // recipient the relay won't pay (codex P1). Falls back to the live
  // derivation only while no review has been committed.
  const reviewRecipientFallback = isSui ? altAccount : connectedAddress;
  const reviewRecipientFull = (() => {
    if (swapSnapshot) return swapSnapshot.recipient;
    if (reviewContext?.recipient) return reviewContext.recipient;
    if (targetAddress && (isSui || isAddress(targetAddress))) return targetAddress;
    return reviewRecipientFallback ?? null;
  })();
  const reviewRecipientDisplay = reviewRecipientFull ? truncateAddress(reviewRecipientFull) : '–';
  /**
   * Destination named at Review, read from the SNAPSHOT rather than live state:
   * Review must display the commitment Confirm will relay. Null for every
   * same-chain exit, which keeps both review variants exactly as they were.
   */
  const reviewDestinationName = swapSnapshot && swapSnapshot.destinationChainId !== swapSnapshot.poolChainId
    ? (getChainConfig(swapSnapshot.destinationChainId)?.displayName || `Chain ${swapSnapshot.destinationChainId}`)
    : null;
  // Withdrawal route on Sepolia v8: msg.sender for PoolVault.transact is
  // the PrivacyPoolRelay contract (the relayer signer calls
  // PrivacyPoolRelay.relay, which then forwards to PoolVault.transact).
  // PoolVault enforces `_transactParams.processor == msg.sender`, so the
  // proof has to bind to PrivacyPoolRelay, not the signer EOA — ignore
  // whatever processor the relayer's /relayer/details quote reports.
  // Resolve BOTH from wagmi's chain (the same source the SDK session, quote
  // and submission use) — never from the display selection, which can lag or
  // diverge (e.g. a rejected wallet switch). A proof bound to another chain's
  // relay dies with PoolVault_ProofContextMismatch after full proving.
  const withdrawalProcessorAddress = getWithdrawalProcessorAddress(chainId);

  // Spinner animation — runs during the proof-generation 'loading' step
  // AND while notes are still being discovered, so the inline placeholder
  // in the pool-account selector actually rotates.
  useEffect(() => {
    const isSpinning =
      step === 'loading' || isLoadingNotes || !sdkReady || isSyncing;
    if (isSpinning) {
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
  }, [step, isLoadingNotes, sdkReady, isSyncing, spinAnim]);

  const spinInterpolate = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Countdown timer for review step (based on quote expiry)
  useEffect(() => {
    if (step === 'review' && countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
    if (step === 'review' && countdown === 0 && (activeFeeCommitment || batchPlan || swapSnapshot)) {
      log('warn', 'Withdraw', 'Relayer quote expired, returning to input step');
      reportWithdrawError('Quote expired. Please request a new quote.');
      setStep('withdraw');
      setActiveFeeCommitment(null);
      setBatchPlan(null);
      setSwapSnapshot(null);
    setYieldRedemption(null);
      setReviewContext(null);
      resetQuote();
    }
  }, [step, countdown, activeFeeCommitment, batchPlan, swapSnapshot]);

  // Step read-through for callbacks/effects that must observe the CURRENT
  // step without re-subscribing on every step change.
  const stepRef = useRef(step);
  stepRef.current = step;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  // A note/session topology change invalidates any quote just as surely as an
  // amount edit. It also makes a committed Review stale: Confirm re-selects
  // notes, so keeping the old review would promise figures for a set that no
  // longer exists.
  const quotedSpendabilityKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = quotedSpendabilityKeyRef.current;
    quotedSpendabilityKeyRef.current = spendabilityKey;
    if (previous === null || previous === spendabilityKey || submittedRef.current) return;
    invalidateQuoteRequests();
    if (stepRef.current !== 'review') return;
    setActiveFeeCommitment(null);
    setColdStartClaim(null);
    setBatchPlan(null);
    setSwapSnapshot(null);
    setReviewContext(null);
    reportWithdrawError('Your spendable notes changed. Please review the withdrawal again.');
    setStep('withdraw');
  }, [invalidateQuoteRequests, reportWithdrawError, spendabilityKey]);

  // Context change (chain / EVM↔Sui routing / session account): every
  // in-flight quote and every reviewed figure was computed for another
  // context — invalidate them all, and kick an open review back to input
  // instead of letting Confirm act on a foreign quote (codex P1: the
  // snapshot must be bound to the reviewed chain/session). Guarded by a
  // context-key ref so ONLY a real context change acts — a re-run from an
  // unstable function dep must never invalidate an in-flight quote.
  const liveContextKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // The SUI account is part of the live context: switching Sui wallets
    // mid-review must invalidate exactly like an EVM account switch.
    const suiAddr = (altAccount ?? '').toLowerCase();
    const key = `${chainId}|${isSui ? 1 : 0}|${(connectedAddress ?? '').toLowerCase()}|${suiAddr}`;
    if (liveContextKeyRef.current === key) return;
    const isFirstRun = liveContextKeyRef.current === null;
    const previousChain = liveContextKeyRef.current?.split('|')[0];
    liveContextKeyRef.current = key;
    if (isFirstRun) return; // mount. Nothing was quoted yet
    // The destination belongs to the chain it was chosen on. Carrying it across a
    // POOL-CHAIN switch produced a destination the user never picked: the new
    // chain's destination list can contain the old pool chain, so
    // crossChainReceive flipped true on its own and the sheet went on offering
    // the stale chain's tokens (kimi 1.4). An ACCOUNT switch on the same chain
    // leaves the pick alone — it is still a valid choice there.
    if (previousChain !== undefined && previousChain !== String(chainId)) {
      setReceiveChainId(chainId);
      setReceiveAsset(null);
    }
    // A SUBMITTED operation is immutable (codex): superseding it would only
    // suppress its honest terminal screen and relabel its frozen outcome —
    // expected mid-flow moves (e.g. a swap-exit's wallet switching to the
    // destination chain) must not tear it down.
    if (submittedRef.current) return;
    // A context change supersedes any PRE-submit operation: its terminal
    // writes must not land in the new context (codex P1-5).
    modalEpochRef.current += 1;
    invalidateQuoteRequests();
    setActiveFeeCommitment(null);
    setBatchPlan(null);
    setSwapSnapshot(null);
    setReviewContext(null);
    if (stepRef.current === 'review' || stepRef.current === 'loading') {
      // 'loading' too (codex): open/close both refuse that step, so a wedge
      // here had no exit.
      reportWithdrawError('The network or account changed. Please review again.');
      setStep('withdraw');
      resetQuote();
    }
  }, [chainId, isSui, connectedAddress, altAccount, invalidateQuoteRequests, resetQuote]);

  // Fetch relayer quote and transition to review step
  // Decides whether an unregistered wallet has to be onboarded BY THE RELAYER:
  // reads its native balance and the chain's gas price, and returns the
  // decision only when the gasless claim applies (null = keep today's flow).
  // Balance is the trigger, per product decision: a funded wallet keeps paying
  // its own registration gas rather than silently moving that cost onto the
  // note being withdrawn.
  const resolveColdStartClaim = useCallback(async (
    owner: Address | undefined,
  ): Promise<RegistrationPathDecision | null> => {
    const supported = supportsColdStartClaim(
      chainId,
      withdrawalProcessorAddress,
      // Static member read — Metro only inlines static process.env.EXPO_PUBLIC_*
      // access in the production web export.
      process.env.EXPO_PUBLIC_COLD_START_CLAIM_RELAYS,
    );
    if (!supported || !owner || !publicClient) {
      log('info', 'Withdraw', 'Cold-start claim unavailable', {
        chainId,
        relay: withdrawalProcessorAddress,
        supported,
        hasOwner: !!owner,
      });
      return null;
    }
    // A failed read must not strand the user mid-flow, and must NOT read as an
    // empty wallet either: readRegistrationPath fail-closes a broken balance
    // read to the self-funded path, where `balanceWei = 0n` as an initial value
    // used to hand a funded wallet to the relayer (code review).
    const decision = await readRegistrationPath({
      getBalanceWei: () => publicClient.getBalance({ address: owner }),
      getGasPriceWei: () => publicClient.getGasPrice(),
    }, {
      onReadError: (scope, err) => log('warn', 'Withdraw', `${scope} read failed for the cold-start decision`, err),
    });
    log('info', 'Withdraw', 'Cold-start registration decision', {
      path: decision.path,
      reason: decision.reason,
      balanceWei: decision.balanceWei.toString(),
      gasPriceWei: (decision.gasPriceWei ?? 0n).toString(),
      estimatedGasCostWei: decision.estimatedGasCostWei.toString(),
    });
    return decision.path === 'relayed-claim' ? decision : null;
  }, [chainId, withdrawalProcessorAddress, publicClient, log]);

  const handleReviewWithdrawal = useCallback(async () => {
    withdrawPhaseRef.current = 'validate';
    // Locked wallet session: the press IS the request to sign in. Prompt for the
    // one-time signature and stop here; the balance and the form's validation
    // only mean anything once the notes can be decrypted, so there is nothing to
    // review yet and nothing to continue into.
    // EVM session only: Sui/Stellar unlock inside their own confirm paths.
    if (!isSui && !keysReadyRef.current && identityMode !== 'key') {
      log('debug', 'Withdraw', 'locked session: prompting for the keystore signature');
      openSeedDerivationModal();
      return;
    }
    // Disabled props are presentation, not an execution guard. A queued/stale
    // press must not start registration or quote work while the current
    // chain/note topology still has no association-set answer.
    if (spendabilityError) {
      reportWithdrawError('Could not verify the association set. Retry the shielded balance check first.');
      return;
    }
    if (spendabilityLoading) {
      reportWithdrawError('Still syncing withdrawable notes. Please try again in a moment.');
      return;
    }
    // Step-by-step trail for diagnosing a failed withdrawal: every line is
    // tagged 'Withdraw' and numbered, so a run can be copied out of the DEBUG
    // panel and compared against a run that behaved differently. Plain values
    // only, deliberately: reading guardStateRef here stopped the React Compiler
    // memoizing this callback, which surfaced unrelated errors elsewhere.
    log('info', 'Withdraw', 'step 1/6 review pressed', { amount, token: selectedToken });
    // Guard gate (codex finding 7): snapshot the selection generation at entry.
    // Advancing to review is refused if the selection changed while we awaited
    // registration/quote work, or if a tripped full-withdrawal guard is not
    // acknowledged — checked immediately before EVERY setStep('review'), not
    // only via the CTA's disabled prop.
    const gen = selectionGenRef.current;
    const canAdvanceToReview = () =>
      selectionGenRef.current === gen && !guardBlocksCta(guardStateRef.current);
    // Re-decided below from live balance/registration state: the wallet may
    // have been funded, registered, or switched since the last review.
    setColdStartClaim(null);
    // Sui: no EVM relayer quote. The Sui withdraw pays its own gas (direct) or
    // quotes at submit time (relayed) and has no fee-commitment/countdown, so
    // skip getQuote and go straight to review. The gate is a connected Sui
    // wallet + an ASP-approved input note (enforced in handleConfirm's isSui path).
    if (isSui) {
      if (!altAccount) {
        reportWithdrawError(isStellar ? 'Please connect Freighter first.' : 'Please connect your Sui wallet first.');
        return;
      }
      // Same selection the confirm path runs — refuse review when it would fail.
      if (suiAmountError) {
        reportWithdrawError(suiAmountError);
        return;
      }
      setActiveFeeCommitment(null);
      setCountdown(0);
      reportWithdrawError(null);
      if (!canAdvanceToReview()) return;
      setReviewContext({
        // 'sui' = the non-EVM route; poolChainId + sessionKey pin the chain.
        mode: 'sui',
        poolChainId: altChainId,
        sessionKey: `${altAccount.toLowerCase()}:${altChainId}`,
        epoch: modalEpochRef.current,
        recipient: (targetAddress && altRecipientPattern.test(targetAddress))
          ? targetAddress
          : altAccount,
        spendabilityKey,
      });
      setStep('review');
      return;
    }

    if (!connectedAddress) {
      reportWithdrawError('Please connect your wallet first.');
      return;
    }

    // === Canonical request identity, registered BEFORE the first await ===
    // (codex P1: a recipient edit during the pre-quote registration await
    // could otherwise relay to the OLD recipient while Review shows the new
    // one — the old continuation used to begin() only after the awaits and
    // made itself current again.) The key carries session, epoch, mode,
    // chain, tokens, amount, recipient, gas-token and slippage; every edit
    // handler invalidates the shared guard, and this handler re-checks
    // after EVERY await and immediately before committing Review.
    const resolvedRecipient = (targetAddress && isAddress(targetAddress))
      ? targetAddress
      : connectedAddress;
    // A cross-chain exit is only ever a swap exit. Without an output asset
    // there is nothing to route, and resolveWithdrawMode would fall back to the
    // plain (same-chain) withdrawal while the card promises another network.
    if (crossChainReceive && !receiveAsset) {
      reportWithdrawError(`Pick the asset to receive on ${receiveChainName}.`);
      return;
    }
    const reviewMode = resolveWithdrawMode({
      isSui: false,
      isSwapExit: !!(isSwapExit && receiveAsset),
      batchEligible: batchEnabled && fullBalanceRequested,
    });
    // Every input of the batch/plain routing decision, because "the batch
    // never triggered" is otherwise undiagnosable from logs: four independent
    // predicates feed it and none of them surfaced anywhere (2026-08-25, the
    // batch e2e burned three runs learning this the hard way).
    log('debug', 'Withdraw', 'Resolved review mode', {
      reviewMode,
      batchEnabled,
      fullBalanceRequested,
      fullWithdrawGroupCount,
      enteredAmountWei: enteredAmountWei.toString(),
      totalActiveWei: currentBalance.active.toString(),
      maxSelected,
      isSwapExit: !!(isSwapExit && receiveAsset),
    });
    const reviewEpoch = modalEpochRef.current;
    const sessionKey = `${connectedAddress.toLowerCase()}:${chainId}`;
    const requestKey = buildWithdrawQuoteKey({
      sessionKey,
      epoch: reviewEpoch,
      mode: reviewMode,
      poolChainId: chainId,
      inputToken: selectedTokenAddress,
      amount,
      outputToken: reviewMode === 'swap' && receiveAsset ? receiveAsset.address : selectedTokenAddress,
      recipient: resolvedRecipient,
      gasToken: gasTokenChecked,
      receiveExact: reviewMode === 'plain' ? effectiveReceiveExact : false,
      spendabilityKey,
      ...(reviewMode === 'swap' ? { slippage: RECEIVE_AS_SLIPPAGE } : {}),
      ...(crossChainReceive ? { destinationChainId: receiveChainId } : {}),
    });
    const requestToken = quoteGuardRef.current.begin(requestKey);
    const isCurrent = () => quoteGuardRef.current.isCurrent(requestToken, requestKey)
      && spendabilityKeyRef.current === spendabilityKey;
    const commitReviewContext = () => setReviewContext({
      mode: reviewMode,
      poolChainId: chainId,
      sessionKey,
      epoch: reviewEpoch,
      recipient: resolvedRecipient,
      spendabilityKey,
    });

    // Gate keystore registration BEFORE fetching the relayer quote.
    // Fees expire ~60s after the relayer issues them; deferring
    // registration to the confirm step meant the quote was almost
    // guaranteed to be stale by the time the user finished signing
    // the registration tx. Run the registration first so the quote
    // we fetch right after is always fresh.
    try {
      const session = sdkReady && poolSession ? poolSession : await ensureInitialized();
      if (!isCurrent()) return;
      if (session) {
        const isRegistered = await session.isKeystoreRegistered();
        if (!isCurrent()) return;
        if (!isRegistered) {
          if (identityMode === 'key') {
            reportWithdrawError(
              'This account key is not registered on-chain yet. Sign out of the account key and connect the owner wallet once to register, then retry from the account key.',
            );
            submittedRef.current = false;
        setStep('error');
            return;
          }
          if (!walletAddress) {
            reportWithdrawError(
              'This account is not registered on-chain yet. Account-key sessions cannot register because registration is a wallet transaction. Connect the owning wallet once to register, then retry from the account key.',
            );
            submittedRef.current = false;
        setStep('error');
            return;
          }
          // Cold start: a wallet that just received its first private payment
          // may hold no native currency at all, which makes the registration
          // transaction impossible. Where the chain's relay implements
          // registerAndRelay we skip that transaction entirely — at Confirm the
          // user signs SetAuthPolicy (free) and the relayer registers the
          // keystore and withdraws in ONE transaction, taking its fee from the
          // note. Fall through to the quote fetch; Confirm branches on this.
          const claimDecision = await resolveColdStartClaim(walletAddress);
          if (!isCurrent()) return;
          if (claimDecision) {
            setColdStartClaim(claimDecision);
          } else {
            log('info', 'Withdraw', 'Keystore not registered, prompting via modal');
            setIsOpen(false);
            openKeystoreRegistrationModal({
              title: 'Register before you withdraw',
              body:
                "Withdrawing privately needs a one-time on-chain record for your wallet. After this transaction confirms we'll fetch a fresh fee quote and continue with your withdrawal.",
              primaryLabel: 'Register and continue',
              onSuccess: () => {
                setIsOpen(true);
                void handleReviewWithdrawal();
              },
              // "Not now" must bring the withdraw modal back (codex round 2:
              // without this the parent stayed hidden in loading forever).
              onCancel: () => {
                setIsOpen(true);
                setLoadingMessage('');
              },
            });
            return;
          }
        }
      }
    } catch (err) {
      // Registration check failures are surfaced like any other
      // pre-quote error — better than silently fetching a quote we
      // can't use.
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'Withdraw', `Keystore registration check failed: ${message}`);
      // A module/chunk load failure is a stale tab, not a keystore fault, and
      // reporting it as one sent QA looking in the wrong place.
      const stale = staleBundleMessage(message);
      reportWithdrawError(stale ?? `Couldn't verify keystore registration: ${message}`);
      submittedRef.current = false;
      setStep('error');
      return;
    }

    const tokenDecimals = withdrawTokenDecimals(selectedToken, chainId, isSui);
    const amountWei = parseTokenAmount(amount, tokenDecimals);

    // === Full-balance batch route (flag-gated) ===
    // When the requested amount is the whole active balance and a single
    // 5-input proof can't cover it, quote the batch instead: partition the
    // active notes exactly the way the SDK session will, then fetch ONE
    // aggregate quote so review shows the real batch fee and totals.
    setBatchPlan(null);
    // Every review pass starts without a swap snapshot or review context;
    // only the branch that commits Review sets them, so Confirm can never
    // route a plain withdrawal through relayWithdrawAndSwap (or vice versa).
    setSwapSnapshot(null);
    setReviewContext(null);

    // === "Receive as" swap-exit route (spec C5) ===
    // A different output token composes the swap into the exit via the REAL
    // swap plumbing (prepareSwapQuote → relayWithdrawAndSwap), mirroring the
    // swap modal's money-safety invariants. Same-chain only (destination =
    // pool chain). The entered amount is the GROSS leaving the pool; the
    // relayer fee comes out of it before the swap (prepareSwapQuote quotes
    // the gross, relay spends the committed net). The request guard was
    // begun with the full canonical key before the first await above.
    if (reviewMode === 'swap' && receiveAsset) {
      const outputToken = receiveAsset;
      const grossWei = amountWei;
      const swapProcessor = getSwapProcessorAddress(chainId);
      if (!swapProcessor) {
        // Defensive: receiveAsAvailable already requires it (fail closed).
        reportWithdrawError('Swaps are not available on this network.');
        return;
      }
      // The relayer publishes the RelaySwaps it relays through; a quote and
      // proof bound to a processor it no longer runs revert on chain
      // (PoolVault_ProofContextMismatch, 2026-09-18). Refuse before quoting.
      try {
        await assertRelayerSwapProcessor(chainId, swapProcessor);
      } catch (drift) {
        reportWithdrawError(drift instanceof Error ? drift.message : String(drift));
        return;
      }
      setIsSwapQuoting(true);
      reportWithdrawError(null);
      try {
        if (grossWei <= 0n) throw new Error('Enter an amount greater than zero.');
        if (spendableCommitments === null) {
          throw new Error('Still syncing withdrawable notes. Please try again in a moment.');
        }
        // A withdraw + swap spends up to 5 ASP-approved notes of any label in
        // ONE proof, the same selector as the swap modal.
        const swapActiveNotes = (noteManager?.getNotes({ status: NoteStatus.ACTIVE }) ?? []).filter(
          (n) =>
            String(n.tokenId).toLowerCase() === selectedTokenAddress.toLowerCase()
            && BigInt(n.value) > 0n
            && spendableCommitments.has(n.commitment),
        );
        const selection = selectSwapInputNotes(swapActiveNotes, grossWei);
        if (!selection.covered) {
          const max = formatTokenUnits(selection.total, tokenDecimals);
          if (!isCurrent()) return;
          reportWithdrawError(
            selection.total > 0n
              ? `A withdraw + swap spends up to 5 approved notes in one proof. Largest spendable now: ${isShareSymbol(selectedToken) ? balanceDisplay(max, selectedToken, chainId).text : tokenAmountLabel(max, selectedToken)}.`
              : `No approved, spendable ${displayTokenSymbol(selectedToken)} notes are available yet.`,
          );
          return;
        }
        const session = sdkReady && poolSession ? poolSession : await ensureInitialized();
        if (!isCurrent()) return;
        if (!session) throw new Error('SDK initialization did not complete.');
        // Bind the quote (LiFi fromAddress) and the proof to the deployed
        // RelaySwaps contract — never the transfer-signer default and never
        // the PrivacyPoolRelay withdrawal contract (either produces
        // PoolVault_ProofContextMismatch after full proving).
        withdrawPhaseRef.current = 'quote';
        const { createRelayerInteractor } = await import('@/services/sdk-runtime');
        const relayerInteractor = createRelayerInteractor(chainId, swapProcessor);
        const relayers = await relayerInteractor.getRelayers();
        if (!isCurrent()) return;
        const relayer = relayers.find((r) => r.status === 'active') ?? relayers[0];
        if (!relayer) throw new Error('No relayer is available for swaps right now.');
        log('info', 'Withdraw', 'Requesting receive-as swap quote', {
          gross: grossWei.toString(),
          tokenId: selectedTokenAddress,
          outputToken: outputToken.address,
          processor: swapProcessor,
        });
        // Shared quote core (services/intent-swaps, same code the swap modal
        // runs): prepareSwapQuote for the gross + app-side re-validation
        // (gross binding, zero addresses, same-chain minimums) + display
        // shaping. Throws InvalidSwapQuoteError before Review can render.
        const { prepared, display } = await prepareValidatedSwapQuote(session as PoolSession, {
          relayerInfo: relayer,
          poolChainId: chainId,
          grossWei,
          inputToken: { address: selectedTokenAddress as Address, decimals: tokenDecimals },
          outputToken: { address: outputToken.address as Address, decimals: outputToken.decimals },
          recipientAddress: resolvedRecipient as Address,
          slippage: RECEIVE_AS_SLIPPAGE,
          ...(SWAP_DENY_EXCHANGES.length > 0 ? { denyExchanges: SWAP_DENY_EXCHANGES } : {}),
          // Cross-chain delivery. The fallback is the recipient the user just
          // entered: the destination leg has no protocol-owned verifier, so if
          // its deposit cannot execute LiFi pays out here instead. Same address
          // they chose to receive on, never a defaulted one.
          ...(crossChainReceive
            ? { toChainId: receiveChainId, fallbackAddress: resolvedRecipient as Address }
            : {}),
        });
        // Only the newest request (with an unchanged form) may commit state.
        if (!isCurrent()) return;
        // A quote that arrived expired never reaches Review. One with less
        // than the proving window left is fine here: Confirm refreshes it.
        const expiration = getPreparedQuoteExpiration(prepared);
        if (!isFreshCommitmentLive(expiration, Date.now())) {
          reportWithdrawError('The relayer quote had already expired when it arrived. Check that your device clock is set correctly, then try again.');
          return;
        }
        const expiresIn = Math.floor(((expiration as number) - Date.now()) / 1000);
        setActiveFeeCommitment(null);
        setSwapSnapshot({
          prepared,
          display,
          grossWei,
          inputToken: { symbol: selectedToken, address: selectedTokenAddress as Address, decimals: tokenDecimals },
          outputToken,
          recipient: resolvedRecipient as Address,
          slippage: RECEIVE_AS_SLIPPAGE,
          poolChainId: chainId,
          destinationChainId: crossChainReceive ? receiveChainId : chainId,
          ...(crossChainReceive ? { fallbackAddress: resolvedRecipient as Address } : {}),
          sessionKey,
          epoch: reviewEpoch,
        });
        setCountdown(expiresIn);
        log('info', 'Withdraw', 'Receive-as swap quote prepared', {
          net: prepared.netAmount,
          minOut: prepared.minOutputAmount,
          estOut: prepared.estimatedOutput,
          swapTarget: prepared.swapTarget,
        });
        // Same gate as the plain/batch paths: refuse to advance if the
        // selection changed or a tripped full-withdrawal guard was
        // un-acknowledged while the quote was in flight.
        if (!canAdvanceToReview()) {
          log('info', 'Withdraw', 'Selection/guard changed during swap quote. Not advancing to review');
          setSwapSnapshot(null);
          return;
        }
        commitReviewContext();
        setStep('review');
      } catch (err) {
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'Withdraw', `Receive-as swap quote failed: ${message}`);
        if (err instanceof InvalidSwapQuoteError) {
          reportWithdrawError(err.message);
        } else if (isSwapUnavailableError(err)) {
          // Typed HTTP 404 from the quote endpoint — expected until the
          // relayer ships /quote/evm/{chainId}/swap. Quote phase only.
          reportWithdrawError("Swaps aren't available on this network. The relayer isn't serving swap quotes here. No funds were moved.");
        } else if (isNoRouteError(err)) {
          reportWithdrawError(`No route found for ${displayTokenSymbol(selectedToken)} → ${displayTokenSymbol(outputToken.symbol)}. Try a different pair or amount.`);
        } else {
          // Raw wei in an SDK message is unreadable next to the amount field;
          // humanizeSdkAmounts rewrites the shapes it knows in the spent
          // asset's units and leaves everything else alone.
          reportWithdrawError(`Failed to get a swap quote: ${shownError(err)}`, err, 'swap-quote');
        }
      } finally {
        if (isCurrent()) setIsSwapQuoting(false);
      }
      return;
    }

    // Route to batch purely on explicit full-balance intent + a >1-proof
    // topology (fullBalanceRequested) — never on a float amount vs cap
    // comparison, which mis-rounds at the boundary (finding 3).
    if (reviewMode === 'batch') {
      try {
        if (spendableCommitments === null) {
          reportWithdrawError('Still syncing withdrawable notes. Please try again in a moment.');
          return;
        }
        const sdk = await import('@/services/sdk-runtime');
        const { createRelayerInteractor } = sdk;
        const batchActiveNotes = (noteManager?.getNotes({ status: NoteStatus.ACTIVE }) ?? []).filter(
          (n) => String(n.tokenId).toLowerCase() === selectedTokenAddress.toLowerCase() && BigInt(n.value) > 0n,
        );
        if (batchActiveNotes.length === 0) {
          reportWithdrawError(`No withdrawable ${displayTokenSymbol(selectedToken)} notes are available yet.`);
          return;
        }
        // Every active note gets its own proof, so every one must be
        // ASP-approved — one missing approval fails the whole batch.
        const unspendable = findUnspendableActiveNotes(batchActiveNotes, spendableCommitments);
        if (unspendable.length > 0) {
          reportWithdrawError(
            `${unspendable.length} ${displayTokenSymbol(selectedToken)} note${unspendable.length === 1 ? ' is' : 's are'} not cleared for spending yet. Sync and retry, or withdraw less.`,
          );
          return;
        }
        // ppv2's structural Note mirror keeps a couple of SDK-required fields
        // optional; these notes come from the SDK note manager, so the runtime
        // shape is right — the cast only bridges the nominal typing gap.
        const plan = planBatchWithdraw({
          notes: batchActiveNotes,
          tokenId: batchActiveNotes[0].tokenId,
          maxInputs: WITHDRAW_MAX_INPUTS,
          maxBatch: sdk.MAX_BATCH,
          selectGroups: sdk.selectNotesForFullWithdraw as unknown as SelectGroupsFn,
        });
        if (!plan.eligible) {
          reportWithdrawError(plan.message);
          return;
        }
        const relayerInteractor = createRelayerInteractor(chainId);
        const relayers = await relayerInteractor.getRelayers();
        if (!isCurrent()) return;
        const relayer = relayers.find((r) => r.status === 'active') ?? relayers[0];
        if (!relayer) throw new Error('No relayer available for a batch withdrawal.');
        const quote = await relayerInteractor.getBatchWithdrawalQuote(relayer, {
          asset: selectedTokenAddress as `0x${string}`,
          commit: true,
          recipient: resolvedRecipient as `0x${string}`,
          extraGas: false,
          amounts: plan.groups.map((g) => g.amountOut.toString()),
        });
        // Shared-guard stale check: any quote-defining edit (including a
        // "Receive as" change — mode + output token are in the key)
        // invalidated this request while it was in flight.
        if (!isCurrent()) {
          log('info', 'Withdraw', 'Discarding stale batch quote (inputs changed during fetch)');
          return;
        }
        // Same rule as the single-quote path: the fee must be denominated in the
        // withdrawn asset, or totalFee is read in the wrong units and N proofs
        // are wasted at Confirm on a mismatch the relayer rejects (codex on c3a2581).
        if (selectedTokenAddress && quote.feeCommitment.asset.toLowerCase() !== selectedTokenAddress.toLowerCase()) {
          reportWithdrawError('The relayer quoted its fee in a different asset than the one you are withdrawing. Please try again.');
          setStep('withdraw');
          return;
        }
        // Reject an already-expired (or sub-second) commitment instead of
        // inventing a fresh 60s countdown the SDK will not honor — a batch
        // proves N proofs, so an under-lifetime quote would waste them all and
        // never submit (findings 5 + 6). The real expiry drives the countdown.
        const expiresIn = Math.floor((quote.feeCommitment.expiration - Date.now()) / 1000);
        if (expiresIn <= 0) {
          reportWithdrawError('The relayer quote expired immediately. Please try again.');
          setStep('withdraw');
          return;
        }
        setActiveFeeCommitment(null);
        setBatchPlan({
          tokenId: batchActiveNotes[0].tokenId,
          groupCount: plan.groupCount,
          totalOutWei: plan.totalWei,
          totalFeeWei: BigInt(quote.totalFee),
          expiration: quote.feeCommitment.expiration,
          gasPrice: quote.gasPrice,
          txCost: quote.txCost,
        });
        setCountdown(expiresIn);
        log('info', 'Withdraw', 'Batch quote received', {
          groups: plan.groupCount,
          totalOut: plan.totalWei.toString(),
          totalFee: quote.totalFee,
          expiry: quote.feeCommitment.expiration,
        });
        // Same gate as the single-quote path below: refuse to advance if the
        // selection changed or a tripped full-withdrawal guard went
        // un-acknowledged while the batch quote was in flight — e.g. re-tapping
        // 100% during the fetch clears consent without changing the quote key
        // (codex finding 7 + integration review finding 2).
        if (!canAdvanceToReview()) {
          log('info', 'Withdraw', 'Selection/guard changed during batch quote. Not advancing to review');
          return;
        }
        commitReviewContext();
        setStep('review');
      } catch (err) {
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'Withdraw', `Failed to get batch fee quote: ${message}`);
        reportWithdrawError(quoteFailureMessage(message, shownError(err)), err, 'fee-quote');
        submittedRef.current = false;
        setStep('error');
      }
      return;
    }

    log('info', 'Withdraw', 'step 2/6 fetching the relayer quote', {
      chainId,
      amount: amountWei.toString(),
      asset: selectedTokenAddress,
      recipient: resolvedRecipient,
    });

    setRelayerQuote(null);
    setIsQuoteLoading(true);
    try {
      const quote = await getQuote(
        chainId,
        amountWei.toString(),
        selectedTokenAddress as `0x${string}`,
        resolvedRecipient as `0x${string}`,
        gasTokenChecked || undefined,
      );
      // Shared-guard stale check: discard the result if any quote-defining
      // input (recipient / amount / token / receive-asset / chain / session)
      // changed while the quote was in flight — otherwise a stale quote
      // would advance to review (and a pending PLAIN quote could enter
      // Review after the user switched "Receive as" to a swap exit).
      if (!isCurrent()) {
        log('info', 'Withdraw', 'Discarding stale relayer quote (inputs changed during fetch)');
        return;
      }
      setRelayerQuote(quote);
      // The displayed amounts and the SIGNED commitment must agree before anything
      // is shown as "the fee": Review reads the top-level copy, Confirm sizes
      // from the signed one (codex on 3f9b3b2). A mismatch is a bad relayer answer.
      if (!quoteMatchesSignedCommitment(quote)) {
        reportWithdrawError('The relayer quote does not match its signed commitment. Please try again.');
        resetQuote();
        return;
      }
      // The fee must be denominated in the withdrawn asset: Confirm compares and
      // subtracts it in that asset's units, the SDK asserts the same, and a fee
      // in another asset is not comparable to the entry at all. Fail closed
      // here rather than let Review and Confirm disagree (codex on 6728c98).
      if (selectedTokenAddress && quote.feeCommitment.asset.toLowerCase() !== selectedTokenAddress.toLowerCase()) {
        reportWithdrawError('The relayer quoted its fee in a different asset than the one you are withdrawing. Please try again.');
        resetQuote();
        return;
      }
      // An already-expired commitment must never reach Review (codex round 1,
      // P2): this used to replace expiry with a cosmetic 60s countdown, and
      // Confirm then rejected the real expiration after the user reviewed —
      // the batch path already refuses expiry here; match it.
      const expiresIn = Math.floor((quote.feeCommitment.expiration - Date.now()) / 1000);
      if (expiresIn <= 0) {
        reportWithdrawError('The relayer quote expired before it arrived. Please try again.');
        resetQuote();
        return;
      }
      // The fee arrives with the quote. In receive-exact mode it rides on top
      // of the entered amount, so an entry that fit before quoting can now be
      // deterministically over the one-proof cap. Refuse Review here rather
      // than letting Confirm discover the same fact after the user approved it.
      const quotedFeeWei = BigInt(quote.feeAmount);
      const quotedGrossLeavingWei = resolveGrossLeavingWei({
        enteredWei: amountWei,
        feeWei: quotedFeeWei + relayerFeeJitterAllowance(quotedFeeWei),
        receiveExact: effectiveReceiveExact,
      });
      if (quotedGrossLeavingWei > availableWei) {
        const maxInputWei = resolveSingleProofMaxInputWei({
          singleProofCapWei: availableWei,
          feeWei: quotedFeeWei + relayerFeeJitterAllowance(quotedFeeWei),
          receiveExact: effectiveReceiveExact,
        });
        const maxInput = formatUnits(maxInputWei, tokenDecimals);
        reportWithdrawError(
          maxInputWei > 0n
            ? `That's more than one transaction can carry. Enter at most ${isShareSymbol(selectedToken) ? balanceDisplay(maxInput, selectedToken, chainId).text : tokenAmountLabel(maxInput, selectedToken)} (up to ${WITHDRAW_MAX_INPUTS} notes per proof${effectiveReceiveExact ? ', after reserving the relayer fee' : ''}).`
            : `Your ${displayTokenSymbol(selectedToken)} notes don't have enough active balance to cover the relayer fee.`,
        );
        setActiveFeeCommitment(null);
        // Keep the non-active quote as advisory form state: the inline cap
        // block can now show the fee-aware max and its one-tap correction. No
        // commitment is activated and Review is not entered; the corrected
        // amount always fetches a fresh quote on the next press.
        return;
      }
      setActiveFeeCommitment(quote.feeCommitment);
      setCountdown(expiresIn);
      log('info', 'Withdraw', 'Relayer quote received', {
        feeAmount: quote.feeAmount,
        expiry: quote.feeCommitment.expiration,
        expiresIn,
      });
      // Refuse to advance if the selection changed or the full-withdrawal guard
      // was un-acknowledged while the quote was in flight (codex finding 7).
      if (!canAdvanceToReview()) {
        log('info', 'Withdraw', 'Selection/guard changed during quote. Not advancing to review');
        return;
      }
      commitReviewContext();
      setStep('review');
    } catch (err) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'Withdraw', `Failed to get relayer quote: ${message}`);
      reportWithdrawError(quoteFailureMessage(message, shownError(err)), err, 'fee-quote');
      submittedRef.current = false;
      setStep('error');
    } finally {
      if (isCurrent()) setIsQuoteLoading(false);
    }
  }, [isSui, suiSession, suiAmountError, connectedAddress, walletAddress, targetAddress, amount, selectedToken, selectedTokenAddress, chainId, gasTokenChecked, getQuote, identityMode, log, sdkReady, poolSession, ensureInitialized, openKeystoreRegistrationModal, openSeedDerivationModal, resolveColdStartClaim, batchEnabled, fullBalanceRequested, grossWithdrawn, availableNum, availableWei, effectiveReceiveExact, spendabilityLoading, spendabilityError, spendabilityKey, spendableCommitments, noteManager, isSwapExit, receiveAsset, crossChainReceive, receiveChainId, receiveChainName]);

  const handleConfirmUnlocked = useCallback(async () => {
    log('info', 'Withdraw', 'step 3/6 confirm pressed', {
      amount,
      token: selectedToken,
      recipient: reviewContext?.recipient ?? targetAddress ?? '(self)',
      fee: relayerFee,
    });
    // === Context/epoch gate (codex P1) ===
    // Confirm executes ONLY the operation that was reviewed, in the context
    // it was reviewed in. A chain switch, account switch, or modal
    // close/reopen since Review invalidates everything: clear the quote and
    // return to input rather than picking branches from live state (which
    // could e.g. run the Sui branch against an EVM-reviewed swap, or spend
    // from a different account's session).
    const confirmEpoch = modalEpochRef.current;
    // Sui-aware live identity: the Sui review stores `suiAddress:SUI_ID` as
    // its sessionKey, so the live key must be built from the SUI account
    // when routing Sui — building it from the EVM connectedAddress made the
    // match vacuous and let account B execute account A's review.
    const liveSessionKey = isSui
      ? `${(altAccount ?? '').toLowerCase()}:${altChainId}`
      : `${(connectedAddress ?? '').toLowerCase()}:${chainId}`;
    if (!reviewContextMatches(reviewContext, {
      isSui,
      poolChainId: isSui ? altChainId : chainId,
      sessionKey: liveSessionKey,
      epoch: confirmEpoch,
      spendabilityKey,
    })) {
      setActiveFeeCommitment(null);
      setColdStartClaim(null);
      setBatchPlan(null);
      setSwapSnapshot(null);
      setReviewContext(null);
      resetQuote();
      reportWithdrawError('The network or account changed since review. Please review again.');
      setStep('withdraw');
      return;
    }
    // An old operation must never overwrite a reopened flow: terminal writes
    // check the epoch. (Close is additionally blocked while step==='loading',
    // so this is defense in depth.)
    const isSameOperation = () => modalEpochRef.current === confirmEpoch;

    setStep('loading');
    reportWithdrawError(null);
    setWithdrawPending(false);
    stopHearingWithdrawSettleRef.current?.();
    stopHearingWithdrawSettleRef.current = null;
    // This attempt is accepted: drop the previous attempt's hash/chain pair so
    // the loading/recovery UI can never link the PRIOR failed transaction as
    // this attempt's outcome (codex).
    setTxHash(null);
    setTxChainId(null);
    submittedRef.current = false;
    withdrawPhaseRef.current = 'proof';
    setLoadingMessage('Preparing withdrawal proof...');

    // === Stellar path ===
    // Self-submitted withdrawal through the shared Stellar account: the same
    // mixed-label, five-input selection the EVM path uses, then the SDK's own
    // withdraw (change note back to self, processor = this account).
    if (reviewContext?.mode === 'sui' && reviewContext.poolChainId === STELLAR_TESTNET_ID) {
      try {
        const amountOut = parseTokenAmount(amount, altDecimals);
        const active = stellarSession.spendableNotes as unknown as Note[];
        // The relayer fee comes on top: pick notes covering amount + fee.
        const gross = amountOut + estimateStellarRelayFee(amountOut);
        const selection = selectWithdrawInputs(active, gross, 0n);
        if (selection.total < gross) {
          throw new Error(`Not enough to cover the amount plus the relayer fee within ${WITHDRAW_MAX_INPUTS} notes. Withdraw a smaller amount.`);
        }
        const recipient = reviewContext.recipient || altAccount || '';
        if (!isSameOperation()) { log('warn', 'Withdraw', 'Stale run aborted before Stellar broadcast'); return; }
        submittedRef.current = true;
        const result = await stellarSession.withdraw({
          amount: amountOut,
          recipient,
          inputCommitments: selection.notes.map((n) => n.commitment as `0x${string}`),
          shouldContinue: isSameOperation,
          onStage: (stage) => { if (isSameOperation()) setLoadingMessage(describeStellarStage(stage)); },
        });
        setTxHash(result.txHash);
        setTxChainId(STELLAR_TESTNET_ID);
        log('info', 'Withdraw', `Stellar withdraw submitted: ${result.txHash}`);
        if (isSameOperation()) setStep('success');
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (/Superseded/.test(raw)) return;
        const message = /reject|denied|cancel|declined/i.test(raw) ? 'Transaction was rejected.' : stellarErrorMessage(raw);
        log('error', 'Withdraw', `Stellar withdraw failed: ${raw}`, err);
        reportWithdrawError(message);
        submittedRef.current = false;
        setStep('error');
      }
      return;
    }

    // === Sui path ===
    // Route the withdrawal to the Sui session: select active notes covering the
    // amount (single lineage), build a change note back to self, then submit
    // RELAYED (gas-abstracted, when a relayer URL is configured) or DIRECT.
    if (reviewContext?.mode === 'sui') {
      withdrawPhaseRef.current = 'proof';
      setLoadingMessage('Reconstructing Merkle proofs + proving...');
      try {
        // Select active Sui notes covering the gross withdrawal amount from
        // ONE lineage (value conservation is per-label; mixing is invalid).
        const tokenDecimals = TOKEN_DECIMALS.SUI; // SUI base units (MIST)
        const amountOut = parseTokenAmount(amount, tokenDecimals);
        const { approvedNotes } = partitionSuiWithdrawNotes(suiSession.loadNotes());
        const selection = selectSuiNotes(approvedNotes, amountOut);
        if (!selection) {
          throw new Error(SUI_SINGLE_NOTE_ERROR);
        }
        const { notes: chosen, sum, label } = selection;
        const tokenId = BigInt(chosen[0].tokenId);
        const change = sum - amountOut;
        const { randomFieldElement } = await import('@/services/sui-witness');
        // Change note (back to self) when not withdrawing the full balance. A
        // transact requires >= 1 output; a zero-value change note keeps the
        // witness valid when withdrawing the full note value.
        const outputNotes = [{
          value: change,
          tokenId,
          label,
          noteSecret: randomFieldElement(),
          ownerAddress: BigInt(chosen[0].ownerAddress),
        }];
        // Recipient: the one Review committed to (the reviewed snapshot),
        // falling back to the connected wallet. Never re-derived from live
        // form state at confirm time (codex P1).
        const suiRecipient = reviewContext.recipient || (suiSession.account?.address ?? '');

        // RELAYED choice: a relayer URL is configured AND a recipient is known.
        // Binds processor = relayer + processor_data = encodePayoutRouting(...)
        // into the proof context and submits via the relayer (gas-abstracted).
        // Otherwise fall back to the DIRECT path (user submits + pays gas).
        if (SUI_TESTNET_RELAYER_URL && suiRecipient) {
          if (!isSameOperation()) { log('warn', 'Withdraw', 'Stale run aborted before Sui relay'); return; }
          submittedRef.current = true;
          // Relayed: from here on a failure report would time an on-chain spend.
          withdrawPhaseRef.current = 'submit';
          const relayed = await suiSession.relayedWithdraw({
            shouldContinue: isSameOperation,
            inputNotes: chosen,
            outputNotes,
            amountOut,
            tokenIdOut: tokenId,
            recipient: suiRecipient,
            relayerUrl: SUI_TESTNET_RELAYER_URL,
            coinType: '0x2::sui::SUI',
          });
          setTxHash(relayed.txDigest);
          setTxChainId(SUI_TESTNET_ID);
          log('info', 'Withdraw', `Sui relayed withdraw submitted: ${relayed.txDigest}`);
          if (isSameOperation()) setStep('success');
          return;
        }

        if (!isSameOperation()) { log('warn', 'Withdraw', 'Stale run aborted before Sui broadcast'); return; }
        submittedRef.current = true;
        const result = await suiSession.transferOrWithdraw({
          shouldContinue: isSameOperation,
          inputNotes: chosen,
          outputNotes,
          amountOut,
          tokenIdOut: tokenId,
          coinType: '0x2::sui::SUI',
        });
        setTxHash(result.txDigest);
        setTxChainId(SUI_TESTNET_ID);
        log('info', 'Withdraw', `Sui direct withdraw submitted: ${result.txDigest}`);
        if (isSameOperation()) setStep('success');
      } catch (err) {
        // Decode any on-chain Move abort into a friendly E_* message.
        const { friendlyError } = await import('@/services/sui-witness/abort-codes');
        const message = friendlyError(err);
        log('error', 'Withdraw', `Sui withdraw failed: ${message}`, err);
        reportWithdrawError(message);
        submittedRef.current = false;
        setStep('error');
      }
      return;
    }

    // === "Receive as" swap-exit confirm (spec C5) ===
    // Relays via relayWithdrawAndSwap from the immutable quote snapshot —
    // never live form state — with the same money-safety invariants the swap
    // modal enforces (confirm-time expiry window, gross binding re-validated
    // in the relay builder, receipt.status check).
    if (reviewContext?.mode === 'swap') {
      const snap = swapSnapshot;
      // The snapshot must exist AND be bound to the exact reviewed context
      // (chain / session / epoch) — anything else clears the quote and
      // returns to input (codex P1: never execute an unbound snapshot).
      if (
        !snap
        || snap.epoch !== confirmEpoch
        || snap.poolChainId !== chainId
        || snap.sessionKey.toLowerCase() !== liveSessionKey
        // The destination is part of what was reviewed. Changing it clears the
        // snapshot anyway; this refuses the case where it somehow did not.
        || snap.destinationChainId !== (crossChainReceive ? receiveChainId : chainId)
      ) {
        setSwapSnapshot(null);
        setReviewContext(null);
        reportWithdrawError('The quote no longer matches this session. Please review again.');
        setStep('withdraw');
        return;
      }
      // Confirm-time lifetime check with the proving safety window: the SDK
      // only re-checks expiry when POSTING to the relayer, after 30-60s of
      // proving — never burn a proof on a commitment that can't be submitted.
      // The relayer's commitments live ~60s (quote_expiration_ms default), and
      // the user has been reading the review for some of that. Rather than
      // bounce them back to re-review, refresh the commitment HERE — same
      // order, re-priced — and only refuse if the re-price moved against them
      // beyond REFRESH_DRIFT_BPS (services/intent-swaps.ts). A refresh is one
      // relayer POST carrying no note-derived value.
      let activePrepared = snap.prepared;
      if (!hasUsableCommitmentLifetime(getPreparedQuoteExpiration(snap.prepared), Date.now())) {
        try {
          withdrawPhaseRef.current = 'quote';
          setLoadingMessage('Refreshing relayer quote...');
          const { createRelayerInteractor } = await import('@/services/sdk-runtime');
          // The re-quote binds a fresh commitment to the processor too.
          await assertRelayerSwapProcessor(snap.poolChainId, getSwapProcessorAddress(snap.poolChainId));
          const relayerInteractor = createRelayerInteractor(snap.poolChainId, getSwapProcessorAddress(snap.poolChainId));
          const relayers = await relayerInteractor.getRelayers();
          const relayer = relayers.find((r) => r.status === 'active') ?? relayers[0];
          if (!relayer) throw new Error('No relayer is available for swaps right now.');
          const session = sdkReady && poolSession ? poolSession : await ensureInitialized();
          if (!session) throw new Error('SDK initialization did not complete.');
          const crossChain = snap.destinationChainId !== snap.poolChainId;
          const { prepared: fresh, display: freshDisplay } = await prepareValidatedSwapQuote(session as PoolSession, {
            relayerInfo: relayer,
            poolChainId: snap.poolChainId,
            grossWei: snap.grossWei,
            inputToken: { address: snap.inputToken.address, decimals: snap.inputToken.decimals },
            outputToken: { address: snap.outputToken.address as Address, decimals: snap.outputToken.decimals },
            recipientAddress: snap.recipient,
            slippage: snap.slippage,
            ...(SWAP_DENY_EXCHANGES.length > 0 ? { denyExchanges: SWAP_DENY_EXCHANGES } : {}),
            ...(crossChain
              ? { toChainId: snap.destinationChainId, ...(snap.fallbackAddress ? { fallbackAddress: snap.fallbackAddress } : {}) }
              : {}),
          });
          if (!isSameOperation()) return;
          const drift = validateRefreshedSwapQuote(snap.prepared, fresh);
          if (drift.length > 0) throw new InvalidSwapQuoteError(drift);
          if (!isFreshCommitmentLive(getPreparedQuoteExpiration(fresh), Date.now())) {
            throw new Error('The refreshed relayer quote had already expired when it arrived.');
          }
          activePrepared = fresh;
          setSwapSnapshot({ ...snap, prepared: fresh, display: freshDisplay });
          log('info', 'Withdraw', 'Refreshed the swap commitment at confirm', {
            fee: fresh.feeAmount, estOut: fresh.estimatedOutput,
          });
        } catch (refreshErr) {
          if (!isSameOperation()) return;
          const why = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
          log('warn', 'Withdraw', `Commitment refresh at confirm failed: ${why}`);
          setSwapSnapshot(null);
          setReviewContext(null);
          reportWithdrawError(
            refreshErr instanceof InvalidSwapQuoteError
              ? 'The price moved while you were reviewing. Review again for the current quote.'
              : 'Not enough time left on the relayer quote to generate the proof. Review again for a fresh quote.',
          );
          setStep('withdraw');
          return;
        }
      }
      beginTx();
      // Heard the moment the relayer returns a hash, even if the SDK's own
      // receipt wait then times out below — the only way to know WHICH relay
      // to watch for settlement when that happens (DEV-458 for the swap-exit
      // route). Declared outside the try so the catch block can still read it.
      const heardSwapExitRelay: { hash: string | null } = { hash: null };
      try {
        setLoadingMessage('Selecting notes...');
        if (spendableCommitments === null) throw new Error('Note approval state is no longer available. Review again.');
        const swapActiveNotes = (noteManager?.getNotes({ status: NoteStatus.ACTIVE }) ?? []).filter(
          (n) =>
            String(n.tokenId).toLowerCase() === String(snap.inputToken.address).toLowerCase()
            && BigInt(n.value) > 0n
            && spendableCommitments.has(n.commitment),
        );
        const selection = selectSwapInputNotes(swapActiveNotes, snap.grossWei);
        if (!selection.covered) throw new Error('The selected notes no longer cover this amount. Review again.');
        const session = sdkReady && poolSession ? poolSession : await ensureInitialized();
        if (!session) throw new Error('SDK initialization did not complete.');
        // buildRelayWithdrawAndSwapParams re-validates the whole quote (gross
        // binding, zero addresses, mode minimums) and THROWS on violation —
        // the last gate before proving. `amount` is the committed NET
        // (gross − relayer fee), never the user's entered gross.
        // Every chain-scoped call below uses snap.poolChainId — the chain
        // the quote was reviewed on — never the live chainId (the context
        // gate above guarantees they match today; the snapshot keeps it
        // that way even if a switch lands mid-flight).
        const relayParams = buildRelayWithdrawAndSwapParams({
          prepared: activePrepared,
          poolChainId: snap.poolChainId,
          grossWei: snap.grossWei,
          inputCommitments: selection.notes.map((n) => n.commitment as Hex),
          tokenId: snap.inputToken.address,
          outputToken: snap.outputToken.address as Address,
          recipientAddress: snap.recipient,
          // Cross-chain only, and taken from the snapshot: the builder
          // re-validates the quote against this address, so relaying a
          // different one than Review showed would (rightly) be refused.
          ...(snap.fallbackAddress ? { fallbackAddress: snap.fallbackAddress } : {}),
        });
        withdrawPhaseRef.current = 'proof';
        setLoadingMessage('Generating ZK proof & relaying...');
        log('info', 'Withdraw', 'Submitting withdraw-and-swap', {
          inputs: relayParams.inputCommitments.length,
          net: relayParams.amount,
          outputToken: relayParams.outputToken,
        });
        if (!isSameOperation()) { log('warn', 'Withdraw', 'Stale run aborted before swap-exit relay'); return; }
        submittedRef.current = true;
        const stopHearingSwapExitRelay = onRelayedTxHash((relayedHash, method) => {
          if (method === 'relayWithdrawAndSwap') { heardSwapExitRelay.hash = relayedHash; withdrawPhaseRef.current = 'confirm'; }
        });
        let receipt: TxReceiptLike;
        try {
          // Relayed: from here on a failure report would time an on-chain spend.
          withdrawPhaseRef.current = 'submit';
          receipt = await (session as PoolSession).relayWithdrawAndSwap(relayParams);
        } finally {
          stopHearingSwapExitRelay();
        }
        const hash = typeof receipt?.txHash === 'string' ? receipt.txHash : null;
        if (hash && isSameOperation()) setTxHash(hash);
        if (hash && isSameOperation()) setTxChainId(chainId);
        // A resolved receipt is NOT success: the SDK returns failed receipts
        // without persisting note updates. Only status === true swapped.
        if (!isSuccessfulSwapReceipt(receipt)) {
          log('error', 'Withdraw', 'Withdraw-and-swap transaction reverted', { txHash: hash });
          if (isSameOperation()) {
            reportWithdrawError(
              'The transaction reverted on-chain. The exit, swap, and payout rolled back together and your notes were NOT spent. You can try again.',
            );
            submittedRef.current = false;
        setStep('error');
          }
          return;
        }
        log('info', 'Withdraw', 'Withdraw-and-swap executed', { txHash: hash });
        // This device's own withdrawal, its relayer fee (input-token units) and
        // what it was received as (services/swap-bookkeeping.ts).
        try {
          recordReceiveAs({
            sourceChainId: snap.poolChainId,
            destinationChainId: snap.destinationChainId,
            txHash: hash,
            inputToken: snap.inputToken.address,
            outputToken: String(snap.outputToken.address),
            feeAmount: activePrepared.feeAmount,
            quotedOutput: activePrepared.estimatedOutput,
            recipient: snap.recipient,
            now: Date.now(),
          }, { recordOwnAction, recordWithdrawFee, recordSwap, recordWithdrawRecipient });
        } catch { /* non-fatal */ }
        if (noteManager && connectedAddress) {
          await exportAccount(session).catch((e) => log('warn', 'Withdraw', 'Post-confirm export failed; next sync will persist', e));
          refetchNotes();
        }
        // Terminal write gated on the operation epoch: a close/reopen since
        // this confirm started must not overwrite the new flow's state.
        if (isSameOperation()) setStep('success');
        try {
          await invalidateTransactionCaches(queryClient);
        } catch { /* non-fatal */ }
      } catch (err) {
        // Never classified as route-unavailable: confirm-phase failures
        // (proof, notes, relay) must not masquerade as the relayer lacking
        // the /swap route.
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'Withdraw', `Withdraw-and-swap failed: ${message}`);
        // The receipt wait can run out on a swap the relayer DID broadcast
        // (DEV-458). Without a hash to watch, this used to just sit marked
        // pending forever: if the swap later landed, the pending notice could
        // clear on its own, but this screen never learned it and never showed
        // success. `timedOutRelayTxHash` reads the hash from viem's own
        // timeout message; `heardSwapExitRelay` covers our own relayed-wait
        // timeout, which names no hash.
        const timedOutHash = isRelayWaitTimeout(message)
          ? (timedOutRelayTxHash(message) ?? heardSwapExitRelay.hash)
          : null;
        if (isSameOperation()) {
          if (timedOutHash) setWithdrawPending(true);
          reportWithdrawError(
            timedOutHash ? SWAP_EXIT_PENDING_MESSAGE
              : isPendingRelayBlocked(message) ? message
                : isRelayerNullifierInFlight(message) ? relayInFlightMessage('withdrawal')
                  : `Withdraw + swap failed: ${shownError(err)}`,
            err,
            'swap-confirm',
          );
          submittedRef.current = false;
          setStep('error');
          if (timedOutHash) {
            setTxHash(timedOutHash as `0x${string}`);
            setTxChainId(chainId);
            const settleWatch = createPendingRelaySettleWatch();
            settleWatch.keep();
            stopHearingWithdrawSettleRef.current = settleWatch.stop;
            void settleWatch.hear(timedOutHash).then((resolution) => {
              settleWatch.stop();
            if (stopHearingWithdrawSettleRef.current === settleWatch.stop) stopHearingWithdrawSettleRef.current = null;
              if (!isSameOperation()) return;
              setWithdrawPending(false);
              if (!resolution.spent) {
                reportWithdrawError('The relayed swap reverted on-chain. Nothing was withdrawn and your balance is unchanged. You can try again.');
                submittedRef.current = false;
                return;
              }
              const landed = landedTxHash(resolution) as `0x${string}` | null;
              if (!landed) {
                reportWithdrawError(`Your notes were spent by another transaction (${resolution.spentBy}), not by this withdrawal. Refresh to see the result; nothing else was sent.`);
                submittedRef.current = false;
                return;
              }
              try {
                recordReceiveAs({
                  sourceChainId: snap.poolChainId,
                  destinationChainId: snap.destinationChainId,
                  txHash: landed,
                  inputToken: snap.inputToken.address,
                  outputToken: String(snap.outputToken.address),
                  feeAmount: activePrepared.feeAmount,
                  quotedOutput: activePrepared.estimatedOutput,
                  recipient: snap.recipient,
                  now: Date.now(),
                }, { recordOwnAction, recordWithdrawFee, recordSwap, recordWithdrawRecipient });
              } catch { /* non-fatal */ }
              setTxHash(landed);
              setTxChainId(chainId);
              reportWithdrawError(null);
              setStep('success');
              refetchNotes();
              void invalidateTransactionCaches(queryClient);
            });
          }
        }
      } finally {
        endTx();
      }
      return;
    }

    if (!activeFeeCommitment && !batchPlan) {
      reportWithdrawError('No active fee quote. Please go back and request a new quote.');
      submittedRef.current = false;
      setStep('error');
      return;
    }

    // Check if quote has expired (batch plans carry their own expiry)
    if (Date.now() > (batchPlan?.expiration ?? activeFeeCommitment?.expiration ?? 0)) {
      log('warn', 'Withdraw', 'Fee quote expired before confirm');
      reportWithdrawError('Fee quote has expired. Please request a new quote.');
      submittedRef.current = false;
      setStep('error');
      setActiveFeeCommitment(null);
      setBatchPlan(null);
      resetQuote();
      return;
    }

    // Recipient: the one Review committed to (the quote was fetched for it),
    // never re-derived from live form state at confirm time (codex P1). The
    // context gate above guarantees reviewContext is present and current.
    const resolvedRecipient = (reviewContext?.recipient && isAddress(reviewContext.recipient))
      ? reviewContext.recipient as `0x${string}`
      : (targetAddress && isAddress(targetAddress))
        ? targetAddress as `0x${string}`
        : connectedAddress;

    if (!resolvedRecipient) {
      reportWithdrawError('Please enter a valid target address or connect your wallet.');
      submittedRef.current = false;
      setStep('error');
      return;
    }

    // Pause background polling (balances, ASP queries) while the tx
    // is in flight so we don't blast the RPC during the wait.
    beginTx();
    // Settlement of this run's relay, heard from the moment its hash returns
    // (either route), so one that settles while the confirmation still waits
    // is not missed.
    const settleWatch = createPendingRelaySettleWatch();
    const stopHearingWithdrawRelay = onRelayedTxHash((hash, method) => {
      if (method && WITHDRAW_RELAY_METHOD.test(method) && isSameOperation()) { withdrawPhaseRef.current = 'confirm'; settleWatch.hear(hash); }
    });
    try {
      const session = sdkReady && poolSession
        ? poolSession
        : await ensureInitialized();

      if (!session) {
        throw new Error('SDK initialization did not complete.');
      }

      // Keystore registration is gated up-front in handleReviewWithdrawal
      // — by the time we reach confirm the auth-policy leaf is on chain
      // and the proof can verify. No registration check needed here.

      if (spendableCommitments === null) {
        reportWithdrawError('Still syncing withdrawable notes. Please try again in a moment.');
        submittedRef.current = false;
        setStep('error');
        return;
      }

      // Filter notes by active status, association-set inclusion, selected token, and selected pool account
      const filterTrace = notes.map((n) => {
        const status = String(n.status);
        const isActive = status === 'active' || status === 'ACTIVE' || n.status === NoteStatus.ACTIVE;
        const inSpendableSet = spendableCommitments.has(n.commitment);
        const tokenAddr = String(n.tokenId || '');
        const matchesToken = resolveTokenSymbol(tokenAddr, chainId) === selectedToken;
        const matchesPA = selectedPA ? String(n.label) === selectedPA : true;
        return {
          commitment: n.commitment,
          status,
          tokenSymbol: resolveTokenSymbol(tokenAddr, chainId),
          label: n.label,
          txHash: n.txHash,
          isActive,
          inSpendableSet,
          matchesToken,
          matchesPA,
          // matchesPA is retained in the trace for diagnostics only — note
          // selection no longer filters by account (auto-select across all notes).
          kept: isActive && inSpendableSet && matchesToken,
        };
      });
      const activeNotes = notes.filter((_, i) => filterTrace[i].kept);

      log('debug', 'Withdraw', 'Active-notes filter run', {
        selectedToken,
        selectedPA,
        totalNotes: notes.length,
        spendableCount: spendableCommitments.size,
        keptCount: activeNotes.length,
        rejectedCount: filterTrace.length - activeNotes.length,
        rejectionReasons: filterTrace.filter((t) => !t.kept).map((t) => ({
          commitment: t.commitment,
          status: t.status,
          tokenSymbol: t.tokenSymbol,
          label: t.label,
          reasons: [
            !t.isActive && 'not ACTIVE',
            !t.inSpendableSet && 'not in ASP spendable set',
            !t.matchesToken && `token ${t.tokenSymbol} != ${selectedToken}`,
            !t.matchesPA && `label != selectedPA (${selectedPA})`,
          ].filter(Boolean),
        })),
      });

      if (activeNotes.length === 0) {
        log('warn', 'Withdraw', 'No notes passed the active-notes filter (see "Active-notes filter run" above)');
        reportWithdrawError(`No withdrawable ${displayTokenSymbol(selectedToken)} notes are available yet.`);
        submittedRef.current = false;
        setStep('error');
        return;
      }

      const chainConfig = getChainConfig(chainId);
      // Legacy spend-out build: pin pool/keystore from env so a chains.ts
      // bump (post-cutover) doesn't silently route legacy withdrawals
      // through the new contracts. fromBlock is intentionally still read
      // from chains.ts — the legacy build must be deployed off a commit
      // that still carries the OLD pool's fromBlock.
      const poolAddress = LEGACY_CONFIG?.pool ?? chainConfig?.contracts?.poolAddress;
      const syncFromBlock = chainConfig?.contracts?.fromBlock;
      // Keystore was deployed before the V6 pool, so its scan floor is
      // earlier — reusing the pool's fromBlock would miss any leaves
      // registered before the V5→V6 migration.
      const keystoreSyncFromBlock = chainConfig?.contracts?.keystoreFromBlock ?? syncFromBlock;
      if (!poolAddress) {
        throw new Error(`Missing pool contract configuration for chain ${chainId}.`);
      }

      // Always re-hydrate createdAtBlock from the contract. The SDK's
      // discoverNotes stores `log.blockNumber` (block number), but the on-chain
      // state tree uses `Poseidon(commitment, block.timestamp)`. Block number
      // != timestamp, so any note whose createdAtBlock came from discovery
      // will fail the state-tree proof. `commitments(commitment)` on the
      // PoolVault returns the stored block.timestamp authoritatively.
      // PRIVACY: one bulk index for the whole note set. This used to issue one
      // PoolVault.commitments() eth_call per active note (and, below, one
      // spentNullifiers() call per note) immediately before building the
      // witness, enumerating the user's portfolio to the RPC provider at the
      // worst possible moment. Never reintroduce a per-note chain read here;
      // see services/onchain-note-index.ts and docs/privacy-request-discipline.md.
      const preflightIndex = await (async () => {
        const { createPoolVaultInteractor, createRPCInteractor, createHashService } =
          await import('@/services/sdk-runtime');
        const { createOnChainNoteIndex } = await import('@/services/onchain-note-index');
        const indexRpc = createRPCInteractor(chainId);
        const indexHashService = await createHashService();
        const indexVault = createPoolVaultInteractor(
          indexRpc,
          poolAddress as `0x${string}`,
          indexHashService,
          syncFromBlock,
        );
        const noteIndex = createOnChainNoteIndex({
          chainId,
          poolVaultInteractor: indexVault as never,
          hashService: indexHashService as never,
          poolAddress: poolAddress as string,
        });

        const before = activeNotes.map((n) => ({ commitment: n.commitment, createdAtBlock: n.createdAtBlock }));
        try {
          await noteIndex.refresh();
          for (const note of activeNotes) {
            const ts = noteIndex.commitmentTimestamp(note.commitment);
            if (ts) {
              note.createdAtBlock = ts;
            } else {
              log('warn', 'Withdraw', `No verified timestamp for ${note.commitment}`, {
                onChain: noteIndex.hasCommitment(note.commitment),
              });
            }
          }
        } catch (err) {
          log('warn', 'Withdraw', 'Failed to build on-chain note index', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Non-fatal, like every sibling persist in this file: the statuses are
        // already correct in memory, and a storage failure (quota, or a
        // refused bucket) must not block a withdrawal from its own preflight.
        await exportAccount(session).catch((e) => log(
          'warn', 'Withdraw', 'Preflight export failed; next sync will persist', e,
        ));
        log('debug', 'Withdraw', 'Refreshed note timestamps from the bulk on-chain index', {
          chainId,
          before,
          after: activeNotes.map((n) => ({ commitment: n.commitment, createdAtBlock: n.createdAtBlock })),
        });
        return noteIndex;
      })();

      // TODO: Remove manual state/keystore tree building when SDK's prepareWithdraw
      // handles fromBlock natively or the backend exposes leaf endpoints.
      const {
        createHashService,
        createKeystoreInteractor,
        createMerkleService,
        createPoolVaultInteractor,
        createRPCInteractor,
      } = await import('@/services/sdk-runtime');
      const hashService = await createHashService();
      const merkleService = createMerkleService(hashService);
      const rpcInteractor = createRPCInteractor(chainId);
      const poolVaultInteractor = createPoolVaultInteractor(
        rpcInteractor,
        poolAddress as `0x${string}`,
        undefined,
        syncFromBlock,
      );
      const stateLeaves = await poolVaultInteractor.getStateLeaves();

      if (!keystoreManager || !connectedAddress) {
        throw new Error('SDK keystore manager unavailable.');
      }

      const chainKeystoreAddress = LEGACY_CONFIG?.keystore ?? chainConfig?.contracts?.keystoreAddress;
      if (!chainKeystoreAddress) {
        throw new Error(`Missing keystore contract configuration for chain ${chainId}.`);
      }

      const keystoreInteractor = createKeystoreInteractor(
        rpcInteractor,
        chainKeystoreAddress as `0x${string}`,
        keystoreSyncFromBlock,
      );
      const keystoreLeaves = await keystoreInteractor.getKeystoreLeaves();
      const onChainNullifyingKeyHash = await keystoreInteractor.getNullifyingKeyHash(connectedAddress as `0x${string}`);
      const privateNullifyingKey = keystoreManager.getPrivateNullifyingKey();
      const privateRevocableKey = keystoreManager.getPrivateRevocableKey();
      const nullifyingKeyHash = hashService.hash([privateNullifyingKey]);
      const authDigest = hashService.hash(['0x0', privateRevocableKey]);
      const keystoreLeaf = hashService.hash([
        connectedAddress as `0x${string}`,
        nullifyingKeyHash,
        authDigest,
      ]);

      const keystoreLeafFound = keystoreLeaves.includes(keystoreLeaf);

      log('debug', 'Withdraw', 'Resolved keystore witness prerequisites', {
        chainId,
        connectedAddress,
        nullifyingKeyHash,
        onChainNullifyingKeyHash,
        authDigest,
        keystoreLeaf,
        keystoreLeafFound,
      });

      if (!keystoreLeafFound) {
        throw new Error(
          onChainNullifyingKeyHash.toLowerCase() !== nullifyingKeyHash.toLowerCase()
            ? 'Current wallet-derived keys do not match the registered keystore for this account.'
            : 'Current auth policy leaf is not present in the keystore tree.',
        );
      }

      // Domain-separation tag for state-tree commitment leaves. The new
      // SDK's WitnessPreparationService computes the leaf as
      // `Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)` — three
      // inputs, NOT the legacy two-input `Poseidon(commitment, timestamp)`.
      // Using the wrong arity here makes the local membership check miss
      // every leaf even when the note is fully valid on chain.
      // See v2-monorepo packages/sdk/src/constant/WitnessPreparationService.ts.
      const COMMITMENT_LEAF_TAG = '0x086205d9d9e32ce53fc309585685ddb629e878ddd2dd04f575089c3a421342d9' as const;

      // Mike (2026-08-25, DEV-379): small withdrawals reverted with
      // PoolVault_NullifierAlreadySpent while larger ones worked. The state
      // tree is append-only — SPENDING a note does not remove its commitment
      // leaf — so the state-leaf check below cannot catch a note that is
      // locally ACTIVE but already spent on-chain. Note selection is
      // smallest-first, so a stale small note poisoned exactly the small
      // withdrawals. The transfer preflight has checked nullifiers since
      // DEV-237; this is the withdraw half of the same check.
      // PRIVACY: answered from the bulk index built above (the union of every
      // Transacted / Ragequit nullifier), never by a per-note spentNullifiers()
      // eth_call: that call handed the RPC provider the exact nullifier this
      // client was about to publish. Fail OPEN when the index did not build,
      // exactly like the old read-error path: the contract still enforces the
      // truth.
      const { createNoteComputationService } = await import('@/services/sdk-runtime');
      const noteComputationService = await createNoteComputationService();
      const nullifierSpentByCommitment = new Map<string, string | null>();
      for (const note of activeNotes) {
        try {
          const nullifier = noteComputationService.computeNullifier(privateNullifyingKey, note.commitment);
          const spent = preflightIndex.isBuilt() && preflightIndex.isNullifierSpent(nullifier as `0x${string}`);
          nullifierSpentByCommitment.set(
            note.commitment,
            spent ? (preflightIndex.nullifierSpentAt(nullifier as `0x${string}`) ?? 'spent') : null,
          );
        } catch (err) {
          log('warn', 'Withdraw', `Nullifier spent-check failed for ${note.commitment}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          nullifierSpentByCommitment.set(note.commitment, null);
        }
      }

      const verifiedActiveNotes = activeNotes.map((note) => {
        const stateLeaf = hashService.hash([COMMITMENT_LEAF_TAG, note.commitment, note.createdAtBlock]);
        const inStateTree = stateLeaves.includes(stateLeaf);
        const nullifierSpentAt = nullifierSpentByCommitment.get(note.commitment) ?? null;
        const isStateSpendable = inStateTree && nullifierSpentAt == null;
        return {
          note,
          stateLeaf,
          isStateSpendable,
          proofError: isStateSpendable
            ? null
            : nullifierSpentAt != null
              ? `nullifier already spent on-chain at ${nullifierSpentAt}`
              : `Leaf ${stateLeaf} not found in state tree`,
        };
      });

      // Self-heal: a note whose nullifier is spent on-chain IS spent — the
      // local ACTIVE is a lie (spent from another device, or a sync window
      // that missed the event). Mark it so balances stop counting it and the
      // next attempt does not trip over it again; persist so it sticks.
      const staleSpent = activeNotes.filter((note) => nullifierSpentByCommitment.get(note.commitment) != null);
      if (staleSpent.length > 0 && noteManager) {
        for (const note of staleSpent) {
          try {
            noteManager.updateNoteStatus(note.commitment, NoteStatus.SPENT);
          } catch (err) {
            log('warn', 'Withdraw', `Could not mark stale note SPENT: ${note.commitment}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        try {
          await exportAccount(session);
        } catch { /* non-fatal: statuses fixed in memory either way */ }
        log('info', 'Withdraw', 'Marked locally-ACTIVE notes as SPENT (nullifier already spent on-chain)', {
          count: staleSpent.length,
          commitments: staleSpent.map((n) => n.commitment),
        });
        void refetchNotes();
      }

      // Pretty-print the per-note state-leaf result for easy copy/paste
      // (the structured log object below is harder to read in DevTools).
      // eslint-disable-next-line no-console
      console.log(
        '[Withdraw] state-leaf check:\n' +
          verifiedActiveNotes
            .map(
              (entry, i) =>
                `  [${i}] ${entry.isStateSpendable ? '✓' : '✗'} ` +
                `commitment=${entry.note.commitment.slice(0, 18)}… ` +
                `createdAt=${entry.note.createdAtBlock} ` +
                `stateLeaf=${entry.stateLeaf.slice(0, 18)}…`,
            )
            .join('\n') +
          `\n  on-chain leaves: ${stateLeaves.length} (first: ${stateLeaves[0]?.slice(0, 18)}…)`,
      );

      const withdrawableNotes = verifiedActiveNotes
        .filter((entry) => entry.isStateSpendable)
        .map((entry) => entry.note);

      log('debug', 'Withdraw', 'Resolved withdrawable notes from state tree', {
        chainId,
        activeNoteCount: activeNotes.length,
        stateSpendableCount: withdrawableNotes.length,
        stateLeavesCount: stateLeaves.length,
        notes: verifiedActiveNotes.map((entry) => ({
          commitment: entry.note.commitment,
          createdAtBlock: entry.note.createdAtBlock,
          stateLeaf: entry.stateLeaf,
          isStateSpendable: entry.isStateSpendable,
          proofError: entry.proofError,
        })),
      });

      if (withdrawableNotes.length === 0) {
        log('warn', 'Withdraw', 'State-tree proof removed every candidate note', {
          activeNoteCount: activeNotes.length,
          stateLeavesCount: stateLeaves.length,
          firstFewStateLeaves: stateLeaves.slice(0, 5),
          rejected: verifiedActiveNotes.map((entry) => ({
            commitment: entry.note.commitment,
            createdAtBlock: entry.note.createdAtBlock,
            stateLeaf: entry.stateLeaf,
            proofError: entry.proofError,
          })),
        });
        reportWithdrawError(`No withdrawable ${displayTokenSymbol(selectedToken)} notes are available yet.`);
        submittedRef.current = false;
        setStep('error');
        return;
      }

      // === Full-balance batch withdrawal (flag-gated) ===
      // One atomic relayBatch spends EVERY active note of the asset: N proofs
      // (≤5 inputs each), ONE on-chain transaction. The SDK persists note
      // state only after the confirmed successful receipt, so a failure at
      // any point leaves every local note ACTIVE — never mark anything spent
      // here. The timestamp re-hydration + keystore checks above already ran
      // for these notes (they're the same live NoteManager objects).
      if (batchPlan) {
        // Submit-time invariant: batchEnabled excludes shares, so a share
        // batchPlan is a bug, and paying shares under a USDC label is the one
        // outcome the redemption promise forbids (codex P1 on d6abfcd).
        if (isShareSymbol(selectedToken)) {
          reportWithdrawError(`Withdrawing a whole ${displayTokenSymbol(selectedToken)} balance across several proofs isn't available yet. Withdraw a smaller amount. Nothing was sent.`);
          submittedRef.current = false;
          setStep('error');
          return;
        }
        const withdrawableSet = new Set(withdrawableNotes.map((n) => n.commitment));
        const sessionActiveNotes = (noteManager?.getNotes({ status: NoteStatus.ACTIVE }) ?? []).filter(
          (n) => String(n.tokenId).toLowerCase() === String(batchPlan.tokenId).toLowerCase() && BigInt(n.value) > 0n,
        );
        if (sessionActiveNotes.length === 0) {
          reportWithdrawError(`No withdrawable ${displayTokenSymbol(selectedToken)} notes are available yet.`);
          submittedRef.current = false;
        setStep('error');
          return;
        }
        // The session proves every one of these — each must have survived the
        // ASP + state-tree gates above or the whole batch fails mid-proof.
        const notReady = sessionActiveNotes.filter((n) => !withdrawableSet.has(n.commitment));
        if (notReady.length > 0) {
          reportWithdrawError(
            `${notReady.length} ${displayTokenSymbol(selectedToken)} note${notReady.length === 1 ? ' is' : 's are'} not spendable yet. Sync and retry, or withdraw less.`,
          );
          submittedRef.current = false;
        setStep('error');
          return;
        }

        // The batch proofs must bind to the PrivacyPoolRelay contract (the
        // on-chain relayBatch msg.sender), NOT the transfer signer EOA the main
        // session advertises. The SDK's PoolSessionBatchWithdraw copies the
        // relayer record's processor into every proof and has no per-call
        // rebind, so we run the batch on a sibling session whose relayer record
        // advertises SEPOLIA_WITHDRAWAL_PROCESSOR_ADDRESS (finding 1). It shares
        // the same note/keystore managers, so persistence lands in one store.
        const batchSession = await getBatchWithdrawSession();
        if (!batchSession) {
          reportWithdrawError('Batch withdrawal session is not ready yet. Please try again in a moment.');
          submittedRef.current = false;
        setStep('error');
          return;
        }

        // Typed by cast: the prepare and relay closures assign these.
        let unsubscribeProofProgress = null as (() => void) | null;
        // Failure stage tracked at each point where on-chain certainty changes,
        // so the error copy is honest about fund state (finding 6). Starts at
        // pre-submit (nothing broadcast); a known tx hash is retained for the
        // explorer link.
        let stage = 'pre-submit' as BatchFailureStage;
        let knownTxHash = null as `0x${string}` | null;
        try {
          // The same grouping the session proves with, from the same notes.
          const sdk = await import('@/services/sdk-runtime');
          const groups = (sdk.selectNotesForFullWithdraw as unknown as SelectGroupsFn)({
            notes: sessionActiveNotes as Note[],
            tokenId: batchPlan.tokenId,
            maxInputs: WITHDRAW_MAX_INPUTS,
          });
          if (groups.reduce((sum, g) => sum + g.amountOut, 0n) !== batchPlan.totalOutWei) {
            reportWithdrawError('Your withdrawable balance changed since you reviewed this withdrawal. Press Withdraw again to see the updated total.');
            setStep('withdraw');
            setBatchPlan(null);
            setBatchProgress(null);
            resetQuote();
            return;
          }

          log('info', 'Withdraw', 'Preparing batch withdrawal', {
            tokenId: batchPlan.tokenId,
            groups: batchPlan.groupCount,
            recipient: resolvedRecipient,
          });
          // Each prepare is read-only on note state: selection + one fresh quote
          // + one proof per group. The whole balance first; when that cannot
          // prove inside the quote window it goes as sub-batches, each with its
          // own quote, on a session that sees only that sub-batch's notes.
          const outcome = await withdrawGroupsWithinWindow({
            groups,
            reviewedTotalFeeWei: batchPlan.totalFeeWei,
            feeOk: feeWithinReviewed,
            prepare: async (chunk, all) => {
              stage = 'pre-submit';
              const session = all
                ? batchSession
                : await getBatchWithdrawSession(new Set(chunk.flatMap((g) => g.inputCommitments)));
              if (!session) throw new Error('Batch withdrawal session is not ready yet. Please try again in a moment.');
              const tracker = createBatchProgressTracker(chunk.length, (progress) => {
                setBatchProgress(progress);
                setLoadingMessage(batchProgressMessage(progress));
              });
              unsubscribeProofProgress = subscribeProofProgress(() => tracker.tick());
              try {
                const prepared = await session.prepareBatchWithdraw({
                  tokenId: batchPlan.tokenId,
                  recipientAddress: resolvedRecipient,
                });
                tracker.submitting();
                return { ...prepared, session };
              } finally {
                unsubscribeProofProgress?.();
                unsubscribeProofProgress = null;
              }
            },
            relay: async (prepared) => {
              if (!isSameOperation()) throw new Error('Stale run aborted before batch relay.');
              submittedRef.current = true;
              log('info', 'Withdraw', 'Submitting batch withdrawal via relayer', {
                items: prepared.items?.length ?? 0,
                totalAmountOut: String(prepared.totalAmountOut),
                totalFee: String(prepared.totalFee),
              });
              // relayBatchWithdraw waits for the receipt and persists the note
              // updates (inputs SPENT + change notes) ONLY when status is truthy.
              let batchReceipt: { status?: boolean; txHash?: `0x${string}` } | `0x${string}`;
              try {
                // Relayed: from here on a failure report would time an on-chain spend.
                withdrawPhaseRef.current = 'submit';
                batchReceipt = await prepared.session.relayBatchWithdraw(prepared);
              } catch (relayErr) {
                stage = classifyBatchRelayError(relayErr instanceof Error ? relayErr.message : String(relayErr));
                throw relayErr;
              }
              const receiptObj = typeof batchReceipt === 'object' ? batchReceipt : null;
              const batchTxHash = (receiptObj?.txHash ?? (typeof batchReceipt === 'string' ? batchReceipt : undefined)) as
                | `0x${string}`
                | undefined;
              knownTxHash = batchTxHash ?? null;
              if (receiptObj && receiptObj.status === false) {
                // relayBatch is atomic: a revert means NO item executed and the
                // SDK skipped persistence — every note is still ACTIVE.
                stage = 'reverted';
                throw new Error('The transaction reverted; no notes were spent.');
              }
              return { txHash: batchTxHash ?? null };
            },
            // Only refusals that provably sent nothing are proved again.
            isReprovable: (error) => stage === 'pre-submit' && isReprovableRelayRefusal(error),
            outcomeKnown: () => stage === 'pre-submit' || stage === 'reverted',
            isQuoteExpiry: isFeeCommitmentExpired,
            shouldContinue: isSameOperation,
            onReprove: ({ attempt, size, reason }) => {
              log('warn', 'Withdraw', 'Batch refused before sending; proving again', { attempt, size, reason });
              setLoadingMessage(reason === 'expired'
                ? `Proving took longer than the relayer quote. Nothing was sent. Withdrawing in batches of ${size}...`
                : 'The approval set just updated. Nothing was sent. Re-proving your withdrawal...');
            },
            onConfirmed: ({ txHash }, prepared, { remaining }) => {
              // Past this point this batch is CONFIRMED on-chain and the SDK has
              // already persisted its note state.
              log('info', 'Withdraw', 'Batch relay succeeded', { txHash, remaining });
              if (!txHash) return;
              try {
                recordOwnWithdrawal({
                  chainId,
                  txHash,
                  recipient: resolvedRecipient,
                  tokenAddress: selectedTokenAddress,
                  feeAmount: BigInt(prepared.totalFee).toString(),
                  stampOwnAction: false,
                  now: Date.now(),
                }, { recordOwnAction, recordWithdrawFee, recordWithdrawRecipient });
              } catch { /* non-fatal */ }
              setTxHash(txHash);
              setTxChainId(chainId);
            },
          });
          if (!outcome) { log('warn', 'Withdraw', 'Stale run aborted before batch relay'); return; }

          // Every batch is CONFIRMED on-chain — any further failure is a
          // local-sync problem, not a fund-loss (finding 6). Record finalized values.
          stage = 'confirmed-sync-failed';
          // Persist the executed totals so the success screen shows what really
          // happened, not the reviewed quote (finding 7).
          setBatchPlan((prev) =>
            prev ? { ...prev, totalOutWei: outcome.amountOutWei, totalFeeWei: outcome.feeWei } : prev,
          );
          if (noteManager && connectedAddress) {
            await exportAccount(session).catch((e) => log('warn', 'Withdraw', 'Post-confirm export failed; next sync will persist', e));
            refetchNotes();
          }
          setBatchProgress(null);
          if (isSameOperation()) setStep('success');

          // Cache invalidation is a pure UI refresh — best-effort, never flips
          // a confirmed success to an error.
          try {
            await invalidateTransactionCaches(queryClient);
          } catch { /* non-fatal */ }
        } catch (err) {
          if (unsubscribeProofProgress) unsubscribeProofProgress();
          const message = err instanceof Error ? err.message : String(err);
          log('error', 'Withdraw', `Batch withdrawal failed (${stage}): ${message}`);
          if (knownTxHash) setTxHash(knownTxHash);
          if (knownTxHash) setTxChainId(chainId);
          if (err instanceof BatchChangedSinceReviewError) {
            // Nothing was sent: back to the form for a fresh quote, as before.
            log('warn', 'Withdraw', 'Batch changed between review and confirm. Aborting', { reason: err.message });
            reportWithdrawError(err.message);
            setStep('withdraw');
            setBatchPlan(null);
            setBatchProgress(null);
            resetQuote();
            submittedRef.current = false;
            return;
          }
          if (err instanceof BatchPartiallyWithdrawnError) {
            // Some batches confirmed (and persisted) before this one failed: say
            // so plainly, and refresh so the balance shows what is left.
            reportWithdrawError(err.message, err, 'batch-partial');
            if (noteManager && connectedAddress) {
              await exportAccount(session).catch((e) => log('warn', 'Withdraw', 'Post-confirm export failed; next sync will persist', e));
              refetchNotes();
            }
          } else {
            reportWithdrawError(describeBatchFailure(stage, shownError(err), { hasTxHash: !!knownTxHash }), err, `batch-${stage}`);
          }
          setBatchProgress(null);
          submittedRef.current = false;
        setStep('error');
        }
        return;
      }

      if (!activeFeeCommitment) {
        // Unreachable: the batch branch above returned, and the top-of-flow
        // guard requires a single-quote commitment whenever there is no batch
        // plan. Narrow for TypeScript and fail safe regardless.
        reportWithdrawError('No active fee quote. Please go back and request a new quote.');
        submittedRef.current = false;
        setStep('error');
        return;
      }

      const tokenDecimals = withdrawTokenDecimals(selectedToken, chainId, isSui);
      let amountWei = parseTokenAmount(amount, tokenDecimals);
      const feeAmountWei = BigInt(activeFeeCommitment.feeAmount);
      const feeAmountHex = `0x${feeAmountWei.toString(16)}` as `0x${string}`;
      // The relayer re-quotes at Confirm and its fee carries float noise across
      // amounts (services/relayer-fee-jitter.ts). Pay for that slack up front:
      // the note selection covers it and gross mode takes it off the recipient.
      const feeJitterWei = relayerFeeJitterAllowance(feeAmountWei);
      // DEV-229: the SDK `amount` IS the recipient's net (it releases
      // amount + fee from the pool). Default (receiveExact) keeps amount =
      // entered. In gross mode — including a full-balance entry, whose fee
      // must come out of the final amount — the entered value is the total
      // leaving the pool, so the recipient nets entered − fee.
      if (!effectiveReceiveExact) {
        // Reject a gross amount that can't even cover the fee — otherwise it
        // would clamp to 0 and the pool would still release just the fee.
        if (amountWei <= feeAmountWei + feeJitterWei) {
          reportWithdrawError('Withdrawal amount must be greater than the relayer fee.');
          submittedRef.current = false;
        setStep('error');
          return;
        }
        amountWei = amountWei - feeAmountWei - feeJitterWei;
      }
      // Auto note-selection (manager spec): smallest non-dust notes first (to
      // consolidate small notes without burning input slots / proving time on
      // dust), up to WITHDRAW_MAX_INPUTS, with a largest-first fallback so big
      // withdrawals still succeed. No manual note/account picker anymore.
      const dustWei = parseTokenAmount(
        String(DUST_THRESHOLD[selectedToken] ?? DEFAULT_DUST_THRESHOLD),
        tokenDecimals,
      );
      // Mixed labels on both routes (the circuit and SDK support them natively;
      // the single-label rule was app-side caution, dropped for the plain route
      // on 2026-08-28 and for the swap exit on 2026-09-04).
      const selection = selectWithdrawInputs(
        withdrawableNotes, amountWei + feeAmountWei + feeJitterWei, dustWei,
      );
      const inputNotes: Note[] = selection.notes;
      const accumulatedValue = selection.total;
      const amountHex = `0x${amountWei.toString(16)}` as `0x${string}`;

      // prepareWithdraw rejects when the selected inputs can't cover amount +
      // relayer fee. Surface the maximum for the INPUT semantics the user
      // chose: receive-exact reserves the fee; gross mode may enter the whole
      // selected total because the fee comes out of it.
      if (inputNotes.length === 0 || accumulatedValue < amountWei + feeAmountWei + feeJitterWei) {
        const maxInputWei = resolveSingleProofMaxInputWei({
          singleProofCapWei: accumulatedValue,
          feeWei: feeAmountWei + feeJitterWei,
          receiveExact: effectiveReceiveExact,
        });
        const maxInput = formatUnits(maxInputWei, tokenDecimals);
        reportWithdrawError(
          maxInputWei > 0n
            ? (isSwapExit
              ? `That's more than a withdraw + swap can carry. Enter at most ${isShareSymbol(selectedToken) ? balanceDisplay(maxInput, selectedToken, chainId).text : tokenAmountLabel(maxInput, selectedToken)} (up to ${WITHDRAW_MAX_INPUTS} notes in one proof${effectiveReceiveExact ? ', after reserving the relayer fee' : ''}).`
              : `That's more than one transaction can carry. Enter at most ${isShareSymbol(selectedToken) ? balanceDisplay(maxInput, selectedToken, chainId).text : tokenAmountLabel(maxInput, selectedToken)} (up to ${WITHDRAW_MAX_INPUTS} notes per proof${effectiveReceiveExact ? ', after reserving the relayer fee' : ''}).`)
            : `Your ${displayTokenSymbol(selectedToken)} notes don't have enough active balance to cover this withdrawal + the relayer fee.`,
        );
        submittedRef.current = false;
        setStep('error');
        return;
      }

      const inputCommitments = inputNotes.map((n) => n.commitment);
      // Preserve the exact token-id spelling of the selected SDK note group.
      // The orchestrator compares inputs with raw equality and uses this value
      // for generated change notes; borrowing it from another casing group can
      // fragment the next withdrawal even though the EVM address compares equal.
      const selectedInputTokenId = inputNotes[0].tokenId;

      log('debug', 'Withdraw', 'Resolved withdraw note selection', {
        selectedPA,
        selectedToken,
        preferredTransaction: preferredTransaction ? {
          id: preferredTransaction.id,
          txHash: preferredTransaction.txHash,
          label: preferredTransaction.label,
          rawAmount: preferredTransaction.rawAmount,
        } : null,
        preferredWithdrawNote: preferredWithdrawNote ? {
          commitment: preferredWithdrawNote.commitment,
          label: preferredWithdrawNote.label,
          value: preferredWithdrawNote.value,
        } : null,
        activeNotes: activeNotes.map((note) => ({
          commitment: note.commitment,
          label: note.label,
          value: note.value,
          txHash: note.txHash,
          status: note.status,
          createdAtBlock: note.createdAtBlock,
        })),
        withdrawableNotes: withdrawableNotes.map((note) => ({
          commitment: note.commitment,
          label: note.label,
          value: note.value,
          txHash: note.txHash,
          status: note.status,
          createdAtBlock: note.createdAtBlock,
        })),
        chosenInputNotes: inputNotes.map((note) => ({
          commitment: note.commitment,
          label: note.label,
          value: note.value,
          txHash: note.txHash,
          createdAtBlock: note.createdAtBlock,
        })),
        accumulatedValue: accumulatedValue.toString(),
        requestedAmount: amountWei.toString(),
      });

      log('info', 'Withdraw', 'Preparing withdrawal', {
        inputCommitments,
        amount: amountHex,
        tokenId: selectedInputTokenId,
        recipient: resolvedRecipient,
        relayAddress: withdrawalProcessorAddress,
        feeAmount: feeAmountHex,
        preferredTransactionId: preferredTransaction?.id ?? null,
        preferredCommitment: preferredWithdrawNote?.commitment ?? null,
      });

      // The transaction hash of whatever route ran, the raw SDK result, and the
      // fee the relay actually charged — all consumed by the shared post-submit
      // bookkeeping below (positive confirmation, note export, fee recording,
      // success screen).
      let relayTxHash: `0x${string}` | undefined;
      let relayReceiptResult: unknown;
      // Set when the SDK threw a receipt-wait timeout that the bulk chain
      // observation later confirmed (see relayOnce).
      let relayTimedOut = false;
      let relayedFeeRaw: string | number | undefined;
      // Set when the router redemption ran: the SDK's relayWithdraw persists
      // notes itself, this route must do it after the bulk confirmation below.
      let yieldPersist: { spentNotes: Note[]; changePendingNotes: PendingNote[] } | null = null;
      // What the success screen will say about the redemption; stored in state
      // only after positive confirmation, so a failed or fallen-back run never
      // shows a previous run's figures.
      let pendingRedemption: { underlyingSymbol: string; underlyingDecimals: number; quotedOut: bigint; minOut: bigint } | null = null;
      setYieldRedemption(null);

      if (coldStartClaim) {
        // === Cold-start claim: no registration transaction at all ===
        // The wallet signs the EIP-712 SetAuthPolicy payload (free), and the
        // SDK proves the withdrawal against the PREDICTED post-registration
        // keystore root — sound because Keystore.setAuthPolicyWithSig inserts
        // that leaf in the SAME transaction as the withdrawal, via
        // PrivacyPoolRelay.registerAndRelay. The relayer's fee comes out of the
        // note, so this works with a zero balance.
        //
        // The quote is re-fetched below (see why), so this path carries the same
        // fee-increase guard the plain path applies: the withdrawal aborts rather
        // than release a bigger fee than the user reviewed.
        const deadline = buildRegistrationDeadline(Date.now());
        const typedData = session.buildSetAuthPolicyTypedData(deadline);
        setLoadingMessage('Waiting for your signature...');
        // Signing costs nothing on-chain; this is the whole "no gas" trick.
        // Done BEFORE the quote below on purpose: the signature prompt is
        // user-paced, and a fee commitment lives ~60s while the proof that
        // follows eats ~15s of it.
        const signature = await signTypedDataAsync({
          domain: typedData.domain,
          types: typedData.types,
          primaryType: typedData.primaryType,
          message: typedData.message,
        } as Parameters<typeof signTypedDataAsync>[0]);

        // The SDK asserts the submitted quote's `amountSent` equals
        // `amount + feeAmount`. A /receive quote treats its request as the
        // RECIPIENT leg (amountReceived = request, amountSent = request + fee), so
        // it is priced on `amountWei`, which is already the recipient leg here
        // (gross mode took the reviewed fee and the allowance off it above). This
        // used to re-quote on amountWei + reviewedFee and hand THAT to the SDK as
        // `amount`, releasing a second, unreserved fee from the pool (codex on
        // 3f9b3b2). `amount` is taken from the relayer's own arithmetic, which
        // satisfies the assertion by construction, and the note selection above
        // covers amountWei + reviewedFee + allowance >= amountSent.
        const reviewedFeeWei = BigInt(activeFeeCommitment.feeAmount);
        withdrawPhaseRef.current = 'quote';
        setLoadingMessage('Confirming the relayer quote...');
        const claimQuote = await getQuote(
          chainId,
          amountWei.toString(),
          selectedTokenAddress as `0x${string}`,
          resolvedRecipient as `0x${string}`,
          gasTokenChecked || undefined,
        );
        const claimFeeWei = BigInt(claimQuote.feeAmount);
        // Same fund-safety rule as the plain path: the withdrawal must never
        // release a bigger fee than the one the user reviewed. Equal or lower is
        // fine — they simply pay no more than they agreed to.
        if (!feeWithinReviewed(claimFeeWei, reviewedFeeWei)) {
          log('warn', 'Withdraw', 'Relayer fee increased between review and the cold-start submit — aborting', {
            reviewedFee: reviewedFeeWei.toString(),
            claimFee: claimFeeWei.toString(),
          });
          reportWithdrawError('The relayer fee went up since you reviewed this withdrawal. Start it again to get a fresh quote before confirming.');
          setStep('withdraw');
          setActiveFeeCommitment(null);
          resetQuote();
          return;
        }
        // Bind the fresh quote to the REQUESTED recipient leg before anything is
        // derived from it: displayed and signed copies agree, the recipient leg is
        // amountWei, the gross is amountWei + fee. Without this, amount = sent - fee
        // satisfied the SDK's equality for ANY consistent quote, so a relayer
        // could size the outflow itself against a large input note (codex on
        // 54a6eb5). The SDK amount is the requested leg, not the quote's.
        if (
          !quoteMatchesSignedCommitment(claimQuote)
          || BigInt(claimQuote.amountReceived) !== amountWei
          || BigInt(claimQuote.amountSent) !== amountWei + claimFeeWei
        ) {
          throw new Error('The relayer quote does not match the requested withdrawal. Nothing was sent. Please try again.');
        }
        const claimNetWei = amountWei;
        withdrawPhaseRef.current = 'proof';
        setLoadingMessage('Generating ZK proof...');
        log('info', 'Withdraw', 'Submitting cold-start register-and-withdraw', {
          reason: coldStartClaim.reason,
          processor: withdrawalProcessorAddress,
          grossWei: claimQuote.amountSent,
          netWei: claimNetWei.toString(),
          feeWei: claimFeeWei.toString(),
          deadline,
        });
        if (!isSameOperation()) { log('warn', 'Withdraw', 'Stale run aborted before the cold-start relay'); return; }
        submittedRef.current = true;
        const receipt: TxReceiptLike = await session.registerAndWithdraw({
          inputCommitments,
          // claimQuote above was requested with this same flag; the SDK's guard
          // needs the caller's intent to know whether nativeGas must be non-zero.
          extraGas: gasTokenChecked,
          amount: `0x${claimNetWei.toString(16)}` as `0x${string}`,
          tokenId: selectedInputTokenId,
          recipientAddress: resolvedRecipient,
          selectedQuote: {
            // The relayer advertises its signer EOA as the processor, but the
            // on-chain msg.sender for registerAndRelay is the PrivacyPoolRelay
            // contract — bind the proof to that one or PoolVault rejects the
            // context with PoolVault_ProofContextMismatch. Same rebinding the
            // plain path does through rebindProcessor().
            relayerInfo: { ...claimQuote.relayer, processorAddress: withdrawalProcessorAddress },
            quote: {
              txCost: claimQuote.txCost,
              gasPrice: claimQuote.gasPrice,
              feeAmount: claimQuote.feeAmount,
              amountSent: claimQuote.amountSent,
              amountReceived: claimQuote.amountReceived,
              feeCommitment: claimQuote.feeCommitment,
            },
          },
          signature,
          deadline,
        });
        // A resolved promise is not success: the SDK returns failed receipts
        // without persisting note updates (services/sdk-types TxReceiptLike).
        // The shared block below re-checks this and, when the SDK gives no
        // usable status, confirms against the chain.
        relayReceiptResult = receipt;
        relayTxHash = (receipt?.txHash ?? receipt) as `0x${string}`;
        if (typeof relayTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(relayTxHash)) {
          throw new Error('The relayer returned no transaction hash. The withdrawal outcome is unknown. Check your balance before retrying.');
        }
        relayedFeeRaw = claimQuote.feeAmount;
        // The keystore is only registered once the register-and-withdraw is
        // CONFIRMED, so markRegistered() runs after the confirmation block below.
      } else {
        // === Yield redemption: a share note (ppUSDC) leaves as its UNDERLYING (USDC)
        // through the PPRouter, relayed (SDK prepareYieldWithdrawRelay). Only when
        // the note's token is a VERIFIED share this session serves, and this is a
        // plain exit (no receive-as swap). The relayer must accept the router as
        // processor: a definitive refusal BEFORE anything is broadcast falls back
        // to the ordinary share-token payout below; a submitted relay never does.
        const yieldDeployment = getYieldDeploymentForAsset(chainId, selectedInputTokenId);
        const yieldNs = yieldDeployment && yieldDeployment.ppUSDC.toLowerCase() === selectedInputTokenId.toLowerCase()
          ? session.yieldFor?.(yieldDeployment.ppUSDC)
          : undefined;
        // A share ALWAYS leaves as its underlying (Pat, 2026-09-05). Without a
        // verified vault (or a session without the yield namespace) there is
        // no router route, so refuse rather than pay the share the UI never
        // promised.
        if (isShareSymbol(selectedToken) && !swapSnapshot && !(yieldNs && yieldDeployment)) {
          // The vault check runs at session creation and is cached for the
          // session, so waiting does not heal a failed read: only a reload
          // re-runs it (codex P2 on d6abfcd).
          throw new Error(`${displayTokenSymbol(selectedToken)} withdrawals need a verified vault. This session could not verify it. Reload the app and try again. Nothing was sent.`);
        }
        let yieldRedeemed = false;
        // The recipient gas top-up rides this route: the quote below asks for it
        // (`gasTokenChecked`), the relayer prices it into the fee and commits a
        // non-zero PayoutRouting.nativeGas, and the SDK pins its PRESENCE against
        // the flag (prepareYieldWithdrawRelay `extraGas`). Before that the SDK
        // asserted nativeGas === 0 here and refused every topped-up quote.
        if (yieldNs && yieldDeployment && !swapSnapshot) {
          withdrawPhaseRef.current = 'quote';
          setLoadingMessage('Quoting the redemption…');
          const { createRelayerInteractor } = await import('@/services/sdk-runtime');
          const routerRelayer = createRelayerInteractor(chainId, yieldDeployment.ppRouter as `0x${string}`);
          let plan: YieldRedemptionPlan | null = null;
          let relayerInfo: Awaited<ReturnType<typeof routerRelayer.getRelayers>>[number] | undefined;
          try {
            relayerInfo = (await routerRelayer.getRelayers())[0];
            const shareQuote = relayerInfo
              ? await getQuote(
                chainId,
                amountWei.toString(),
                selectedInputTokenId as `0x${string}`,
                resolvedRecipient as `0x${string}`,
                gasTokenChecked || undefined,
              )
              : null;
            plan = shareQuote
              ? planYieldRedemption({ quote: shareQuote, shareToken: selectedInputTokenId, requestedWei: amountWei, reviewedFeeWei: feeAmountWei })
              : null;
          } catch (quoteErr) {
            // No silent fallback to the share payout: the UI promised the
            // underlying. Nothing has been broadcast at this point.
            log('error', 'Withdraw', 'Yield redemption quote failed', { err: quoteErr });
            throw new Error(`The relayer could not quote redeeming ${displayTokenSymbol(selectedToken)} to ${displayTokenSymbol(yieldDeployment.underlyingSymbol)} right now. Nothing was sent. Try again in a few minutes.`);
          }
          if (plan && 'refusal' in plan) {
            log('warn', 'Withdraw', `Yield redemption refused: ${plan.refusal}`);
            throw new Error(`The relayer refused to redeem ${displayTokenSymbol(selectedToken)} to ${displayTokenSymbol(yieldDeployment.underlyingSymbol)}: ${plan.refusal}. Nothing was sent.`);
          }
          if (!plan || !relayerInfo) {
            throw new Error(`No relayer is serving ${displayTokenSymbol(selectedToken)} redemptions right now. Nothing was sent. Try again later.`);
          }
          if (plan && relayerInfo) {
            withdrawPhaseRef.current = 'proof';
            setLoadingMessage('Generating ZK proof...');
            log('info', 'Withdraw', 'step 4/6 calling prepareYieldWithdrawRelay', {
              inputCount: inputCommitments.length,
              amountOut: plan.amountOutHex,
              recipient: resolvedRecipient,
              router: yieldDeployment.ppRouter,
            });
            const prepared = await yieldNs.withdraw.prepareYieldWithdrawRelay({
              inputCommitments,
              amount: BigInt(plan.amountOutHex),
              amountOut: BigInt(plan.amountOutHex),
              recipient: resolvedRecipient,
              signedFeeCommitment: plan.feeCommitment,
              // Must match what the quote above asked for: the SDK refuses a
              // routing whose nativeGas presence disagrees with this flag.
              extraGas: gasTokenChecked,
            });
            withdrawPhaseRef.current = 'submit';
            setLoadingMessage('Submitting to the relayer…');
            // From here there is NO fallback to the share payout: the relayer
            // wraps write failures in the same HTTP 400 as refusals, so an error
            // after this POST may be a broadcast transaction (codex, 2026-09-04).
            // A throw lands in the common catch as a failed/unknown withdrawal,
            // exactly like the ordinary path's relay.
            submittedRef.current = true;
            // Relayed: from here on a failure report would time an on-chain spend.
            withdrawPhaseRef.current = 'submit';
            const redeemTxHash = await routerRelayer.relayWithdrawal(
              relayerInfo,
              prepared.relayParams as Parameters<typeof routerRelayer.relayWithdrawal>[1],
            );
            if (typeof redeemTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(redeemTxHash)) {
              throw new Error('The relayer returned no transaction hash. The withdrawal outcome is unknown. Check your balance before retrying.');
            }
            relayTxHash = redeemTxHash;
            relayReceiptResult = undefined; // confirm from bulk chain data below
            relayedFeeRaw = plan.feeAmount;
            yieldPersist = { spentNotes: prepared.spentNotes, changePendingNotes: prepared.changePendingNotes };
            pendingRedemption = {
              underlyingSymbol: yieldDeployment.underlyingSymbol,
              underlyingDecimals: yieldDeployment.underlyingDecimals,
              quotedOut: prepared.quotedUnderlyingOut,
              minOut: prepared.minUnderlyingOut,
            };
            yieldRedeemed = true;
          }
        }
        if (!yieldRedeemed) {
        withdrawPhaseRef.current = 'proof';
        setLoadingMessage('Generating ZK proof and submitting via relayer...');
        // The ASP root the proof will be built against comes from the SDK's own
        // association-set fetch, not from this app, so log what the ASP is
        // serving right now: a withdrawal that reverts with
        // PoolVault_InvalidASPRoot is a disagreement between that root and the
        // one the registry holds at submit time.
        log('info', 'Withdraw', 'step 4/6 requesting a committed relayer quote', {
          inputCount: inputCommitments.length,
          amountHex,
          recipient: resolvedRecipient,
          processor: withdrawalProcessorAddress,
        });
        // The relayer's fee commitment lives about 60 s. session.prepareWithdraw
        // requests one and then proves self-submit calldata this path discards,
        // so relayWithdraw's proof had only what that first proof left over.
        // Requesting the quote here, right before relayWithdraw, gives the one
        // proof that is relayed the whole lifetime. The request is the one
        // prepareWithdraw made (same body, same relayer, at Confirm), and only
        // the relayer that receives the relay sees it.
        const { createRelayerInteractor } = await import('@/services/sdk-runtime');
        // The relayer's /relayer/details quote advertises the signer EOA as
        // the processor (since that's the on-chain account it signs from),
        // but the actual `msg.sender` inside PoolVault.transact will be the
        // PrivacyPoolRelay contract that wraps the call. Binding the record to
        // that contract makes relayWithdraw prove against the correct
        // processor, so the on-chain `processor == msg.sender` check passes.
        const quoteRelayer = createRelayerInteractor(chainId, withdrawalProcessorAddress);
        const prepareRelayerOption = async () => {
          const relayers = await quoteRelayer.getRelayers();
          const relayerInfo = relayers.find((r) => r.status === 'active') ?? relayers[0];
          if (!relayerInfo) throw new Error('No relayer is configured for this chain. Nothing was sent.');
          const quote = await quoteRelayer.getWithdrawalQuote(relayerInfo, {
            asset: selectedInputTokenId,
            amount: BigInt(amountHex).toString(),
            recipient: resolvedRecipient,
            // The gas top-up is requested on the committed quote too: the SDK's
            // guard refuses a commitment with nativeGas 0 when this is true
            // (QA I-b, 2026-09-02).
            extraGas: gasTokenChecked,
            commit: true,
          });
          return rebindProcessor({
            inputCommitments,
            amount: amountHex,
            tokenId: selectedInputTokenId,
            recipientAddress: resolvedRecipient,
            extraGas: gasTokenChecked,
            processorAddress: withdrawalProcessorAddress,
            selectedQuote: { relayerInfo, quote },
          }, withdrawalProcessorAddress);
        };
        type RelayerOption = Awaited<ReturnType<typeof prepareRelayerOption>>;

        // v2.0 migration: relayWithdraw now resolves to the full TxReceipt
        // ({ status, blockNumber, txHash, logs }), not a bare tx-hash string.
        // A receipt-wait timeout after the relayer broadcast is NOT a failure:
        // the hash is in the message and the bulk chain observation below
        // confirms the spend. Matthew (QA 2026-08-31) saw a mainnet USDC
        // withdrawal complete while the modal read "Withdrawal Failed".
        const relayOnce = async (option: RelayerOption) => {
          submittedRef.current = true;
          // Relayed: from here on a failure report would time an on-chain spend.
          withdrawPhaseRef.current = 'submit';
          log('info', 'Withdraw', 'step 5/6 proving and submitting to the relayer', {
            relayer: option.selectedQuote.relayerInfo.name,
            processor: option.selectedQuote.relayerInfo.processorAddress,
          });
          // Our own wait (services/relayed-receipt.ts) names no hash in its
          // timeout, so the hash is the one heard as the relayer returned it.
          const heard: { hash: string | null } = { hash: null };
          const stopHearing = onRelayedTxHash((hash, method) => {
            if (method && WITHDRAW_RELAY_METHOD.test(method)) { heard.hash = hash; withdrawPhaseRef.current = 'confirm'; }
          });
          try {
            return await session.relayWithdraw(option);
          } catch (relayErr) {
            const relayMessage = relayErr instanceof Error ? relayErr.message : String(relayErr);
            const timedOutHash = timedOutRelayTxHash(relayMessage)
              ?? (isRelayWaitTimeout(relayMessage) && heard.hash ? heard.hash as `0x${string}` : null);
            if (!timedOutHash) throw relayErr;
            log('warn', 'Withdraw', 'Receipt wait timed out after the relay; confirming from bulk chain data', { txHash: timedOutHash });
            relayTimedOut = true;
            return { txHash: timedOutHash, status: undefined } as unknown as Awaited<ReturnType<typeof session.relayWithdraw>>;
          } finally {
            stopHearing();
          }
        };
        // The fresh quote is fetched and checked first; relayOnce moves to submit.
        withdrawPhaseRef.current = 'quote';
        const outcome = await relayWithdrawalWithFreshQuote({
          prepareOption: prepareRelayerOption,
          reviewedFee: BigInt(activeFeeCommitment.feeAmount),
          shouldContinue: isSameOperation,
          relay: relayOnce,
          onStaleAspRoot: (staleErr) => {
            log('warn', 'Withdraw', 'Association-set root rotated mid-flight; re-proving once', { relayMessage: staleErr.message });
            setLoadingMessage('The approval set just updated. Re-proving your withdrawal...');
          },
        }).catch((feeErr: unknown) => {
          // A fee above the reviewed one (outside the jitter allowance) is
          // refused before proving, so nothing was sent: back to the form for a
          // fresh quote rather than releasing more from the pool than was shown.
          if (!(feeErr instanceof RelayFeeIncreasedError)) throw feeErr;
          if (isSameOperation()) {
            log('warn', 'Withdraw', 'Relayer fee increased between review and submit — aborting', {
              reviewedFee: String(feeErr.reviewedFee),
              relayFee: String(feeErr.relayFee),
            });
            submittedRef.current = false;
            reportWithdrawError(feeErr.message);
            setStep('withdraw');
            setActiveFeeCommitment(null);
            resetQuote();
          }
          return null;
        });
        if (!outcome) return;
        const relayResult = outcome.result;
        relayedFeeRaw = outcome.feeAmount;
        relayReceiptResult = relayResult;
        relayTxHash = (relayResult?.txHash ?? relayResult) as `0x${string}`;
        if (typeof relayTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(relayTxHash)) {
          throw new Error('The relayer returned no transaction hash. The withdrawal outcome is unknown. Check your balance before retrying.');
        }
        }
      }

      if (!relayTxHash) {
        throw new Error('No relay transaction was submitted. Your notes were NOT spent.');
      }

      // POSITIVE confirmation required (codex round 2: rejecting only
      // status===false let a malformed/legacy result with no confirmable
      // status fall through to fee recording and Success). A literal-true
      // SDK receipt needs no second client; anything else must confirm via
      // the chain — a fetch failure is submitted-unknown, never success.
      const sdkStatus = (relayReceiptResult && typeof relayReceiptResult === 'object'
        && 'status' in relayReceiptResult)
        ? (relayReceiptResult as { status?: unknown }).status
        : undefined;
      if (sdkStatus === false) {
        throw new Error('Withdrawal transaction reverted on-chain. Your notes were NOT spent.');
      }
      if (sdkStatus !== true) {
        // PRIVACY: confirm from bulk chain data, NOT by polling this client's
        // RPC for the relayer's transaction hash. That poll tells the provider
        // this IP is waiting on that specific withdrawal, nullifying the
        // relayer's whole purpose. The input nullifiers are known locally and
        // their appearance in one Transacted event is the same fact from data
        // every client fetches identically. Positive confirmation is still
        // required: no observation means submitted-unknown, never success.
        const { confirmRelayedSpend } = await import('@/services/onchain-note-index');
        const confirmChain = getChainConfig(chainId);
        const confirmPool = LEGACY_CONFIG?.pool ?? confirmChain?.contracts?.poolAddress;
        const confirmKey = keystoreManager?.getPrivateNullifyingKey();
        if (!confirmPool || !confirmChain?.contracts?.fromBlock || !confirmKey) {
          throw new Error(`The withdrawal was submitted (tx ${relayTxHash}) but cannot be confirmed right now. Verify it in the explorer before retrying.`);
        }
        // Mark the inputs spent ourselves when the SDK threw before its own
        // persistNoteUpdates (timed-out receipt wait). The SDK refuses
        // SPENT -> SPENT, and a discovery pass may already have marked some of
        // them while the wait ran, so only still-ACTIVE inputs are sent, and a
        // persistence failure never turns a confirmed outcome into "failed"
        // (codex on 4506de0).
        const markInputsSpentIfActive = async (blockNumber: unknown, notes: readonly { commitment: string }[] = inputNotes) => {
          const spentAtBlock = `0x${BigInt(String(blockNumber ?? 0)).toString(16)}` as `0x${string}`;
          const stillActive = noteManager
            ? new Set(noteManager.getNotes({ status: NoteStatus.ACTIVE }).map((n) => String(n.commitment).toLowerCase()))
            : null;
          const targets = stillActive ? notes.filter((n) => stillActive.has(String(n.commitment).toLowerCase())) : notes;
          if (targets.length === 0) return;
          try {
            await session.markNotesSpent(targets.map((n) => ({ commitment: n.commitment as `0x${string}`, spentAtBlock })));
          } catch (markErr) {
            log('warn', 'Withdraw', 'Marking inputs spent after a timed-out receipt wait failed; the next sync reconciles', { err: markErr });
          }
        };
        let observed: Awaited<ReturnType<typeof confirmRelayedSpend>>['observed'] = null;
        try {
          ({ observed } = await confirmRelayedSpend({
            chainId,
            poolAddress: String(confirmPool),
            fromBlock: confirmChain.contracts.fromBlock,
            inputCommitments: inputNotes.map((n) => n.commitment as `0x${string}`),
            // Router route: ask whether THIS proof's outputs landed, so a
            // competing same-input spend (another device) is told apart.
            ...(yieldPersist ? { outputCommitments: yieldPersist.changePendingNotes.map((n) => n.commitment as `0x${string}`) } : {}),
            privateNullifyingKey: confirmKey,
          }));
        } catch (confirmErr) {
          log('warn', 'Withdraw', 'Bulk confirmation failed', confirmErr);
        }
        if (!observed) {
          // Broadcast but not in a block yet: pending, not failed (DEV-458).
          // The pending-relay record holds the notes and settles this screen.
          const pendingHash = relayTxHash.toLowerCase();
          const pendingFee = relayedFeeRaw ?? activeFeeCommitment?.feeAmount;
          log('warn', 'Withdraw', 'Relayed withdrawal not confirmed within the wait; keeping it pending', { txHash: relayTxHash });
          settleWatch.keep();
          stopHearingWithdrawSettleRef.current = settleWatch.stop;
          void settleWatch.hear(pendingHash).then((resolution) => {
            settleWatch.stop();
            if (stopHearingWithdrawSettleRef.current === settleWatch.stop) stopHearingWithdrawSettleRef.current = null;
            if (!isSameOperation()) return;
            setWithdrawPending(false);
            if (!resolution.spent) {
              reportWithdrawError('The relayed withdrawal reverted on-chain. Nothing was withdrawn and your balance is unchanged. You can try again.');
              submittedRef.current = false;
              return;
            }
            const landed = landedTxHash(resolution) as `0x${string}` | null;
            if (!landed) {
              reportWithdrawError(`Your notes were spent by another transaction (${resolution.spentBy}), not by this withdrawal. Refresh to see the result; nothing else was sent.`);
              submittedRef.current = false;
              return;
            }
            try {
              recordOwnWithdrawal({
                chainId,
                txHash: landed,
                recipient: resolvedRecipient,
                tokenAddress: selectedTokenAddress,
                feeAmount: pendingFee,
                stampOwnAction: true,
                now: Date.now(),
              }, { recordOwnAction, recordWithdrawFee, recordWithdrawRecipient });
            } catch { /* non-fatal */ }
            setTxHash(landed);
            setTxChainId(chainId);
            reportWithdrawError(null);
            setStep('success');
            refetchNotes();
            void invalidateTransactionCaches(queryClient);
          });
          setTxHash(relayTxHash);
          setTxChainId(chainId);
          setWithdrawPending(true);
          throw new Error(WITHDRAW_PENDING_MESSAGE);
        }
        if (relayTimedOut && relayTxHash && (!observed.txHash || observed.txHash.toLowerCase() !== relayTxHash.toLowerCase())) {
          // The inputs were consumed, but this is not positively THIS relay's
          // transaction: either a different hash (a competing spend from
          // another device landed first and the relayed one reverts) or an
          // observation with no hash at all (a snapshot row). Reconcile the
          // consumed inputs, persist and refresh, then fail without claiming
          // this withdrawal happened (codex on 4506de0 and 49f41bf).
          await markInputsSpentIfActive(observed.blockNumber);
          log('warn', 'Withdraw', 'Timed-out relay: inputs consumed but not matched to this transaction', { txHash: relayTxHash, observedTxHash: observed.txHash ?? null });
          if (noteManager && connectedAddress) {
            await exportAccount(session).catch((e) => log('warn', 'Withdraw', 'Export after an unmatched spend failed; next sync will persist', e));
            refetchNotes();
          }
          throw new Error(observed.txHash
            ? `Your notes were spent by another transaction (${observed.txHash}), not by this withdrawal (tx ${relayTxHash}). Your balance has been refreshed.`
            : `The withdrawal was submitted (tx ${relayTxHash}) and your notes show as spent, but it cannot be matched to the chain yet. Verify it in the explorer before retrying.`);
        }
        log('info', 'Withdraw', 'Relay confirmed via bulk Transacted observation', {
          txHash: relayTxHash,
          observedTxHash: observed.txHash,
          blockNumber: observed.blockNumber,
        });
        // The router redemption bypassed the SDK's relayWithdraw, so the note
        // manager has not seen it: mark the inputs spent at the OBSERVED block and
        // add the change notes, exactly what the SDK does after its own relay.
        if (yieldPersist) {
          // The bulk index found the transaction that consumed these inputs;
          // ITS hash is canonical from here (a relayer has reported an unrelated
          // hash before), for the change notes, the explorer link and the fee row.
          if (typeof observed.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(observed.txHash)) {
            relayTxHash = observed.txHash as `0x${string}`;
          }
          // Nullifier observation is proof the inputs are spent, whoever spent them.
          await markInputsSpentIfActive(observed.blockNumber, yieldPersist.spentNotes);
          if (observed.outputsMatch === false) {
            // Another spend of the same inputs won (a second device, a retry):
            // our change notes were never minted. Say what happened; discovery
            // will pick up whatever that transaction produced.
            log('warn', 'Withdraw', 'Observed spend does not carry this proof\'s outputs; not registering change notes', { observedTxHash: observed.txHash });
            pendingRedemption = null;
            throw new Error(`Your notes were spent by another transaction (${observed.txHash}), not this one. Refresh to see the result; nothing else was sent.`);
          }
          if (yieldPersist.changePendingNotes.length > 0) {
            // Registration is bookkeeping after a CONFIRMED spend: a failure here
            // must not read as a failed withdrawal. Discovery re-derives it.
            try {
              await session.addNotes(yieldPersist.changePendingNotes.map((pendingNote) => ({ pendingNote, txHash: relayTxHash! })));
            } catch (addErr) {
              log('warn', 'Withdraw', 'Change note registration failed after a confirmed redemption; discovery will re-derive it', { err: addErr });
            }
          }
          setYieldRedemption(pendingRedemption);
        }
        if (relayTimedOut && !yieldPersist) {
          // The SDK threw before its persistNoteUpdates: the inputs are not
          // marked spent and the change note was never added. Mark the inputs
          // so nothing reselects them; the change comes back from the chain's
          // Note event on the grid's next discovery pass, not from a pass timed
          // to this relayed withdrawal.
          await markInputsSpentIfActive(observed.blockNumber);
          log('info', 'Withdraw', 'Timed-out relay reconciled from chain data', { txHash: relayTxHash, count: inputNotes.length });
        }
      }

      if (coldStartClaim) {
        // The keystore leaf is on-chain now (same transaction as the
        // withdrawal, confirmed above). Mark it in both the SDK manager and the
        // registration modal's cached status so nothing re-prompts for a
        // registration the relayer already performed.
        try {
          keystoreManager?.markRegistered(chainId);
        } catch {
          // SDK already has it; duplicate marker calls are harmless.
        }
        markRegistered(connectedAddress, chainId);
        // registerAndRelay sets no viewing key, so the account is only partially set up.
        setReceiveSetup(connectedAddress, chainId, 'partial', 'local');
      }

      // SDK's prepareWithdraw already adds the change note and marks inputs
      // as SPENT inside NoteManager — no client-side persistence needed here.
      // We just sync the export and refetch so the UI sees the updated state.
      if (noteManager && connectedAddress) {
        await exportAccount(session).catch((e) => log('warn', 'Withdraw', 'Post-confirm export failed; next sync will persist', e));
        refetchNotes();
      }

      setTxHash(relayTxHash);
      setTxChainId(chainId);
      // This device withdrew in this tx: the change note must never read as
      // Transfer In while the snapshot lags (services/own-actions-core.ts).
      // The relayer fee is stashed because the feed only carries the gross
      // withdrawnValue: the fee actually used by the relay (guarded above to
      // be ≤ the reviewed fee), else the reviewed one. The recipient names
      // where the money went, which the feed mostly does not.
      try {
        recordOwnWithdrawal({
          chainId,
          txHash: relayTxHash,
          recipient: resolvedRecipient,
          tokenAddress: selectedTokenAddress,
          feeAmount: relayedFeeRaw ?? activeFeeCommitment?.feeAmount,
          stampOwnAction: true,
          now: Date.now(),
        }, { recordOwnAction, recordWithdrawFee, recordWithdrawRecipient });
      } catch { /* non-fatal */ }
      if (isSameOperation()) setStep('success');

      await invalidateTransactionCaches(queryClient);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'Withdraw', `Withdrawal failed: ${message}`);
      if (!isSameOperation()) return;
      // A relayer that cannot fund the relay is an outage, named as one
      // (DEV-400): the raw "HTTP 400 {...statusCode:400}" blob told the user
      // nothing about whose problem it was or whether funds moved.
      reportWithdrawError(
        isRelayerOutOfGas(message) ? relayerOutOfGasMessage('withdrawal')
          : isPendingRelayBlocked(message) ? message
            : isRelayerNullifierInFlight(message) ? relayInFlightMessage('withdrawal')
              : message === WITHDRAW_PENDING_MESSAGE ? message
                : `Withdrawal failed: ${shownError(err)}`,
        err,
        'relay',
      );
      setYieldRedemption(null);
      submittedRef.current = false;
      setStep('error');
    } finally {
      stopHearingWithdrawRelay();
      settleWatch.release();
      endTx();
    }
  }, [isSui, suiSession, sdkReady, poolSession, noteManager, keystoreManager, notes, amount, effectiveReceiveExact, selectedToken, selectedTokenAddress, targetAddress, connectedAddress, activeFeeCommitment, batchPlan, swapSnapshot, reviewContext, getBatchWithdrawSession, withdrawalProcessorAddress, chainId, log, resetQuote, selectedPA, refetchNotes, exportAccount, preferredTransaction, preferredWithdrawNote, ensureInitialized, spendabilityKey, spendableCommitments, publicClient, queryClient, beginTx, endTx, coldStartClaim, getQuote, gasTokenChecked, signTypedDataAsync, markRegistered, crossChainReceive, receiveChainId]);

  // Same-tick double-press guard — see hooks/use-op-lock.ts.
  const handleConfirm = useMemo(() => withOpLock(handleConfirmUnlocked), [withOpLock, handleConfirmUnlocked]);

  // Back from Review to the amount step (QA 09-02: the review had no way back
  // short of the quote expiring). Same teardown as the expiry path above,
  // minus the error toast: the fee commitment, cold-start decision, batch
  // plan, swap snapshot and review context were all computed for THIS quote
  // and must not survive into the next Review, or Confirm could act on them.
  const handleBackToInput = useCallback(() => {
    invalidateQuoteRequests();
    setStep('withdraw');
    setActiveFeeCommitment(null);
    setColdStartClaim(null);
    setBatchPlan(null);
    setSwapSnapshot(null);
    setReviewContext(null);
    resetQuote();
  }, [invalidateQuoteRequests, resetQuote]);

  // Inline mode: the hub's amount input IS the withdraw amount — mirror the
  // in-card TextInput handler exactly so quotes/consent stay coherent.
  const syncInlineAmount = useCallback((text: string) => {
    const val = sanitizeAmountInput(text, tokenDecimalsForDisplay);
    setAmount(val);
    setSelectedTab(null);
    invalidateQuoteRequests();
    setMaxSelected(false);
    setDollarValue(amountDollarLabel(val));
    bumpSelection();
  }, [tokenDecimalsForDisplay, amountDollarLabel, invalidateQuoteRequests, bumpSelection]);

  // DEV-531: the hub's card token, pushed live (Send has had this since
  // DEV-469). Same resets as the form's own token dropdown: the receive-as
  // pick, every quote and the percent intent belong to the old asset. The
  // amount stays, re-sanitized, because the hub owns the input.
  const syncInlineToken = useCallback((symbol: string) => {
    if (isSui || stepRef.current !== 'withdraw') return;
    const meta = getTokenMetadataBySymbol(symbol, chainId);
    if (!meta) return;
    selectWithdrawToken(meta.symbol, true);
    setReceiveAsset(null);
    setReceiveChainId(chainId);
    setSwapSnapshot(null);
    setActiveFeeCommitment(null);
    setBatchPlan(null);
    setReviewContext(null);
    invalidateQuoteRequests();
    setSelectedTab(null);
    setMaxSelected(false);
    setAmount((a) => sanitizeAmountInput(a, withdrawTokenDecimals(meta.symbol, chainId, false)));
    bumpSelection();
  }, [isSui, chainId, selectWithdrawToken, invalidateQuoteRequests, bumpSelection]);

  // Native mock mode: no real flow starts from the pretend account.
  const blockMockFlow = useNativeMockBlock();
  const openWithdrawModal = useCallback((transaction?: Transaction, opts?: { tokenSymbol?: string; amount?: string; inline?: boolean; receiveTokenAddress?: string; receiveChainId?: number; targetAddress?: string }) => {
    if (blockMockFlow()) return;
    // A withdrawal is executing — never reset the flow state under it
    // (codex P1: close/reopen during 'loading' let an old operation
    // overwrite a fresh flow).
    if (isOpenRef.current && stepRef.current === 'loading') return;
    // The wallet-picker and seed-derivation gates are EVM session concerns; the
    // Sui session derives its keys from a wallet signature at submit time.
    if (!isSui) {
      // Disconnected → open the wallet picker instead of a dead modal (QA-4).
      // NOT for inline (hub) opens — the hub gates on the UNIFIED connection
      // while this reads raw wagmi; mid-reconnect the mismatch silently
      // swallowed the auto-open. The inline form re-checks at its own CTA.
      if (!opts?.inline && !ensureConnected()) return;
      // Keys not derived yet → one-time signature first, then continue here.
      // Inline (hub) opens show the FORM without forcing the unlock first —
      // the flow's own actions walk the gates when a session is needed.
      if (!keysReadyRef.current && identityMode !== 'key' && !opts?.inline) {
        openSeedDerivationModal({ onSigned: () => openWithdrawModal(transaction, opts) });
        return;
      }
    }
    setStep('withdraw');
    setTxHash(null);
    setTxChainId(null);
    submittedRef.current = false;
    // Sui amounts are MIST (9 dp) regardless of what the launcher passed —
    // sanitizing at a wider precision would silently truncate downstream.
    setAmount(opts?.amount
      ? sanitizeAmountInput(opts.amount, isSui ? altDecimals : withdrawTokenDecimals(opts.tokenSymbol ?? 'ETH', chainId, false))
      : '');
    setDollarValue('$0.00');
    setSelectedTab(null);
    setMaxSelected(false);
    setGasTokenChecked(false);
    setReceiveExact(true); // DEV-229: reset to "recipient receives exact amount" per open
    setRelayerSelectorOpen(false); // DEV-233
    setFeeExpanded(false);
    setCountdown(0);
    reportWithdrawError(null);
    setWithdrawPending(false);
    // A launcher may hand over the wallet to pay (the Send tab's swap-send is
    // a public payout, so it continues here). Only a well-formed EVM address
    // is taken; anything else leaves the field empty for the user.
    const handedTarget = !isSui && opts?.targetAddress && isAddress(opts.targetAddress.trim()) ? opts.targetAddress.trim() : '';
    setTargetInput(handedTarget);
    setTargetAddress(handedTarget);
    setResolvedTargetName(null);
    setTargetEnsResolving(false);
    setTargetEnsError(null);
    setLoadingMessage('Preparing withdrawal...');
    setActiveFeeCommitment(null);
    setColdStartClaim(null);
    setBatchPlan(null);
    setBatchProgress(null);
    // "Receive as" resets to the pool asset (plain withdrawal) on every open,
    // and to this chain: a destination left over from a previous operation must
    // never be the default for the next one.
    // A launcher may hand over a receive-as pick (the Send tab's "pay my own
    // wallet in X on Y" is a withdrawal). Validated against what this chain
    // can deliver; anything else is the pool asset on this chain, as before.
    const swapExitsHere = !isSui && crossFlowsEnabled() && intentSwapsEnabledForChain(chainId);
    const handedChain = swapExitsHere
      && opts?.receiveChainId !== undefined
      && opts.receiveChainId !== chainId
      && getSwapDestinationChains(chainId).includes(opts.receiveChainId)
      ? opts.receiveChainId
      : chainId;
    const handedAddress = opts?.receiveTokenAddress?.toLowerCase();
    const handedAsset = swapExitsHere && handedAddress
      ? getSwapDeliveryTokens(handedChain).find((t) => t.address.toLowerCase() === handedAddress) ?? null
      : null;
    setReceiveAsset(handedAsset);
    setReceiveChainId(handedAsset ? handedChain : chainId);
    setReceiveSelectorOpen(false);
    setSwapSnapshot(null);
    setReviewContext(null);
    // New modal operation: everything from a previous open/close is foreign.
    modalEpochRef.current += 1;
    invalidateQuoteRequests();
    setSelectedPA(null);
    setPreferredTransaction(transaction ?? null);
    // Fresh selection on every open — clears any stale guard acknowledgment
    // from a prior session (codex finding 7).
    dispatchGuard({ type: 'reset' });
    bumpSelection();
    if (isSui) {
      // Sui withdraws are always SUI — ignore EVM token prefills from
      // launchers (e.g. the home action hub defaults to 'ETH').
      selectWithdrawToken(altSymbol);
    } else if (opts?.tokenSymbol && getTokenMetadataBySymbol(opts.tokenSymbol, chainId)) {
      // Registry-gated per chain (codex round 2): the static TOKEN_DECIMALS
      // gate accepted symbols with no contract on the active chain (DAI on
      // Citrea), whose address resolution then fell back to native.
      // The REGISTRY spelling, not the launcher's: the pool route hands over
      // an upper-cased PPETH, the notes and balances are keyed ppETH, and
      // the comparisons below are case-sensitive, so a pinned PPETH showed
      // no spendable funds on the ETH pool page (codex on dd034a1).
      selectWithdrawToken(getTokenMetadataBySymbol(opts.tokenSymbol, chainId)!.symbol, true);
      // The launcher chose. The largest-balance auto-pick must not overrule it.
    } else if (transaction?.asset && getTokenMetadataBySymbol(transaction.asset, chainId)) {
      selectWithdrawToken(getTokenMetadataBySymbol(transaction.asset, chainId)!.symbol);
    } else {
      // The chain's native asset, not a literal 'ETH' — Citrea's is cBTC and
      // an 'ETH' default there matched no notes (symbol filter) forever.
      selectWithdrawToken((preferredHubToken(hubTokenCatalog('withdraw', chainId, sourceHoldings), sourceHoldings) ?? emptySpendToken(chainId))?.symbol ?? 'ETH');
    }
    setNoteDropdownOpen(false);
    setTokenDropdownOpen(false);
    resetQuote();
    setInlinePreferred(!!opts?.inline);
    setIsOpen(true);

    log('debug', 'Withdraw', 'Opened withdraw modal', {
      transaction: transaction ? {
        id: transaction.id,
        txHash: transaction.txHash,
        label: transaction.label,
        rawAmount: transaction.rawAmount,
        tokenAddress: transaction.tokenAddress,
        asset: transaction.asset,
        status: transaction.status,
      } : null,
    });
  }, [blockMockFlow, resetQuote, ensureConnected, identityMode, openSeedDerivationModal, isSui, chainId, sourceHoldings, bumpSelection, invalidateQuoteRequests, selectWithdrawToken]);

  const closeWithdrawModal = useCallback(() => {
    // Block close while the withdrawal is executing (codex P1): a proof/relay
    // is in flight — closing (and reopening a second flow) would let the old
    // operation's completion overwrite the new flow. The tab-close guard
    // already warns about the same hazard at the browser level.
    if (stepRef.current === 'loading') return;
    // Crossing this boundary invalidates every in-flight quote and reviewed
    // figure — a reopened modal starts a NEW operation epoch.
    modalEpochRef.current += 1;
    submittedRef.current = false;
    invalidateQuoteRequests();
    setReviewContext(null);
    setPreferredTransaction(null);
    explicitTokenPinRef.current = false;
    setInlinePreferred(false);
    setIsOpen(false);
  }, [invalidateQuoteRequests]);

  // Test affordance: expose openWithdrawModal on window so the Sui withdraw
  // playwright harness can open the modal directly (the normal trigger is a
  // completed-tx row menu, which only appears once the ASP approves the note).
  // Guarded to web + when EXPO_PUBLIC_TEST_MODE is on. No-op in production.
  useEffect(() => {
    if (Platform.OS !== 'web' || process.env.EXPO_PUBLIC_TEST_MODE !== 'true') return;
    (window as unknown as { __openWithdraw?: typeof openWithdrawModal }).__openWithdraw = openWithdrawModal;
  }, [openWithdrawModal]);

  useEffect(() => {
    if (!isOpen || Platform.OS !== 'web') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeWithdrawModal();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeWithdrawModal]);
  useBackHandler(isOpen, closeWithdrawModal);

  // Explorer link for the submitted tx — the FROZEN chain decides both the URL
  // and the label; branching on live isSui sends an EVM hash to a /txblock/
  // URL after a post-submit chain switch (codex).
  const explorerChainId = txChainId ?? (isSui ? altChainId : chainId);
  const explorerIsSui = explorerChainId === SUI_TESTNET_ID;
  const explorerTxLink = (hash: string) => (explorerIsSui
    ? `${getChainConfig(SUI_TESTNET_ID)?.explorerUrl ?? 'https://testnet.suivision.xyz'}/txblock/${hash}`
    : getExplorerTxUrl(explorerChainId, hash));

  const applyEvmPercentForRoute = (
    tab: string,
    nextIsSwapExit: boolean,
    nextSingleProofCapWei: bigint,
  ) => {
    const selection = resolveWithdrawPercentSelection({
      pct: parseInt(tab, 10),
      isSwapExit: nextIsSwapExit,
      batchEnabled,
      spendableWei: currentBalance.active,
      singleProofCapWei: nextSingleProofCapWei,
    });
    const amountWei = parseInt(tab, 10) < 100
      ? floorToDisplayPrecision(selection.amountWei, tokenDecimalsForDisplay)
      : selection.amountWei;
    const val = formatUnits(amountWei, tokenDecimalsForDisplay);
    setMaxSelected(selection.maxSelected);
    setAmount(val);
    setDollarValue(amountDollarLabel(val));
  };

  const handleTabPress = (tab: string) => {
    // Percentages of a balance that hasn't loaded are percentages of 0; the
    // tabs render disabled during the load, and this guard covers a race
    // between the press and the set landing.
    if (spendabilityBlocked) return;
    setSelectedTab(tab);
    // Amount is part of the swap-quote key — drop any in-flight quote.
    invalidateQuoteRequests();
    const pct = parseInt(tab, 10);
    if (isSui) {
      // Sui keeps its float path (9-decimal, single-note cap).
      const exact = displayAvailableNum * (pct / 100);
      const val = (Math.floor(exact * 10000) / 10000).toFixed(4);
      setMaxSelected(false);
      setAmount(val);
      setDollarValue(amountDollarLabel(val));
    } else {
      // Pass the route and cap explicitly. Route-change handlers call the same
      // helper with the DESTINATION cap before React has re-rendered it.
      applyEvmPercentForRoute(tab, isSwapExit, availableWei);
    }
    // Every tab press is a new selection — clears any prior acknowledgment,
    // including tapping 100% again while already at 100% (yield codex finding 7).
    bumpSelection();
  };

  const receiveExactExplanation = receiveExact
    ? 'The relayer fee is added on top of the amount you entered.'
    : 'The relayer fee is taken out of the amount you entered, so the recipient receives a little less.';

  const handleReceiveExactToggle = () => {
    setReceiveExact((value) => !value);
    invalidateQuoteRequests();
    setActiveFeeCommitment(null);
    setColdStartClaim(null);
    setReviewContext(null);
    bumpSelection();
    // Review was priced and admitted under the previous net/gross semantics.
    // Return to the form so the new choice gets a fresh fee-bound review.
    if (stepRef.current === 'review') setStep('withdraw');
  };

  const handleGasTokenToggle = () => {
    setGasTokenChecked((value) => !value);
    invalidateQuoteRequests();
    setActiveFeeCommitment(null);
    setReviewContext(null);
    bumpSelection();
  };

  // Exact-share writes (including Use maximum) bypass the entry boundary.
  // Single write path for "apply a suggested amount" — the exact sequence the
  // quick-amount chips already ran inline (sanitize with the token's decimals →
  // setAmount → clear tab/Max intent → drop in-flight quotes → refresh the USD
  // line → fresh guard consent). Presentation only: nothing here changes how an
  // amount is parsed, capped or guarded.
  const applyShareAmount = (value: string) => {
    const val = sanitizeAmountInput(value, tokenDecimalsForDisplay);
    setAmount(val);
    setSelectedTab(null);
    setMaxSelected(false);
    invalidateQuoteRequests();
    setDollarValue(amountDollarLabel(val));
    bumpSelection();
  };

  // Quick presets are underlying literals when the rate is known, shares otherwise.
  const applyPresetAmount = (value: string) => {
    if (spendabilityBlocked) return;
    const maxWei = getWithdrawMaxWei(selectedToken);
    if (amountField.presetExceedsMax(value) ?? presetExceedsWithdrawMax(value, maxWei, selectedTokenDecimals)) {
      errorToast({ title: `You can withdraw up to ${spendableLabel(formatUnits(maxWei ?? 0n, selectedTokenDecimals), selectedToken, chainId)}.`, variant: 'warning' });
      return;
    }
    applyShareAmount(amountField.toShares(value));
  };

  // FullWithdrawalGuard escape hatch: one tap resets the selection to 75%.
  const handleFullWithdrawalEscape = () => {
    dispatchGuard({ type: 'escape' });
    handleTabPress(FULL_WITHDRAWAL_ESCAPE_TAB);
  };

  return (
    <WithdrawModalContext.Provider value={{ openWithdrawModal, closeWithdrawModal, isOpen, inlineActive: isOpen && inlineHubActive, inlineStep: step, syncInlineAmount, inlineAmount: amount, inlineToken: selectedToken, syncInlineToken, spendabilityLoading, spendabilityError, retrySpendability: retryAssociationSetLeaves, getSpendableBalanceWei, getWithdrawMaxWei }}>
      {children}
      {isOpen && (
        <OpShell
          inline={inlineHubActive}
          isSheet={isSheet}
          isDark={isDark}
          sheetAnim={sheetAnim}
          onClose={closeWithdrawModal}
          cardClassName={`relative items-center overflow-hidden border border-border bg-card-background ${step === 'withdraw' ? 'gap-[20px]' : 'gap-[16px]'} ${(step === 'loading' || step === 'success') ? 'justify-center' : ''} ${
            isSheet
              ? 'w-full max-w-full px-[16px] py-[24px] pt-[28px] rounded-t-card rounded-b-none border-b-0 mb-0'
              : isMobile
                ? 'w-[95%] max-w-[95%] rounded-card px-[16px] py-[24px]'
                : 'w-[504px] max-w-[95%] rounded-card px-[24px] py-[36px]'
          }`}
        >
            {isSheet && !inlineHubActive && <View className="absolute top-[10px] self-center w-[44px] h-[4px] rounded-[2px] z-[10] bg-border" />}
            {/* Close Button — hidden inline: the hub's tabs are the exit. */}
            {!inlineHubActive && (
              <>
                <Pressable className="absolute top-[11px] right-[11px] w-[24px] h-[24px] items-center justify-center z-[10]" onPress={closeWithdrawModal}>
                  <CloseIcon color={colors.text} />
                </Pressable>
              </>
            )}

            {step === 'withdraw' && (
              <>
                {!isSui && <PendingRelayNotice chainId={chainId} owner={connectedAddress} />}
                {/* Title + token selector — hidden inline: the hub card above
                    already carries the token pills and the big amount input;
                    only the EXTRA withdraw info renders below it. */}
                {!inlineHubActive && (<>
                {/* Title */}
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Make a withdrawal
                </Text>

                {/* Token Selector Dropdown */}
                <View className="relative w-full z-[20]">
                  <Pressable
                    className="w-full h-[40px] flex-row items-center rounded-control border border-border px-[16px] py-[12px] gap-[12px] bg-card-background"
                    onPress={() => setTokenDropdownOpen(!tokenDropdownOpen)}
                  >
                    <Text className="text-[16px] leading-[16px] flex-1 text-text font-pp-regular">
                      {amountField.symbol}
                    </Text>
                    <Pressable
                      className="flex-row items-center gap-[4px] px-[8px] py-[4px] border border-border-light rounded-control"
                      onPress={(e) => { e.stopPropagation(); }}
                    >
                      <Text className="text-[12px] leading-[12px] text-[#4D4D4D] font-pp-regular">
                        {currentChainName}
                      </Text>
                      <ChainLogo chain={chainLogoChainFor(isSui ? altChainId : chainId)} size={20} />
                    </Pressable>
                    {tokenDropdownOpen ? <CaretUpIcon color={colors.text} /> : <CaretDownIcon color={colors.text} />}
                  </Pressable>
                  {tokenDropdownOpen && (
                    <View
                      className="absolute top-[42px] left-0 right-0 z-[100] overflow-hidden rounded-control border border-border bg-menu-background"
                      // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                      style={DROPDOWN_SHADOW}
                    >
                      {(isSui ? [altSymbol] : sourceTokens.map((t) => t.symbol)).map((token, idx, arr) => {
                        const bal = tokenBalances.get(token);
                        return (
                          <Pressable
                            key={token}
                            className={`flex-row items-center justify-between px-[16px] py-[10px] ${idx < arr.length - 1 ? 'border-b' : ''} border-b-border-light ${selectedToken === token ? 'bg-primary-soft' : 'bg-transparent'}`}
                            onPress={() => {
                              selectWithdrawToken(token, true);
                              setTokenDropdownOpen(false);
                              // Pool asset switch: "Receive as" resets to the
                              // (new) pool asset — plain withdrawal — and every
                              // in-flight/reviewed quote is dropped (shared
                              // guard covers plain/batch/swap).
                              setReceiveAsset(null);
                              setSwapSnapshot(null);
                              setActiveFeeCommitment(null);
                              setBatchPlan(null);
                              setReviewContext(null);
                              invalidateQuoteRequests();
                              // Token switch changes the balance/cap → reset the
                              // entry AND any full-balance (Max/100%) intent, so a
                              // stale amount can't route the NEW token's full batch
                              // or leave the full-withdrawal guard un-tripped
                              // (integration review finding 1). Then bump for fresh
                              // consent (codex finding 7).
                              setSelectedTab(null);
                              setMaxSelected(false);
                              setAmount('');
                              setDollarValue('$0.00');
                              bumpSelection();
                            }}
                          >
                            <Text className={`text-text text-[14px] ${selectedToken === token ? 'font-pp-medium' : 'font-pp-regular'}`}>
                              {poolDisplayLabel(token, chainId)}
                            </Text>
                            <Text className="text-text-secondary font-pp-regular text-[12px]">
                              {balanceDisplay(bal ? formatUnits(bal.active, withdrawTokenDecimals(token, chainId, isSui)) : '0', token, chainId).text}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
                </>)}

                {/* Amount Input Field with Info — the box itself is the hub's
                    input when inline; validation/presets below always render. */}
                <View className="w-full gap-[8px]">
                  {!inlineHubActive && (
                  <View className="w-full border border-border-light rounded-control p-[16px] gap-[10px] bg-card-background">
                    {/* Top row: amount + info */}
                    <View className="flex-row justify-between items-end gap-[12px]">
                      <View className="flex-1 gap-[4px]">
                        <TextInput
                          className={`text-[24px] leading-[30px] p-0 m-0 font-pp-regular ${amount ? 'text-text' : 'text-[#999999]'}`}
                          // nw-keep(platform-css): web-only outline reset + text cursor have no className path (empty on native)
                          // nw-keep(measured-or-inset): font size shrinks to the measured field width for long figures
                          style={[WEB_NO_OUTLINE, Platform.OS === 'web' ? { cursor: 'text' } as unknown as TextStyle : {}, { fontSize: fitAmountFontSize(amountField.value, amountFieldWidth, 24) }]}
                          onLayout={(e) => setAmountFieldWidth(Math.round(e.nativeEvent.layout.width))}
                          value={amountField.value}
                          placeholder="0"
                          placeholderTextColor="#999999"
                          onChangeText={(text) => {
                            const val = sanitizeAmountInput(amountField.toShares(text), tokenDecimalsForDisplay);
                            setAmount(val);
                            setSelectedTab(null);
                            // Amount is part of the swap-quote key.
                            invalidateQuoteRequests();
                            // Typing clears explicit Max intent — a typed amount
                            // only counts as full when it equals the balance to
                            // the wei (checked in fullBalanceRequested).
                            setMaxSelected(false);
                            setDollarValue(amountDollarLabel(val));
                            // New selection → fresh consent (codex finding 7).
                            bumpSelection();
                          }}
                          keyboardType="numeric"
                        />
                        <Text className="text-[14px] text-[#999999] font-pp-regular">
                          {isShareSymbol(selectedToken) ? amountDollarLabel(amount) : dollarValue}
                        </Text>
                      </View>
                      {isShareSymbol(selectedToken) ? <BalanceAmount view={balanceDisplay(amount || '0', selectedToken, chainId)} className="text-[12px] text-text-secondary" /> : null}
                      {amountField.error ? <Text className="text-[12px] text-danger">{amountField.error}</Text> : null}
                      <View className="shrink gap-[6px] items-end">
                        <View className="flex-row items-center gap-[4px] flex-wrap justify-end">
                          <Text className="text-[14px] text-[#999999] text-right font-pp-regular">
                            {spendabilityLoading
                              ? 'Loading shielded balance…'
                              : spendabilityError
                                ? 'Shielded balance unavailable'
                                : `Available: ${spendableLabel(isSui ? String(displayAvailableNum) : formatUnits(resolveDisplayAvailableWei({ isSwapExit, batchEnabled, spendableWei: currentBalance.active, singleProofCapWei: availableWei }), selectedTokenDecimals), selectedToken, chainId)}`}
                          </Text>
                          <ShareCountHint hint={balanceDisplay(isSui ? String(displayAvailableNum) : formatUnits(resolveDisplayAvailableWei({ isSwapExit, batchEnabled, spendableWei: currentBalance.active, singleProofCapWei: availableWei }), selectedTokenDecimals), selectedToken, chainId).hint} />
                          <ModalInfoIcon color="#999999" />
                        </View>
                        <View className="flex-row gap-[2px] flex-wrap justify-end max-w-[188px]">
                          {['25%', '50%', '75%', '100%'].map((tab) => (
                            <Pressable
                              key={tab}
                              // Guard tripped → the 100% tab turns red.
                              className={`border rounded-control min-w-[40px] px-[6px] py-[4px] items-center justify-center bg-card-background ${
                                fullWithdrawalTripped && tab === '100%'
                                  ? 'border-danger'
                                  : selectedTab === tab
                                    ? 'border-text'
                                    : 'border-border-light'
                              }`}
                              onPress={() => handleTabPress(tab)}
                              disabled={spendabilityBlocked}
                            >
                              <Text className={`text-[12px] font-pp-medium ${fullWithdrawalTripped && tab === '100%' ? 'text-danger' : spendabilityBlocked ? 'text-[#B8BBBF]' : 'text-[#4D4D4D]'}`}>
                                {tab}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    </View>
                    {/* Progress Bar */}
                    <View className="w-full h-[4px] rounded-card flex-row overflow-hidden">
                      {/* nw-keep(measured-or-inset): progress segment flex is a computed spendable/total ratio */}
                      <View className="h-[4px] bg-primary-soft" style={{ flex: totalNum > 0 ? Math.round((spendableNum / totalNum) * 100) : 100 }} />
                      {/* nw-keep(measured-or-inset): progress segment flex is a computed pending/total ratio */}
                      <View className="h-[4px] bg-success" style={{ flex: totalNum > 0 ? Math.round((pendingNum / totalNum) * 100) : 0 }} />
                    </View>
                    {/* Accrued yield callout (A3) — balance auto-includes it. */}
                    {/* Balance / Pending info. Balance = total spendable (all
                        notes, matching the home screen); Available above = the
                        current route's per-transaction cap (#214). */}
                    <View className="flex-row justify-between">
                      <Text className="text-[12px] text-[#4D4D4D] font-pp-regular">
                        Balance: {spendabilityBlocked ? '—' : spendableLabel(formatUnits(currentBalance.active, selectedTokenDecimals), selectedToken, chainId)}
                      </Text>
                      <Text className="text-[12px] text-[#999999] font-pp-regular">
                        Pending: {spendabilityBlocked ? '—' : balanceDisplay(formatUnits(currentBalance.pending, selectedTokenDecimals), selectedToken, chainId).text}
                      </Text>
                    </View>
                    {spendabilityError ? (
                      <View className="flex-row items-center justify-between gap-[8px]">
                        <Text className="flex-1 text-[12px] text-danger font-pp-regular">
                          Couldn&apos;t verify which notes are withdrawable.
                        </Text>
                        <Pressable onPress={retryAssociationSetLeaves}>
                          <Text className="text-[12px] underline text-text font-pp-medium">Retry</Text>
                        </Pressable>
                      </View>
                    ) : null}
                    {spendableNum - displayAvailableNum > 1e-9 ? (
                      <Text className="text-[12px] text-[#999999] font-pp-regular">
                        {isSui
                          ? 'One deposit per withdrawal. Withdraw again for the rest.'
                          : isSwapExit
                            ? `One deposit (up to ${WITHDRAW_MAX_INPUTS} notes) per withdraw + swap. Repeat for the rest.`
                            : `Up to ${WITHDRAW_MAX_INPUTS} notes per withdrawal proof. Withdraw again for the rest.`}
                      </Text>
                    ) : null}
                  </View>
                  )}
                  {/* Quick-amount presets — INLINE mode's presets moved into
                      the hub card header (2026-08-18 layout), so this row is
                      full-modal only. */}
                  {!inlineHubActive && (
                  <View className="flex-row flex-wrap gap-[8px] mt-[10px] items-center">
                    {(usesNativeWithdrawPresets(selectedToken) ? QUICK_AMOUNTS_NATIVE : QUICK_AMOUNTS_STABLE).map((preset) => {
                      const active = isShareSymbol(selectedToken) ? amountField.value === preset : amount === preset;
                      const outOfReach = !spendabilityBlocked && (amountField.presetExceedsMax(preset)
                        ?? presetExceedsWithdrawMax(preset, getWithdrawMaxWei(selectedToken), selectedTokenDecimals));
                      return (
                        <Pressable
                          key={preset}
                          // nw-keep(data-color): active chip fill is a runtime tint token at 22 (~13%) alpha — no static class value;
                          // minWidth is runtime so 1- and 3-digit chips render the same box
                          style={[{ minWidth: 50 }, active ? { backgroundColor: `${colors.tint}22` } : null]}
                          className={`items-center px-[12px] py-[6px] rounded-[8px] border ${active ? 'border-tint' : 'border-border-light'} ${active ? '' : 'bg-transparent'} ${outOfReach ? 'opacity-40' : ''}`}
                          accessibilityState={{ disabled: outOfReach || spendabilityBlocked }}
                          onPress={() => applyPresetAmount(preset)}
                          disabled={spendabilityBlocked}
                        >
                          <Text className={`text-[13px] font-pp-regular ${active ? 'text-tint' : 'text-text'}`}>
                            {isShareSymbol(selectedToken) ? `${formatQuickAmount(preset)} ${amountField.symbol}` : formatQuickAmount(preset)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  )}
                  {/* Receive side as the OUT card (Uniswap pair, same design
                      as the Shield tab): the hub's amount card above is what
                      leaves the pool, this card is what lands in the wallet,
                      and the arrow chip straddles the seam between the two.
                      Disabled with the reason when the route isn't live,
                      rather than disappearing. */}
                  {inlineHubActive && receiveAsVisible ? (() => {
                    // The coin, never the share (DEV-428); the hue follows the coin too.
                    const recvSymbol = displayTokenSymbol(isSwapExit && receiveAsset ? receiveAsset.symbol : shareUnderlyingSymbol);
                    const recvHue = TokenHues[colorScheme][recvSymbol] ?? TokenHues[colorScheme].ETH;
                    return (
                      <>
                        {/* Bridges the hub gap (12) above and the inline gap
                            (16) below to the same ~6px seam as the Shield pair. */}
                        {/* nw-keep(data-color): arrow glyph color is a runtime theme token (vector-icon sink) */}
                        <PairArrow color={colors.text} icon="globe-outline" marginBottom={-24} />
                        <View className={`w-full rounded-inner bg-background-secondary ${tight ? 'gap-[6px] px-[16px] py-[12px]' : 'gap-[10px] p-[16px]'}`}>
                          <View className="flex-row flex-wrap items-center justify-end gap-[8px]">
                            <Text className="font-pp-sans-medium text-[12px] text-text-muted">Receive publicly on {receiveChainName} as</Text>
                          </View>
                          <View className="flex-row items-center justify-between gap-[8px]">
                            {/* What lands in the wallet: net of fees for a
                                plain exit; a swap exit shows a live LiFi
                                estimate ("~", not binding), a dash only while
                                it loads or when no route answers. */}
                            <Text className={`min-w-0 flex-1 py-[2px] font-pp-sans-bold ${tight ? 'text-[26px] leading-[32px]' : 'text-[44px] leading-[52px]'} tracking-[-1px] text-text-muted`} numberOfLines={1} testID="withdraw-receive-figure">
                              {enteredAmount > 0
                                ? (isSwapExit
                                  ? (swapExitEstimateText ?? '—')
                                  : (previewNet == null ? '—' : previewNet.toLocaleString('en-US', { maximumFractionDigits: 6 })))
                                : '0'}
                            </Text>
                            <Pressable
                              onPress={() => { if (receiveAsAvailable) setReceiveSelectorOpen(true); }}
                              disabled={!receiveAsAvailable}
                              accessibilityRole="button"
                              accessibilityState={{ disabled: !receiveAsAvailable }}
                              testID="withdraw-receive-as-chip"
                              className={`flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px] ${receiveAsAvailable ? '' : 'opacity-60'}`}
                              // nw-keep(data-color): pill border/bg follow the receive asset's runtime hue (same as the shield pool pill)
                              style={{ backgroundColor: recvHue.bg, borderColor: recvHue.fg }}
                            >
                              <TokenNetworkIcon symbol={recvSymbol} size={28} badgeSize={16} badgeTestnetLabel={false} chainId={receiveChainId} />
                              {/* nw-keep(data-color): label colour is the receive asset's runtime hue, same token as the pill border/bg above */}
                              <Text className="font-pp-sans-semi-bold text-[15px]" style={{ color: recvHue.fg }}>{recvSymbol}</Text>
                              <CaretDownIcon color={colors.text} />
                            </Pressable>
                          </View>
                          {isSwapExit && receiveAsset && crossChainReceive ? (
                            <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">
                              Exit to {receiveChainName}: {displayTokenSymbol(selectedToken)} → {displayTokenSymbol(receiveAsset.symbol)} bridged via LI.FI. The source transaction is atomic. Delivery on {receiveChainName} follows and can take a few minutes. If the far side cannot complete, LI.FI pays the same recipient address on {receiveChainName}.
                            </Text>
                          ) : isSwapExit && receiveAsset ? (
                            <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">
                              Swap on exit: {displayTokenSymbol(selectedToken)} → {displayTokenSymbol(receiveAsset.symbol)}, one atomic transaction via LI.FI. Rate locked at Review.
                            </Text>
                          ) : !receiveAsAvailable ? (
                            <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">
                              Receiving a different token needs the swap route, which isn&apos;t live on this network yet.
                            </Text>
                          ) : null}
                        </View>
                      </>
                    );
                  })() : null}
                  {/* Over the per-transaction cap is NOT the same as over your
                      balance, and saying "exceeds available balance" for both
                      contradicted the "Shielded balance" line right above: QA
                      reported 9 USDC shielded and "exceeds available balance
                      (5.0000 USDC)" on the same card. Both routes use the largest
                      notes across labels.
                      Both circuits take at most WITHDRAW_MAX_INPUTS, so when
                      the gross amount fits the balance but not one proof, name
                      that and offer a fee-aware cap. */}
                  {!isSui && !spendabilityBlocked && enteredAmount > 0 && grossLeavingWei > availableWei && !fullBalanceRequested ? (
                    grossLeavingWei <= currentBalance.active ? (
                      <View className="gap-[4px]">
                        <Text className="text-[12px] text-[#E53935] font-pp-regular">
                          {isSwapExit
                            ? `One withdraw + swap can spend ${spendableLabel(formatUnits(availableWei, selectedTokenDecimals), selectedToken, chainId)} (up to ${WITHDRAW_MAX_INPUTS} notes per proof). The rest of your ${spendableLabel(formatUnits(currentBalance.active, selectedTokenDecimals), selectedToken, chainId)} balance needs another transaction`
                            : `One withdrawal can spend ${spendableLabel(formatUnits(availableWei, selectedTokenDecimals), selectedToken, chainId)} (up to ${WITHDRAW_MAX_INPUTS} notes per proof). The rest of your ${spendableLabel(formatUnits(currentBalance.active, selectedTokenDecimals), selectedToken, chainId)} balance needs another transaction`}
                          {batchEnabled && !isSwapExit
                            ? ', or use 100% to withdraw everything.'
                            : singleProofMaxInputWei > 0n
                              ? `, so enter ${spendableLabel(formatUnits(singleProofMaxInputWei, tokenDecimalsForDisplay), selectedToken, chainId)} now and repeat for the rest.`
                              : '. The relayer fee currently consumes that one-proof cap.'}
                        </Text>
                        {singleProofMaxInputWei > 0n ? (
                          <Pressable onPress={() => applyShareAmount(formatUnits(singleProofMaxInputWei, tokenDecimalsForDisplay))}>
                            <Text className="text-[12px] underline text-text font-pp-medium">
                              {`Use ${spendableLabel(formatUnits(singleProofMaxInputWei, tokenDecimalsForDisplay), selectedToken, chainId)}`}
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : (
                      <Text className="text-[12px] text-[#E53935] font-pp-regular">
                        {`Amount exceeds your shielded balance (${spendableLabel(formatUnits(currentBalance.active, selectedTokenDecimals), selectedToken, chainId)})`}
                      </Text>
                    )
                  ) : null}
                  {isSui && !spendabilityLoading && suiAmountError ? (
                    <Text className="text-[12px] text-[#E53935] font-pp-regular">
                      {suiAmountError}
                    </Text>
                  ) : null}
                  {/* FullWithdrawalGuard: hard warning + ack at 100% selection. */}
                  {fullWithdrawalTripped && (
                    <FullWithdrawalGuard
                      acknowledged={guardState.acknowledged}
                      onAcknowledge={(value) => dispatchGuard({ type: 'ack', value })}
                      onEscape={handleFullWithdrawalEscape}
                    />
                  )}
                </View>

                {/* Receive as (spec C5): pool asset = plain withdrawal
                    (default); a different token composes a swap into the
                    exit via the real LiFi route, quoted at Review. Renders
                    ONLY when intent swaps are live for this chain. */}
                {receiveAsVisible && !inlineHubActive && (() => {
                  // The coin, never the share (DEV-428); the hue follows the coin too.
                  const recvSymbol = displayTokenSymbol(isSwapExit && receiveAsset ? receiveAsset.symbol : shareUnderlyingSymbol);
                  const recvHue = TokenHues[colorScheme][recvSymbol] ?? TokenHues[colorScheme].ETH;
                  return (
                    <View className="w-full gap-[6px]">
                      <View className="w-full flex-row flex-wrap items-center justify-between gap-[8px]">
                        <Text className="font-pp-sans text-[12px] text-text-secondary">Receive publicly on {receiveChainName} as</Text>
                        <Pressable
                          onPress={() => { if (receiveAsAvailable) setReceiveSelectorOpen(true); }}
                          disabled={!receiveAsAvailable}
                          accessibilityRole="button"
                          accessibilityState={{ disabled: !receiveAsAvailable }}
                          testID="withdraw-receive-as"
                          className={`flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px] ${receiveAsAvailable ? '' : 'opacity-60'}`}
                          // nw-keep(data-color): pill border/bg follow the receive asset's runtime hue
                          style={{ backgroundColor: recvHue.bg, borderColor: recvHue.fg }}
                        >
                          <TokenNetworkIcon symbol={recvSymbol} size={16} chainId={receiveChainId} />
                          {/* nw-keep(data-color): label colour is the receive asset's runtime hue */}
                          <Text className="font-pp-sans-semi-bold text-[12px]" style={{ color: recvHue.fg }}>{recvSymbol}</Text>
                          <CaretDownIcon color={colors.text} />
                        </Pressable>
                      </View>
                      {isSwapExit && receiveAsset && enteredAmount > 0 && swapExitEstimateText ? (
                        <Text className="font-pp-mono text-[12px] text-text-secondary" testID="withdraw-receive-estimate">
                          {swapExitEstimateText} {displayTokenSymbol(receiveAsset.symbol)} est.
                        </Text>
                      ) : null}
                      {isSwapExit && receiveAsset && crossChainReceive ? (
                        <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">
                          Exit to {receiveChainName}: {displayTokenSymbol(selectedToken)} → {displayTokenSymbol(receiveAsset.symbol)} bridged via LI.FI. The source transaction is atomic. Delivery on {receiveChainName} follows and can take a few minutes. If the far side cannot complete, LI.FI pays the same recipient address on {receiveChainName}.
                        </Text>
                      ) : isSwapExit && receiveAsset ? (
                        <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">
                          Swap on exit: {displayTokenSymbol(selectedToken)} → {displayTokenSymbol(receiveAsset.symbol)}, one atomic transaction via LI.FI. Rate locked at Review.
                        </Text>
                      ) : !receiveAsAvailable ? (
                        <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">
                          Receiving a different token needs the swap route, which isn&apos;t live on this network yet.
                        </Text>
                      ) : null}
                    </View>
                  );
                })()}

                {/* Target Address Input */}
                <View className="w-full gap-[4px]">
                  <View className={`w-full h-[40px] flex-row items-center rounded-control border px-[16px] py-[12px] gap-[12px] bg-card-background ${targetError ? 'border-[#E53935]' : 'border-border'}`}>
                    <TextInput
                      className={`text-[14px] flex-1 p-0 m-0 font-pp-regular ${targetInput ? 'text-text' : 'text-[#999999]'}`}
                      // nw-keep(platform-css): web-only outline reset + text cursor have no className path (empty on native)
                      style={[WEB_NO_OUTLINE, Platform.OS === 'web' ? { cursor: 'text' } as unknown as TextStyle : {}]}
                      value={targetInput}
                      placeholder={isStellar ? "Enter recipient Stellar address (G…)" : "Enter recipient 0x address"}
                      placeholderTextColor="#999999"
                      onChangeText={handleTargetInputChange}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                  {targetError ? (
                    <Text className="text-[12px] text-[#E53935] font-pp-regular">
                      {targetError}
                    </Text>
                  ) : null}
                  {!targetError && targetHelperText ? (
                    <Text className="text-[12px] text-[#737373] font-pp-regular">
                      {targetHelperText}
                    </Text>
                  ) : null}
                </View>

                {/* Gas Token Checkbox — not offered on the swap-exit route
                    (relayWithdrawAndSwap has no extra-gas option).

                    Honoured end to end since SDK v2.0 e75fdbec (#396): the flag
                    goes into prepareWithdraw / registerAndWithdraw below, the SDK
                    asks every relayer quote for the top-up and REFUSES a
                    commitment whose routing carries nativeGas 0 when it was
                    requested. Before that the SDK hardcoded extraGas:false and
                    a ticked box only inflated ppv2's review quote (QA I-b,
                    2026-09-02: 2.95 USDC shown, 1.44 charged, no ETH delivered),
                    which is why this sat disabled for a few hours (9aad341). */}
                {/* Offered for a share too: its exit goes through the PPRouter,
                    which requires the relayer to attach the committed nativeGas
                    as msg.value and forwards it to the recipient (PPRouter.sol
                    NativeGasMismatch + sendValue). Every prod pool is a share
                    pool, so without this nobody on prod could be funded for gas
                    on the way out. */}
                {supportsGasTokenOption && !isSwapExit && (
                  <Pressable
                    className="w-full flex-row items-center gap-[6px]"
                    onPress={handleGasTokenToggle}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: gasTokenChecked }}
                    testID="withdraw-gas-token"
                  >
                    <CheckboxIcon checked={gasTokenChecked} color={colors.textMuted} />
                    <Text className="text-[14px] text-text font-pp-medium">
                      Receive some Gas Token
                    </Text>
                    <ModalInfoIcon color="#4D4D4D" />
                  </Pressable>
                )}


                {/* DEV-229 net-vs-gross, ON THE FORM STEP (Mike, 2026-08-26:
                    "where did the send exact checkbox go"). The control existed
                    only on the review step, one screen after the amount it
                    governs, so nobody typing an amount ever saw it. Same
                    control stays on the form; review shows the resulting amounts.
                    A full-balance or one-proof-Max entry has nothing to
                    add a fee on top of, so it states the real semantics instead
                    of showing a checkbox whose state would lie. */}
                {!isSui && !isSwapExit && !batchPlan ? (
                  maxGrossIntent ? (
                    <Text className="text-[11px] text-[#737373] font-pp-regular">
                      {fullBalanceIntent ? 'Full balance' : 'One-transaction maximum'}: the relayer fee comes out of the withdrawn amount.
                    </Text>
                  ) : (
                    <View className="w-full gap-[3px]">
                      <View className="w-full flex-row items-center gap-[6px]">
                      <Pressable
                        className={`${tight ? 'shrink' : 'flex-1'} flex-row items-center gap-[6px]`}
                        onPress={handleReceiveExactToggle}
                        testID="withdraw-receive-exact"
                      >
                        <CheckboxIcon checked={receiveExact} color={colors.textMuted} />
                        <Text className={`${tight ? '' : 'flex-1 '}text-[14px] text-text font-pp-medium`}>
                          Recipient receives the exact amount
                        </Text>
                      </Pressable>
                        {/* Phone web: the fee line folds into a hint so the CTA stays above the fold.
                            A sibling of the checkbox, so a tap on it never toggles the setting. */}
                        {tight && (
                          <HoverHint hint={receiveExactExplanation} wrap testID="withdraw-receive-exact-hint">
                            {/* nw-keep(data-color): glyph colour is a runtime theme token (vector-icon sink) */}
                            <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} accessibilityLabel="About the relayer fee" />
                          </HoverHint>
                        )}
                      </View>
                      {!tight && <Text className="text-[11px] leading-[15px] text-text-secondary font-pp-regular">
                        {/* Name the ONE fee a withdrawal pays. The vetting fee
                            is charged by the Entrypoint on the way IN
                            (Entrypoint.sol applies vettingFeeBPS on deposit
                            only), so "fees" plural here read as if the exit
                            had its own protocol cut. */}
                        {receiveExactExplanation}
                      </Text>}
                    </View>
                  )
                ) : null}

                {/* The "Exit with a proof" explainer box lived here until QA
                    2026-08-17 — removed as noise alongside the Shield tab's
                    "Pending until approved" box. */}

                {/* Withdraw Button — inline: pinned to the zone bottom so
                    every tab's CTA sits at the same Y. */}
                {/* nw-keep(measured-or-inset): auto top margin is what pins every tab's CTA to the same Y in the hub zone */}
                <View className="w-full items-center" style={inlineHubActive ? { marginTop: 'auto', marginBottom: 3 } : undefined}>
                  <Pressable
                    className={inlineHubActive
                      ? `w-full items-center rounded-inner py-[16px] bg-button-primary ${withdrawCtaDisabled ? 'opacity-50' : 'active:bg-button-primary-pressed'}`
                      : `border rounded-control px-[20px] py-[10px] items-center justify-center border-[#B8BBBF] bg-card-background ${withdrawCtaDisabled ? 'opacity-50' : 'opacity-100'}`}
                    onPress={handleReviewWithdrawal}
                    accessibilityRole="button"
                    disabled={withdrawCtaDisabled}
                  >
                    <Text className={inlineHubActive ? 'font-pp-sans-semi-bold text-[16px] tracking-[0.1px] text-button-primary-text' : 'text-[14px] text-text font-pp-medium'}>
                      {(isQuoteLoading || isSwapQuoting) ? 'Fetching Quote...' : 'Withdraw'}
                    </Text>
                  </Pressable>
                </View>

                {/* DEV-367: the "Your anonymity set: 3381" line used to sit
                    here. Removed on Mike's call. It stated a privacy claim as a
                    hard number attached to the individual, which reads as a
                    guarantee and renders as a discouragingly small figure on a
                    fresh pool. The public "deposits in the crowd" stat covers
                    the pool as a whole on the page. */}

              </>
            )}

            {step === 'review' && inlineHubActive && (() => {
              /* Compact inline review — the activity-row idiom (icon well,
                 two lines, right-aligned figures) instead of the modal's tall
                 column, so the review fits the hub zone without growing it. */
              const hue = TokenHues[colorScheme][(swapSnapshot ? swapReviewInputSymbol : selectedToken).toUpperCase()] ?? TokenHues[colorScheme].ETH;
              const outSym = swapSnapshot ? swapSnapshot.outputToken.symbol : shareUnderlyingSymbol;
              const outHue = TokenHues[colorScheme][outSym.toUpperCase()] ?? TokenHues[colorScheme].ETH;
              const grossNum = swapSnapshot ? swapReviewGrossNum : reviewGross;
              const grossUsd = balanceDisplay(swapSnapshot ? formatUnits(swapSnapshot.grossWei, swapSnapshot.inputToken.decimals) : String(reviewGross), swapSnapshot ? swapReviewInputSymbol : selectedToken, swapSnapshot?.poolChainId ?? chainId).usd;
              const netLabel = swapSnapshot
                ? `~${balanceDisplay(swapSnapshot.display.estimatedOutput, outSym, swapSnapshot.destinationChainId).text}`
                : reviewNetLabel;
              const netUsd = swapSnapshot
                ? (parseFloat(swapSnapshot.display.estimatedOutput) || 0) * (priceMap[outSym] || 0)
                : reviewNetUsd;
              return (
              <>
                <View className="w-full rounded-inner bg-background-secondary px-[14px]">
                  {/* What leaves the pool */}
                  <View className="flex-row items-center gap-[10px] py-[11px]">
                    {/* nw-keep(data-color): icon-well bg + glyph are the runtime per-asset hue */}
                    <View className="h-[32px] w-[32px] items-center justify-center rounded-full" style={{ backgroundColor: hue.bg }}>
                      <Ionicons name="arrow-up-circle" size={16} color={hue.fg} />
                    </View>
                    <View className="flex-1 gap-[1px]">
                      <Text className="font-pp-sans-medium text-[13px] text-text" numberOfLines={1}>Unshielding</Text>
                      <Text className="font-pp-sans text-[11.5px] text-text-muted" numberOfLines={1}>
                        {poolName} · {balanceDisplay(batchPlan ? 0 : remainingAmount, selectedToken, chainId).text} left after
                      </Text>
                    </View>
                    <View className="items-end gap-[1px]">
                      <Text className="font-pp-mono text-[13px] text-text">{balanceDisplay(swapSnapshot ? formatUnits(swapSnapshot.grossWei, swapSnapshot.inputToken.decimals) : String(grossNum), swapSnapshot ? swapReviewInputSymbol : selectedToken, swapSnapshot?.poolChainId ?? chainId).text}</Text>
                      <Text className="font-pp-sans text-[11.5px] text-text-muted">${grossUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</Text>
                    </View>
                  </View>
                  <View className="h-[1px] self-stretch bg-border-light" />
                  {/* What the recipient gets */}
                  <View className="flex-row items-center gap-[10px] py-[11px]">
                    {/* nw-keep(data-color): icon-well bg + glyph are the runtime per-asset hue */}
                    <View className="h-[32px] w-[32px] items-center justify-center rounded-full" style={{ backgroundColor: outHue.bg }}>
                      <Ionicons name="arrow-down-circle" size={16} color={outHue.fg} />
                    </View>
                    <View className="flex-1 gap-[1px]">
                      <Text className="font-pp-sans-medium text-[13px] text-text" numberOfLines={1}>
                        {swapSnapshot ? 'Recipient gets (est.)' : 'You receive'}
                      </Text>
                      <Text className="font-pp-sans text-[11.5px] text-text-muted" numberOfLines={1}>
                        to {reviewRecipientDisplay}{reviewDestinationName ? ` on ${reviewDestinationName}` : ''}{reviewRecipientFull ? <CopyIconButton value={reviewRecipientFull} /> : null}
                      </Text>
                      {reviewDestinationName && (
                        <Text className="font-pp-sans text-[11.5px] text-text-muted">
                          Bridged via LI.FI. If the far side cannot complete, it pays this address on {reviewDestinationName}.
                        </Text>
                      )}
                    </View>
                    <View className="items-end gap-[1px]">
                      <Text className="font-pp-mono text-[13px] text-text">{netLabel}</Text>
                      {netUsd != null ? <Text className="font-pp-sans text-[11.5px] text-text-muted">${netUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</Text> : null}
                    </View>
                  </View>
                  <View className="h-[1px] self-stretch bg-border-light" />
                  {/* Fee · relayer · quote countdown, one quiet line. Stellar has
                      no relayer yet: the withdrawal is sent from this account. */}
                  {isStellar ? (
                    <Text className="py-[9px] font-pp-sans text-[11.5px] text-text-muted">
                      {`Relayer fee up to ${formatUnits(estimateStellarRelayFee(parseTokenAmount(amount, altDecimals)), altDecimals)} XLM (0.5% plus network cost), added on top; any unused part returns as change. Sent by the testnet relayer, not your account.`}
                    </Text>
                  ) : (
                  <View className="flex-row flex-wrap items-center justify-between gap-[6px] py-[9px]">
                    <Text className="font-pp-sans text-[11.5px] text-text-muted">
                      Relayer fee {swapSnapshot ? `${balanceDisplay(swapSnapshot.display.relayerFee, swapReviewInputSymbol, swapSnapshot.poolChainId).text}` : (batchPlan || isStellar) ? `${isStellar ? "\u2248 " : ""}${balanceDisplay(reviewFee, selectedToken, chainId).text}` : balanceDisplay(resolvedFee.text.split(' ')[0], resolvedFee.symbol, chainId).text} (~${balanceDisplay(swapSnapshot ? swapSnapshot.display.relayerFee : String(reviewFee), swapSnapshot ? swapReviewInputSymbol : (batchPlan || isStellar) ? selectedToken : resolvedFee.symbol, swapSnapshot?.poolChainId ?? chainId).usd.toFixed(2)})
                    </Text>
                    <View className="flex-row items-center gap-[10px]">
                      <Pressable className="flex-row items-center gap-[3px]" onPress={() => setRelayerSelectorOpen((v) => !v)}>
                        <Text className="font-pp-sans text-[11.5px] text-text-secondary">{selectedRelayer.name}</Text>
                        {/* nw-keep(data-color): caret color is a theme token into the vector-icon sink */}
                        <Ionicons name={relayerSelectorOpen ? 'chevron-up' : 'chevron-down'} size={11} color={colors.textSecondary} />
                      </Pressable>
                      {!isSui && (
                        <Text className="font-pp-sans-medium text-[11.5px] text-warning">Quote expires in {countdown}s</Text>
                      )}
                    </View>
                  </View>
                  )}
                  {withdrawFeeBreakdown && withdrawFeeBreakdown.level !== 'none' && (
                    <View className="pb-[9px]">
                      <FeeWarning breakdown={withdrawFeeBreakdown} testID="withdraw-fee-warning" />
                    </View>
                  )}
                  {gasTopUp && (
                    <Text className="pb-[9px] font-pp-sans text-[11.5px] text-text-muted" testID="withdraw-gas-top-up">
                      Includes {gasTopUp.amountText}{gasTopUp.usdText ? ` (~${gasTopUp.usdText})` : ''} sent to your wallet for gas
                    </Text>
                  )}
                  {coldStartClaim && (
                    <View className="flex-row items-start gap-[8px] rounded-[8px] border border-border-light bg-background-secondary px-[10px] py-[8px]">
                      {/* nw-keep(data-color): bolt glyph tint token (vector-icon color prop) */}
                      <Ionicons name="flash-outline" size={13} color={colors.tint} />
                      <Text className="flex-1 font-pp-sans text-[11px] leading-[16px] text-text-secondary">
                        {describeRelayedClaim((batchPlan || isStellar) ? `${isStellar ? "\u2248 " : ""}${balanceDisplay(reviewFee, selectedToken, chainId).text}` : balanceDisplay(resolvedFee.text.split(' ')[0], resolvedFee.symbol, chainId).text)}
                      </Text>
                    </View>
                  )}
                  {relayerSelectorOpen && (
                    <View className="mb-[10px] overflow-hidden rounded-[8px] border border-border-light bg-card-background">
                      {WITHDRAW_RELAYERS.map((r) => {
                        const isSel = r.id === selectedRelayerId;
                        return (
                          <Pressable
                            key={r.id}
                            disabled={!r.available}
                            onPress={() => {
                              if (!r.available) return;
                              setSelectedRelayerId(r.id);
                              setRelayerSelectorOpen(false);
                            }}
                            className={`flex-row items-center gap-[8px] px-[12px] py-[9px] ${r.available ? 'opacity-100' : 'opacity-50'} ${isSel ? 'bg-primary-soft' : 'bg-transparent'}`}
                          >
                            <Text className="flex-1 text-text font-pp-regular text-[12.5px]">{r.name}</Text>
                            {/* nw-keep(data-color): tint token into the vector-icon sink */}
                            {isSel && r.available ? <Ionicons name="checkmark" size={14} color={colors.tint} /> : null}
                            {!r.available ? <Text className="text-[#808080] font-pp-regular text-[11px]">soon</Text> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>

                {!swapSnapshot && sharePayoutDisclosure ? (
                  <Text className="text-center font-pp-sans text-[11.5px] leading-[16px] text-text-secondary">
                    {sharePayoutDisclosure}
                  </Text>
                ) : null}

                {/* Special-case withdrawal disclosures. */}
                {batchPlan ? (
                  <Text className="text-[11px] text-[#737373] font-pp-regular">
                    Full withdrawal: {batchPlan.groupCount} proofs, 1 transaction.
                  </Text>
                ) : swapSnapshot ? (
                  <Text className="text-[11px] text-[#737373] font-pp-regular">
                    Withdraw + swap. The relayer fee comes out of the entered amount before the swap.
                  </Text>
                ) : !isStellar && maxGrossIntent ? (
                  <Text className="text-[11px] text-[#737373] font-pp-regular">
                    {fullBalanceIntent ? 'Full balance' : 'One-transaction maximum'}: the relayer fee comes out of the withdrawn amount.
                  </Text>
                ) : null}

                {/* Back + Confirm, pinned like every tab's CTA. The pair is the
                    Send review's row (transfer-modal-provider), same sizing and
                    the same Back, so the two flows read as one product; only
                    Confirm keeps the primary fill because it moves money. */}
                {/* Same consuming-fee refusal as the non-inline review: the inline
                    Confirm used to stay live beside an impossible quote (codex on 8a2b5e6). */}
                {!swapSnapshot && feeRefusal ? (
                  <View className="gap-[4px] rounded-inner border border-danger bg-warning-bg px-[12px] py-[10px]">
                    <Text className="text-[12px] leading-[17px] text-danger font-pp-regular">
                      {feeRefusal}
                    </Text>
                  </View>
                ) : null}
                {/* nw-keep(measured-or-inset): same CTA pinning as the inline variant above */}
                <View className="w-full flex-row gap-[12px]" style={{ marginTop: 'auto', marginBottom: 3 }}>
                  <Pressable
                    className="flex-1 h-[44px] border rounded-control items-center justify-center border-[#B8BBBF] bg-card-background"
                    onPress={handleBackToInput}
                    accessibilityRole="button"
                    testID="withdraw-review-back"
                  >
                    <Text className="text-[14px] text-text font-pp-medium">
                      Back
                    </Text>
                  </Pressable>
                  <Pressable
                    className={`flex-1 h-[44px] rounded-control items-center justify-center bg-button-primary active:bg-button-primary-pressed ${!swapSnapshot && feeRefusal ? 'opacity-50' : ''}`}
                    onPress={handleConfirm}
                    disabled={!swapSnapshot && !!feeRefusal}
                    accessibilityRole="button"
                  >
                    <Text className="text-[14px] text-button-primary-text font-pp-medium">
                      Confirm Withdrawal
                    </Text>
                  </Pressable>
                </View>
              </>
              );
            })()}

            {step === 'review' && !inlineHubActive && (
              <>
                {/* Title */}
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Review the Withdrawal
                </Text>

                {/* Two-Column Summary */}
                <View className="w-full flex-row items-center justify-center border-b border-b-border-light pb-[16px] gap-[20px]">
                  {/* Left: Total Withdrawn */}
                  <View className="flex-1 items-center gap-[4px]">
                    <Text className="text-[14px] text-center text-text font-pp-regular">
                      Total Withdrawn
                    </Text>
                    <Text className="text-text">
                      <Text className="text-[20px] font-pp-regular">~</Text>
                      <Text className="text-[20px] font-pp-bold">
                        {swapSnapshot
                          ? `${balanceDisplay(formatUnits(swapSnapshot.grossWei, swapSnapshot.inputToken.decimals), swapReviewInputSymbol, swapSnapshot.poolChainId).text}`
                          : balanceDisplay(reviewGross, selectedToken, chainId).text}
                      </Text>
                    </Text>
                    <Text className="text-[14px] text-text font-pp-regular">
                      ${(balanceDisplay(swapSnapshot ? formatUnits(swapSnapshot.grossWei, swapSnapshot.inputToken.decimals) : String(reviewGross), swapSnapshot ? swapReviewInputSymbol : selectedToken, swapSnapshot?.poolChainId ?? chainId).usd).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </Text>
                  </View>
                  {/* Vertical Divider */}
                  <View className="w-[1px] self-stretch bg-border-light" />
                  {/* Right: Total Received (net to recipient). Swap exit:
                      the recipient gets the OUTPUT token. Show LiFi's
                      estimate with an honest "(est.)" label. */}
                  <View className="flex-1 items-center gap-[4px]">
                    <Text className="text-[14px] text-center text-text font-pp-regular">
                      {swapSnapshot ? 'Recipient Gets (est.)' : 'Total Received'}
                    </Text>
                    {swapSnapshot ? (
                      <Text className="text-text">
                        <Text className="text-[20px] font-pp-regular">~</Text>
                        <Text className="text-[20px] font-pp-bold">
                          {balanceDisplay(swapSnapshot.display.estimatedOutput, swapSnapshot.outputToken.symbol, swapSnapshot.destinationChainId).text}
                        </Text>
                      </Text>
                    ) : (
                      <Text className="text-[20px] text-text font-pp-bold">
                        {reviewNetLabel}
                      </Text>
                    )}
                    {(() => {
                      const usd = swapSnapshot
                        ? (parseFloat(swapSnapshot.display.estimatedOutput) || 0) * (priceMap[swapSnapshot.outputToken.symbol] || 0)
                        : reviewNetUsd;
                      return usd != null ? (
                        <Text className="text-[14px] text-text font-pp-regular">
                          ${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                        </Text>
                      ) : null;
                    })()}
                  </View>
                </View>

                {!swapSnapshot && sharePayoutDisclosure ? (
                  <Text className="text-center text-[12px] leading-[17px] text-text-secondary font-pp-regular">
                    {sharePayoutDisclosure}
                  </Text>
                ) : null}

                {/* Special-case withdrawal disclosures. */}
                {batchPlan ? (
                  <Text className="text-[11px] text-[#737373] font-pp-regular">
                    Full withdrawal: {batchPlan.groupCount} proofs, 1 transaction.
                  </Text>
                ) : swapSnapshot ? (
                  <Text className="text-[11px] text-[#737373] font-pp-regular">
                    Withdraw + swap. The relayer fee comes out of the entered amount before the swap.
                  </Text>
                ) : !isStellar && maxGrossIntent ? (
                  <Text className="text-[11px] text-[#737373] font-pp-regular">
                    {fullBalanceIntent ? 'Full balance' : 'One-transaction maximum'}: the relayer fee comes out of the withdrawn amount.
                  </Text>
                ) : null}

                {/* Transaction Details */}
                <View className="w-full">
                  <Text className="text-[16px] leading-[24px]">
                    <Text className="text-[16px] text-[#737373] font-pp-bold">To: </Text>
                    <Text className="text-[14px] text-[#808080] font-pp-regular">
                      {reviewRecipientDisplay}{reviewDestinationName ? ` on ${reviewDestinationName}` : ''}
                    </Text>
                    {reviewRecipientFull ? <CopyIconButton value={reviewRecipientFull} /> : null}
                  </Text>
                  {reviewDestinationName && (
                    <Text className="text-[12px] leading-[17px] text-[#808080] font-pp-regular">
                      Delivered on {reviewDestinationName} via LI.FI, after this chain&apos;s transaction confirms. If the far side cannot complete, it pays this address on {reviewDestinationName}.
                    </Text>
                  )}
                </View>

                {/* DEV-233: relayer selector (replaces the old static Fees Collector line) */}
                <View className="w-full z-[30]">
                  <View className="flex-row items-center flex-wrap">
                    <Text className="text-[16px] text-[#737373] font-pp-bold">Relayer: </Text>
                    <Pressable
                      className="flex-row items-center gap-[6px]"
                      onPress={() => setRelayerSelectorOpen((v) => !v)}
                    >
                      <Text className="text-[14px] text-[#808080] font-pp-regular">
                        {selectedRelayer.name}
                      </Text>
                      {relayerSelectorOpen ? <CaretUpIcon color={colors.text} /> : <CaretDownIcon color={colors.text} />}
                    </Pressable>
                  </View>
                  {relayerSelectorOpen && (
                    <View className="mt-[6px] border border-border-light rounded-[8px] overflow-hidden bg-card-background">
                      {WITHDRAW_RELAYERS.map((r) => {
                        const isSel = r.id === selectedRelayerId;
                        return (
                          <Pressable
                            key={r.id}
                            disabled={!r.available}
                            onPress={() => {
                              if (!r.available) return;
                              setSelectedRelayerId(r.id);
                              setRelayerSelectorOpen(false);
                            }}
                            className={`flex-row items-center gap-[8px] px-[12px] py-[10px] ${r.available ? 'opacity-100' : 'opacity-50'} ${isSel ? 'bg-primary-soft' : 'bg-transparent'}`}
                          >
                            <Text className="flex-1 text-text font-pp-regular text-[13px]">
                              {r.name}
                            </Text>
                            {/* nw-keep(data-color): tint token into the vector-icon sink */}
                            {isSel && r.available ? <Ionicons name="checkmark" size={14} color={colors.tint} /> : null}
                            {!r.available ? (
                              <Text className="text-[#808080] font-pp-regular text-[11px]">soon</Text>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>

                {/* Fees & Expiry */}
                {/* Fees & Expiry (EVM relayer quote only — Sui has no fee commitment) */}
                {!isSui && (
                  <View className="w-full">
                    <Text className="text-[16px] leading-[24px]">
                      <Text className="text-[16px] text-[#737373] font-pp-bold">Quote expires </Text>
                      <Text className="text-[16px] text-[#F4B740] font-pp-bold">in {countdown}s</Text>
                    </Text>
                  </View>
                )}

                {/* Cost Breakdown Box */}
                <View className="w-full border border-border-light p-[16px] gap-[8px] bg-card-background">
                  {/* Relayer-fee header row. Swap exit: every figure comes from
                      the validated quote snapshot (services/intent-swaps
                      shaping), never live form state. */}
                  <View className="flex-row items-center justify-between">
                    <Text className="text-[16px] leading-[19.2px] flex-1 text-text font-pp-bold">
                      {/* The fee's OWN asset and decimals (services/relayer-fee.ts),
                          not the withdrawn token's. When they differ the symbol
                          says so instead of relabelling one asset as another. */}
                      Relayer fee: {swapSnapshot ? `${balanceDisplay(swapSnapshot.display.relayerFee, swapReviewInputSymbol, swapSnapshot.poolChainId).text}` : (batchPlan || isStellar) ? `${isStellar ? "\u2248 " : ""}${balanceDisplay(reviewFee, selectedToken, chainId).text}` : balanceDisplay(resolvedFee.text.split(' ')[0], resolvedFee.symbol, chainId).text} (~${balanceDisplay(swapSnapshot ? swapSnapshot.display.relayerFee : String(reviewFee), swapSnapshot ? swapReviewInputSymbol : (batchPlan || isStellar) ? selectedToken : resolvedFee.symbol, swapSnapshot?.poolChainId ?? chainId).usd.toFixed(2)})
                    </Text>
                  </View>
                  <FeeWarning breakdown={withdrawFeeBreakdown} testID="withdraw-fee-warning" />
                  {coldStartClaim && (
                    <Text className="text-[13px] leading-[19px] text-[#737373] font-pp-regular">
                      {describeRelayedClaim((batchPlan || isStellar) ? `${isStellar ? "\u2248 " : ""}${balanceDisplay(reviewFee, selectedToken, chainId).text}` : balanceDisplay(resolvedFee.text.split(' ')[0], resolvedFee.symbol, chainId).text)}
                    </Text>
                  )}
                  {gasTopUp && (
                    <View className="flex-row items-center justify-between gap-[4px]">
                      <Text className="text-[13px] leading-[24px] text-[#737373] font-pp-regular">Gas sent to your wallet</Text>
                      <Text className="text-[13px] leading-[24px] text-right text-text font-pp-regular">
                        {gasTopUp.amountText}{gasTopUp.usdText ? ` (~${gasTopUp.usdText})` : ''}
                      </Text>
                    </View>
                  )}
                  {swapSnapshot && (
                    <>
                      <View className="flex-row items-center justify-between gap-[4px]">
                        <Text className="text-[13px] leading-[24px] text-[#737373] font-pp-regular">Swapped after fee</Text>
                        <Text className="text-[13px] leading-[24px] text-right text-text font-pp-regular">
                          {balanceDisplay(swapSnapshot.display.netSwapped, swapReviewInputSymbol, swapSnapshot.poolChainId).text}
                        </Text>
                      </View>
                      {!!swapSnapshot.display.rate && (
                        <View className="flex-row items-center justify-between gap-[4px]">
                          <Text className="text-[13px] leading-[24px] text-[#737373] font-pp-regular">Rate</Text>
                          <Text className="text-[13px] leading-[24px] text-right text-text font-pp-regular">
                            1 {balanceDisplay('1', swapReviewInputSymbol, swapSnapshot.poolChainId).symbol} ≈ {Number(swapSnapshot.display.rate) * balanceDisplay('1', swapSnapshot.outputToken.symbol, swapSnapshot.destinationChainId).amount / balanceDisplay('1', swapReviewInputSymbol, swapSnapshot.poolChainId).amount} {balanceDisplay('1', swapSnapshot.outputToken.symbol, swapSnapshot.destinationChainId).symbol}
                          </Text>
                        </View>
                      )}
                      <View className="flex-row items-center justify-between gap-[4px]">
                        <Text className="text-[13px] leading-[24px] text-[#737373] font-pp-regular">Min received</Text>
                        <Text className="text-[13px] leading-[24px] text-right text-text font-pp-bold">
                          {balanceDisplay(swapSnapshot.display.minReceived, swapSnapshot.outputToken.symbol, swapSnapshot.destinationChainId).text}
                        </Text>
                      </View>
                      <View className="flex-row items-center justify-between gap-[4px]">
                        <Text className="text-[13px] leading-[24px] text-[#737373] font-pp-regular">Max slippage</Text>
                        <Text className="text-[13px] leading-[24px] text-right text-text font-pp-regular">
                          {(swapSnapshot.slippage * 100).toFixed(1)}%
                        </Text>
                      </View>
                      <Text className="text-[11px] leading-[16px] text-[#737373] font-pp-regular">
                        Route locked at quote and sealed in your proof. The relayer cannot alter route, amounts, or recipient (LI.FI {swapSnapshot.prepared.swapTarget.slice(0, 6)}…{swapSnapshot.prepared.swapTarget.slice(-4)}).
                      </Text>
                    </>
                  )}
                  {/* A signed "Accrued yield (Aave)" line belongs here, but only
                      once the yield-withdraw route sources it from the router
                      quote (amountOut − fee shares). Omitted until then rather
                      than fabricated (codex findings 1, 3). */}
                </View>

                {/* Remaining in Pool Account */}
                <View className="items-center gap-[4px]">
                  <Text className="text-[14px] text-center text-text">
                    <Text className="font-pp-regular">Remaining in Pool Account: </Text>
                    <Text className="font-pp-bold">{poolName}</Text>
                  </Text>
                  <Text className="text-[20px] text-text font-pp-regular">
                    {balanceDisplay(batchPlan ? 0 : remainingAmount, selectedToken, chainId).text}
                  </Text>
                </View>

                {/* A fee that eats the whole withdrawal is refused HERE, by
                    name, rather than drawn next to a working Confirm — which
                    is what the card did when the relayer quoted 499312 USDC
                    against 5 USDC (Artem, 2026-08-28). Swap exits carry their
                    own quoted fee and are judged by the swap snapshot. */}
                {!swapSnapshot && feeRefusal ? (
                  <View className="gap-[4px] rounded-inner border border-danger bg-warning-bg px-[12px] py-[10px]">
                    <Text className="text-[12px] leading-[17px] text-danger font-pp-regular">
                      {feeRefusal}
                    </Text>
                  </View>
                ) : null}

                {/* Back + Confirm, the Send review's row verbatim */}
                <View className="flex-row gap-[12px] w-full">
                  <Pressable
                    className="flex-1 h-[44px] border rounded-control items-center justify-center border-[#B8BBBF] bg-card-background"
                    onPress={handleBackToInput}
                    accessibilityRole="button"
                    testID="withdraw-review-back"
                  >
                    <Text className="text-[14px] text-text font-pp-medium">
                      Back
                    </Text>
                  </Pressable>
                  <Pressable
                    className={`flex-1 h-[44px] border rounded-control items-center justify-center border-[#B8BBBF] bg-card-background ${!swapSnapshot && feeRefusal ? 'opacity-50' : ''}`}
                    onPress={handleConfirm}
                    disabled={!swapSnapshot && !!feeRefusal}
                    accessibilityRole="button"
                  >
                    <Text className="text-[14px] text-text font-pp-medium">
                      Confirm
                    </Text>
                  </Pressable>
                </View>
              </>
            )}

            {step === 'loading' && (
              <>
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Processing Withdrawal
                </Text>

                {/* w-full: the stage rail below is width:100%, so the column
                    must not shrink-to-fit its own content. */}
                <View className="w-full items-center gap-[16px] py-[20px]">
                  {/* nw-keep(animated): spinner rotation rides an Animated interpolate (spinInterpolate) */}
                  <Animated.View style={{ transform: [{ rotate: spinInterpolate }] }}>
                    <SpinnerIcon color={colors.text} />
                  </Animated.View>
                  {/* The same horizontal rail the shield flow uses, so a
                      withdrawal reads like the rest of the app instead of as a
                      vertical checklist of its own (QA). The live message still
                      shows verbatim underneath, which is where the flow's own
                      wording ("Generating ZK proof", "Submitting via relayer")
                      lands. */}
                  {/* FlowProgress prints the live message under the rail
                      itself, so this must not repeat it (QA saw "Preparing
                      withdrawal proof..." twice). */}
                  <FlowProgress message={loadingMessage} />
                  {/* Batch progress bar: N proofs take minutes — show how far
                      along the batch is so the app never looks stuck. */}
                  {batchProgress ? (
                    <View className="w-full h-[6px] rounded-[3px] overflow-hidden bg-background-secondary">
                      {/* nw-keep(measured-or-inset): fill width is the computed batch-progress fraction */}
                      <View
                        className="h-full bg-tint"
                        style={{ width: `${Math.round(batchProgressFraction(batchProgress) * 100)}%` }}
                      />
                    </View>
                  ) : null}
                </View>

                <View className="items-center gap-[5px]">
                  <Text className="text-[24px] text-text font-pp-regular">
                    {swapSnapshot
                      ? `≥ ${balanceDisplay(swapSnapshot.display.minReceived, swapSnapshot.outputToken.symbol, swapSnapshot.destinationChainId).text}`
                      : reviewNetLabel}
                  </Text>
                  {!swapSnapshot && sharePayoutDisclosure ? (
                    <Text className="max-w-[340px] text-center text-[12px] leading-[17px] text-text-secondary font-pp-regular">
                      {sharePayoutDisclosure}
                    </Text>
                  ) : null}
                </View>

                {txHash && (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(explorerTxLink(txHash))}>
                    <Text className="text-[14px] text-[#3B82F6] underline font-pp-medium">
                      {viewOnExplorerLabel(explorerChainId, getChainConfig(explorerChainId)?.explorerUrl)}
                    </Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={getExplorerName(explorerChainId)} />
                  </View>
                )}
              </>
            )}

            {step === 'error' && withdrawPending && (
              <>
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Withdrawal pending
                </Text>
                <View className="w-full border rounded-control p-[12px] border-warning bg-warning-bg">
                  <Text className="text-[13px] leading-[19px] font-pp-medium text-warning">
                    {withdrawError}
                  </Text>
                </View>
                <PendingRelayNotice chainId={chainId} owner={connectedAddress} />
                <Pressable
                  className="border rounded-control px-[20px] py-[10px] items-center justify-center border-[#B8BBBF] bg-card-background"
                  onPress={() => {
                    reportWithdrawError(null);
                    setWithdrawPending(false);
                    // The notice keeps tracking it; this screen no longer waits.
                    stopHearingWithdrawSettleRef.current?.();
                    stopHearingWithdrawSettleRef.current = null;
                    setSwapSnapshot(null);
                    setBatchPlan(null);
                    setActiveFeeCommitment(null);
                    setReviewContext(null);
                    resetQuote();
                    submittedRef.current = false;
                    setStep('withdraw');
                  }}
                >
                  <Text className="text-[14px] text-text font-pp-medium">
                    Back
                  </Text>
                </Pressable>
              </>
            )}

            {step === 'error' && !withdrawPending && (
              <>
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Withdrawal Failed
                </Text>

                <View className="w-full border border-danger rounded-control px-[16px] py-[16px] gap-[6px] items-center bg-danger-bg">
                  <Text className="text-[16px] text-center font-pp-bold text-danger">
                    Something went wrong
                  </Text>
                  <Text className="text-[13px] leading-[20px] text-center font-pp-regular text-danger">
                    {withdrawError || 'An unexpected error occurred. Please try again.'}
                  </Text>
                </View>

                <Pressable
                  className="border rounded-control px-[20px] py-[10px] items-center justify-center border-[#B8BBBF] bg-card-background"
                  onPress={() => {
                    reportWithdrawError(null);
                    setSwapSnapshot(null);
                    setBatchPlan(null);
                    setActiveFeeCommitment(null);
                    setReviewContext(null);
                    resetQuote();
                    submittedRef.current = false;
                    setStep('withdraw');
                  }}
                >
                  <Text className="text-[14px] text-text font-pp-medium">
                    Try Again
                  </Text>
                </Pressable>
              </>
            )}

            {step === 'success' && (
              <>
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Withdrawal Successful
                </Text>

                <View className="items-center gap-[16px] py-[20px]">
                  <CheckCircleIcon color={colors.success} />
                  <Text className="text-[16px] text-center text-success font-pp-medium">
                    {swapSnapshot && swapSnapshot.destinationChainId !== swapSnapshot.poolChainId
                      ? 'Source transaction confirmed'
                      : 'Transaction confirmed'}
                  </Text>
                </View>

                <View className="items-center gap-[5px]">
                  <Text className="text-[24px] text-text font-pp-regular">
                    {swapSnapshot
                      ? `≥ ${balanceDisplay(swapSnapshot.display.minReceived, swapSnapshot.outputToken.symbol, swapSnapshot.destinationChainId).text}`
                      : successNetLabel}
                  </Text>
                  <Text className="text-[14px] text-[#737373] font-pp-regular">
                    {swapSnapshot
                      ? (swapSnapshot.destinationChainId !== swapSnapshot.poolChainId
                        ? `withdrawn from ${displayTokenSymbol(swapReviewInputSymbol)} Pool, bridging to ${displayTokenSymbol(swapSnapshot.outputToken.symbol)} on ${reviewDestinationName ?? receiveChainName}`
                        : `withdrawn from ${displayTokenSymbol(swapReviewInputSymbol)} Pool, swapped to ${displayTokenSymbol(swapSnapshot.outputToken.symbol)} on exit`)
                      : `withdrawn from ${poolName}`}
                  </Text>
                  {yieldRedemption ? (
                    <Text className="max-w-[340px] text-center text-[12px] leading-[17px] text-text-secondary font-pp-regular" testID="withdraw-success-redemption">
                      Redeemed through the router: the recipient receives {describeRedemption({ quotedOut: yieldRedemption.quotedOut, minOut: yieldRedemption.minOut, decimals: yieldRedemption.underlyingDecimals, symbol: yieldRedemption.underlyingSymbol })}.
                    </Text>
                  ) : !swapSnapshot && sharePayoutDisclosure ? (
                    <Text className="max-w-[340px] text-center text-[12px] leading-[17px] text-text-secondary font-pp-regular">
                      {sharePayoutDisclosure}
                    </Text>
                  ) : null}
                  {gasTopUp && (
                    <Text className="text-[13px] text-text-secondary font-pp-sans" testID="withdraw-success-gas-top-up">
                      + {gasTopUp.amountText} for gas
                    </Text>
                  )}
                  {/* The far leg is not part of the transaction above: saying
                      nothing here would read as delivered when it is still in
                      flight, and the explorer link only ever shows the source. */}
                  {swapSnapshot && swapSnapshot.destinationChainId !== swapSnapshot.poolChainId && (
                    <Text className="max-w-[320px] text-center text-[12px] leading-[17px] text-text-secondary font-pp-sans">
                      Delivery on {reviewDestinationName ?? receiveChainName} follows this transaction and can take a few minutes. Nothing else is needed from you.
                    </Text>
                  )}
                </View>

                {txHash && (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(explorerTxLink(txHash))}>
                    <Text className="text-[14px] text-[#3B82F6] underline font-pp-medium">
                      {viewOnExplorerLabel(explorerChainId, getChainConfig(explorerChainId)?.explorerUrl)}
                    </Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={getExplorerName(explorerChainId)} />
                  </View>
                )}

                <Pressable
                  className="border rounded-control px-[20px] py-[10px] items-center justify-center border-[#B8BBBF] bg-card-background"
                  onPress={closeWithdrawModal}
                >
                  <Text className="text-[14px] text-text font-pp-medium">
                    Done
                  </Text>
                </Pressable>
              </>
            )}

        </OpShell>
      )}

      {/* "Receive as" picker — the SAME sheet the Shield tab uses to pick an
          asset (search, wallet balances, USD), so the two pickers in one flow
          don't look like two different products. Its route chips are suppressed:
          they describe how an asset gets INTO the pool, which is the opposite
          direction from the one being chosen here. The network row lists the
          destinations this exit can actually reach: just the pool chain unless
          the pair can route, in which case picking one turns the exit into a
          cross-chain delivery. */}
      {isOpen && receiveSelectorOpen && (
        <TokenSelectSheet
          tokens={receiveTokens}
          networks={receiveDestinations.map((id) => ({
            id,
            name: id === chainId
              ? currentChainName
              : getChainConfig(id)?.displayName || `Chain ${id}`,
          }))}
          selectedAddress={isSwapExit && receiveAsset ? receiveAsset.address : selectedTokenAddress}
          activeNetworkId={receiveChainId}
          chainId={receiveChainId}
          isSui={isSui}
          // Any ERC-20 LiFi can route to is a valid payout, so a pasted
          // address is adoptable here (Mike, 2026-09-22). An address that
          // routes nowhere surfaces as "No route found", which is the honest
          // answer and already the copy for an unroutable pair.
          allowCustomSelection
          onSelectToken={(t) => {
            // A pasted token is not in the catalog list, so fall back to what
            // the sheet resolved on chain. Matching only against
            // `receiveTokens` used to drop it to `undefined`, which read as
            // "pool asset picked" and silently turned the swap exit the user
            // asked for back into a plain withdrawal.
            const token = receiveTokens.find((x) => x.address.toLowerCase() === t.address.toLowerCase())
              ?? (t.address.toLowerCase() === selectedTokenAddress.toLowerCase()
                ? undefined
                : { symbol: t.symbol, address: t.address as `0x${string}`, decimals: t.decimals, isNative: !!t.isNative });
            // A "Receive as" change redefines the whole quote (codex P1):
            // invalidate EVERY in-flight request (the shared guard covers
            // plain, batch AND swap — mode + output token are in the key)
            // and clear every reviewed figure, so a pending plain/batch
            // response can never enter Review as a swap (or vice versa).
            invalidateQuoteRequests();
            setSwapSnapshot(null);
            setActiveFeeCommitment(null);
            setBatchPlan(null);
            setReviewContext(null);
            // Cross-chain makes ANY picked asset a swap exit: the native-asset
            // sentinel is the same address on every chain, so the address test
            // alone would clear receiveAsset and quietly turn an exit promised
            // on another network into a plain same-chain withdrawal.
            const enteringSwap = !!token
              && (crossChainReceive || isSwapExitSelection(token.address, selectedTokenAddress));
            if (enteringSwap && token) {
              setReceiveAsset(token);
              // A swap exit never uses the gas-token top-up.
              setGasTokenChecked(false);
            } else {
              // Pool asset picked → back to the plain withdrawal (default).
              setReceiveAsset(null);
            }
            // A selected percentage belongs to the route's cap, not to the raw
            // amount it happened to produce. Recompute against the DESTINATION
            // route explicitly: `availableWei` still belongs to the old route
            // in this event handler's render.
            const percentTab = selectedTab ?? (maxSelected ? '100%' : null);
            if (percentTab) {
              applyEvmPercentForRoute(
                percentTab,
                enteringSwap,
                mixedLabelCapWei,
              );
            }
            // New selection → the full-withdrawal guard re-consents and any
            // in-flight review handler refuses to advance.
            bumpSelection();
            setReceiveSelectorOpen(false);
          }}
          onSelectNetwork={(id) => {
            // The sheet's "all networks" option is null. This picker is a
            // delivery target, not a filter, so there is nothing to widen to.
            if (id === null) return;
            if (id === receiveChainId) return;
            if (!receiveDestinations.includes(id)) return;
            // A destination change redefines the route as completely as an
            // asset change does, so it clears exactly the same state: the
            // token list belongs to the other chain now, and any in-flight or
            // reviewed quote describes a delivery that is no longer the one
            // being asked for.
            invalidateQuoteRequests();
            setSwapSnapshot(null);
            setActiveFeeCommitment(null);
            setBatchPlan(null);
            setReviewContext(null);
            setReceiveChainId(id);
            // Moving to another chain picks that chain's first accepted asset
            // with it. Leaving this null would leave isSwapExit false while the
            // card read "Receive on <other chain>", and Review would then relay
            // a PLAIN same-chain withdrawal under that label. The user can
            // still change the asset in the same sheet.
            setReceiveAsset(id === chainId ? null : (getSwapDeliveryTokens(id)[0] ?? null));
            // Cross-chain leaves through the swap route, which has no
            // gas-token top-up and no batch semantics.
            if (id !== chainId) {
              setGasTokenChecked(false);
            }
            const percentTab = selectedTab ?? (maxSelected ? '100%' : null);
            if (percentTab) {
              const nextIsSwapExit = id !== chainId;
              applyEvmPercentForRoute(
                percentTab,
                nextIsSwapExit,
                mixedLabelCapWei,
              );
            }
            bumpSelection();
          }}
          onClose={() => setReceiveSelectorOpen(false)}
          title="Receive as"
        />
      )}
    </WithdrawModalContext.Provider>
  );
}
