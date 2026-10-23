import { useShareAmountField } from '@/hooks/use-share-amount-field';
// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
import { useBalanceDisplay } from '@/hooks/use-balance-display';
import { BalanceAmount } from '@/components/pools/balance-amount';
import { crossFlowsEnabled } from '@/config/intent-lockdown';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { usePools } from '@/components/pools-provider';
import { hubTokenCatalog, heldSymbolsFor, preferredHubToken, emptySpendToken } from '@/services/hub-token-catalog';
import { poolDisplayLabel } from '@/config/pool-paths';
import React, { createContext, useContext, useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { KeySourceChangedError } from '@/components/sdk-provider';
import { truncateAddress } from '@/services/hex-format';
import { isSessionInitTimeout } from '@/services/session-init-timeout';
import { tokenAmountLabel, displayTokenSymbol, isShareSymbol } from '@/services/share-display';
import { reportErrorReport } from '@/services/error-reports';
import { classifyFailure } from '@/services/error-reports-cause';
import { stellarErrorReportStage, type ErrorReportStage } from '@/services/error-reports-failure';
import { TEST_MODE } from '@/config/env';
import { ProgressStages, progressStageIndex } from '@/components/ui/progress-stages';
import { CheckCircleIcon, CloseIcon, SpinnerIcon } from '@/components/ui/modal-icons';
import { DROPDOWN_SHADOW, WEB_FIXED_POSITION, WEB_BLUR_BACKDROP, WEB_NO_OUTLINE } from '@/components/ui/web-style-shims';
import { View, Text, Pressable, Platform, useWindowDimensions, TextInput, Animated, Easing, Linking, ScrollView } from 'react-native';
import type { TextStyle } from 'react-native';
import Svg, { Path, Circle, Rect } from 'react-native-svg';
import { useAccount, usePublicClient, useSendTransaction } from 'wagmi';
import { formatUnits, isAddress, parseUnits } from 'viem';
import type { Hex } from 'viem';
import { NoteStatus } from '@/services/sdk-types';
import { netAfterReserve, splitRelayFee } from '@/services/relay-fee-split';
import type { Note, Hash, Address as SdkAddress } from '@/services/sdk-types';
import { plainTransferRelayError, relayerTransferQuotes, relayTransferParams, relayWithReprove, requestTransferQuote, transferRelayExpectation, transferRelayFee, TRANSFER_QUOTE_EXPIRED_MESSAGE } from '@/services/relayed-transfer';
import { expectTransferRelay } from '@/services/transfer-relay-outputs';
import { feeWithinReviewed } from '@/services/relayer-fee-jitter';
import { recordSentTransfer } from '@/services/sent-transfers-store';
import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { recordOwnAction } from '@/services/own-actions-store';
import { recordWithdrawFee } from '@/services/withdraw-fees-store';
import { useRequireConnection } from '@/hooks/use-require-connection';
import { useTabCloseGuard } from '@/hooks/use-tab-close-guard';
import { LinkLeaveConfirm } from '@/components/ui/link-leave-confirm';
import { needsLeaveConfirm, receiptLeaveCopy, SUI_RECEIPT_LEAVE } from '@/services/link-leave-guard';
import { sanitizeAmountInput } from '@/services/token-amount';
import { dropSentAudits, recordSentAuditsVerified } from '@/services/audit-store';
import { transferPendingAuditKey } from '@/services/audit-store-core';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useToast } from '@/components/toast-provider';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
// WithdrawModalProvider is an ANCESTOR of this one (app/_layout.tsx), so the
// context is real here. That is why this is a plain hook and not the
// module-level channel services/swap-handoff.ts needs for the swap modal,
// which is mounted BELOW this provider and would read the no-op default.
import { useWithdrawModal } from '@/components/withdraw-modal-provider';
import { useTransfer } from '@/hooks/use-transfer';
import { useNotes } from '@/hooks/use-notes';
import { useDebug } from '@/components/debug-provider';
import { useTxActivity } from '@/components/tx-activity-provider';
import { getExplorerName, getExplorerTxUrl, getChainConfig, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { describeStellarStage, stellarErrorMessage, stellarUnlockErrorTitle } from '@/services/stellar/stellar-copy';
import type { Note as StellarUiNote } from '@/services/sdk-types';
import { FlowProgress } from '@/components/ui/flow-progress';
import { fetchTransferFeeQuote } from '@/services/transfer-fee-quote';
import { SwapPairCard } from '@/components/ui/swap-pair-card';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useOpLock } from '@/hooks/use-op-lock';
import { getTokenMetadataBySymbol } from '@/config/tokens';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateTransactionCaches } from '@/services/cache';
import { useSuiSession } from '@/hooks/use-sui-session';
import { selectSuiNotes, maxSuiLineageTotal, SUI_SINGLE_NOTE_ERROR } from '@/services/sui-witness/note-selection';
import { IsDefaultPoolActive } from '@/config/pool-profile';
import {
  TRANSFER_MAX_INPUTS,
  TRANSFER_MAX_LABELS,
  formatTransferSpendabilityUnavailable,
  maxCoverableTransfer,
  selectGreedyTransferInputs,
  toTransferSpendabilityLog,
  verifyTransferSpendability,
} from '@/services/transfer-spendability';
import { ENS_UNSUPPORTED_MESSAGE, isPotentialEnsName, normalizeEnsName } from '@/services/ens';
import { CopyIconButton } from '@/components/ui/copy-address';
import { OpShell } from '@/components/op-shell';
import { ConsolidationShell } from '@/components/consolidation-shell';
import { ConsolidationAssetList } from '@/components/consolidation-asset-list';
import { ConsolidationPanel, ConsolidationSummary, ConsolidationGroupSummary } from '@/components/consolidation-panel';
import { useInlineOpsCapable } from '@/hooks/use-inline-ops-capable';
import { useTransferFeeEstimate } from '@/hooks/use-transfer-fee-estimate';
import { consolidationSelectionError, consolidationGroups, consolidationNet, planConsolidation, resolveForcedInputs, unavailableConsolidationCommitments } from '@/services/consolidate-notes';
import {
  getSwapOutputTokens,
  getSwapDeliveryTokens,
  intentSwapInputSupported,
  getSwapDestinationChains,
  type SwapTokenInfo,
  crossChainReshieldSupported,
  getSwapProcessorAddress,
  swapInputUnits,
} from '@/config/intent-swaps';
import { conversionDepositTarget, isConfiguredShareTarget } from '@/config/intent-targets';
import { sdkErrorText, type ErrorUnits } from '@/services/sdk-error-amounts';
import { isSwapSendSelection, sameAssetAddressesFor } from '@/services/intent-swaps';
import { getConfiguredYieldDeploymentForAsset } from '@/config/yield';
import { preferredReceiveAsset } from '@/services/receive-asset-pick';
import { isConfirmedRevert, isKnownRejection, isRelayerNullifierInFlight, isRelayerOutOfGas, isRelayerRateLimited, isRelayerRefusal, isRelayerUnreachable, isRelayWaitTimeout, relayerOutOfGasMessage, relayerRateLimitedMessage, relayInFlightMessage } from '@/services/transfer-outcome';
import { isPendingRelayBlocked, landedTxHash, PENDING_RELAY_TTL_MS } from '@/services/pending-relays-core';
import { onPendingRelaySettled, type PendingRelayResolution } from '@/services/pending-relays-store';
import { PendingRelayNotice } from '@/components/pending-relay-notice';
import { requestSwap, requestSwapTab, saveSwapSendDraft, takeSwapSendDraft, clearSwapSendDraft } from '@/services/swap-handoff';
import { useSwapPreview } from '@/hooks/use-swap-preview';
import { formatSwapExitEstimate } from '@/services/swap-exit-estimate';
import { resolveEffectiveReceiveExact } from '@/services/withdraw-quotes';
import { formatShortfallAmount } from '@/services/relayed-payment-shortfall';
import { capText, feeMovedUp, feeOverflowsCap, overCapReason, stableSendMax } from '@/services/send-amount-rules';
import { previewNoteReceiptUrl } from '@/services/note-receipt-preview';
import { TokenSelectSheet } from '@/components/ui/token-select-sheet';
import { TokenMark } from '@/components/ui/token-network-icon';
import { LEARN_MORE_UNREGISTERED_LABEL, UNREGISTERED_DEPOSIT_DOCS_URL } from '@/services/recipient-registration-hint';
import * as auditStore from '@/services/audit-store';
import type { SentNoteDisclosure } from '@/services/audit-receipt';
import { onRelayedTxHash, onRelayCalled } from '@/services/relayed-receipt';
import { RELAY_WAITING_BLOCK, RELAY_WAITING_RELAYER } from '@/services/relay-step-copy';
import { useBackHandler } from '@/hooks/use-back-handler';
import { useNativeMockBlock } from '@/hooks/use-native-mock-block';
import { useFeePricing } from '@/hooks/use-fee-pricing';
import { FeeWarning } from '@/components/fee-warning';
import { relayedSpendBreakdown } from '@/services/fee-warning';
import { SHIELDED_TRANSFER_GAS } from '@/services/transfer-fee-estimate';

// Web-only styles

const NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const TOKEN_DECIMALS: Record<string, number> = {
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 18,
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': 6,
  '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0': 6,
};

const TOKEN_SYMBOL_BY_ADDRESS: Record<string, string> = {
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 'ETH',
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': 'USDC',
  '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0': 'USDT',
};

function getTokenDecimals(tokenId: string): number {
  return TOKEN_DECIMALS[tokenId.toLowerCase()] ?? 18;
}

function getTokenSymbol(tokenId: string): string {
  return TOKEN_SYMBOL_BY_ADDRESS[tokenId.toLowerCase()] ?? 'ETH';
}



/**
 * What a third party can receive on `destinationChainId`: every plain asset a
 * wallet payout can deliver (Withdraw), plus, across chains the reshield
 * serves, the destination's yield shares, which reshield-and-transfer-
 * crosschain delivers as a private note. Shares are never a wallet payout.
 */
export function thirdPartyReceiveTokens(destinationChainId: number, sourceChainId: number): SwapTokenInfo[] {
  const delivery = getSwapDeliveryTokens(destinationChainId);
  if (destinationChainId === sourceChainId || !crossChainReshieldSupported(sourceChainId, destinationChainId)) return delivery;
  const seen = new Set(delivery.map((t) => t.address.toLowerCase()));
  const shares = getSwapOutputTokens(destinationChainId, sourceChainId)
    .filter((t) => isConfiguredShareTarget(t.address, destinationChainId) && !seen.has(t.address.toLowerCase()));
  return [...delivery, ...shares];
}

function truncateSecret(secret: string): string {
  if (secret.length < 20) return secret;
  return `${secret.slice(0, 10)}...${secret.slice(-8)}`;
}

// --- Icons ---




// === Staged progress feedback (proof generation takes many seconds) ==========
// The three real phases a transfer walks through, in order. NOT a timed
// animation: the stage is DERIVED from the flow's own status message
// (`loadingMessage`), which `handleConfirm` already sets at every real await
// boundary (sync → spendability → prepareTransfer → submit/relay → receipt).
// A stage therefore only reads as complete once the flow itself has posted a
// message belonging to a later phase, and any failure drops straight out of
// `step === 'loading'` so nothing keeps "progressing" behind an error.
const TRANSFER_STAGES = ['Preparing transfer', 'Generating ZK proof', 'Submitting via relayer'] as const;

/**
 * Phase index for a live status message. Prefix rules run BEFORE the
 * proof keyword on purpose: submit-phase messages can mention "proofs" and
 * prepare-phase messages can mention "proof". Unknown text falls back to the
 * first stage so the tracker can never over-claim progress.
 */

/**
 * Compact stage rail. The ACTIVE row renders the flow's live message verbatim
 * (so specifics like "proof 2 of 5" survive); the others render the canonical
 * phase name. Static — no animation, nothing for the visual-regression
 * harness (or a reduced-motion user) to see as nondeterministic.
 */





function CaretDownIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
      <Path d="M4 6L8 10L12 6" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function CaretUpIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
      <Path d="M4 10L8 6L12 10" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function SendIcon({ color = '#000000' }: { color?: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Path d="M4 10H16M16 10L11 5M16 10L11 15" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// --- Context ---

export type TransferPrefill = {
  recipient?: string;
  amount?: string;
  // Any registry symbol — the modal registry-validates per chain (cBTC etc).
  tokenSymbol?: string;
  /**
   * Invoked once the transfer is CONFIRMED, with what was ACTUALLY sent —
   * the user can edit token/amount/recipient (or the chain can move) while
   * the modal is open, so callers binding the callback to an external row
   * (payroll) must verify the details match before marking anything paid.
   */
  onSent?: (txHash: string, details?: { chainId: number; tokenSymbol: string; amount: string; recipient: string }) => void;
  /** Hub opener: draw inside the inline host instead of the overlay. */
  inline?: boolean;
  /**
   * Consolidation: spend exactly 2..5 notes of one token, with at least two
   * per deposit group. A fee-only transaction creates one owned note per group.
   * Refused when any selected input is no longer spendable.
   */
  inputCommitments?: string[];
  /** Consolidation picked from the asset list: the note picker offers Back to it. */
  fromAssetList?: boolean;
};

type TransferModalContextType = {
  openTransferModal: (prefill?: TransferPrefill) => void;
  closeTransferModal: () => void;
  /** Whether the modal is currently shown — consumed by the URL bridge. */
  isOpen: boolean;
  /** True while the flow draws inside the hub's inline host (no overlay). */
  inlineActive: boolean;
  isConsolidating: boolean;
  /** Consolidation's asset list, in the same modal as the note picker it opens. */
  openConsolidation: () => void;
  /** Inline mode: push the hub input's amount into the flow. */
  syncInlineAmount: (text: string) => void;
  /**
   * The asset the flow spends, and the hub's live push of its pool pill into
   * it. The pill used to reach the flow only on open or an explicit pick, so a
   * chain switch left the pill on BNB while the flow spent ppUSDT (DEV-469).
   */
  inlineToken: string;
  syncInlineToken: (symbol: string) => void;
  /**
   * Fee-aware max for the hub's tap-to-max (formatted, in the selected
   * token): the note-cap ceiling (5 inputs / 2 lineages), minus the relayer
   * fee when it applies — hidden-address sends pay the fee ON TOP of the
   * amount. Null on Sui (single-note semantics live in the flow itself).
   */
  maxSend: string | null;
  /** One-transfer cap for a token, connected account, current chain; null when unknown. */
  getTransferMaxWei: (tokenSymbol: string) => bigint | null;
  /**
   * The flow's step, so the hub can tell a settled send from a form in
   * progress (mirrors the withdraw provider's `inlineStep`). The hub clears
   * its amount on the success edge: the recipient is already cleared by the
   * reopen, and an amount left standing reads as a second send primed to go.
   */
  inlineStep: TransferStep;
  /**
   * The amount the flow is actually working with. The hub renders the visible
   * input inline, so it needs this to adopt an amount it never typed (a
   * payment link, an activity row, a deep link): otherwise its input reads 0
   * while the flow's "Recipient receives" card shows the real figure.
   */
  inlineAmount: string;
};

function missingProvider(): never {
  throw new Error('useTransferModal must be used within a TransferModalProvider');
}

const TransferModalContext = createContext<TransferModalContextType>({
  openTransferModal: missingProvider,
  closeTransferModal: missingProvider,
  isOpen: false,
  inlineActive: false,
  isConsolidating: false,
  openConsolidation: missingProvider,
  syncInlineAmount: () => {},
  inlineToken: '',
  syncInlineToken: () => {},
  maxSend: null,
  getTransferMaxWei: () => null,
  inlineStep: 'select-notes',
  inlineAmount: '',
});

export function useTransferModal() {
  return useContext(TransferModalContext);
}

// --- Steps ---

type TransferStep = 'choose-asset' | 'select-notes' | 'unregistered-confirm' | 'review' | 'loading' | 'success';

// --- Provider ---

function CheckboxSquare({ checked, color = '#737373' }: { checked: boolean; color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Rect x={1} y={1} width={14} height={14} rx={3} stroke={color} strokeWidth={1.4} fill={checked ? color : 'none'} />
      {checked && <Path d="M4.5 8L7 10.5L11.5 5.5" stroke="#FFFFFF" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />}
    </Svg>
  );
}

const RECIPIENT_CHECK_FAILED_MESSAGE =
  "Couldn't check whether this recipient can receive privately. Nothing was sent. Try again in a moment.";

/** One Send run's relay, written from callbacks (see handleConfirmUnlocked). */
type RelayRun = {
  hash: string | null;
  /** Resolves when this run's pending-relay record settles. */
  settled: Promise<PendingRelayResolution> | null;
  stopHearing: (() => void) | null;
  keepHearing: boolean;
  /** A different transaction spent this run's inputs (an earlier attempt). */
  otherSpendHash: string | null;
};

function createRelayRun(): RelayRun {
  return { hash: null, settled: null, stopHearing: null, keepHearing: false, otherSpendHash: null };
}

export function TransferModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const isDark = colorScheme === 'dark';
  const { width } = useWindowDimensions();
  const isMobile = width <= 540;
  // On a phone the modal presents as a bottom sheet.
  const isSheet = isMobile;
  // Modal-less presentation for hub-opened flows (see withdraw provider).
  const inlineCapable = useInlineOpsCapable();
  const [inlinePreferred, setInlinePreferred] = useState(false);
  const [consolidationContext, setConsolidationContext] = useState<{ chainId: number; owner: string; tokenId: string; fromAssetList?: boolean } | null>(null);
  const isConsolidating = consolidationContext !== null;
  const [consolidationQuotedFee, setConsolidationQuotedFee] = useState<bigint | null>(null);
  const [unavailableConsolidationInputs, setUnavailableConsolidationInputs] = useState<string[]>([]);
  const inlineBase = inlinePreferred && inlineCapable && !isConsolidating;
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
  const withOpLock = useOpLock();
  const queryClient = useQueryClient();
  // Sui/EVM branch follows the app-wide chain SELECTION (the single routing
  // truth) — ChainProvider auto-selects Sui when a Sui wallet connects, and
  // useSuiSession/usePrivacyPool read their deployment config from the same
  // selection, so display and submit can never disagree.
  const { isSui: isSuiChain, isStellar } = useChainRouter();
  // "Not an EVM chain": Sui and Stellar share the non-EVM branches (no relayer
  // fee, no swaps, one native asset); the note source and submit differ.
  const isSui = isSuiChain || isStellar;
  const activeEvmChainId = chainId;
  const suiSession = useSuiSession();
  const stellarSession = useStellarSession();
  // Freighter connected but the account not unlocked in this tab: the notes are
  // unknown, not empty. Ask to sign in instead of claiming there is no balance.
  const stellarLocked = stellarSession.wallet.isConnected && !stellarSession.unlocked && stellarSession.status !== 'unlocking';
  const altSymbol = isStellar ? 'XLM' : 'SUI';
  const altDecimals = isStellar ? 7 : 9;
  const chainConfig = getChainConfig(chainId);
  const chainDisplayName = isStellar ? 'Stellar Testnet' : isSui ? 'Sui Testnet' : (chainConfig?.displayName ?? `Chain ${chainId}`);
  const { address: walletAddress } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  // Relayed flow: an account-key session is enough — no wallet tx is posted.
  const ensureConnected = useRequireConnection({ allowAccountKey: true });
  // Key gate: actions that need the derived keys prompt for the one-time
  // signature on demand (the modal no longer auto-opens on connect). Read
  // through a ref so the onSigned continuation re-enters with fresh state.
  const { keysReady, sessionAddress, identityMode, isInitializing } = usePoolSession();
  // Owner identity for the flow: the SESSION identity (key wins over a
  // connected payer wallet; wallet when no key). Relayed flows never post
  // a wallet tx.
  /** Always-current identity. See receiptOwnerRef: the opener is a useCallback
   *  that deliberately does not depend on the address, so it must not read one
   *  captured at first render. */
  const currentIdentityRef = useRef<string | null>(null);
  const connectedAddress = (sessionAddress ?? walletAddress ?? undefined) as `0x${string}` | undefined;
  // The sending account as the review shows it, per chain.
  const fromAddress = isStellar
    ? (stellarSession.wallet.isConnected ? stellarSession.wallet.address ?? undefined : undefined)
    : isSui ? suiSession.account?.address : connectedAddress;
  // On Stellar the receipt belongs to the Freighter account that sent it.
  currentIdentityRef.current = isStellar ? fromAddress ?? null : connectedAddress?.toLowerCase() ?? null;
  // A swap-send draft belongs to the identity that made it: sign-out or an
  // account switch drops it (cubic, #219).
  const draftIdentity = currentIdentityRef.current;
  const draftIdentitySeenRef = useRef(draftIdentity);
  useEffect(() => {
    if (draftIdentitySeenRef.current === draftIdentity) return;
    draftIdentitySeenRef.current = draftIdentity;
    clearSwapSendDraft();
  }, [draftIdentity]);
  const keysReadyRef = useRef(keysReady);
  keysReadyRef.current = keysReady;
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const { openWithdrawModal } = useWithdrawModal();
  const publicClient = usePublicClient({ chainId });
  const { noteManager, keystoreManager, exportAccount, ensureInitialized, getCommittedManagers } = usePoolSession();
  const { transfer, prepareRelayed } = useTransfer();
  const { notes, refetch: refetchNotes, isLoading: isLoadingNotes } = useNotes();
  const { beginTx, endTx } = useTxActivity();

  const [step, setStep] = useState<TransferStep>('select-notes');
  // The asset list and the consolidation flow share one modal.
  const consolidationShell = isConsolidating || step === 'choose-asset';
  // Mobile keeps the sheet ONLY for progress/success (and the one-time
  // receipt that success carries); the form is inline like desktop.
  const inlineHubActive = inlineBase && !(isMobile && (step === 'loading' || step === 'success'));
  const [selectedNoteCommitments, setSelectedNoteCommitments] = useState<Hash[]>([]);
  // Consolidation: forced inputs from TransferPrefill.inputCommitments, and a
  // one-shot flag to seed the amount from their total once the fee is quoted.
  const [forcedInputs, setForcedInputs] = useState<string[] | null>(null);
  const [consolidateSeed, setConsolidateSeed] = useState<'total' | 'done'>('done');
  const [amount, setAmount] = useState('');
  // The figure the SUCCESS screen shows, latched when the send settles.
  // `amount` is the live form input and is released the moment the transfer
  // lands (see the settle effect below), so the receipt cannot read it: the
  // at-risk-receipt reopen returns straight to this screen without going
  // through openTransferModal, and would have rendered '0 ETH'.
  const [settledAmountFormatted, setSettledAmountFormatted] = useState('');
  // What the transfer ACTUALLY sent, set at submit time. In send-exact mode the
  // net is recomputed from the fee quote the relay uses, which can differ from
  // the one the form displayed (gas moves between them): a real run showed
  // 0.000412 on the form and 0.00035 sent. The success screen must state the
  // figure that left, not the older estimate.
  const [sentAmountWei, setSentAmountWei] = useState<bigint | null>(null);
  // The asset the sent amount is denominated in, LATCHED at submit: the live
  // selectedSymbol/selectedDecimals follow the pill (and the chain-snap effect),
  // so a chain switch mid-loading reformatted a latched USDC amount as ETH
  // (audit, 2026-08-29).
  const [sentUnits, setSentUnits] = useState<{ symbol: string; decimals: number } | null>(null);
  const [recipientInput, setRecipientInput] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [resolvedRecipientName, setResolvedRecipientName] = useState<string | null>(null);
  const [recipientEnsResolving, setRecipientEnsResolving] = useState(false);
  const [recipientEnsError, setRecipientEnsError] = useState<string | null>(null);
  // Updated by each input writer before React commits the next render, so an
  // ENS result cannot replace a newer address while effect cleanup is pending.
  const recipientInputRef = useRef('');
  const recipientAccountRef = useRef(connectedAddress?.toLowerCase());
  useLayoutEffect(() => {
    const previous = recipientAccountRef.current;
    recipientAccountRef.current = connectedAddress?.toLowerCase();
    if (previous === recipientAccountRef.current || !isOpen || step !== 'select-notes') return;
    // Re-enter the recipient for the new account before the form is painted.
    // Keeping the old account's self-send would turn it into a wallet payout.
    recipientInputRef.current = '';
    setRecipientInput('');
    setRecipientAddress('');
    setResolvedRecipientName(null);
    setRecipientEnsResolving(false);
    setRecipientEnsError(null);
  }, [connectedAddress, isOpen, step]);
  // DEV-237: default-anonymous. Unchecking submits the transfer directly from
  // the connected wallet (no relayer, no relayer fee), so the sender's wallet
  // address is the public on-chain msg.sender — a deliberate disclosure.
  // Every EVM send goes through the relayer (Pat, 2026-08-29). The "Hide my
  // wallet" checkbox that let a user opt into a self-submitted transfer (their
  // own wallet as the visible on-chain sender, DEV-237) is gone from the form;
  // the disclosed submission path below stays behind this constant until it
  // is deleted outright.
  const hideAddress: boolean = true;
  // DEV-229 parity with Withdraw: does the recipient get the EXACT typed amount
  // with the relayer fee added on top (default, and what Send has always done),
  // or is the typed amount the whole debit with the fee taken out of it?
  //
  // Fee-on-top cannot send a full balance by construction — amount + fee never
  // fits — so the form could only say "send at most 0.009463" and the user was
  // stuck (reported 2026-08-26). Unchecking this is the way to send everything.
  const [receiveExact, setReceiveExact] = useState(true);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const { toast: errorToast } = useToast();
  // Every flow error ALSO surfaces as a destructive toast — visible even
  // when the inline error line is below the fold or the modal is closing.
  // The token state is declared below this reporter and a ref reads across
  // that order without moving either.
  const diagnosticTokenRef = useRef('ETH');
  // The stage the running transfer last entered, for the failure report.
  const transferPhaseRef = useRef<ErrorReportStage>('unknown');
  const reportTransferError = useCallback((msg: string | null, cause?: unknown, stage?: string) => {
    setTransferError(msg);
    if (msg) errorToast({ title: msg, variant: 'destructive' });
    // The fact plus the failure CLASS, never the message. See the same block
    // in the withdraw provider. The values below ride in a separate bag that
    // only a staging build sends - services/error-reports.ts decides.
    if (msg) {
      reportErrorReport('transfer-failed', { testMode: TEST_MODE === true, ...classifyFailure(msg, cause) }, {
        ...(stage ? { stage } : {}),
        detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : msg,
        ...(connectedAddress ? { address: connectedAddress } : {}),
        ...(amount ? { amount } : {}),
        asset: diagnosticTokenRef.current,
        chainId,
      }, undefined, {
        stage,
        phase: transferPhaseRef.current,
        error: cause,
        // Sui and Stellar have their own chain and asset, which the EVM
        // selection here does not describe. Left out rather than wrong.
        chainId: isSui ? undefined : chainId,
        asset: isSui ? undefined : diagnosticTokenRef.current,
        isYield: isSui ? undefined : isShareSymbol(diagnosticTokenRef.current),
      });
    }
  }, [errorToast, connectedAddress, amount, chainId, isSui]);
  const [loadingMessage, setLoadingMessage] = useState('Preparing transfer...');
  // Set after a successful out-of-band transfer (recipient never
  // registered, no on-chain Note event) so the success step can show
  // the one-time import payload instead of leaving the recipient
  // stranded. JSON shape: { notes: [Note], syncCursor: '0x0' }.
  const [recipientImportPayload, setRecipientImportPayload] = useState<string | null>(null);
  const [recipientImportUrl, setRecipientImportUrl] = useState<string | null>(null);
  const [copiedPayload, setCopiedPayload] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  // Auto-copy the one-time receipt link once per URL when the success screen
  // shows it — the clipboard write can race a later URL rebuild, so track the
  // exact URL copied, not a boolean.
  const autoCopiedUrlRef = useRef<string | null>(null);
  // Pre-flight keystore lookup result, decided when the user clicks
  // Review Transfer. null = not yet checked, true = registered (use
  // discoverable path), false = unregistered (one-time receipt).
  const [recipientIsRegistered, setRecipientIsRegistered] = useState<boolean | null>(null);

  // One-time receipt lifecycle for the tab-close guard. Out-of-band transfers
  // (unregistered EVM recipient, every Sui transfer) mint a note whose secret
  // exists only in this tab:
  //   'none'    → no receipt at risk
  //   'at-risk' → set immediately before submitting a one-time-note transfer
  //               and kept through success, until the receipt is secured
  //   'secured' → the user successfully copied/shared the receipt
  // Explicit state — NOT inferred from URL presence — so the Sui path (which
  // only produces a raw JSON payload) and the mid-flight proving window are
  // both covered, and a copied receipt stops warning.
  const [receiptLifecycle, setReceiptLifecycle] = useState<'none' | 'at-risk' | 'secured'>('none');
  // Chain FROZEN at submission — explorer links/tracking must not follow a
  // later app-chain switch (codex round 3, P2).
  const [txChainId, setTxChainId] = useState<number | null>(null);

  // True after a submission whose outcome is UNKNOWN (timeout/RPC failure
  // after the broadcast started). While set, a retry is refused: a new
  // attempt would mint NEW recipient secrets and overwrite the shown
  // payload — if the first attempt actually mined, its secrets (the
  // recipient's only recovery path) would be destroyed (codex round 2, P0).
  const [indeterminateAttempt, setIndeterminateAttempt] = useState(false);
  // What the success screen SAYS, kept apart from the retry latch above
  // (DEV-412). Copying the receipt secures it and unlocks retries, which used
  // to flip the header to "Transfer Successful" with nothing verified. This
  // clears only when the spend is observed on-chain, or on a fresh open.
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  // A relayed send the relayer broadcast that has not been seen on-chain yet
  // (DEV-458). Pending, not failed: it flips to success, or to the earlier
  // attempt that spent the same notes, when the pending-relay record settles.
  const [relayPending, setRelayPending] = useState<null | 'pending' | 'other-spend'>(null);

  // Auto-copy the one-time receipt link when the success screen presents it —
  // a missed manual copy is the easiest way to lose the receipt. Deliberately
  // does NOT secure the lifecycle: the clipboard is volatile, so the close
  // guard stays armed until the user explicitly copies or shares.
  useEffect(() => {
    if (step !== 'success' || !recipientImportUrl) return;
    // Unknown outcome: don't auto-copy or toast — a cheerful "copied" reads
    // as success and the receipt may describe a transfer that never landed.
    // The warning banner points at the manual copy controls instead.
    if (indeterminateAttempt || outcomeUnknown) return;
    if (autoCopiedUrlRef.current === recipientImportUrl) return;
    if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.clipboard) return;
    autoCopiedUrlRef.current = recipientImportUrl;
    navigator.clipboard.writeText(recipientImportUrl)
      .then(() => { errorToast({ title: 'Receipt link copied to your clipboard.' }); })
      .catch(() => { /* focus/permission denied. The Copy Link button remains */ });
  }, [step, recipientImportUrl, indeterminateAttempt, outcomeUnknown, errorToast]);
  useEffect(() => {
    // Securing or clearing the receipt resolves the ambiguity — allow retries.
    if (receiptLifecycle !== 'at-risk') setIndeterminateAttempt(false);
  }, [receiptLifecycle]);
  const receiptLifecycleRef = useRef(receiptLifecycle);
  receiptLifecycleRef.current = receiptLifecycle;
  /**
   * Which identity the pending one-time receipt belongs to.
   *
   * An unsecured receipt is deliberately kept across closes: it is the only
   * copy of the recipient's note secret, so `closeTransferModal` refuses to
   * drop it and `openTransferModal` reopens straight onto it. Correct, but it
   * was identity-blind, so after signing into a DIFFERENT account in the same
   * browser the Send tab still opened on the previous account's receipt (QA
   * A-f, Matthew: "shows Transfer Successful as per previous transfer", and
   * pressing Done only bounced it back on the next open).
   *
   * The receipt is still never dropped - losing it strands the recipient. It
   * simply stops being auto-reopened for someone it does not belong to.
   */
  const receiptOwnerRef = useRef<string | null>(null);
  // Whether the pending receipt was stored on this device, which is what the
  // history row's "Copy payment link" rebuilds from (DEV-413). Decides how
  // hard the leave confirm warns (DEV-487).
  const receiptStoredRef = useRef(false);
  const [receiptLeaveOpen, setReceiptLeaveOpen] = useState(false);
  useTabCloseGuard(
    receiptLifecycle === 'at-risk',
    "This transfer's one-time receipt exists only in this tab. Closing now can permanently lose the recipient's funds. Copy the receipt first.",
  );

  const [recipientRegistrationCheck, setRecipientRegistrationCheck] = useState<{
    chainId: number;
    recipientAddress: string;
    registered: boolean;
  } | null>(null);
  const recipientCheckRef = useRef({ chainId, recipientAddress });
  const [keystoreCheckPending, setKeystoreCheckPending] = useState(false);
  // Asset selector — mirrors the deposit/withdraw modals so the user can
  // pick which token's notes they want to spend.
  const { data: sourcePools } = usePools();
  const sourceHoldings = useMemo(() => ({ symbols: heldSymbolsFor(sourcePools.myPools, activeEvmChainId), ready: sourcePools.holdingsReady }), [sourcePools.myPools, sourcePools.holdingsReady, activeEvmChainId]);
  const sourceTokens = useMemo(() => hubTokenCatalog('send', activeEvmChainId, sourceHoldings), [activeEvmChainId, sourceHoldings]);
  const defaultSourceSymbol = (preferredHubToken(sourceTokens, sourceHoldings) ?? emptySpendToken(activeEvmChainId))?.symbol;
  const [selectedToken, setSelectedToken] = useState<string>(defaultSourceSymbol ?? 'ETH');
  // Read by reportTransferError, which is defined above this state. Written in
  // an effect rather than during render, for the reason spelled out in the
  // withdraw provider: a discarded render must not relabel a real failure.
  useEffect(() => { diagnosticTokenRef.current = selectedToken; }, [selectedToken]);
  // Keep the selection meaningful for the ACTIVE chain: 'ETH' resolves to
  // nothing on Citrea (registry miss → native fallback), which would spend
  // cBTC under an ETH label. Snap to the chain's native symbol on switch.
  useEffect(() => {
    if (isSui) return;
    if (!sourceTokens.some((t) => t.symbol === selectedToken) || (sourceHoldings.ready && !sourceHoldings.symbols.has(selectedToken.toUpperCase()) && !!defaultSourceSymbol && sourceHoldings.symbols.has(defaultSourceSymbol.toUpperCase()))) {
      if (defaultSourceSymbol && selectedToken !== defaultSourceSymbol) setSelectedToken(defaultSourceSymbol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEvmChainId, isSui, selectedToken, sourceTokens, sourceHoldings, defaultSourceSymbol]);
  const [tokenDropdownOpen, setTokenDropdownOpen] = useState(false);
  // "Receive as" on Send — the recipient is paid in a DIFFERENT token via the
  // intent-swap route. null = the pool asset = the ordinary private note
  // transfer, which is every existing path below.
  //
  // This is a genuinely different transaction, not a variation: there is no
  // transfer+swap primitive in the SDK (prepareTransfer has no output-token
  // option and there is no relayTransferAndSwap), so paying someone in another
  // token means the withdraw-and-swap route with THEIR address as the
  // recipient. That exits the pool and pays them publicly. The copy below says
  // so plainly — presenting it as a private send would be a lie about privacy.
  const [receiveAsset, setReceiveAsset] = useState<SwapTokenInfo | null>(null);
  const [receiveSelectorOpen, setReceiveSelectorOpen] = useState(false);
  // Which chain the recipient is paid on. The pool chain is the ordinary send;
  // another chain rides the same swap route with a destination, so it is the
  // same exit-the-pool trade-off one hop further, and the copy says so.
  const [sendChainId, setSendChainId] = useState<number>(chainId);
  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isOpen || identityMode !== 'key' || keysReady || isInitializing) return;
    ensureInitialized().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      // The sign-in that CREATED this session bumps the derive epoch, so an
      // init started in that window is aborted by design. It is not something
      // to tell the user about: this effect re-runs when isInitializing flips
      // and the retry succeeds (Pat saw the toast on every key sign-in).
      if (err instanceof KeySourceChangedError) {
        log('debug', 'Transfer', `Account-key init superseded, retrying: ${message}`);
        return;
      }
      log('error', 'Transfer', `Account-key session initialization failed: ${message}`, err);
      reportTransferError(`Couldn't initialize the account-key session: ${message}`);
    });
  }, [isOpen, identityMode, keysReady, isInitializing, ensureInitialized, log]);

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
  // Optional callback fired with the txHash after a successful transfer (used
  // by Payroll to mark a salary line paid).
  const transferOnSentRef = useRef<((txHash: string, details?: { chainId: number; tokenSymbol: string; amount: string; recipient: string }) => void) | null>(null);
  // Operation epoch (codex P1-5): bumped on every open/close. A run that
  // outlived its modal session must ABORT before broadcasting (nothing sent,
  // no UI writes) — without this, closing mid-proof and opening a new
  // transfer let the old run broadcast into the new session's UI, and its
  // stale transferOnSentRef read could mark the WRONG payroll row paid.
  const opEpochRef = useRef(0);

  const selectedTokenId = useMemo(() => {
    // Chain-scoped: a transfer's tokenId must be THIS chain's contract —
    // the Sepolia addresses this map used to hardcode select nothing (or the
    // wrong notes) on the staging chains.
    return getTokenMetadataBySymbol(selectedToken, activeEvmChainId)?.address.toLowerCase()
      ?? NATIVE_ASSET_ADDRESS.toLowerCase();
  }, [selectedToken, activeEvmChainId]);
  // Sui notes never populate the EVM notes list — force SUI units/symbol
  // (MIST, 9 decimals). EVM decimals come from the SAME chain-scoped registry
  // lookup as selectedTokenId (kimi round-1 CRITICAL): the old address-keyed
  // Sepolia map fell back to 18 for mainnet/OP USDC/USDT, making every
  // stable amount 10^12x off and blocking those transfers outright.
  const selectedDecimals = isSui
    ? altDecimals
    : (getTokenMetadataBySymbol(selectedToken, activeEvmChainId)?.decimals
      ?? getTokenDecimals(selectedTokenId));
  const selectedSymbol = isSui ? altSymbol : selectedToken;
  // The note being sent, for sdkErrorText: a transfer's figures (fees, the
  // value the selected notes hold) are all in it. A ref, so the confirm
  // callback reads the current units without a new dependency.
  const errorUnitsRef = useRef<ErrorUnits>({});
  useEffect(() => {
    const note = { symbol: selectedSymbol, decimals: selectedDecimals };
    errorUnitsRef.current = {
      input: note,
      swapInput: isSui ? note : swapInputUnits(activeEvmChainId, selectedTokenId, note),
    };
  }, [selectedSymbol, selectedDecimals, selectedTokenId, activeEvmChainId, isSui]);
  /** A caught error as the user should read it: SDK figures in human units. */
  const shownError = useCallback((err: unknown) => sdkErrorText(err, errorUnitsRef.current), []);

  // --- "Receive as" (intent-swap send) ---
  //
  // Visibility is wider than availability on purpose (same reasoning as the
  // withdraw modal): a control that vanishes when the route isn't live reads as
  // a removed feature, so it renders disabled with the reason instead.
  const receiveAsVisible = !isSui;
  // The pool token's share/underlying pair: on this chain ppUSDC and USDC are
  // one asset, so "Recipient receives USDC" from a ppUSDC note is the plain
  // private transfer, not a swap-send (DEV-530).
  const sameAssetAddresses = useMemo(() => {
    const d = isSui ? undefined : getConfiguredYieldDeploymentForAsset(activeEvmChainId, selectedTokenId);
    return sameAssetAddressesFor(selectedTokenId, d);
  }, [isSui, activeEvmChainId, selectedTokenId]);
  const isSameAsset = useCallback(
    (address: string) => sameAssetAddresses.includes(address.toLowerCase()),
    [sameAssetAddresses],
  );
  const receiveAsAvailable = !isSui && crossFlowsEnabled() && intentSwapInputSupported(chainId, selectedTokenId);
  // Wallet payouts can reach every delivery chain. A self-send is checked
  // separately below, because not every destination supports a reshield.
  const sendDestinations = useMemo(
    () => (receiveAsAvailable
      ? getSwapDestinationChains(chainId)
      : [chainId]),
    [receiveAsAvailable, chainId],
  );
  const crossChainSend = receiveAsAvailable
    && sendChainId !== chainId
    && sendDestinations.includes(sendChainId);
  // Pool-chain switch drops the destination: it was a choice about the chain the
  // user was on, and the new chain's destination list can include the old one,
  // so carrying it over produces a payout target nobody picked (agy).
  const previousPoolChainRef = useRef<number | null>(null);
  useEffect(() => {
    const previous = previousPoolChainRef.current;
    previousPoolChainRef.current = chainId;
    if (previous === null || previous === chainId) return;
    setSendChainId(chainId);
    setReceiveAsset(null);
  }, [chainId]);
  const sendChainName = useMemo(
    () => (sendChainId === chainId
      ? chainDisplayName
      : getChainConfig(sendChainId)?.displayName || `Chain ${sendChainId}`),
    [sendChainId, chainId, chainDisplayName],
  );
  // Paying on another chain is always the swap route, even for the same asset:
  // the native-asset sentinel is the same address everywhere, so the address
  // test alone would call it an ordinary private send and quietly keep the
  // value on this chain.
  const isSwapSend = receiveAsAvailable
    && (crossChainSend
      ? !!receiveAsset
      : isSwapSendSelection(receiveAsset?.address, selectedTokenId, sameAssetAddresses));
  /**
   * Picker rows: the pool asset first (= ordinary private send), then outputs.
   *
   * WHICH LIST depends on where the value is going, because the two routes can
   * deliver different things and offering the wrong one produces a form that
   * validates and then refuses.
   *
   *   yourself  -> a reshield. The output has to be something a deposit can
   *                land in on that chain, which is `getSwapOutputTokens`.
   *   anyone    -> a wallet payout. Any asset that chain can deliver, which is
   *   else       the wider `getSwapDeliveryTokens` (configured outputs merged
   *                with the plain registry).
   *
   * Using the wide list for both offered plain USDT on BNB for a cross-chain
   * send to your OWN account. The route was available, the copy promised a new
   * shielded note, and both receivers then refused the token because it is
   * deliverable to a wallet and not a reshield target: "Couldn't open the
   * private swap route" on a form that had already said yes (2026-09-22).
   *
   * The source chain is passed so a cross-chain reshield is judged on what it
   * can actually hand over, not on what the destination serves same-chain.
   */
  const receiveTokens = useMemo<SwapTokenInfo[]>(() => {
    if (!receiveAsAvailable) return [];
    const toOwnAccount = !!connectedAddress
      && recipientAddress.trim().toLowerCase() === connectedAddress.toLowerCase();
    const outputs = toOwnAccount
      ? getSwapOutputTokens(sendChainId, chainId)
      : thirdPartyReceiveTokens(sendChainId, chainId);
    // Another chain has no "ordinary private send" row to fall back to: every
    // option there is a swap route.
    if (sendChainId !== chainId) return outputs;
    const pool = outputs.find((t) => t.address.toLowerCase() === selectedTokenId)
      ?? {
        symbol: selectedSymbol,
        address: selectedTokenId as `0x${string}`,
        decimals: selectedDecimals,
        isNative: selectedTokenId === NATIVE_ASSET_ADDRESS.toLowerCase(),
      };
    // The pool row stands for the asset; its share/underlying twin would be a
    // second "USDC" row that reads the same and routed as a swap (DEV-530).
    return [pool, ...outputs.filter((t) => !isSameAsset(t.address))];
  }, [receiveAsAvailable, sendChainId, chainId, selectedTokenId, selectedSymbol, selectedDecimals, connectedAddress, recipientAddress, isSameAsset]);
  // One place decides that a pick is no longer valid, because there are two
  // ways for that to happen and a second effect would be a second setState in
  // an effect for the same piece of state.
  //
  //   1. it became the INPUT asset. "Send ETH, receive USDC" would silently
  //      become "send USDC, receive USDC", a plain send, while the row still
  //      showed USDC as if a swap were happening. Same-chain only: across
  //      chains the same asset really is a legitimate move.
  //   2. it is no longer OFFERED. `receiveTokens` narrows when the recipient
  //      becomes your own account, because a self-send is a reshield and can
  //      only land where a deposit can reach, while paying a third party can
  //      deliver any asset. Picking USDT on BNB with the recipient still empty
  //      and then typing your own address left USDT selected and on screen
  //      while the list behind it had become [BNB, FDUSD]. The form promised a
  //      shielded note and the button refused, because the route genuinely
  //      cannot deliver that token (QA, 2026-09-22).
  //
  // Narrowing a list is not enough on its own: the selection has to be
  // revalidated against it, or a stale pick outlives the reason it was valid.
  // An EMPTY list means the swap route is unavailable here, not that nothing is
  // offered, so it clears nothing.
  //
  // Across chains a dropped pick is replaced, never left empty. Empty there is
  // not "no swap": there is no plain-send row on another chain, so the card kept
  // showing the input coin under the destination's badge while Review refused
  // with "Pick the asset…" instead of handing off to Swap (Pat, USDT to BNB,
  // 2026-09-25). The replacement keeps the coin when the new list has it (a
  // share reads as its underlying).
  //
  // Not on the commit where the pool chain changed: the reset effect above
  // clears the pick and the destination in that same commit, but this one still
  // sees the old destination and would re-fill the pick behind the reset
  // (cubic, #149). The next render has the reset state and runs normally.
  const pickPoolChainRef = useRef(chainId);
  useEffect(() => {
    if (pickPoolChainRef.current !== chainId) {
      pickPoolChainRef.current = chainId;
      return;
    }
    if (receiveTokens.length === 0) return;
    if (!receiveAsset) {
      if (crossChainSend) setReceiveAsset(preferredReceiveAsset(receiveTokens, [selectedSymbol]));
      return;
    }
    const address = receiveAsset.address.toLowerCase();
    const becameTheInput = !crossChainSend && isSameAsset(address);
    const noLongerOffered = !receiveTokens.some((t) => t.address.toLowerCase() === address);
    if (!becameTheInput && !noLongerOffered) return;
    setReceiveAsset(crossChainSend
      ? preferredReceiveAsset(receiveTokens, [receiveAsset.symbol, selectedSymbol])
      : null);
  }, [receiveAsset, isSameAsset, selectedSymbol, crossChainSend, receiveTokens, chainId]);

  /**
   * Hand a swap-send to the swap modal, pre-filled with the recipient and the
   * chosen output token.
   *
   * Deliberately a handoff and not a second implementation: the swap modal
   * already owns the reviewed money path (validated quote, fee-commitment
   * lifetime with a proving safety window, note selection, the app-side
   * re-validation before relaying). Duplicating that here to keep the user on
   * one screen would mean two copies of the code that decides what gets
   * relayed.
   */
  /**
   * Who the swap-send pays decides WHICH route it takes, and the two differ in
   * what they reveal. They are not interchangeable, so the choice is the
   * recipient's and the form says which one is in force.
   *
   *   yourself  -> a reshield. The output is a new note of your own and the
   *                value never leaves the pool. Same chain, or across for the
   *                pairs the SDK serves.
   *   anyone    -> a wallet payout. The note is spent and the swapped asset
   *   else       is delivered to that address on-chain, exactly as the Withdraw
   *                tab does it. The recipient and the amount are public, as
   *                they are for any withdrawal.
   *
   * The third combination, the swapped output arriving as a SHIELDED note for
   * someone else, is served since reshield-and-transfer (v2-monorepo #439, and
   * #472 for plain assets, in the SDK vendored here). It is the private route for
   * a third party, with two limits that decide it (`privateSwapSend` below): the
   * OUTPUT must be one a deposit can land in (a reshield target), and it is same
   * chain only.
   * Anything else to a third party stays the public payout, and the copy says
   * so rather than pretending otherwise.
   */
  const sendsToOwnAccount = !!connectedAddress && recipientAddress.trim().toLowerCase() === connectedAddress.toLowerCase();
  // Private when the output stays yours: a reshield (same chain, or across for
  // the pairs the SDK serves) on the Swap tab.
  const privateSwapRoute = isSwapSend && sendsToOwnAccount
    && (!crossChainSend || crossChainReshieldSupported(chainId, sendChainId));
  // Public when it pays someone else: the same route the Withdraw tab takes,
  // received as another asset. Needs a resolved recipient — an unresolved ENS
  // name has no address to pay yet.
  //
  // Paying SOMEONE ELSE has two routes and the OUTPUT decides which one, because
  // the private one can only deliver what a deposit can land in (reshield-and-
  // transfer, v2-monorepo #439: a configured yield share, same chain). Offering
  // it for anything else is the form that says yes and then refuses.
  const recipientResolved = isAddress(recipientAddress, { strict: false });
  //
  // The private route delivers what a deposit can land in on this chain, which is
  // exactly the reshield target list (a yield share OR a plain pool asset: the SDK
  // builds the recipient's deposit for both). The wider delivery list, which also
  // offers assets with no pool, stays the public Withdraw.
  //
  // The picker lists what can be PAID to a wallet (the plain coin), while this
  // route deposits into a pool. Where the chain wraps the picked asset in a
  // share (BSC USDT is withdraw-only, its pool is ppUSDT) the share is the note
  // the recipient gets, so that is what is compared and handed off. Comparing
  // the plain address sent every such pick to the public payout (Mike, DEV-509
  // QA on #219, 2026-10-06).
  //
  // Across chains (reshield-and-transfer-crosschain) the SDK only delivers a
  // configured yield SHARE on the destination, for the pairs the cross-chain
  // reshield serves. A plain output there (BNB, plain USDT) stays the public
  // payout. The swap flow checks the recipient is registered on that chain.
  const privateOutputChainId = crossChainSend ? sendChainId : chainId;
  // A plain coin the destination wraps in a share (USDC to ppUSDC) is delivered
  // as that share note, across chains as on the same chain. Reading the plain
  // pick as a wallet payout sent every cross-chain send to Withdraw, since the
  // picker shows the coin, not the share (Mike, #251 QA, 2026-10-12).
  const privateOutputAddress = receiveAsset
    ? conversionDepositTarget(receiveAsset.address, privateOutputChainId, !!receiveAsset.isNative).toLowerCase()
    : null;
  const privateSwapSend = isSwapSend && !sendsToOwnAccount && recipientResolved
    && !!privateOutputAddress
    && (!crossChainSend || (crossChainReshieldSupported(chainId, sendChainId)
      && isConfiguredShareTarget(privateOutputAddress, sendChainId)))
    && getSwapOutputTokens(privateOutputChainId, chainId).some((t) => t.address.toLowerCase() === privateOutputAddress);
  const publicSwapPayout = isSwapSend && !sendsToOwnAccount && recipientResolved && !privateSwapSend;
  const handoffSwapSend = useCallback(() => {
    if (!isSwapSend || !receiveAsset) return;
    const request = {
      tokenSymbol: selectedToken,
      initialAmount: amount,
      outputTokenAddress: receiveAsset.address,
      ...(crossChainSend ? { destinationChainId: sendChainId } : {}),
    };
    // Paying someone else goes to WITHDRAW, not to Swap.
    //
    // Receiving a different token at an address is a withdrawal received as
    // another asset, and Withdraw is the surface that owns that: it is named
    // for what happens, it already carries the recipient and the payout
    // disclosures, and it cannot be mistaken for the private route. Sending it
    // to Swap instead put a public payout on a screen whose other mode is a
    // private reshield, one toggle apart, and the difference is what ends up
    // published on chain (2026-09-22).
    //
    // A shielded output for someone else is not a thing this can offer: the
    // swap-deposit call names no deposit owner, so the note could only be the
    // caller's. That is why there is no third branch here.
    // Someone else, and an output the private route can deliver: the swap
    // flow runs reshield-and-transfer and the recipient gets a SHIELDED note.
    // It must be a registered account (the swap flow checks, and refuses before
    // anything is proved or spent), and it never falls back to a public payout.
    if (privateSwapSend) {
      if (requestSwap({
        ...request,
        ...(privateOutputAddress ? { outputTokenAddress: privateOutputAddress } : {}),
        recipient: recipientAddress,
        mode: 'reshield',
        // From the hub's Send tab, the swap-send runs in the same widget
        // instead of a separate modal (Mike, #219 QA).
        ...(inlineBase ? { inline: true } : {}),
      })) {
        if (inlineBase && currentIdentityRef.current) saveSwapSendDraft({ owner: currentIdentityRef.current, chainId, recipient: recipientInput.trim() || recipientAddress, sendChainId, receiveAsset });
        setIsOpen(false);
        return;
      }
      reportTransferError("Couldn't open the private swap route. Reload and try again.");
      return;
    }
    if (publicSwapPayout) {
      openWithdrawModal(undefined, {
        tokenSymbol: selectedToken,
        amount,
        receiveTokenAddress: receiveAsset.address,
        receiveChainId: sendChainId,
        targetAddress: recipientAddress,
      });
      setIsOpen(false);
      return;
    }
    // Paying yourself, but this pair has no private route across these chains.
    // Falling through to the public payout would quietly turn a private send
    // into an on-chain one, so it stops here instead.
    if (!privateSwapRoute) {
      reportTransferError(sendsToOwnAccount
        ? 'This swap route is not available on this network yet.'
        : 'Enter a valid recipient address.');
      return;
    }
    if (requestSwapTab(request)) {
      setIsOpen(false);
      return;
    }
    // No hub Swap tab here (pool page, native): the modal runs the same
    // private reshield, pinned. Never a public payout.
    if (requestSwap({ ...request, mode: 'reshield' })) {
      setIsOpen(false);
      return;
    }
    reportTransferError("Couldn't open the private swap route. Reload and try again.");
  }, [isSwapSend, receiveAsset, privateOutputAddress, privateSwapRoute, privateSwapSend, publicSwapPayout, recipientAddress, recipientInput, chainId, inlineBase, sendsToOwnAccount, selectedToken, amount, crossChainSend, sendChainId, reportTransferError, openWithdrawModal]);
  const recipientEnsName = useMemo(() => {
    // Sui recipients are raw addresses; there is no ENS on Sui.
    if (isSui) return null;
    const trimmed = recipientInput.trim();
    if (!trimmed || isAddress(trimmed, { strict: false })) return null;
    return normalizeEnsName(trimmed);
  }, [recipientInput, isSui]);

  // Active notes available for transfer, filtered to the selected asset and
  // sorted newest -> oldest by createdAtBlock so the most recent deposit/
  // change note appears at the top of the list.
  const activeNotes = useMemo(() => {
    const filtered = notes.filter((n) => {
      if (n.status !== NoteStatus.ACTIVE) return false;
      if (!connectedAddress) return false;
      if (!n.isOwned) return false;
      if (String(n.ownerAddress ?? '').toLowerCase() !== connectedAddress.toLowerCase()) return false;
      if (String(n.tokenId || '').toLowerCase() !== selectedTokenId) return false;
      // Zero-value notes are the change left behind after a full-balance
      // spend — they can't fund anything, so don't offer them as inputs.
      try {
        if (BigInt(n.value) === 0n) return false;
      } catch {
        return false;
      }
      return true;
    });
    const ts = (raw: unknown): bigint => {
      try {
        return BigInt(String(raw ?? '0'));
      } catch {
        return 0n;
      }
    };
    return [...filtered].sort((a, b) => {
      const diff = ts(b.createdAtBlock) - ts(a.createdAtBlock);
      if (diff > 0n) return 1;
      if (diff < 0n) return -1;
      return 0;
    });
  }, [notes, selectedTokenId, connectedAddress]);

  // Selected notes info — clamped to the currently selected asset. Commitments
  // from a previously selected asset are dropped on switch.
  const selectedNotes = useMemo(() => {
    return activeNotes.filter((n) => selectedNoteCommitments.includes(n.commitment as Hash));
  }, [activeNotes, selectedNoteCommitments]);

  // Reset selection when the user switches asset so stale commitments don't
  // linger from the prior token's note list.
  useEffect(() => {
    setSelectedNoteCommitments([]);
  }, [selectedToken]);

  const handleRecipientInputChange = useCallback((value: string) => {
    recipientInputRef.current = value;
    const trimmed = value.trim();
    // Sui addresses are 32 bytes (0x + 64 hex); EVM keeps viem's isAddress.
    const isValidRecipient = isStellar
      ? /^G[A-Z2-7]{55}$/.test(trimmed)
      : isSui
      ? /^0x[0-9a-fA-F]{64}$/.test(trimmed)
      : isAddress(trimmed, { strict: false });
    const nextAddress = trimmed && isValidRecipient ? trimmed : '';
    const nextEnsName = (nextAddress || isSui) ? null : normalizeEnsName(trimmed);
    setRecipientInput(value);
    if (nextEnsName && nextEnsName === recipientEnsName) return;
    setResolvedRecipientName(null);
    setRecipientEnsError(null);
    setRecipientEnsResolving(false);
    setRecipientAddress(nextAddress);
  }, [recipientEnsName, isSui, isStellar]);

  // DEV-570: ENS is not supported, for privacy. A typed name is never looked
  // up (no request names the counterparty); it only gets the message.
  useEffect(() => {
    if (!recipientEnsName) return;
    setRecipientAddress('');
    setResolvedRecipientName(null);
    setRecipientEnsResolving(false);
    setRecipientEnsError(ENS_UNSUPPORTED_MESSAGE);
  }, [recipientEnsName]);

  useEffect(() => {
    recipientCheckRef.current = { chainId, recipientAddress };
    setRecipientIsRegistered(null);
    setRecipientRegistrationCheck(null);
  }, [chainId, recipientAddress]);

  const totalSelectedValue = useMemo(() => {
    let total = 0n;
    for (const note of selectedNotes) {
      total += BigInt(note.value);
    }
    return total;
  }, [selectedNotes]);

  const totalSelectedFormatted = formatUnits(totalSelectedValue, selectedDecimals);

  // Validation
  const enteredAmount = parseFloat(amount) || 0;
  const enteredAmountWei = useMemo(() => {
    try {
      return amount ? parseUnits(amount, selectedDecimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, selectedDecimals]);

  // Sui: notes live in the Sui note store, not the EVM notes list.
  const suiActiveNotes = useMemo(() => {
    if (!isSuiChain) return [];
    try {
      return suiSession.loadNotes().filter((n) => n.status === 'active' && n.aspApproved !== false);
    } catch {
      return [];
    }
    // `step` forces a re-read after a submitted transfer flips notes to spent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuiChain, suiSession, step]);
  // Stellar: the SDK's ACTIVE notes, selected with the EVM transfer rules
  // (five inputs, two lineages) since the SDK builds the same transact.
  const stellarActiveNotes = useMemo(
    () => (isStellar ? (stellarSession.spendableNotes as unknown as StellarUiNote[]) : []),
    [isStellar, stellarSession.spendableNotes],
  );
  const suiActiveTotal = useMemo(
    () => (isStellar
      ? stellarActiveNotes.reduce((a, n) => a + BigInt(n.value), 0n)
      : suiActiveNotes.reduce((a, n) => a + BigInt(n.value), 0n)),
    [isStellar, stellarActiveNotes, suiActiveNotes],
  );
  // The most a one-proof Sui transfer can move (largest single lineage) — the
  // amount validation uses this, not the cross-lineage total, so the UI never
  // green-lights an amount the submit path must reject.
  const suiMaxLineageTotal = useMemo(
    () => (isStellar
      ? maxCoverableTransfer(stellarActiveNotes, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS)
      : isSui ? maxSuiLineageTotal(suiActiveNotes) : 0n),
    [isSui, isStellar, stellarActiveNotes, suiActiveNotes],
  );
  // Mirror the confirm-time lineage-first note selection for review display.
  const suiChosen = useMemo(() => {
    if (!isSui) return { count: 0, sum: 0n };
    let want = 0n;
    try { want = amount ? parseUnits(amount, altDecimals) : 0n; } catch { want = 0n; }
    if (isStellar) {
      const pick = want > 0n ? selectGreedyTransferInputs(stellarActiveNotes, want, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS) : null;
      return pick?.covered ? { count: pick.selectedNotes.length, sum: pick.accumulated } : { count: 0, sum: 0n };
    }
    const sel = want > 0n ? selectSuiNotes(suiActiveNotes, want) : null;
    return sel ? { count: sel.notes.length, sum: sel.sum } : { count: 0, sum: 0n };
  }, [isSui, isStellar, altDecimals, stellarActiveNotes, suiActiveNotes, amount]);

  // Transfer circuits cap inputs at 5 (transact_5x*) AND outputs at 5 — one
  // change note per input lineage plus up to one recipient note per lineage,
  // so a single transfer spans at most TRANSFER_MAX_LABELS deposit lineages.
  // maxCoverableTransfer sizes the ceiling against BOTH caps (a bare top-5 sum
  // could green-light an amount whose selection reverts with
  // InvalidTransactDimensions). Surface that ceiling so the user understands
  // why a larger amount fails before they hit the relayer.
  // Token-keyed one-transfer cap for launchers (the hub's Max). The
  // provider's own maxSpendableWei follows ITS selected token, which is not
  // the hub's until the flow is open, and the hub fell back to the whole
  // shielded balance: above the cap when notes are fragmented (codex #3).
  const stellarConnected = isStellar && stellarSession.wallet.isConnected && !!stellarSession.wallet.address;
  const getTransferMaxWei = useCallback((tokenSymbol: string): bigint | null => {
    // Stellar: the same five-input / two-lineage cap the amount check uses,
    // so the hub's Max never fills more than one transfer can move.
    if (isStellar) return stellarConnected ? (tokenSymbol === altSymbol ? suiMaxLineageTotal : 0n) : null;
    if (isSui || !connectedAddress || isLoadingNotes) return null;
    const tokenId = getTokenMetadataBySymbol(tokenSymbol, activeEvmChainId)?.address?.toLowerCase();
    if (!tokenId) return null;
    const owner = connectedAddress.toLowerCase();
    const eligible = notes.filter((n) => {
      if (n.status !== NoteStatus.ACTIVE || !n.isOwned) return false;
      if (String(n.ownerAddress ?? '').toLowerCase() !== owner) return false;
      if (String(n.tokenId || '').toLowerCase() !== tokenId) return false;
      try { return BigInt(n.value) > 0n; } catch { return false; }
    });
    return maxCoverableTransfer(eligible, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS);
  }, [isSui, isStellar, stellarConnected, altSymbol, suiMaxLineageTotal, connectedAddress, notes, isLoadingNotes, activeEvmChainId]);
  const maxSpendableWei = useMemo(
    () => maxCoverableTransfer(activeNotes, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS),
    [activeNotes],
  );
  const maxSpendableFormatted = formatUnits(maxSpendableWei, selectedDecimals);
  /** Everything spendable of this token, before the one-transfer note caps. */
  const eligibleTotalWei = useMemo(
    () => activeNotes.reduce((sum, n) => { try { return sum + BigInt(n.value); } catch { return sum; } }, 0n),
    [activeNotes],
  );

  // The relayer fee estimated from the gas-price and price feeds. Reading it
  // cannot trigger a request when a token, amount or modal changes; the binding
  // quote is requested at Confirm, right before the relay.
  const transferFeeFor = useTransferFeeEstimate(chainId);
  const relayFeeEstimate = !isSui && hideAddress ? transferFeeFor(selectedTokenId) : null;
  const feePricing = useFeePricing(chainId);
  const relayedFeeBreakdown = (amountWei: bigint, feeWei: bigint | null) => isSui ? null : relayedSpendBreakdown({
    chainId,
    amountWei,
    feeWei,
    decimals: selectedDecimals,
    tokenUsd: feePricing.tokenUsdOf(chainId, selectedTokenId, selectedSymbol),
    gasUnits: SHIELDED_TRANSFER_GAS,
    gasPriceWei: feePricing.gasPriceOf(chainId),
    nativeUsd: feePricing.nativeUsdOf(chainId),
  });
  // A binding quote that changed is visible on review and reserved on retry.
  const consolidationFee = consolidationQuotedFee !== null && (relayFeeEstimate === null || consolidationQuotedFee > relayFeeEstimate)
    ? consolidationQuotedFee : relayFeeEstimate;
  // 6 dp display granularity: fee ceiled (never understated), max floored
  // (the suggestion always clears the pre-relay guard).
  const feeDisplayGrain = selectedDecimals > 6 ? 10n ** BigInt(selectedDecimals - 6) : 1n;
  const relayFeeCeiled = relayFeeEstimate != null
    ? ((relayFeeEstimate + feeDisplayGrain - 1n) / feeDisplayGrain) * feeDisplayGrain
    : null;
  const relayTotalWithFee = relayFeeCeiled != null ? enteredAmountWei + relayFeeCeiled : null;
  // Send-exact only exists on the relayed EVM path: the disclosed path pays
  // ordinary gas from the wallet, and a swap-send's payout comes from a quote
  // rather than this subtraction.
  // A max entry has nothing left to add a fee on top of: like Withdraw, an
  // amount equal to the one-transfer cap is gross by construction and the
  // relayer fee comes out of it, whatever the toggle says. Tapping Max is then
  // always a reviewable entry instead of an overflow (Pat, 2026-08-29).
  // DEV-409: so is any amount under the cap that the fee would push over it
  // (a Max filled from another figure, a typed full balance), but ONLY when the
  // user has not ticked "Recipient receives the exact amount". A ticked box is
  // a promise about what the recipient gets, and silently netting the fee out
  // would break it (#157 review).
  // DEV-490 (Mike's decision, 2026-10-01) reverses that last part: sending
  // your full balance should just work, ticked or not. A full-balance entry
  // has no room for a fee on top, so the fee comes out of it and the form
  // says so with the figure the recipient gets. Not silent: the line under
  // the amount replaces the checkbox while this holds.
  const maxGrossIntent = !isSui && enteredAmountWei > 0n && (
    enteredAmountWei === maxSpendableWei
    || (hideAddress && !isSwapSend && feeOverflowsCap(enteredAmountWei, relayFeeCeiled, maxSpendableWei))
  );
  const effectiveReceiveExact = !maxGrossIntent && resolveEffectiveReceiveExact({
    requestedReceiveExact: receiveExact,
    enteredWei: enteredAmountWei,
    totalBalanceWei: maxSpendableWei,
    singleProofCapWei: maxSpendableWei,
  });
  const sendExactActive = !isConsolidating && !isSui && hideAddress && !isSwapSend && !effectiveReceiveExact;
  // "~ what lands in your account" for a swap-send, before Review (same
  // estimate the Withdraw tab shows for a receive-as exit).
  const swapSendPreview = useSwapPreview({
    enabled: isSwapSend && !!receiveAsset && enteredAmountWei > 0n,
    chainId,
    toChainId: crossChainSend ? sendChainId : chainId,
    fromToken: selectedTokenId,
    toToken: receiveAsset?.address ?? null,
    fromAmountWei: enteredAmountWei,
    fromAddress: getSwapProcessorAddress(chainId) ?? connectedAddress ?? null,
  });
  const swapSendPreviewText = swapSendPreview.status === 'ok' && receiveAsset
    ? `~${formatSwapExitEstimate(swapSendPreview.toAmount, receiveAsset.decimals)}`
    : null;
  // The net/gross rule itself lives in services/relay-fee-split.ts so it is
  // unit-tested rather than only exercised by driving the UI.
  const feeSplit = splitRelayFee({
    entered: enteredAmountWei,
    feeWei: relayFeeCeiled,
    grain: feeDisplayGrain,
    sendExact: sendExactActive,
  });
  const relayFeeReserveWei = feeSplit.reserveWei;
  /** What the recipient actually receives (send-exact nets the fee out of it). */
  const recipientAmountWei = feeSplit.recipientWei;
  /** The fee would swallow the whole transfer: the one send-exact failure mode. */
  const sendExactBelowFee = feeSplit.belowFee;
  // Fee-on-top overflow. Not a condition in send-exact mode: there the typed
  // amount IS the ceiling, so nothing can be "added on top" of it.
  // DEV-514: not a swap-send condition. A swap-send never submits this transfer:
  // it hands off to the swap flow (private route) or to Withdraw (public
  // payout), and both treat the entered amount as gross and take their own
  // relayer fee out of it. Applying the plain-transfer fee guard here refused a
  // full balance with advice ("uncheck ...") the screen cannot follow.
  const relayFeeExceeds = !isSwapSend && !sendExactActive && relayTotalWithFee != null && relayTotalWithFee > maxSpendableWei;
  const relayFeeMaxSend = relayFeeCeiled != null && maxSpendableWei > relayFeeCeiled
    ? ((maxSpendableWei - relayFeeCeiled) / feeDisplayGrain) * feeDisplayGrain
    : 0n;
  // Hub tap-to-max: the one-transfer cap itself. A cap-equal entry is gross
  // (the fee comes out of it, see maxGrossIntent), so no fee headroom is
  // reserved any more and Max never produces an amount the fee pushes over.
  const maxSend = useMemo(() => {
    if (isSui) return null;
    return formatUnits(maxSpendableWei, selectedDecimals);
  }, [isSui, maxSpendableWei, selectedDecimals]);

  // Auto-select the notes that cover the entered amount, mirroring the
  // confirm-time selection (fewest lineages first, then fewest inputs) so the
  // review display and the submitted inputs agree. Replaces the old manual
  // checkbox UI — the SDK transfers don't care which notes are picked, only
  // that they sum to the amount, so letting users hand-pick was just clutter.
  useEffect(() => {
    if (enteredAmountWei === 0n) {
      setSelectedNoteCommitments((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // An invalid consolidation selection stays empty; never substitute other notes.
    const forced = forcedInputs ? resolveForcedInputs(forcedInputs, activeNotes) : null;
    const selection = forcedInputs
      ? { selectedNotes: forced ?? [], accumulated: 0n, covered: !!forced }
      : selectGreedyTransferInputs(
        activeNotes,
        enteredAmountWei,
        TRANSFER_MAX_INPUTS,
        TRANSFER_MAX_LABELS,
      );
    const picks: Hash[] = selection.selectedNotes.map((n) => n.commitment as Hash);
    // Replace selection only when it actually changes to avoid render churn.
    setSelectedNoteCommitments((prev) => {
      if (
        prev.length === picks.length &&
        prev.every((c, i) => c === picks[i])
      ) {
        return prev;
      }
      return picks;
    });
  }, [enteredAmountWei, activeNotes, forcedInputs]);

  // Seed only local display state. Selection and fee changes cannot fetch.
  useEffect(() => {
    if (!forcedInputs || consolidateSeed === 'done') return;
    const forced = resolveForcedInputs(forcedInputs, activeNotes);
    if (!forced) { setAmount(''); return; }
    const total = forced.reduce((sum, n) => sum + BigInt(n.value), 0n);
    const net = consolidationNet(total, consolidationFee);
    setAmount(formatUnits(net ?? total, selectedDecimals));
    if (consolidationFee !== null) setConsolidateSeed('done');
  }, [forcedInputs, consolidateSeed, activeNotes, consolidationFee, selectedDecimals]);

  const consolidationContextError = isConsolidating && (
    isSui || !keysReady || chainId !== consolidationContext.chainId
    || connectedAddress?.toLowerCase() !== consolidationContext.owner
    || recipientAddress.toLowerCase() !== consolidationContext.owner
    || selectedTokenId.toLowerCase() !== consolidationContext.tokenId
  ) ? 'Your account or network changed. Close this modal and choose your notes again.' : null;
  const consolidationAvailableNotes = useMemo(() => activeNotes.filter((note) =>
    !unavailableConsolidationInputs.includes(note.commitment.toLowerCase())), [activeNotes, unavailableConsolidationInputs]);
  const consolidationSelection = forcedInputs ? resolveForcedInputs(forcedInputs, consolidationAvailableNotes) : null;
  const consolidationTotal = consolidationSelection?.reduce((sum, note) => sum + BigInt(note.value), 0n) ?? 0n;
  const consolidationError = consolidationContextError
    ?? consolidationSelectionError(consolidationSelection ?? [], consolidationFee);
  const consolidationNoteGroups = useMemo(() => consolidationGroups(consolidationAvailableNotes), [consolidationAvailableNotes]);
  const changeConsolidationSelection = (commitments: string[]) => {
    setForcedInputs(commitments);
    setConsolidateSeed('total');
    reportTransferError(null);
  };
  const backToConsolidationNotes = () => {
    // Refresh from local state only. A preflight rejection or a settled earlier
    // spend must not be offered again while discovery catches up.
    const spent = relayPending === 'other-spend' ? forcedInputs ?? [] : [];
    const spentSet = new Set(spent.map((commitment) => commitment.toLowerCase()));
    const available = new Set(consolidationNoteGroups.flatMap((group) => group.notes)
      .filter((note) => !spentSet.has(note.commitment.toLowerCase()))
      .map((note) => note.commitment.toLowerCase()));
    if (spent.length) setUnavailableConsolidationInputs((previous) => [...new Set([...previous, ...spentSet])]);
    changeConsolidationSelection((forcedInputs ?? []).filter((commitment) => available.has(commitment.toLowerCase())));
    setRelayPending(null);
    setTxHash(null);
    setStep('select-notes');
  };
  const consolidationAwaitingConfirmation = isConsolidating && step === 'success'
    && (relayPending === 'pending' || outcomeUnknown);

  const amountError = useMemo(() => {
    if (!amount || enteredAmount === 0) return null;
    if (enteredAmount < 0) return 'Amount must be positive';
    // No account, no balance to measure against: every limit below reads 0 and
    // told a visitor with no wallet that the most they could send was 0.0000
    // (Mike, 2026-09-24). The button already asks them to connect. Stellar
    // has no EVM account at all: its account is the Freighter one.
    if (isStellar) { if (!stellarConnected || stellarLocked) return null; }
    else if (!connectedAddress) return null;
    if (isSui) {
      if (enteredAmountWei > suiActiveTotal) return `Insufficient ${isStellar ? 'Stellar' : 'Sui'} balance (${formatUnits(suiActiveTotal, altDecimals)} ${altSymbol} available)`;
      if (enteredAmountWei > suiMaxLineageTotal) {
        return isStellar
          ? `One transfer can spend up to ${TRANSFER_MAX_INPUTS} notes from ${TRANSFER_MAX_LABELS} deposits (${formatUnits(suiMaxLineageTotal, altDecimals)} ${altSymbol}). Send that first, then the rest.`
          : SUI_SINGLE_NOTE_ERROR;
      }
      return null;
    }
    if (enteredAmountWei > maxSpendableWei) {
      // DEV-437: floored so it reads below the entry, and the reason is the
      // real one (the note caps only when they are what binds).
      const cap = tokenAmountLabel(capText(maxSpendableWei, enteredAmountWei, selectedDecimals), selectedSymbol);
      return overCapReason(eligibleTotalWei, maxSpendableWei) === 'note-caps'
        ? `Maximum sendable in one transfer is ${cap}`
        : `Exceeds your shielded balance of ${cap}`;
    }
    // Derive coverage from a LIVE greedy pass over the current notes — not
    // from the selection STATE, which an effect writes one render later.
    // Reading the state here flashed (and could stick) 'Insufficient
    // selected balance (0 selected)' whenever the amount landed before the
    // effect ran (deep-link prefill, notes finishing sync; QA 2026-08-17).
    const liveSelection = selectGreedyTransferInputs(
      activeNotes,
      enteredAmountWei,
      TRANSFER_MAX_INPUTS,
      TRANSFER_MAX_LABELS,
    );
    if (!liveSelection.covered) {
      return `Insufficient selected balance (${tokenAmountLabel(formatUnits(liveSelection.accumulated, selectedDecimals), selectedSymbol)} selected)`;
    }
    // Send-exact with an amount at or under the fee: there is nothing left to
    // deliver, so block here rather than letting the relay path discover it.
    if (relayFeeExceeds) {
      return `Amount plus the relayer fee (~${formatUnits(relayFeeCeiled ?? 0n, selectedDecimals)} ${isShareSymbol(selectedSymbol) ? selectedSymbol : displayTokenSymbol(selectedSymbol)}) exceeds what one transfer can send. Send at most ${tokenAmountLabel(formatUnits(relayFeeMaxSend, selectedDecimals), selectedSymbol)}, or uncheck "Recipient receives the exact amount".`;
    }
    if (sendExactBelowFee) {
      return `Send at least a little more than the relayer fee (~${formatUnits(relayFeeReserveWei ?? 0n, selectedDecimals)} ${isShareSymbol(selectedSymbol) ? selectedSymbol : displayTokenSymbol(selectedSymbol)}), or the recipient gets nothing`;
    }
    return null;
  }, [stellarLocked, amount, enteredAmount, enteredAmountWei, activeNotes, selectedDecimals, selectedSymbol, maxSpendableWei, eligibleTotalWei, isSui, suiActiveTotal, suiMaxLineageTotal, sendExactBelowFee, relayFeeReserveWei, relayFeeExceeds, relayFeeCeiled, relayFeeMaxSend, connectedAddress, isStellar, stellarConnected, altDecimals, altSymbol]);

  // Render error figures at the same display boundary as balances. The
  // validation memo above remains in shares and has no rate dependencies.
  const displayAmountError = amountError?.replace(/(?:≈\s*)?(\d+(?:\.\d+)?)\s+(ppETH|ppUSDC|ppUSDT)\b/gi,
    (_, exact: string, symbol: string) => balanceDisplay(exact, symbol, chainId).text);

  const recipientError = useMemo(() => {
    const trimmed = recipientInput.trim();
    if (isStellar) {
      if (!trimmed || /^G[A-Z2-7]{55}$/.test(trimmed)) return null;
      return 'Invalid Stellar address (G…)';
    }
    if (isSui) {
      if (!trimmed || /^0x[0-9a-fA-F]{64}$/.test(trimmed)) return null;
      return 'Invalid Sui address';
    }
    if (!trimmed || isAddress(trimmed, { strict: false })) return null;
    if (isPotentialEnsName(trimmed)) return ENS_UNSUPPORTED_MESSAGE;
    return 'Invalid Ethereum address';
  }, [recipientInput, recipientEnsError, isSui, isStellar]);

  const recipientHelperText = useMemo(() => {
    if (recipientEnsResolving) return 'Resolving ENS name...';
    if (resolvedRecipientName && recipientAddress) return `Resolved to ${truncateAddress(recipientAddress)}`;
    return null;
  }, [recipientEnsResolving, resolvedRecipientName, recipientAddress]);

  // DEV-411: no wallet and no account key means there is nothing to send from.
  // The form stays editable, shows no limits (amountError is gated the same
  // way), and the primary button asks to connect instead of naming a route.
  const needsConnect = !isSui && !connectedAddress && identityMode !== 'key';
  const canProceedToReview = isSui
    ? suiActiveTotal > 0n && enteredAmount > 0 && !amountError && !!recipientAddress && !recipientError
    // Gross mode needs the fee figure before Review: without it the recipient's
    // net is unknown and Review would show the full typed amount (codex #2).
    : selectedNotes.length > 0 && enteredAmount > 0 && !amountError && !!recipientAddress && !recipientError && !recipientEnsResolving
      && (!sendExactActive || relayFeeCeiled != null);

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

  // Transfer flow
  const handleConfirmUnlocked = useCallback(async () => {
    transferPhaseRef.current = 'validate';
    if (isConsolidating && consolidationError) {
      reportTransferError(consolidationError);
      return;
    }
    let broadcastAttempted = false;
    // DEV-412: what an unknown outcome needs to keep looking for this spend.
    let bgRun: {
      inputs: Hash[];
      outputs: Hash[];
      amountHex: Hex;
      tokenId: string;
      disclosures: SentNoteDisclosure[];
      /** The relayer's quoted fee, once the relayed branch has it. */
      feeWei?: bigint;
    } | null = null;
    // DEV-413: the pre-broadcast one-time receipt record, until re-keyed.
    let provisionalAuditKey: string | null = null;
    // This run's relay, written from callbacks: the relayer's hash as soon as
    // it returns, and the settlement of its pending-relay record, heard from
    // that moment so a settle that lands mid-run is not missed.
    const relayRun = createRelayRun();
    let suiBroadcastAttempted = false;
    // A previous attempt may have reached the chain with the receipt shown
    // on screen — refuse to overwrite those secrets with a fresh prepare.
    if (indeterminateAttempt) {
      reportTransferError(
        'The previous attempt may have reached the chain. Copy the receipt shown, verify the transaction in the explorer, and start a NEW transfer only once you know the outcome.',
      );
      return;
    }
    // This attempt is accepted: drop the previous attempt's hash/chain pair
    // NOW. A confirmed revert returns to Review with them still set, and an
    // unknown-outcome path below jumps to success without writing a new pair —
    // the recovery screen must never link the PRIOR (possibly other-chain)
    // transaction as this attempt's outcome (codex).
    setTxHash(null);
    setTxChainId(null);
    setRelayPending(null);
    // Operation binding (codex P1-5): freeze this run's epoch and callback at
    // entry. `live()` gates the broadcast — a run whose modal was closed or
    // reopened aborts BEFORE sending, silently (its UI belongs to someone
    // else now). `onSent` is delivered from the capture, never from the ref,
    // so a later open's callback can't be invoked for THIS run's transfer.
    const runEpoch = opEpochRef.current;
    const live = () => opEpochRef.current === runEpoch;
    const onSent = transferOnSentRef.current;
    // === Stellar path ===
    // The SDK announces the recipient's note on-chain (encrypted to their
    // viewing key), exactly like an EVM transfer, so there is no receipt to
    // hand over: the recipient's own session discovers it.
    if (isStellar) {
      const sender = stellarSession.wallet.isConnected ? stellarSession.wallet.address : null;
      if (!sender) {
        reportTransferError('Connect Freighter first.');
        return;
      }
      setSentAmountWei(null);
      setSentUnits(null);
      setStep('loading');
      reportTransferError(null);
      transferPhaseRef.current = 'validate';
      setLoadingMessage('Preparing the transfer...');
      try {
        if (recipientAddress === sender) throw new Error('That is your own address. Pick someone else to send to.');
        // No separate recipient lookup here: the SDK resolves the recipient's
        // viewing key inside transfer() and refuses an unregistered one.
        const want = parseUnits(amount, altDecimals);
        const pick = selectGreedyTransferInputs(stellarActiveNotes, want, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS);
        if (!pick.covered) throw new Error(`One transfer can spend up to ${TRANSFER_MAX_INPUTS} notes from ${TRANSFER_MAX_LABELS} deposits.`);
        if (!live()) { log('warn', 'Transfer', 'Stale run aborted before Stellar broadcast'); return; }
        // The user already confirmed a one-time link for exactly this recipient.
        // Case-insensitive: the shared check may hold a lowercased copy (a G address is uppercase only).
        const oneTime = recipientRegistrationCheck?.registered === false
          && recipientRegistrationCheck.chainId === STELLAR_TESTNET_ID
          && recipientRegistrationCheck.recipientAddress.toUpperCase() === recipientAddress.trim().toUpperCase();
        const inputCommitments = pick.selectedNotes.map((n) => n.commitment as `0x${string}`);
        transferPhaseRef.current = 'proof';
        const onStage = (stage: Parameters<typeof describeStellarStage>[0]) => { if (!live()) return; transferPhaseRef.current = stellarErrorReportStage(stage); setLoadingMessage(describeStellarStage(stage)); };
        let result: { txHash: string };
        if (oneTime) {
          const { buildStellarClaimUrl } = await import('@/services/stellar/stellar-claim-url');
          const sent = await stellarSession.sendOneTime({
            amount: want,
            recipient: recipientAddress,
            inputCommitments,
            shouldContinue: live,
            onStage,
            // Saved for the sender already; from here until it is copied the
            // link is at risk in this tab, like any one-time receipt.
            onClaimReady: (notes) => {
              receiptOwnerRef.current = sender;
              setReceiptLifecycle('at-risk');
              setRecipientImportPayload(JSON.stringify({ notes }));
              setRecipientImportUrl(buildStellarClaimUrl(notes));
            },
          });
          setRecipientImportPayload(JSON.stringify({ notes: sent.notes }));
          setRecipientImportUrl(buildStellarClaimUrl(sent.notes));
          result = sent;
        } else {
          try {
            result = await stellarSession.transfer({
              amount: want,
              recipient: recipientAddress,
              inputCommitments,
              shouldContinue: live,
              onStage,
            });
          } catch (err) {
            const raw = err instanceof Error ? `${err.name} ${err.message}` : String(err);
            // No viewing key: offer the one-time link (nothing was sent).
            if (live() && /RecipientViewingKeyUnregistered|no on-chain viewing key/i.test(raw)) {
              reportTransferError(null);
              setRecipientRegistrationCheck({ chainId: STELLAR_TESTNET_ID, recipientAddress, registered: false });
              setRecipientIsRegistered(false);
              setStep('unregistered-confirm');
              return;
            }
            throw err;
          }
        }
        setTxHash(result.txHash);
        setTxChainId(STELLAR_TESTNET_ID);
        // Local only: names the payee on the Sent row this device rebuilds
        // from the chain (the recipient is not in any event).
        try {
          recordSentTransfer({
            txHash: result.txHash,
            recipient: recipientAddress,
            rawAmount: `0x${want.toString(16)}`,
            tokenAddress: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId,
            chainId: STELLAR_TESTNET_ID,
            timestamp: Date.now(),
          });
        } catch (e) {
          log('warn', 'Transfer', 'Failed to stamp sent-transfer record', { err: e instanceof Error ? e.message : String(e) });
        }
        log('info', 'Transfer', `Stellar transfer submitted: ${result.txHash}`);
        if (live()) setStep('success');
        try { onSent?.(result.txHash, { chainId: STELLAR_TESTNET_ID, tokenSymbol: 'XLM', amount, recipient: recipientAddress }); } finally { if (transferOnSentRef.current === onSent) transferOnSentRef.current = null; }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        log('error', 'Transfer', `Stellar transfer failed: ${raw}`, err);
        const declined = /reject|denied|cancel|declined/i.test(raw);
        // A one-time link was armed for this send. Declined in Freighter: the
        // transfer never happened, so the link is dropped. Anything else after
        // that point may have landed: keep the link on screen, framed as an
        // unknown outcome (the sender also has the saved copy).
        if (receiptLifecycleRef.current === 'at-risk') {
          if (declined || /Superseded/.test(raw)) {
            if (live()) {
              setReceiptLifecycle('none');
              setRecipientImportPayload(null);
              setRecipientImportUrl(null);
            }
          } else {
            setIndeterminateAttempt(true);
            setOutcomeUnknown(true);
            if (live()) setStep('success');
            return;
          }
        }
        if (!live() || /Superseded/.test(raw)) return;
        reportTransferError(declined ? 'Transaction was rejected.' : stellarErrorMessage(raw), err);
        setStep('review');
      }
      return;
    }

    // === Sui path ===
    // Route the internal transfer to the Sui session: lineage-first note
    // selection, outputs = [recipient exact amount, change to self],
    // amountOut = 0 (pure in-pool transfer). The recipient's spendable note
    // is returned as a one-time receipt payload on the success screen.
    if (isSui) {
      if (!suiSession.account?.address) {
        reportTransferError('Connect your Sui wallet first.');
        return;
      }
      setSentAmountWei(null);
      setSentUnits(null);
      setStep('loading');
      reportTransferError(null);
      transferPhaseRef.current = 'validate';
      setLoadingMessage('Reconstructing Merkle proofs + proving...');
      try {
        // Select active Sui notes covering the amount from ONE lineage —
        // value conservation is per-label, so mixing lineages is invalid.
        // SUI base units (MIST, 9 decimals).
        const want = parseUnits(amount, 9);
        const selection = selectSuiNotes(suiSession.loadNotes(), want);
        if (!selection) {
          throw new Error(SUI_SINGLE_NOTE_ERROR);
        }
        const { notes: chosen, sum, label } = selection;
        transferPhaseRef.current = 'proof';
        // Pure transfer: amountOut = 0. Exact-amount output to the recipient
        // plus a change note back to self (Nx2, lineage label preserved).
        const { randomFieldElement, addressToU256 } = await import('@/services/sui-witness');
        // Output note owner = recipient's Sui address as a field element
        // (addressToU256: mod BN254 field, matching the contract/circuit).
        const recipientField = addressToU256(recipientAddress);
        const tokenId = BigInt(chosen[0].tokenId);
        const change = sum - want;
        const senderField = addressToU256(suiSession.account?.address ?? '');
        const recipientNote = {
          value: want,
          tokenId,
          label,
          noteSecret: randomFieldElement(),
          ownerAddress: recipientField,
        };
        // Superseded run: abort before the receipt machinery arms or anything
        // reaches the chain — this run's UI belongs to a newer modal session.
        if (!live()) { log('warn', 'Transfer', 'Stale run aborted before Sui receipt arm'); return; }
        // The recipient's note secret now exists only in this tab; arm the
        // close guard before the transaction can land on-chain.
        receiptOwnerRef.current = currentIdentityRef.current;
        receiptStoredRef.current = false;
        setReceiptLifecycle('at-risk');
        // Show a COMPLETE importable receipt BEFORE broadcast (same P0 class
        // as the EVM branch): transferOrWithdraw signs AND executes, so a
        // throw after submission would otherwise leave a mined transfer with
        // no payload. The commitment is deterministic from the note fields
        // (codex round 2: the import path REQUIRES it — a payload without it
        // is unimportable), so compute it here; the enriched payload below
        // adds the txDigest on success.
        {
          const { calculateNoteAddressHash, calculateNoteCommitment } = await import('@/services/sui-witness/crypto');
          const preNoteAddressHash = await calculateNoteAddressHash(recipientNote.ownerAddress, recipientNote.noteSecret);
          const preCommitment = await calculateNoteCommitment(preNoteAddressHash, recipientNote.tokenId, recipientNote.value, 0n, recipientNote.label);
          setRecipientImportPayload(JSON.stringify({
            kind: 'ppv2-sui-note',
            note: {
              commitment: preCommitment.toString(),
              value: recipientNote.value.toString(),
              tokenId: recipientNote.tokenId.toString(),
              label: recipientNote.label.toString(),
              noteSecret: recipientNote.noteSecret.toString(),
              ownerAddress: recipientNote.ownerAddress.toString(),
              coinType: '0x2::sui::SUI',
              status: 'active',
            },
          }, null, 2));
        }
        // Superseded run (modal closed/reopened since Confirm): abort silently
        // before anything reaches the chain — and DISARM the receipt this run
        // armed above, or every reopen is trapped on a receipt screen for a
        // transfer that never broadcast (codex).
        if (!live()) {
          setReceiptLifecycle('none');
          setRecipientImportPayload(null);
          log('warn', 'Transfer', 'Stale run aborted before Sui broadcast (own receipt disarmed)');
          return;
        }
        suiBroadcastAttempted = true;
        const result = await suiSession.transferOrWithdraw({
          shouldContinue: live,
          inputNotes: chosen,
          outputNotes: change > 0n
            ? [
                recipientNote,
                // change back to self (same lineage)
                { value: change, tokenId, label, noteSecret: randomFieldElement(), ownerAddress: senderField },
              ]
            : [recipientNote],
          amountOut: 0n,
          tokenIdOut: 0n,
        });
        setTxHash(result.txDigest);
        setTxChainId(SUI_TESTNET_ID);
        // Receipt for the recipient: the full spendable note (only their
        // keystore keys can spend it). Shown once on the success screen.
        setRecipientImportPayload(JSON.stringify({
          kind: 'ppv2-sui-note',
          note: {
            commitment: result.outputCommitments[0].toString(),
            value: recipientNote.value.toString(),
            tokenId: recipientNote.tokenId.toString(),
            label: recipientNote.label.toString(),
            noteSecret: recipientNote.noteSecret.toString(),
            ownerAddress: recipientNote.ownerAddress.toString(),
            coinType: '0x2::sui::SUI',
            status: 'active',
            txDigest: result.txDigest,
          },
        }, null, 2));
        log('info', 'Transfer', `Sui transfer submitted: ${result.txDigest}`);
        if (live()) setStep('success');
        try { onSent?.(result.txDigest, { chainId: SUI_TESTNET_ID, tokenSymbol: 'SUI', amount, recipient: recipientAddress }); } finally { if (transferOnSentRef.current === onSent) transferOnSentRef.current = null; }
      } catch (err) {
        // Disarm ONLY for pre-broadcast failures — transferOrWithdraw signs
        // and executes in one call, so a throw after it started may follow a
        // MINED transfer whose only recovery material is the payload above.
        const message = err instanceof Error ? err.message : String(err);
        // Same outcome classification as the EVM branch: a known wallet
        // rejection never reached the chain; only a genuinely unknown
        // post-submit failure latches (and shows the receipt immediately).
        const suiKnownRejection = /Superseded|User rejected|User denied|User cancelled|rejected from user/i.test(message);
        if (!suiBroadcastAttempted || suiKnownRejection) {
          // Provably never broadcast — disarm this run's own receipt (a
          // 'Superseded' abort inside the Sui method lands here too).
          setReceiptLifecycle('none');
          setRecipientImportPayload(null);
        } else {
          // Global on purpose: an unknown-outcome broadcast must block sends
          // regardless of which modal session is currently showing.
          setIndeterminateAttempt(true);
          setOutcomeUnknown(true);
          if (live()) { setStep('success'); reportTransferError(null); }
          log('error', 'Transfer', `Sui transfer outcome unknown after submit: ${message}`, err);
          return;
        }
        log('error', 'Transfer', `Sui transfer failed: ${message}`, err);
        if (live()) {
          reportTransferError(message, err);
          setStep('review');
        }
      }
      return;
    }

    if (!connectedAddress) {
      reportTransferError('Wallet not connected.');
      return;
    }

    // A previous attempt's latched figure must not survive into this one (codex #5).
    setSentAmountWei(null);
    setSentUnits(null);
    setStep('loading');
    reportTransferError(null);
    transferPhaseRef.current = 'validate';
    setLoadingMessage('Syncing latest pool state...');
    // Pause background polling (balances, ASP queries) while the tx
    // is in flight so we don't blast the RPC during the wait.
    beginTx();

    // Build (or reuse) the SDK session up-front. We used to hard-bail
    // with "SDK not initialized" on `!sdkReady`, but the session is
    // built lazily now (auto-init-on-connect was removed). Grab it
    // here so `relayTransfer` below has a guaranteed-fresh handle
    // — the modal's captured `poolSession` would be stale within
    // this same handler run if the session was just created.
    let session;
    try {
      console.log('[TransferModal] handleConfirm: ensuring SDK session');
      session = await ensureInitialized();
      console.log('[TransferModal] handleConfirm: session ready');
    } catch (initErr) {
      const message = initErr instanceof Error ? initErr.message : String(initErr);
      console.warn('[TransferModal] handleConfirm: ensureInitialized failed:', message);
      reportTransferError(
        isSessionInitTimeout(initErr)
          // The wait was abandoned, not the session. Say what to do next; the
          // provider has already dropped the stalled attempt so pressing Send
          // again is a real second try, not a re-attach to the same promise.
          ? message
          : /user rejected|user denied|user cancel/i.test(message)
            ? 'Signature cancelled. Connect your wallet and approve the sign-in to transfer.'
            : `Couldn't initialize the SDK: ${message}`,
      );
      // No dedicated 'error' step — surface the message on the review
      // screen, same as the catch block below.
      setStep('review');
      endTx();
      return;
    }

    // DEV-237: when "Hide my address" is unchecked, the transfer is submitted
    // directly from the connected wallet (below), so the on-chain msg.sender IS
    // that wallet. PoolVault enforces `processor == msg.sender`, and we bind the
    // proof's processor to `walletAddress`, so the submitting wallet must be the
    // same account that owns this session (`connectedAddress`). Account-key /
    // payer sessions (session ≠ wallet) can't disclose: the revealed sender
    // wouldn't be the note owner, and the tx would revert on the processor
    // check. Block both early.
    if (!hideAddress && (!walletAddress || walletAddress.toLowerCase() !== connectedAddress.toLowerCase())) {
      reportTransferError(
        !walletAddress
          ? 'Connect a wallet to send a non-anonymous transfer. Your wallet address becomes the on-chain sender.'
          : 'A non-anonymous transfer must be sent from the wallet that owns this account. Switch to that wallet, or re-check “Hide my address” to send anonymously.',
      );
      setStep('review');
      endTx();
      return;
    }

    log('info', 'Transfer', 'Starting transfer preflight', {
      inputCount: selectedNoteCommitments.length,
      tokenSymbol: selectedSymbol,
      chainId,
    });

    try {
      // No discovery pass before the proof. The SDK rebuilds the state and
      // keystore trees from the leaves the feed grid holds plus an RPC sweep
      // to the head (services/sdk-setup.ts), and the preflight below reads
      // spent state from bulk data, so a pass here only told the ASP and the
      // RPC provider that a spend was about to be proved.
      transferPhaseRef.current = 'validate';
      setLoadingMessage('Checking private funds...');
      // Read the freshly committed managers, not the render-captured ones —
      // on the first attempt those are still stale right after ensureInitialized().
      const { noteManager: liveNoteManager, keystoreManager: liveKeystoreManager } = getCommittedManagers();
      if (!liveNoteManager) {
        throw new Error('Private note state is not available yet. Sync the pool and try again.');
      }
      if (!liveKeystoreManager) {
        throw new Error('Private spending keys are not available yet. Reconnect your wallet and try again.');
      }
      const spendabilityReport = await verifyTransferSpendability({
        notes: activeNotes,
        chainId,
        noteManager: liveNoteManager,
        keystoreManager: liveKeystoreManager,
        ownerAddress: connectedAddress as SdkAddress,
      });
      // The RELAYED path spends amount + fee from the selected inputs
      // (relayTransfer proves with the fee on top), so the input selection
      // must target BOTH — greedy targeting the bare amount picks a note that
      // exactly covers it and leaves nothing for the fee (QA 2026-08-17:
      // 0.01 send from a 0.01 note with 0.24 shielded hit the fee guard).
      // Fresh non-committal quote; 25% headroom absorbs drift until the
      // binding quote (over-selection just returns more change).
      let feeBudget = 0n;
      // The unpadded quote, for the fallback selection below.
      let feeQuoteWei = 0n;
      let feeQuote: bigint | null = null;
      if (hideAddress) {
        feeQuote = await fetchTransferFeeQuote(chainId, selectedTokenId);
        feeBudget = feeQuote != null ? (forcedInputs ? feeQuote : feeQuote + feeQuote / 4n) : (relayFeeEstimate ?? 0n);
        feeQuoteWei = feeQuote ?? relayFeeEstimate ?? 0n;
        console.log('[Transfer] fee budget for input selection:', feeBudget.toString());
      }
      // Consolidation: the forced notes ARE the inputs. They must all still be
      // spendable and must cover amount + fee; otherwise refuse rather than
      // silently substituting an amount-driven pick that would defeat the point.
      let forcedNow = forcedInputs ? resolveForcedInputs(forcedInputs, spendabilityReport.spendableNotes) : null;
      if (forcedInputs && !forcedNow) {
        if (live()) {
          setUnavailableConsolidationInputs((previous) => [...new Set([...previous,
            ...unavailableConsolidationCommitments(spendabilityReport.rejected),
          ])]);
        }
        throw new Error('Some selected notes are no longer spendable. Press Back to choose from the updated notes.');
      }
      // Consolidation sends no recipient amount: all value except the binding
      // fee returns as one owned change note per label. This amount is display
      // state only; the SDK receives zero and applies the final fee itself.
      let sendAmountWei = enteredAmountWei;
      // Send-exact: the typed amount is the whole debit, so what the recipient
      // gets is it MINUS the fresh fee budget (the same padded figure the form
      // displayed). Computed from this quote, not the form's older one, so the
      // debit stays at or under what the user typed.
      if (sendExactActive) {
        // feeBudget is ALREADY the padded reserve, so subtract it directly
        // rather than padding twice.
        const net = netAfterReserve(enteredAmountWei, feeBudget, feeDisplayGrain);
        if (net <= 0n) {
          throw new Error(`The relayer fee (~${formatUnits(feeBudget, selectedDecimals)} ${displayTokenSymbol(selectedSymbol)}) is at least the amount you entered, so nothing would reach the recipient. Send a little more.`);
        }
        setSentAmountWei(net);
        setSentUnits({ symbol: selectedSymbol, decimals: selectedDecimals });
        log('info', 'Transfer', 'Send-exact: netted the relayer fee out of the entered amount', {
          entered: enteredAmountWei.toString(), net: net.toString(), feeBudget: feeBudget.toString(),
        });
        sendAmountWei = net;
      }
      if (forcedNow) {
        // A missing pre-check quote falls back to the reviewed fee; the binding
        // fee is still checked against it before anything is relayed.
        const prepared = planConsolidation(forcedNow, feeQuote !== null && consolidationFee !== null && feeQuote > consolidationFee ? feeQuote : consolidationFee);
        // Label order determines which group pays the fee in the SDK.
        forcedNow = prepared.notes;
        feeBudget = prepared.fee;
        sendAmountWei = prepared.net;
        // A re-quote is never bit-identical to the reviewed one; the same
        // allowance withdrawals use (services/relayer-fee-jitter.ts) keeps
        // ordinary drift from refusing every press.
        if (consolidationFee !== null && !feeWithinReviewed(prepared.fee, consolidationFee)) {
          if (live()) setConsolidationQuotedFee(prepared.fee);
          throw new Error('The relayer fee increased. Review the updated quote before trying again. Nothing was sent.');
        }
        setSentAmountWei(sendAmountWei);
        setSentUnits({ symbol: selectedSymbol, decimals: selectedDecimals });
      }
      // These inputs are spent now, so each selection also merges the spare
      // notes of the deposits it already uses. Forced inputs stay as pinned.
      let selection = forcedNow
        ? (() => {
            const accumulated = forcedNow.reduce((sum, n) => sum + BigInt(n.value), 0n);
            return { selectedNotes: forcedNow, accumulated, covered: accumulated >= sendAmountWei + feeBudget };
          })()
        : selectGreedyTransferInputs(
          spendabilityReport.spendableNotes,
          // sendAmountWei, not the typed amount: in send-exact mode the fee is
          // already inside the typed figure, so selecting for typed + fee would
          // demand more than the user has and defeat the whole point.
          sendAmountWei + feeBudget,
          TRANSFER_MAX_INPUTS,
          TRANSFER_MAX_LABELS,
          { sweepSelectedLabels: true },
        );
      if (!selection.covered && feeBudget > 0n && !forcedNow && feeQuoteWei > 0n) {
        // The padding is headroom, not a requirement: amount + the quote
        // itself may still fit (DEV-490). Going straight to the bare amount
        // picked the fewest notes that cover it, which left no room for the
        // fee a full-balance send needs.
        selection = selectGreedyTransferInputs(
          spendabilityReport.spendableNotes,
          sendAmountWei + feeQuoteWei,
          TRANSFER_MAX_INPUTS,
          TRANSFER_MAX_LABELS,
          { sweepSelectedLabels: true },
        );
      }
      if (!selection.covered && feeBudget > 0n && !forcedNow) {
        // Balance covers the amount but not the padded budget — fall back to
        // the bare-amount selection so the relay-time guard states the exact
        // constraint instead of the padded one failing opaquely here.
        selection = selectGreedyTransferInputs(
          spendabilityReport.spendableNotes,
          sendAmountWei,
          TRANSFER_MAX_INPUTS,
          TRANSFER_MAX_LABELS,
          { sweepSelectedLabels: true },
        );
      }
      log('info', 'Transfer', 'Preflighted transfer input spendability', {
        ...toTransferSpendabilityLog(spendabilityReport),
        selectedCount: selection.selectedNotes.length,
        covered: selection.covered,
        feeBudget: feeBudget.toString(),
      });
      if (!selection.covered) {
        throw new Error(formatTransferSpendabilityUnavailable({
          requestedAmount: formatUnits(enteredAmountWei, selectedDecimals),
          availableAmount: formatUnits(selection.accumulated, selectedDecimals),
          tokenSymbol: selectedSymbol,
          maxInputs: TRANSFER_MAX_INPUTS,
        }));
      }
      const verifiedInputCommitments = selection.selectedNotes.map((note) => note.commitment as Hash);
      setSelectedNoteCommitments((prev) => (
        prev.length === verifiedInputCommitments.length &&
        prev.every((commitment, index) => commitment === verifiedInputCommitments[index])
          ? prev
          : verifiedInputCommitments
      ));
      transferPhaseRef.current = 'proof';
      setLoadingMessage('Generating proof...');
      let amountHex = `0x${sendAmountWei.toString(16)}` as Hex;

      // Use the *exact* tokenId from the input note instead of the canonical
      // lowercase one — the SDK compares them character-for-character and
      // rejects checksum vs lowercase mismatches (e.g. 0xEeee… vs 0xeeee…).
      const inputTokenId = (selection.selectedNotes[0]?.tokenId ?? selectedTokenId) as SdkAddress;
      const normalizedRecipient = recipientAddress.toLowerCase();
      const outOfBandFallbackConfirmed =
        recipientRegistrationCheck?.registered === false &&
        recipientRegistrationCheck.chainId === chainId &&
        recipientRegistrationCheck.recipientAddress === normalizedRecipient;
      if (recipientIsRegistered === false && !outOfBandFallbackConfirmed) {
        throw new Error('Recipient registration status changed. Review the recipient again before sending.');
      }
      // LAST pre-broadcast liveness gate (codex). NOTE (GLM review): on the
      // pinned SDK, neither prepareTransfer nor relayTransfer's proof mutates
      // local note state — SPENT marking happens in finalizeTransfer AFTER a
      // confirmed receipt — so a failure between here and broadcast leaves no
      // corrupted balance. The operation still proceeds once submission
      // starts (only its UI writes are epoch-guarded).
      if (!live()) { log('warn', 'Transfer', 'Stale run aborted before prepare'); return; }
      if (!hideAddress && !walletAddress) {
        throw new Error('Connect a wallet to send a non-anonymous transfer. Your wallet address becomes the on-chain sender.');
      }
      // Out-of-band path: the recipient's note secret is about to be created
      // in this tab only — arm the close guard before submission.
      if (outOfBandFallbackConfirmed) {
        receiptOwnerRef.current = currentIdentityRef.current;
        receiptStoredRef.current = false;
        setReceiptLifecycle('at-risk');
      }
      // Relayed (hidden address): plan the recipient and the outputs here and
      // prove once, inside relayTransfer below, against a quote requested
      // right before it. Disclosed: prepare self-submit calldata on the
      // relayer-less session; it never relays, so it needs no quote.
      const relayedPlan = hideAddress
        ? await prepareRelayed({
          inputNotes: selection.selectedNotes,
          recipientAddress: recipientAddress as SdkAddress,
          ownerAddress: connectedAddress as SdkAddress,
          chainId,
          amount: forcedNow ? 0n : sendAmountWei,
          consolidation: !!forcedNow,
          tokenId: inputTokenId,
          allowOutOfBandFallback: !isConsolidating && outOfBandFallbackConfirmed,
        })
        : null;
      const disclosed = relayedPlan ? null : await transfer({
        inputCommitments: verifiedInputCommitments,
        recipientAddress: recipientAddress as SdkAddress,
        ownerAddress: connectedAddress as SdkAddress,
        chainId,
        amount: amountHex,
        tokenId: inputTokenId,
        allowOutOfBandFallback: outOfBandFallbackConfirmed,
        // DEV-237 disclose: bind the proof's processor to the submitting wallet
        // so PoolVault's `processor == msg.sender` passes on the direct submit.
        // The guard above already ensured walletAddress === connectedAddress.
        selfSubmitProcessor: walletAddress as SdkAddress,
      });
      const result = (relayedPlan ?? disclosed)!;

      if (isConsolidating && !result.discoverable) {
        throw new Error('Complete keystore registration and publish your viewing key on this network before consolidating notes.');
      }
      log('info', 'Transfer', 'Transfer prepared, submitting', {
        discoverable: result.discoverable,
      });
      // The outputs a mined spend is matched against. Only the recipient notes
      // are known before the proof (the change takes the relayer fee and fresh
      // secrets), and the relay check holds the relayed proof to them. A
      // consolidation has none and is matched by its input nullifiers alone.
      const expectedOutputs = result.recipientNotes.map((r) => r.commitment as Hash);
      bgRun = {
        inputs: verifiedInputCommitments,
        outputs: expectedOutputs,
        amountHex,
        tokenId: inputTokenId,
        disclosures: result.recipientDisclosures.map((d) => ({
          chainId,
          txHash: '0x0' as Hash,
          commitment: d.commitment,
          ownerAddress: d.ownerAddress,
          noteSecret: d.noteSecret,
          tokenId: d.tokenId,
          value: d.value,
          label: d.label,
        })) as SentNoteDisclosure[],
      };

      // BASE receipt BEFORE broadcast (codex round 1, P0): for an out-of-band
      // transfer the recipient's one-time note secrets exist RIGHT NOW, and
      // they used to be serialized only after the receipt wait — a timeout,
      // RPC failure or replacement race after a MINED transfer left the
      // success screen with no recoverable payload, permanently losing the
      // recipient's funds. This placeholder payload (txHash/createdAtBlock
      // stubbed) is enough to recover the notes: the import path runs a
      // full-range discovery reconcile that re-derives the real block data.
      // The post-confirmation builder below replaces it with the enriched one.
      if (!result.discoverable && result.recipientNotes.every((r) => r.noteSecret != null)) {
        try {
          const baseNotes = result.recipientNotes.map((r) => ({
            commitment: r.commitment,
            value: r.value,
            tokenId: r.tokenId,
            label: r.label,
            status: NoteStatus.ACTIVE,
            ownerAddress: recipientAddress as SdkAddress,
            noteSecret: r.noteSecret as Hex,
            noteAddressHash: r.noteAddressHash,
            isOwned: true,
            createdAtBlock: '0x0' as Hex,
            spentAtBlock: null,
            txHash: '0x0',
          }));
          const basePayload = { notes: baseNotes, syncCursor: '0x0' as Hex, owner: recipientAddress as SdkAddress, chainId };
          console.log('[Transfer] BASE receipt built (pre-broadcast, txHash 0x0 stub)', {
            commitments: baseNotes.map((n) => n.commitment),
          });
          setRecipientImportPayload(JSON.stringify(basePayload, null, 2));
          // Link the base receipt too: if confirmation or the enriched
          // rebuild below fails AFTER broadcast, the success screen would
          // otherwise offer only Copy JSON — the import route's discovery
          // reconcile tolerates the stubbed txHash/createdAtBlock.
          const { encodeNoteReceiptForUrl, buildNoteReceiptUrl } = await import('@/services/note-receipt');
          setRecipientImportUrl(buildNoteReceiptUrl(encodeNoteReceiptForUrl(
            basePayload as unknown as import('@/services/sdk-types').AccountExport,
          )));
        } catch (baseErr) {
          log('warn', 'Transfer', 'Failed to pre-build base receipt payload', {
            err: baseErr instanceof Error ? baseErr.message : String(baseErr),
          });
        }
      }
      // DEV-413: store the recipient disclosures BEFORE broadcast. The receipt
      // above lives only in React state, which closing the modal wipes, and
      // the normal record below is written only after confirmation. An unknown
      // relay outcome never gets there, so the history row had no "Copy payment
      // link" and the unregistered recipient's only claim route was gone.
      // Keyed by the change note (see transferPendingAuditKey) because no hash
      // exists yet; the row menu falls back to it, and success re-keys it.
      if (!result.discoverable && result.recipientDisclosures.length > 0) {
        provisionalAuditKey = transferPendingAuditKey(
          result.changeCommitment,
          result.recipientDisclosures.map((d) => String(d.commitment)),
        );
        if (provisionalAuditKey) {
          const pendingKey = provisionalAuditKey;
          const stored = recordSentAuditsVerified(result.recipientDisclosures.map((d) => ({
            chainId,
            txHash: pendingKey as Hash,
            commitment: d.commitment,
            ownerAddress: d.ownerAddress,
            noteSecret: d.noteSecret,
            tokenId: d.tokenId,
            value: d.value,
            label: d.label,
          })));
          if (!stored) {
            log('warn', 'Transfer', 'One-time receipt could not be stored locally before broadcast; the success screen is the only copy');
          } else {
            receiptStoredRef.current = true;
          }
        }
      }
      transferPhaseRef.current = 'submit';
      setLoadingMessage('Submitting transaction...');


      // DEV-237: the submission path depends on "Hide my address".
      //  - hidden (default): relay through the SDK's HTTPS relayer — the
      //    on-chain caller is the relayer, so the sender stays private. The
      //    one proof is built inside relayTransfer with the agreed fee.
      //  - disclosed (unchecked): submit the transact DIRECTLY from the user's
      //    wallet (executeOptions, processor=walletAddress), so on-chain
      //    msg.sender IS the sender's address — non-anonymous, for compliance.
      //    No relayer.
      // Once a broadcast/relay may have reached the chain, a failure below
      // must KEEP the at-risk receipt armed — the tx can still mine, and the
      // pre-built base payload is the recipient's only recovery path.
      let hash: Hash;
      // The relayer's fee is quoted inside the relayed branch below but has to
      // outlive it: the fee is debited ON TOP of the amount, so unless we stamp
      // it next to the sent record the history row understates the spend and a
      // user adding their own rows up can never reach their balance.
      // Typed by cast: the re-prove closure assigns it, which narrowing cannot see.
      let relayerFeeWei = null as bigint | null;
      // Receipt status the SDK's relayTransfer observed internally (it still
      // polls the relayer's hash inside the vendored tarball). Used only as a
      // confirmation fallback below; it adds no request of ours.
      let sdkReceiptStatus: unknown;
      // DEV-494: when each relayed step ended, for the local debug log.
      let relayT0 = 0;
      const relayTimes: Record<string, number> = {};
      // The relayed proof's first change commitment, read by the relay check;
      // the heal below needs it because the plan cannot know it.
      let relayedChangeCommitment: Hash | null = null;
      if (disclosed) {
        transferPhaseRef.current = 'submit';
        setLoadingMessage('Confirm the transfer in your wallet…');
        log('info', 'Transfer', 'Submitting transfer directly from wallet (address disclosed)', { from: walletAddress });
        // Pin the sending account + chain to the proof-bound wallet. The proof
        // and calldata bind processor=walletAddress; if wagmi sent from a
        // different active connector account (user switched mid-flow), the tx
        // would revert with PoolVault_InvalidProcessor. Passing `account` makes
        // viem fail fast (or use the right signer) instead of silently sending
        // from the wrong address.
        // Flag ONLY at the actual submission boundary (codex round 2): setting
        // it before the wallet/relayer precondition checks kept the at-risk
        // guard armed for failures that provably never reached the chain.
        broadcastAttempted = true;
        hash = (await sendTransactionAsync({
          account: walletAddress as `0x${string}`,
          chainId,
          to: disclosed.to as `0x${string}`,
          data: disclosed.callData as `0x${string}`,
        })) as Hash;
        log('info', 'Transfer', 'Direct transfer tx submitted', { txHash: hash });
      } else {
        if (!relayedPlan) throw new Error('No relayer quote available for this transfer.');
        // The one committed quote, requested right before the one proof, so
        // that proof gets the commitment's whole lifetime. Run again for every
        // re-prove (relayWithReprove below), so a retry's fee passes the same
        // checks as the first one.
        const transferQuotes = relayerTransferQuotes(chainId);
        let outputPlan: ReturnType<typeof relayedPlan.plan>;
        const freshRelayerOption = async () => {
        transferPhaseRef.current = 'quote';
        setLoadingMessage('Getting a fresh relayer quote…');
        const selectedQuote = await requestTransferQuote(transferQuotes, inputTokenId);
        if (!selectedQuote) {
          throw new Error('No relayer quote available for this transfer.');
        }
        // The relayer takes its fee ON TOP of the sent amount (relayTransfer
        // proves with totalSpent = amount + fee), so sending the full input
        // value dies inside the SDK's proof with InsufficientTransactValue —
        // pre-broadcast, but generic enough that it used to latch the
        // unknown-outcome path and fake a success screen (QA 2026-08-17).
        // Check the quoted fee against the selected inputs HERE, before
        // proving, and fail with the actual constraint instead.
        const quotedRelayFee = transferRelayFee({ selectedQuote });
        if (forcedNow) {
          // The fee this relay spends must still leave one positive note per
          // deposit and must not exceed the fee the user reviewed.
          if (live()) setConsolidationQuotedFee(quotedRelayFee);
          const finalPlan = planConsolidation(forcedNow, quotedRelayFee);
          if (!feeWithinReviewed(quotedRelayFee, consolidationFee ?? feeBudget)) {
            throw new Error('The relayer fee increased. Review the updated quote before trying again. Nothing was sent.');
          }
          sendAmountWei = finalPlan.net;
          amountHex = `0x${sendAmountWei.toString(16)}` as Hex;
          if (bgRun) bgRun.amountHex = amountHex;
          if (live()) setSentAmountWei(sendAmountWei);
        }
        relayerFeeWei = quotedRelayFee;
        if (bgRun) bgRun.feeWei = quotedRelayFee;
        if (sendAmountWei + quotedRelayFee > selection.accumulated) {
          // DEV-490: the suggestion comes from the one-transfer cap, not from
          // the notes picked for THIS amount, which shrink with it and made
          // every retry at the suggested figure suggest a smaller one.
          // Human-sized figures: floor the retypable max (so the suggestion
          // always passes this guard) and ceil the fee (never understate it).
          // 6 dp granularity; tokens with ≤6 decimals keep exact values.
          const maxSendFloored = stableSendMax(maxSpendableWei, quotedRelayFee, selectedDecimals);
          const feeMoved = feeMovedUp(relayFeeEstimate, quotedRelayFee) ? ' The fee changed since your last quote.' : '';
          // Same shortfall wording as Pay request (Mike, #282): the fee is
          // inside "needs", costs round up, what can be used rounds down.
          const amt = (v: bigint, up: boolean) =>
            isShareSymbol(selectedSymbol) ? balanceDisplay(formatShortfallAmount(v, selectedDecimals, up, selectedSymbol), selectedSymbol, chainId).text : tokenAmountLabel(formatShortfallAmount(v, selectedDecimals, up, selectedSymbol), selectedSymbol);
          // The guard checks the notes picked for this amount, not the account:
          // only call the balance short when the one-transfer cap is short too
          // (cubic on #282).
          const opener = maxSpendableWei >= sendAmountWei + quotedRelayFee
            ? "The notes picked for this payment can't cover it."
            : "Your balance isn't high enough.";
          throw new Error(
            `${opener} This payment needs ${amt(sendAmountWei + quotedRelayFee, true)}. You can use up to ${amt(maxSpendableWei, false)}.${feeMoved} Send at most ${amt(maxSendFloored, false)}, or enter your full balance and the fee comes out of it.`,
          );
        }
        outputPlan = relayedPlan.plan(quotedRelayFee);
        return relayTransferParams({
          inputCommitments: verifiedInputCommitments,
          amount: forcedNow ? 0n : sendAmountWei,
          tokenId: inputTokenId,
          built: relayedPlan.recipient,
          selectedQuote,
        });
        };
        let relayerOption = await freshRelayerOption();
        transferPhaseRef.current = 'submit';
        setLoadingMessage('Submitting via relayer…');
        log('info', 'Transfer', 'Submitting transfer via SDK relayer', {
          relayer: relayerOption.selectedQuote.relayerInfo.name,
          processor: relayerOption.selectedQuote.relayerInfo.processorAddress,
        });
        broadcastAttempted = true;
        let transferResult: Awaited<ReturnType<typeof session.relayTransfer>> | null = null;
        relayT0 = Date.now();
        // DEV-412: relayTransfer resolves only after the SDK's receipt wait, so
        // the relayer's hash is heard as soon as it returns and the stepper
        // moves on to confirmation instead of sitting on "Submitting".
        // Only a transfer relay: a withdrawal or swap relayed meanwhile from
        // another surface must not stamp its hash on this screen. Transfers
        // themselves are one at a time (op lock + the unknown-outcome latch).
        // DEV-494: and say which wait it is. relayTransfer proves before it
        // posts, so "Submitting via relayer" covers that; once the request
        // leaves it is the relayer's wait, and once its hash is back it is the
        // block's. Step times go to the local debug log only.
        const stopHearingPost = onRelayCalled((method) => {
          if (method !== 'relayTransfer') return;
          relayTimes.postedMs = Date.now() - relayT0;
          if (live()) setLoadingMessage(RELAY_WAITING_RELAYER);
        });
        const stopHearingRelay = onRelayedTxHash((relayedHash, method) => {
          if (method !== 'relayTransfer' || !live()) return;
          relayTimes.relayerAnsweredMs = Date.now() - relayT0;
          relayRun.hash = relayedHash;
          transferPhaseRef.current = 'confirm';
          const want = relayedHash.toLowerCase();
          relayRun.stopHearing?.();
          relayRun.settled = new Promise<PendingRelayResolution>((resolve) => {
            const stop = onPendingRelaySettled((resolution) => {
              if (resolution.record.txHash !== want) return;
              stop();
              resolve(resolution);
            });
            relayRun.stopHearing = stop;
          });
          setTxHash(relayedHash as Hash);
          setTxChainId(chainId);
          transferPhaseRef.current = 'confirm';
          setLoadingMessage(RELAY_WAITING_BLOCK);
        });
        let relayCheck = expectTransferRelay(transferRelayExpectation(relayerOption.selectedQuote, verifiedInputCommitments.length, outputPlan!));
        try {
          // A refusal that sent nothing and that a fresh proof fixes (the ASP
          // root moved, or the quote ran out while proving) is re-proved here,
          // as withdraw and payment do, instead of failing the send.
          const relayed = await relayWithReprove({
            option: relayerOption,
            relay: (option) => session.relayTransfer(option),
            // A re-prove relays a new quote and change notes, so its plan is
            // armed in place of the refused one.
            refresh: async () => {
              const next = await freshRelayerOption();
              transferPhaseRef.current = 'submit';
              relayCheck.release();
              relayCheck = expectTransferRelay(transferRelayExpectation(next.selectedQuote, verifiedInputCommitments.length, outputPlan!));
              return next;
            },
            shouldContinue: live,
            sent: () => !!relayRun.hash,
            onReprove: (error, attempt) => {
              log('warn', 'Transfer', 'Relay refused before sending; re-proving', { attempt, relayMessage: error.message });
              setLoadingMessage('Nothing was sent. Re-proving your transfer…');
            },
          }).catch((relayErr: unknown) => {
            throw plainTransferRelayError(relayErr);
          });
          relayerOption = relayed.option;
          transferResult = relayed.result;
        } catch (relayErr) {
          // The relay call can fail AFTER the relayer broadcast: its HTTP
          // answer times out while the transaction mines. That used to land on
          // "outcome unknown" with the placeholder receipt, for a transfer that
          // had gone through (Mike, 2026-09-24: 5 minutes on "Submitting via
          // relayer…", both sends landed, and the link was gone from the tx
          // row because nothing was recorded). Look for the spend in the same
          // bulk data the confirmation below uses; if our inputs were spent,
          // that transaction is the answer and the normal success path runs.
          // A known non-send keeps its own handling in the catch below.
          const relayMessage = relayErr instanceof Error ? relayErr.message : String(relayErr);
          const confirmKeyAfterError = keystoreManager?.getPrivateNullifyingKey();
          if (isKnownRejection(relayMessage) || isConfirmedRevert(relayMessage) || isRelayerRefusal(relayMessage) || isRelayerOutOfGas(relayMessage)
            || isPendingRelayBlocked(relayMessage) || isRelayerNullifierInFlight(relayMessage)
            || !confirmKeyAfterError || !chainConfig?.contracts?.poolAddress) {
            throw relayErr;
          }
          setLoadingMessage('Checking whether the transfer landed…');
          const { confirmRelayedSpend: findSpend } = await import('@/services/onchain-note-index');
          const { observed: landed } = await findSpend({
            chainId,
            poolAddress: String(chainConfig.contracts.poolAddress),
            fromBlock: chainConfig.contracts.fromBlock,
            inputCommitments: verifiedInputCommitments,
            outputCommitments: expectedOutputs,
            privateNullifyingKey: confirmKeyAfterError,
            // Short: a relay that failed late has usually mined by now, and a
            // failure that never broadcast should not hold the screen 3 minutes.
            attempts: 8,
            intervalMs: 4_000,
            budgetMs: 40_000,
          }).catch(() => ({ observed: null }));
          // Only a spend whose outputs are the ones this flow built is ours; a
          // different transaction consuming the inputs stays unknown here.
          // The relayer's own hash is ours whatever the outputs say; a
          // different hash is an earlier attempt that spent the same inputs.
          const landedIsOurs = !!landed?.txHash && !!relayRun.hash && landed.txHash.toLowerCase() === relayRun.hash.toLowerCase();
          if (landed?.txHash && landed.outputsMatch === false && !landedIsOurs) relayRun.otherSpendHash = landed.txHash;
          if (!landed?.txHash || (landed.outputsMatch === false && !landedIsOurs)) throw relayErr;
          log('warn', 'Transfer', 'Relay call failed but the transfer landed', { txHash: landed.txHash, error: relayMessage });
          transferResult = { txReceipt: { txHash: landed.txHash as Hash, status: true } } as unknown as Awaited<ReturnType<typeof session.relayTransfer>>;
        } finally {
          stopHearingPost();
          stopHearingRelay();
          relayedChangeCommitment = relayCheck.outputs()?.[0] ?? null;
          relayCheck.release();
        }
        relayTimes.minedSeenMs = Date.now() - relayT0;
        hash = transferResult.txReceipt.txHash as Hash;
        sdkReceiptStatus = (transferResult.txReceipt as { status?: unknown }).status;
        log('info', 'Transfer', 'Relay tx submitted', { txHash: hash });
        console.log('[Transfer] RELAY SUBMITTED — on-chain tx:', hash);
      }
      setTxHash(hash);
      setTxChainId(chainId);
      // Relayed: the block wait is already behind us here (relayTransfer
      // resolves after it), so what is left is matching it in bulk data.
      transferPhaseRef.current = 'confirm';
      setLoadingMessage(hideAddress ? 'Confirming the transfer…' : 'Waiting for confirmation...');

      // PRIVACY: confirm from bulk chain data, NOT by polling this client's RPC
      // for the relayer's transaction hash. This is a RELAYED transfer: the
      // whole point is that the relayer's address and IP submit it, and asking
      // our own provider about that hash tells it this IP is the beneficiary.
      // The input nullifiers and the output commitments are known locally, so
      // the exact Transacted event is matched in data every client fetches
      // identically. No observation means submitted-unconfirmed, never success.
      // See services/onchain-note-index.ts and docs/privacy-request-discipline.md.
      const { confirmRelayedSpend } = await import('@/services/onchain-note-index');
      // Timestamp source for the output notes, set by whichever route confirmed.
      let outputTimestampFor: (commitment: Hash) => Hex | null = () => null;
      let confirmedBlock: string | null = null;
      if (!hideAddress) {
        // DIRECT (disclosed) transfer: this wallet broadcast the transaction
        // itself, so the RPC provider already saw it arrive from this client
        // and the receipt is the authoritative answer, revert included. No
        // relayer indirection exists here to protect; do not "fix" this into a
        // bulk wait (it would report a revert as "not visible yet").
        if (!publicClient) {
          throw new Error('No public client available, cannot confirm the transaction');
        }
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === 'reverted') {
          throw new Error('Transaction reverted on-chain');
        }
        const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        const directTs = `0x${BigInt(block.timestamp).toString(16)}` as Hex;
        outputTimestampFor = () => directTs;
        confirmedBlock = receipt.blockNumber.toString();
        log('info', 'Transfer', 'Transfer tx confirmed', { txHash: hash, via: 'wallet-receipt', blockNumber: confirmedBlock });
      } else {
        // RELAYED transfer. The SDK's relayTransfer already saw a receipt inside
        // the vendored tarball; a literal false there is a revert and ends the
        // flow before anything is recorded.
        if (sdkReceiptStatus === false) {
          throw new Error('Transaction reverted on-chain. Your notes were NOT spent.');
        }
        const confirmKey = keystoreManager?.getPrivateNullifyingKey();
        if (!confirmKey || !chainConfig?.contracts?.poolAddress) {
          throw new Error(`The transfer was submitted (tx ${hash}) but cannot be confirmed right now. It will appear in your activity once indexed; do not resend.`);
        }
        const { observed, index: spendIndex } = await confirmRelayedSpend({
          chainId,
          poolAddress: String(chainConfig.contracts.poolAddress),
          fromBlock: chainConfig.contracts.fromBlock,
          inputCommitments: verifiedInputCommitments,
          outputCommitments: expectedOutputs,
          privateNullifyingKey: confirmKey,
          // DEV-494: a receipt the block walk already built from the pool's own
          // logs is the confirmation, so the bulk match only adds the output
          // timestamps. It no longer gets the full 3-minute budget, which held
          // a landed send on this screen while the index caught up; unmatched,
          // the receipt stands (below) and the next sync dates the notes.
          ...(sdkReceiptStatus === true ? { attempts: 4, intervalMs: 3_000, budgetMs: 20_000 } : {}),
        });
        // Fallback: a receipt status the SDK reported as true is a real
        // confirmation (that wait cannot be removed on the website side) and
        // adds no request of ours.
        //
        // "Not observed yet" is NOT a failure and must NOT throw: the relayer
        // accepted the transaction and the notes are already spent, so throwing
        // here would skip the sent-record stamping below and leave the user with
        // a smaller balance and no row for where it went — an invisible
        // transfer (the class of report we chased on 2026-08-26). Warn and carry
        // on; note sync settles the row.
        if (!observed && sdkReceiptStatus !== true) {
          log('warn', 'Transfer', 'Relayed transfer not observed on-chain yet; recording it anyway', { txHash: hash });
          console.log('[Transfer] SUBMITTED, NOT YET OBSERVED — recorded so it cannot go missing:', hash);
        }
        // Conflict = our inputs were consumed by a transaction that is NOT the
        // one the relayer submitted for us (another device or a replacement
        // landed first). Decided on the observed txHash, which the chain tail
        // supplies: then this flow's recipient notes do not exist on-chain and
        // nothing below (receipt payload, sent rows, audit receipt) may be
        // recorded. The output comparison alone is NOT a conflict signal: on a
        // verified own-hash spend it still read false (2026-08-26, tx
        // 0x2061296e), so the commitments this flow holds are not the emitted
        // ones; logged for investigation, never fatal.
        const observedTx = observed?.txHash?.toLowerCase() ?? null;
        if (observed && observedTx && observedTx !== hash.toLowerCase()) {
          log('warn', 'Transfer', 'Inputs spent by a different transaction than this flow submitted', {
            submittedTxHash: hash,
            observedTxHash: observed.txHash,
          });
          throw new Error(`Your notes were spent by a different transaction (${observed.txHash}), not by this transfer. Nothing was recorded here; check your activity.`);
        }
        if (observed && observed.outputsMatch === false) {
          log('warn', 'Transfer', 'Observed outputs differ from the commitments this flow expected (same tx)', {
            txHash: hash,
            expected: expectedOutputs,
            observed: observed.outputCommitments,
          });
        }
        outputTimestampFor = (c) => spendIndex.commitmentTimestamp(c);
        confirmedBlock = observed?.blockNumber ?? null;
        relayTimes.confirmedMs = Date.now() - relayT0;
        log('info', 'Transfer', 'Transfer tx confirmed', {
          txHash: hash,
          via: observed ? 'bulk-observation' : 'sdk-receipt',
          blockNumber: confirmedBlock,
          observedTxHash: observed?.txHash ?? null,
        });
      }
      console.log('[Transfer] CONFIRMED', { txHash: hash, blockNumber: confirmedBlock });

      // Stamp local sent records only AFTER the tx confirms. On the direct
      // (disclosed) path `hash` is a pending wallet tx that can still revert;
      // recording before confirmation would leave a phantom "Transfer Out"
      // and audit receipt for a tx that never landed.
      // Stamp this txHash locally so the transactions feed can render it as a
      // Transfer Out instead of a Transfer In on our change. The ASP can't
      // tell us we were the sender — both the change and the recipient's note
      // are emitted as Note events under the same tx, and `event.label` isn't
      // a reliable discriminator.
      // The device-level action word first and on its own: a send stamp that
      // dies with a malformed sent-transfer record would leave this change note
      // free to read as Transfer In / Deposit in the lineage pass.
      try {
        recordOwnAction({ kind: forcedInputs ? 'consolidate' : 'send', chainId, txHash: String(hash).toLowerCase(), timestamp: Date.now() });
      } catch (e) {
        log('warn', 'Transfer', 'Failed to stamp own-action record', { err: e instanceof Error ? e.message : String(e) });
      }
      try {
        recordSentTransfer({
          txHash: hash,
          recipient: recipientAddress,
          rawAmount: amountHex,
          tokenAddress: inputTokenId,
          chainId,
          timestamp: Date.now(),
        });
      } catch (e) {
        log('warn', 'Transfer', 'Failed to stamp sent-transfer record', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      // Stamp the relayer fee against the same tx hash so the row detail can
      // name it. Kept in its own try so a fee-store failure can never lose the
      // sent record above, which is the one that makes the row appear at all.
      if (relayerFeeWei !== null && relayerFeeWei > 0n) {
        try {
          recordWithdrawFee({
            txHash: hash,
            feeAmount: `0x${relayerFeeWei.toString(16)}`,
            tokenAddress: inputTokenId,
            chainId,
            timestamp: Date.now(),
            kind: 'transfer',
          });
        } catch (e) {
          log('warn', 'Transfer', 'Failed to stamp relayer-fee record', {
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // Persist every recipient note's preimage (one disclosure per note —
      // a multi-lineage transfer emits several) so the sender can later
      // export per-transaction partial viewing keys (audit receipts)
      // proving this payment without their master viewing key.
      if (result.recipientDisclosures.length > 0) {
        try {
          const kept = recordSentAuditsVerified(result.recipientDisclosures.map((d) => ({
            chainId,
            txHash: hash,
            commitment: d.commitment,
            ownerAddress: d.ownerAddress,
            noteSecret: d.noteSecret,
            tokenId: d.tokenId,
            value: d.value,
            label: d.label,
          })));
          if (kept) receiptStoredRef.current = true;
          // Retire the pre-broadcast record only once the real one is proven
          // stored, so a failed re-key leaves the secret findable.
          if (kept && provisionalAuditKey) dropSentAudits(provisionalAuditKey);
        } catch (e) {
          log('warn', 'Transfer', 'Failed to stamp sent-audit records', {
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Out-of-band recipient: build the one-time receipt payload they
      // need to import. The recipient never registered a viewing key,
      // so the SDK didn't emit an encrypted Note event for them — only
      // the locally-known noteSecret can prove ownership of the new
      // commitment. Use the real txHash + block timestamp from the
      // receipt so the imported note merges cleanly with the receiver
      // wallet's NoteManager state.
      if (result.discoverable) {
        // Discoverable delivery — the recipient can find the note on-chain;
        // no one-time receipt exists, so nothing in this tab is at risk.
        setReceiptLifecycle('none');
      }
      if (!result.discoverable && result.recipientNotes.every((r) => r.noteSecret != null)) {
        try {
          // Timestamp from the bulk index, not from the relayed tx's block: it is
          // the exact block.timestamp the state tree used, and it costs no
          // request that names our transaction.
          const blockTsHex = result.recipientNotes
            .map((r) => outputTimestampFor(r.commitment as Hash))
            .find((ts): ts is Hex => ts != null);
          if (!blockTsHex) throw new Error('recipient note timestamp not yet indexed');
          // EVERY recipient note goes into the payload, each with its OWN SDK
          // value — a multi-lineage transfer emits one note per lineage, and a
          // note re-labeled with the full amount cannot recompute its
          // commitment (the receipt would be unusable and the other notes
          // would be silently lost).
          const recipientNotes = result.recipientNotes.map((r) => ({
            commitment: r.commitment,
            value: r.value,
            tokenId: r.tokenId,
            label: r.label,
            status: NoteStatus.ACTIVE,
            ownerAddress: recipientAddress as SdkAddress,
            noteSecret: r.noteSecret as Hex,
            noteAddressHash: r.noteAddressHash,
            isOwned: true,
            createdAtBlock: blockTsHex,
            spentAtBlock: null,
            txHash: hash,
          }));
          const exportPayload = { notes: recipientNotes, syncCursor: '0x0' as Hex, owner: recipientAddress as SdkAddress, chainId };
          console.log('[Transfer] ENRICHED receipt built', {
            txHash: hash,
            createdAtBlock: blockTsHex,
            commitments: recipientNotes.map((n) => n.commitment),
          });
          setRecipientImportPayload(JSON.stringify(exportPayload, null, 2));
          // Also build a shareable link the recipient can click
          // instead of copy-pasting JSON. The /import-note route
          // decodes the same payload and merges it via SDK
          // importAccount when the recipient connects their wallet.
          try {
            const { encodeNoteReceiptForUrl, buildNoteReceiptUrl } = await import(
              '@/services/note-receipt'
            );
            const encoded = encodeNoteReceiptForUrl(
              exportPayload as unknown as import('@/services/sdk-types').AccountExport,
            );
            setRecipientImportUrl(buildNoteReceiptUrl(encoded));
          } catch (urlErr) {
            log('warn', 'Transfer', 'Failed to build receipt URL', {
              err: urlErr instanceof Error ? urlErr.message : String(urlErr),
            });
          }
        } catch (err) {
          console.log('[Transfer] ENRICHMENT FAILED — success screen keeps the base (txHash 0x0) receipt', err instanceof Error ? err.message : String(err));
          log('warn', 'Transfer', 'Failed to build recipient import payload', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Mark input notes as SPENT and add change note to NoteManager
      if (noteManager) {
        for (const commitment of verifiedInputCommitments) {
          try {
            noteManager.updateNoteStatus(commitment, NoteStatus.SPENT);
            log('debug', 'Transfer', `Marked note ${truncateAddress(commitment)} as SPENT`);
          } catch (e) {
            log('error', 'Transfer', `Failed to mark note ${truncateAddress(commitment)} as SPENT`, {
              err: e instanceof Error ? e.message : String(e),
            });
          }
        }

        // The SDK's finalizeTransfer already added the change note to its internal
        // NoteManager with the correct noteSecret + ACTIVE status, and marked
        // the input note SPENT. Persist the updated SDK state to local
        // storage so it survives reload.
        try {
          await exportAccount();
        } catch (persistErr) {
          log('error', 'Transfer', 'Failed to persist SPENT note state - reload may show already-spent notes as active', persistErr);
        }
        refetchNotes();
      }

      // Refresh every page showing transactions/events/stats (codex round 1,
      // P1: a confirmed transfer never invalidated the shared query caches —
      // the activity feed and stats described the pre-transfer world until
      // their own refetch intervals fired).
      // No address filter: sdkAccountEvents is keyed by the SESSION address,
      // which differs from the payer wallet in account-key mode — the prefix
      // invalidation covers both (codex round 2).
      void invalidateTransactionCaches(queryClient);

      // No discovery pass after the transfer. The inputs are marked SPENT
      // above, so the next transfer cannot reselect one (which would revert
      // with PoolVault_NullifierAlreadySpent), and the change note is the
      // SDK's, healed below from the observed spend. The grid's discovery
      // confirms both on its own schedule; a pass timed to this relayed spend
      // would tie this client to it.
      if (live()) setLoadingMessage('Transfer confirmed. Updating your balance…');

      // Heal local note state directly off the observed spend. Without it the
      // change note keeps its placeholder `txHash: "0x0"` and the input notes
      // never get a `spentAtBlock` stamp. Both placeholders break the
      // My Transactions filter (txHash mismatch) and the In/Out
      // classifier (no spentAtBlock to compare against tx.timestamp),
      // so the row appears as a stranger's "Transfer" instead of the
      // user's "Transfer Out". Patching deterministically here closes
      // the gap immediately, and a later discovery pass re-confirms
      // the same values.
      const changeCommitment = (result.changeCommitment as Hash | null) ?? relayedChangeCommitment;
      // Without the checked proof's outputs there is no change note to heal;
      // say so rather than skip it silently.
      if (!disclosed && !relayedChangeCommitment) log('warn', 'Transfer', 'Relay check read no outputs; skipping the change-note heal');
      if (noteManager && changeCommitment) {
        try {
          const blockTsHex = outputTimestampFor(changeCommitment);
          if (!blockTsHex) throw new Error('change note timestamp not yet indexed');
          const nm = noteManager as unknown as {
            getNote: (c: Hash) => Note;
            deleteNote: (c: Hash) => void;
            addNote: (n: Note) => void;
          };
          // Heal the change note (txHash + createdAtBlock placeholders).
          try {
            const existing = nm.getNote(changeCommitment);
            if (existing.txHash === '0x0' || existing.createdAtBlock === '0x0') {
              nm.deleteNote(changeCommitment);
              nm.addNote({
                ...existing,
                txHash: hash as Hash,
                createdAtBlock: blockTsHex,
              });
              log('debug', 'Transfer', 'Healed change note from receipt');
            }
          } catch (changeErr) {
            log('debug', 'Transfer', 'Change note not in NoteManager. Skipping heal', {
              err: changeErr instanceof Error ? changeErr.message : String(changeErr),
            });
          }
          // Heal each spent input's spentAtBlock.
          for (const commitment of verifiedInputCommitments) {
            try {
              const existing = nm.getNote(commitment);
              if (existing.spentAtBlock == null) {
                nm.deleteNote(commitment);
                nm.addNote({ ...existing, spentAtBlock: blockTsHex });
              }
            } catch (inputErr) {
              log('debug', 'Transfer', `Spent input ${truncateAddress(commitment)} not found. Skipping heal`, {
                err: inputErr instanceof Error ? inputErr.message : String(inputErr),
              });
            }
          }
          try {
            await exportAccount();
          } catch (persistErr) {
            log('error', 'Transfer', 'Failed to persist healed note state - reload may show stale transfer notes', persistErr);
          }
          refetchNotes();
        } catch (healErr) {
          log('warn', 'Transfer', 'Post-transfer heal failed; relying on next discovery pass', {
            err: healErr instanceof Error ? healErr.message : String(healErr),
          });
          refetchNotes();
        }
      } else {
        refetchNotes();
      }

      if (relayT0) log('info', 'Transfer', 'Relayed transfer timing', { ...relayTimes, successMs: Date.now() - relayT0 });
      // Terminal UI transition belongs to the modal session that started this
      // run (codex): a stale run must not repaint a reopened modal, though its
      // receipt/note/cache writes above always land.
      if (live()) setStep('success');
      // Notify any opener (e.g. Payroll) only once the transfer is confirmed —
      // with what was ACTUALLY sent, so the caller can verify it matches its row.
      try { onSent?.(hash, { chainId, tokenSymbol: selectedSymbol, amount, recipient: recipientAddress }); } finally { if (transferOnSentRef.current === onSent) transferOnSentRef.current = null; }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'Transfer', 'Transfer failed', { err: message });

      // Outcome classification (codex round 3): only a GENUINELY UNKNOWN
      // out-of-band submission latches retries. Known outcomes must not:
      //  - a wallet rejection provably never reached the chain;
      //  - a confirmed on-chain revert is a known non-send;
      //  - a discoverable transfer has no one-time receipt to protect, so
      //    latching it just bricked retries forever (its lifecycle stays
      //    'none', which the clearing effect never touches).
      // 'Insufficient value for transact' is the SDK's input-validation
      // throw during (re-)proving — always PRE-broadcast, so it must never
      // latch the unknown-outcome path (it faked a success screen with a
      // dead base receipt, QA 2026-08-17). Same for our own fee-guard text.
      // FeeCommitmentExpired and the feeCommitment-asset mismatch are also
      // thrown by relayTransfer BEFORE its HTTP POST (verified in the pinned
      // SDK dist; GLM review) — provably pre-broadcast, never indeterminate.
      const knownRejection = isKnownRejection(message);
      const confirmedRevert = isConfirmedRevert(message);
      /*
       * The relayer refused to submit, which is a KNOWN non-send.
       *
       * It answers 400 with the revert its own eth_call hit, e.g. "PoolVault
       * transact failed: The contract function \"transact\" reverted.
       * (PoolVault_ProofContextMismatch)". Nothing was broadcast and no note was
       * spent, so there is nothing for the recipient to claim.
       *
       * broadcastAttempted cannot tell this apart: it is set immediately before
       * relayTransfer, so a refusal at the far end still looks like a handover.
       * Without this the run landed in the unknown-outcome bucket and was shown
       * the deliberate base receipt (txHash 0x0) — a one-time receipt, framed as
       * unrecoverable, for a transfer that never happened, whose link cannot
       * claim anything (Artem, OP mainnet, 2026-08-20).
       *
       * Distinct from confirmedRevert above, which is OUR wording for a
       * transaction that did land and then reverted on-chain.
       */
      const relayerRefused = isRelayerRefusal(message);
      // Same non-send shape: the relayer answered 400 because its own signer
      // cannot pay for the relay (DEV-400). Checked HERE, not only below: a run
      // that had already armed the one-time receipt would otherwise take the
      // unknown-outcome branch and show a receipt for a transfer that never
      // left (codex, 2026-09-04).
      const relayerOutOfGas = isRelayerOutOfGas(message);
      // The same funds are already in flight, refused here or by the relayer:
      // nothing of THIS attempt was sent.
      const pendingBlocked = isPendingRelayBlocked(message);
      const relayerInFlight = isRelayerNullifierInFlight(message);
      const hadOneTimeReceipt = receiptLifecycleRef.current === 'at-risk';
      // The bulk index and the pending-relay settle can both find the send; stamp it once.
      const stamped = new Set<string>();
      const stampLanded = async (landedHash: string, run: NonNullable<typeof bgRun>, pendingAuditKey: string | null) => {
        if (stamped.size > 0) return;
        stamped.add(landedHash);
        log('info', 'Transfer', 'Unresolved transfer observed on-chain', { txHash: landedHash });
        // The screen only if it still shows this run; the records either way.
        if (live()) {
          setTxHash(landedHash as Hash);
          setTxChainId(chainId);
          setOutcomeUnknown(false);
        }
        // The rest of what the success path stamps, so the late-found send
        // reads as this user's own Transfer Out and its launcher hears it.
        try {
          recordOwnAction({ kind: forcedInputs ? 'consolidate' : 'send', chainId, txHash: String(landedHash).toLowerCase(), timestamp: Date.now() });
        } catch (e) {
          log('warn', 'Transfer', 'Failed to stamp own-action record', { err: e instanceof Error ? e.message : String(e) });
        }
        try {
          recordSentTransfer({
            txHash: landedHash,
            recipient: recipientAddress,
            rawAmount: run.amountHex,
            tokenAddress: run.tokenId,
            chainId,
            timestamp: Date.now(),
          });
          // Same fee stamp as the success path, so the row and the
          // accounting export name the fee of a late-found send too.
          if (run.feeWei !== undefined && run.feeWei > 0n) {
            recordWithdrawFee({
              txHash: landedHash,
              feeAmount: `0x${run.feeWei.toString(16)}`,
              tokenAddress: run.tokenId,
              chainId,
              timestamp: Date.now(),
              kind: 'transfer',
            });
          }
          if (run.disclosures.length > 0) {
            const kept = auditStore.recordSentAuditsVerified(run.disclosures.map((d) => ({ ...d, txHash: landedHash as Hash })));
            // The pre-broadcast record (DEV-413) is retired only once the real one reads back.
            if (kept && pendingAuditKey) auditStore.dropSentAudits(pendingAuditKey);
          }
        } catch (e) {
          log('warn', 'Transfer', 'Failed to stamp records for the observed transfer', {
            err: e instanceof Error ? e.message : String(e),
          });
        }
        // The landed spend consumed these inputs: mark them so the next send
        // cannot reselect one. The change note this attempt never got to
        // register comes from the grid's discovery, not from a pass timed to
        // this spend landing.
        const manager = getCommittedManagers().noteManager ?? noteManager;
        if (manager) {
          for (const commitment of run.inputs) {
            try {
              if (String(manager.getNote(commitment).status) === NoteStatus.ACTIVE) {
                manager.updateNoteStatus(commitment, NoteStatus.SPENT);
              }
            } catch { /* not held here, or already settled */ }
          }
          try { await exportAccount(); } catch { /* the next discovery pass persists it */ }
        }
        refetchNotes();
        try { onSent?.(landedHash, { chainId, tokenSymbol: selectedSymbol, amount, recipient: recipientAddress }); } finally { if (transferOnSentRef.current === onSent) transferOnSentRef.current = null; }
      };
      if (!broadcastAttempted || knownRejection || confirmedRevert || relayerRefused || relayerOutOfGas || pendingBlocked || relayerInFlight) {
        setReceiptLifecycle('none');
        // A known non-send: nothing on chain for the pre-broadcast record to claim.
        if (provisionalAuditKey) dropSentAudits(provisionalAuditKey);
      } else if (hadOneTimeReceipt) {
        console.log('[Transfer] OUTCOME UNKNOWN after broadcast — success screen shows the BASE (txHash 0x0) receipt. Error was:', message);
        // The latch is global on purpose: an unknown-outcome broadcast must
        // block further sends regardless of which modal session is showing.
        setIndeterminateAttempt(true);
        setOutcomeUnknown(true);
        // DEV-412: keep looking for the spend in the bulk index (never by
        // hash). Found with this flow's outputs → the header says so, with
        // the real hash; not found → it stays "outcome unknown".
        const bgKey = keystoreManager?.getPrivateNullifyingKey();
        const bgPool = chainConfig?.contracts?.poolAddress;
        const run = bgRun;
        const pendingAuditKey = provisionalAuditKey;
        // The relayer's own hash seen spent settles it too, outputs aside.
        if (relayRun.hash && run) {
          relayRun.keepHearing = true;
          const settledOurs = (resolution: PendingRelayResolution) => {
            const landed = landedTxHash(resolution);
            if (landed) {
              void stampLanded(landed, run, pendingAuditKey).catch(() => { /* stays unknown */ });
              return;
            }
            if (!resolution.spent) {
              // Reverted: nothing was sent, so the pre-broadcast record has
              // nothing to protect and the retry latch must release — without
              // this a revert left the screen reading "outcome unknown"
              // forever, blocking every further send of these notes.
              if (provisionalAuditKey) dropSentAudits(provisionalAuditKey);
              if (live()) {
                setIndeterminateAttempt(false);
                setOutcomeUnknown(false);
                setStep('review');
                reportTransferError('The relayed transfer reverted on-chain. Nothing was sent and your balance is unchanged. Review again to build a fresh proof.');
              }
              return;
            }
            // A different, known transaction spent these notes: this attempt
            // never landed, so show it as already spent rather than leaving
            // the "outcome unknown" banner up.
            if (live()) {
              setTxHash(resolution.spentBy as Hash);
              setTxChainId(chainId);
              setOutcomeUnknown(false);
              setRelayPending('other-spend');
            }
          };
          void relayRun.settled?.then(settledOurs);
        }
        if (bgKey && bgPool && run) {
          void (async () => {
            const { confirmRelayedSpend: findLanded } = await import('@/services/onchain-note-index');
            const { observed } = await findLanded({
              chainId,
              poolAddress: String(bgPool),
              fromBlock: chainConfig!.contracts!.fromBlock,
              inputCommitments: run.inputs,
              outputCommitments: run.outputs,
              privateNullifyingKey: bgKey,
            });
            if (!observed?.txHash || observed.outputsMatch === false) return;
            await stampLanded(observed.txHash, run, pendingAuditKey);
          })().catch(() => { /* stays unknown */ });
        }
        // Show the receipt + copy controls IMMEDIATELY (codex round 3: the
        // retry-refusal message said "copy the receipt shown" while Review
        // renders no receipt — it only appeared after close/reopen).
        if (live()) { setStep('success'); reportTransferError(null); }
        return;
      } else if (relayRun.hash && bgRun && (isRelayWaitTimeout(message) || relayRun.otherSpendHash)) {
        // DEV-458: the relayer broadcast this send and it has not been seen
        // in a block yet. It can still land, so it is pending, not failed,
        // and the pending-relay record keeps the same notes from being
        // relayed again until it settles.
        log('warn', 'Transfer', 'Relayed transfer not confirmed within the wait; keeping it pending', { err: message });
        const run = bgRun;
        const pendingAuditKey = provisionalAuditKey;
        const settle = (resolution: PendingRelayResolution) => {
          if (!resolution.spent) {
            // Mined and reverted: nothing was spent.
            if (live()) {
              setRelayPending(null);
              setStep('review');
              reportTransferError('The relayed transfer reverted on-chain. Nothing was sent and your balance is unchanged. Review again to build a fresh proof.');
            }
            return;
          }
          const landed = landedTxHash(resolution);
          if (!landed) {
            if (live()) {
              setTxHash(resolution.spentBy as Hash);
              setRelayPending('other-spend');
            }
            return;
          }
          if (live()) setRelayPending(null);
          void stampLanded(landed, run, pendingAuditKey).catch(() => { /* the snapshot reconciles the rows */ });
        };
        if (relayRun.otherSpendHash) {
          if (live()) {
            setTxHash(relayRun.otherSpendHash as Hash);
            setTxChainId(chainId);
            setRelayPending('other-spend');
            setStep('success');
            reportTransferError(null);
          }
          return;
        }
        relayRun.keepHearing = true;
        // A record expires without settling; stop listening then.
        const stopListening = relayRun.stopHearing;
        const expiry = setTimeout(() => stopListening?.(), PENDING_RELAY_TTL_MS);
        relayRun.stopHearing = () => { clearTimeout(expiry); stopListening?.(); };
        void relayRun.settled?.then((resolution) => { clearTimeout(expiry); settle(resolution); });
        if (live()) {
          setRelayPending('pending');
          setTxChainId(chainId);
          setStep('success');
          reportTransferError(null);
        }
        return;
      }

      if (pendingBlocked || relayerInFlight) {
        if (live()) {
          setStep('review');
          reportTransferError(pendingBlocked ? message : relayInFlightMessage('transfer'));
        }
        return;
      }

      if (knownRejection) {
        // The fee/balance guard and an expired quote carry what actually
        // happened — show it, not the generic wallet-rejection line.
        const carriesOwnText = /Insufficient value for transact|exceeds your available balance|balance isn't high enough|can't cover it/i.test(message)
          || message === TRANSFER_QUOTE_EXPIRED_MESSAGE;
        if (live()) {
          setStep('review');
          reportTransferError(carriesOwnText ? shownError(err) : 'Transaction was rejected.', err, 'relay');
        }
        return;
      }

      // The SDK rejects transfers to recipients with no on-chain viewing key
      // unless out-of-band delivery is explicitly opted into. Surface a plain
      // explanation instead of the raw "pass allowOutOfBandFallback" message
      // (QA-9) — the user reaches this only if the unregistered-recipient
      // consent state didn't carry through.
      if (message.includes('allowOutOfBandFallback') || message.includes('no on-chain viewing key')) {
        if (!live()) return;
        setStep('review');
        reportTransferError(
          isConsolidating
            ? 'Complete keystore registration and publish your viewing key on this network before consolidating notes.'
            : 'This recipient hasn’t registered an on-chain viewing key, so the transfer can only be delivered out-of-band (you share a receipt link with them afterwards). Re-check the recipient and confirm the out-of-band prompt to continue.',
        );
        return;
      }

      if (relayerRefused) {
        // Say what happened and what is true of their money, then leave them on
        // Review where a fresh proof is one press away. The raw revert name is
        // kept: it is what the relayer said, and it is what a bug report needs.
        if (live()) {
          setStep('review');
          reportTransferError(
            `The relayer would not submit this transfer: ${message.split('\n')[0]}. Nothing was sent, no note was spent, and your balance is unchanged. Review again to build a fresh proof.`,
          );
        }
        return;
      }

      // DEV-370: a quote failure is an outage in an OPTIONAL dependency, and
      // calling it "Transfer failed" tells the user their money moved and broke
      // when nothing was attempted at all. Name the relayer, say what is true of
      // their balance, and point at the way out — which is real now that the
      // disclosed path needs no relayer.
      // The relayer answered but its signer cannot pay for the relay
      // (DEV-400): nothing was broadcast, so this is the same non-send shape
      // as unreachable, with the relayer named as the cause.
      if (relayerOutOfGas) {
        if (live()) {
          setStep('review');
          reportTransferError(relayerOutOfGasMessage('transfer'));
        }
        return;
      }
      if (isRelayerRateLimited(message)) {
        if (live()) {
          setStep('review');
          reportTransferError(relayerRateLimitedMessage('transfer'));
        }
        return;
      }
      if (isRelayerUnreachable(message)) {
        if (live()) {
          setStep('review');
          reportTransferError(
            `Could not reach the relayer to price this transfer, so nothing was sent and your balance is unchanged. Try again in a moment. (${message.split('\n')[0]})`,
          );
        }
        return;
      }

      if (live()) {
        reportTransferError(`Transfer failed: ${shownError(err)}`, err, 'relay');
        setStep('review');
      }
    } finally {
      if (!relayRun.keepHearing) relayRun.stopHearing?.();
      endTx();
    }
  }, [
    isSui, isStellar, suiSession, stellarSession, stellarActiveNotes, altDecimals,
    ensureInitialized, connectedAddress, amount, selectedSymbol, recipientAddress,
    hideAddress, relayFeeEstimate, maxSpendableWei, sendTransactionAsync, walletAddress, sendExactActive,
    selectedNoteCommitments, enteredAmountWei, selectedTokenId, chainId, forcedInputs, feeDisplayGrain, selectedDecimals,
    transfer, prepareRelayed, log, noteManager, keystoreManager,
    activeNotes, selectedDecimals, recipientIsRegistered, recipientRegistrationCheck,
    refetchNotes,
    exportAccount, publicClient,
    beginTx, endTx,
    indeterminateAttempt, isConsolidating, consolidationError, consolidationFee,
  ]);

  // Same-tick double-press guard — see hooks/use-op-lock.ts.
  const handleConfirm = useMemo(() => withOpLock(handleConfirmUnlocked), [withOpLock, handleConfirmUnlocked]);

  // Note selection toggle — enforce same tokenId across all selected notes
  const toggleNoteSelection = useCallback((commitment: Hash) => {
    setSelectedNoteCommitments((prev) => {
      if (prev.includes(commitment)) {
        return prev.filter((c) => c !== commitment);
      }
      // When adding a note, check if its tokenId matches the already-selected notes
      const noteToAdd = activeNotes.find((n) => n.commitment === commitment);
      if (!noteToAdd) return prev;
      if (prev.length > 0) {
        const firstSelected = activeNotes.find((n) => n.commitment === prev[0]);
        if (firstSelected && String(noteToAdd.tokenId).toLowerCase() !== String(firstSelected.tokenId).toLowerCase()) {
          // Different token — replace selection with only this note
          return [commitment];
        }
      }
      return [...prev, commitment];
    });
  }, [activeNotes]);

  // Modal open/close
  // Inline mode: the hub's amount input IS the transfer amount.
  const syncInlineAmount = useCallback((text: string) => {
    setAmount(sanitizeAmountInput(text, selectedDecimals));
  }, [selectedDecimals]);
  // Inline mode: the hub's pool pill IS the spent asset. Only a symbol this
  // chain's Send offers, which the snap effect above also requires, so the two
  // cannot hand a token back and forth. Recipient and toggles are left alone.
  const syncInlineToken = useCallback((symbol: string) => {
    if (isSui) return;
    const meta = sourceTokens.find((t) => t.symbol === symbol);
    if (!meta) return;
    setSelectedToken(symbol);
    setAmount((a) => sanitizeAmountInput(a, meta.decimals));
  }, [isSui, sourceTokens]);

  // Native mock mode: no real flow starts from the pretend account.
  const blockMockFlow = useNativeMockBlock();
  const openTransferModal = useCallback((prefill?: TransferPrefill) => {
    // A new flow never inherits the last one's stage (a stale 'confirm' would
    // mark a pre-send error as broadcast).
    transferPhaseRef.current = 'unknown';
    if (blockMockFlow()) return;
    if (isOpen && isConsolidating) return;
    // The wallet-picker and seed-derivation gates are EVM session concerns; the
    // Sui session derives its keys from a wallet signature at submit time.
    if (!isSui) {
      // Disconnected → open the wallet picker instead of a dead modal (QA-4).
      // NOT for inline (hub) opens: the hub gates on the UNIFIED connection
      // while this check reads raw wagmi, and during a wallet reconnect the
      // mismatch silently swallowed the auto-open (Send tab showed only the
      // amount card, at random). The inline form is not a dead modal — its
      // CTA re-checks the connection.
      if (!prefill?.inline && !ensureConnected()) return;
      // Keys not derived yet → one-time signature first, then continue here.
      if (!keysReadyRef.current && identityMode !== 'key' && !prefill?.inline) {
        openSeedDerivationModal({ onSigned: () => openTransferModal(prefill) });
        return;
      }
    }
    // An unsecured one-time receipt is still pending from a previous send —
    // reopen straight onto the success/receipt screen instead of wiping the
    // only copy of the recipient's note secret.
    if (receiptLifecycleRef.current === 'at-risk'
      && receiptOwnerRef.current !== null
      && receiptOwnerRef.current === currentIdentityRef.current) {
      setStep('success');
      setInlinePreferred(!!prefill?.inline);
      setIsOpen(true);
      log('debug', 'Transfer', 'Transfer modal reopened onto pending unsecured receipt');
      return;
    }
    const forcedFromPrefill = prefill?.inputCommitments && prefill.inputCommitments.length >= 2 ? prefill.inputCommitments : null;
    if (forcedFromPrefill && (isSui || !connectedAddress)) return;
    const consolidationToken = forcedFromPrefill && prefill?.tokenSymbol
      ? getTokenMetadataBySymbol(prefill.tokenSymbol, activeEvmChainId) : null;
    if (forcedFromPrefill && !consolidationToken) return;
    opEpochRef.current += 1;
    setStep('select-notes');
    setReceiveExact(true); // DEV-229 parity: fee-on-top is the default per open
    setSentAmountWei(null); // a fresh open has not sent anything yet
    setSentUnits(null);
    setSelectedNoteCommitments([]);
    setConsolidationQuotedFee(null);
    setUnavailableConsolidationInputs([]);
    setConsolidationContext(forcedFromPrefill && connectedAddress && consolidationToken
      ? { chainId, owner: connectedAddress.toLowerCase(), tokenId: consolidationToken.address.toLowerCase(), fromAssetList: prefill?.fromAssetList } : null);
    setForcedInputs(forcedFromPrefill);
    setConsolidateSeed(forcedFromPrefill && !prefill?.amount ? 'total' : 'done');
    setAmount(prefill?.amount ?? '');
    // Back from a private swap-send that did not settle: the form returns as it
    // was handed off, recipient and "receive as" included. Never a fresh form
    // that reads as a plain same-asset send (Mike, #219 QA).
    const swapSendDraft = !forcedFromPrefill && prefill?.inline && !prefill?.recipient?.trim()
      ? takeSwapSendDraft(chainId, currentIdentityRef.current) as { recipient: string; receiveAsset: SwapTokenInfo } | null
      : (clearSwapSendDraft(), null);
    const prefilledRecipient = forcedFromPrefill ? connectedAddress! : swapSendDraft?.recipient ?? prefill?.recipient?.trim() ?? '';
    recipientInputRef.current = prefilledRecipient;
    setRecipientInput(prefilledRecipient);
    // Chain-aware, same rules as typing into the field.
    const prefilledValid = isStellar
      ? /^G[A-Z2-7]{55}$/.test(prefilledRecipient)
      : isSui
        ? /^0x[0-9a-fA-F]{64}$/.test(prefilledRecipient)
        : isAddress(prefilledRecipient, { strict: false });
    setRecipientAddress(prefilledRecipient && prefilledValid ? prefilledRecipient : '');
    setResolvedRecipientName(null);
    setRecipientEnsResolving(false);
    setRecipientEnsError(null);
    // Receive-as is a per-send choice, and a picker left open from a previous
    // send must not be showing over the fresh form.
    setReceiveAsset(swapSendDraft?.receiveAsset ?? null);
    setSendChainId(chainId);
    setReceiveSelectorOpen(false);
    // Sui transfers are always SUI — ignore EVM token prefills from launchers.
    // Registry-validate the prefill (codex round 2): an unknown symbol fell
    // through to the native-sentinel fallback and would spend the native
    // asset under the prefill's label (e.g. a USDC payroll row on Citrea
    // selecting cBTC notes).
    if (prefill?.tokenSymbol && !isSui) {
      if (getTokenMetadataBySymbol(prefill.tokenSymbol, activeEvmChainId)) {
        setSelectedToken(prefill.tokenSymbol);
      } else {
        // FAIL CLOSED (codex): keeping the previous/default token under a
        // rejected prefill silently substitutes the asset the caller asked
        // for. Surface it; the user picks explicitly.
        reportTransferError(`${displayTokenSymbol(prefill.tokenSymbol)} is not available on this network. Pick a token manually.`);
        // The amount was typed in THAT token's units; leaving it under the
        // previous token's pill would show a figure in the wrong asset.
        setAmount('');
      }
    }
    transferOnSentRef.current = prefill?.onSent ?? null;
    setRelayPending(null);
    setOutcomeUnknown(false);
    setTxHash(null);
    setTxChainId(null);
    if (!prefill?.tokenSymbol || isSui || getTokenMetadataBySymbol(prefill.tokenSymbol, activeEvmChainId)) reportTransferError(null);
    setRecipientImportPayload(null);
    setRecipientImportUrl(null);
    setReceiptLifecycle('none');
    setCopiedPayload(false);
    setCopiedUrl(false);
    setRecipientIsRegistered(null);
    setRecipientRegistrationCheck(null);
    setKeystoreCheckPending(false);
    setInlinePreferred(!forcedFromPrefill && !!prefill?.inline);
    setIsOpen(true);
    log('debug', 'Transfer', 'Transfer modal opened', { prefilled: !!prefill });
  }, [blockMockFlow, log, ensureConnected, identityMode, openSeedDerivationModal, isSui, isStellar, activeEvmChainId, chainId, reportTransferError, connectedAddress, isOpen, isConsolidating]);

  const showConsolidationAssets = useCallback(() => {
    setConsolidationContext(null);
    setForcedInputs(null);
    reportTransferError(null);
    setStep('choose-asset');
  }, [reportTransferError]);
  const openConsolidation = useCallback(() => {
    if (blockMockFlow() || (isOpen && isConsolidating)) return;
    opEpochRef.current += 1;
    setInlinePreferred(false);
    showConsolidationAssets();
    setIsOpen(true);
  }, [blockMockFlow, isOpen, isConsolidating, showConsolidationAssets]);

  const closeTransferModal = useCallback(() => {
    // A picker left open would otherwise survive the flow it belongs to.
    opEpochRef.current += 1;
    setReceiveSelectorOpen(false);
    setIsOpen(false);
    setInlinePreferred(false);
    // Secured receipt → drop the sensitive payload from memory. An UNSECURED
    // receipt is deliberately kept (guard stays armed; reopening the modal
    // returns to the receipt screen) — it is the only copy of the secret.
    if (receiptLifecycleRef.current === 'secured') {
      setRecipientImportPayload(null);
      setRecipientImportUrl(null);
      setReceiptLifecycle('none');
    }
    log('debug', 'Transfer', 'Transfer modal closed');
  }, [log]);

  // The user-facing close (Done, X, backdrop, Escape, back). With an
  // uncopied one-time receipt on screen, closing used to keep the receipt and
  // reopen onto it, so Done read as a dead button (DEV-487). It asks instead.
  const requestCloseTransferModal = useCallback(() => {
    if (step === 'success' && needsLeaveConfirm({
      link: recipientImportUrl ?? recipientImportPayload,
      copied: receiptLifecycleRef.current !== 'at-risk',
    })) {
      setReceiptLeaveOpen(true);
      return;
    }
    closeTransferModal();
  }, [step, recipientImportUrl, recipientImportPayload, closeTransferModal]);
  const copyPendingReceipt = useCallback(async (): Promise<boolean> => {
    const value = recipientImportUrl ?? recipientImportPayload;
    if (!value) return false;
    const { copyText } = await import('@/services/copy-text');
    if (!(await copyText(value))) return false;
    receiptLifecycleRef.current = 'secured';
    setReceiptLifecycle((prev) => (prev === 'at-risk' ? 'secured' : prev));
    return true;
  }, [recipientImportUrl, recipientImportPayload]);
  // Leave (copied or not): drop the receipt from this screen and close, so
  // the hub reopens on a new, empty Send form. Leaving uncopied is a choice
  // the confirm has already put to the user, with the recovery route named.
  const leavePendingReceipt = useCallback(() => {
    setReceiptLeaveOpen(false);
    receiptLifecycleRef.current = 'secured';
    setReceiptLifecycle((prev) => (prev === 'at-risk' ? 'secured' : prev));
    closeTransferModal();
  }, [closeTransferModal]);

  // Signing out drops a settled send with the rest of the widget, so signing
  // back in opens an empty Send form rather than the previous success screen.
  const signedInRef = useRef(!!connectedAddress);
  useEffect(() => {
    const signedOut = signedInRef.current && !connectedAddress;
    signedInRef.current = !!connectedAddress;
    if (!signedOut) return;
    setReceiptLeaveOpen(false);
    receiptLifecycleRef.current = 'none';
    receiptOwnerRef.current = null;
    setReceiptLifecycle('none');
    setRecipientImportPayload(null);
    setRecipientImportUrl(null);
    setCopiedPayload(false);
    setCopiedUrl(false);
    setStep((prev) => (prev === 'success' ? 'select-notes' : prev));
  }, [connectedAddress]);

  useEffect(() => {
    if (!isOpen || Platform.OS !== 'web') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestCloseTransferModal();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, requestCloseTransferModal]);
  useBackHandler(isOpen, requestCloseTransferModal);

  // Frozen chain decides BOTH the URL and the label — branching on live isSui
  // sends an EVM hash to a /txblock/ URL after a post-submit chain switch (codex).
  const explorerChainId = txChainId ?? (isStellar ? STELLAR_TESTNET_ID : isSuiChain ? SUI_TESTNET_ID : chainId);
  const explorerIsSui = explorerChainId === SUI_TESTNET_ID;
  const explorerUrl = txHash
    ? (explorerIsSui
      ? `${getChainConfig(SUI_TESTNET_ID)?.explorerUrl ?? 'https://testnet.suivision.xyz'}/txblock/${txHash}`
      : getExplorerTxUrl(explorerChainId, txHash))
    : '';
  // The amount the RECIPIENT gets, which is what every confirmation surface
  // should name: in send-exact mode the typed figure is the debit, not the
  // delivery, and showing the typed figure on the review and success screens
  // would overstate what was sent.
  const amountField = useShareAmountField({ amount, symbol: selectedSymbol, chainId, maxSharesExact: formatUnits(maxSpendableWei, selectedDecimals), capKnown: !isLoadingNotes, onAmountResolved: setAmount, underlyingEntry: !isSui });
  const transferAmountFormatted = sentAmountWei != null
    // Gross mode nets an ESTIMATED fee until the relayer's binding fee is
    // known at relay time; the marker says so (codex #1/#2).
    ? `${sendExactActive ? '~' : ''}${balanceDisplay(formatUnits(sentAmountWei, sentUnits?.decimals ?? selectedDecimals), sentUnits?.symbol ?? selectedSymbol, explorerChainId).text}`
    : sendExactActive
      ? balanceDisplay(formatUnits(recipientAmountWei, selectedDecimals), selectedSymbol, chainId).text
      : balanceDisplay(amount || '0', selectedSymbol, chainId).text;

  // A settled send must not leave its amount in the form. `amount` feeds the
  // "Recipient receives" card, and openTransferModal was the ONLY thing that
  // ever reset it — so every way back to the form that does not go through a
  // fresh open (Done then the hub's auto-reopen, and the at-risk-receipt
  // branch, which returns early before the reset) left the settled figure
  // standing there. Reported 2026-08-24: the hub had cleared its own copy, so
  // the pay card read 0 while the receive card still read the amount just
  // sent. Cleared on the EDGE only, so an amount typed for the NEXT send is
  // never wiped from under the user.
  const sendSettledRef = useRef(false);
  useEffect(() => {
    if (step !== 'success') { sendSettledRef.current = false; return; }
    if (sendSettledRef.current) return;
    sendSettledRef.current = true;
    // Latch BEFORE releasing: transferAmountFormatted is this render's value,
    // still describing the send that just landed.
    setSettledAmountFormatted(transferAmountFormatted);
    setAmount('');
  }, [step, transferAmountFormatted]);

  const TransferShell = consolidationShell ? ConsolidationShell : OpShell;

  return (
    <TransferModalContext.Provider value={{ openTransferModal, closeTransferModal, isOpen, isConsolidating: consolidationShell, openConsolidation, inlineActive: isOpen && inlineHubActive, syncInlineAmount, inlineToken: selectedToken, syncInlineToken, maxSend, getTransferMaxWei, inlineStep: step, inlineAmount: amount }}>
      {children}
      <LinkLeaveConfirm
        visible={receiptLeaveOpen}
        copy={txChainId === SUI_TESTNET_ID && !recipientImportUrl ? SUI_RECEIPT_LEAVE : receiptLeaveCopy(receiptStoredRef.current)}
        onCopy={copyPendingReceipt}
        onLeave={leavePendingReceipt}
        onCancel={() => setReceiptLeaveOpen(false)}
        testID="receipt-leave-confirm"
      />
      {isOpen && (
        <TransferShell
          inline={inlineHubActive}
          isSheet={isSheet}
          isDark={isDark}
          sheetAnim={sheetAnim}
          onClose={requestCloseTransferModal}
          cardClassName={`relative items-center overflow-hidden border border-border bg-card-background ${step === 'select-notes' ? 'gap-[16px]' : 'gap-[20px]'} ${(step === 'loading' || step === 'success') ? 'justify-center' : ''} ${
            isSheet
              ? 'w-full max-w-full rounded-t-card rounded-b-none border-b-0 mb-0 px-[16px] py-[24px] pt-[28px]'
              : isMobile
                ? 'w-[95%] max-w-[95%] rounded-card px-[16px] py-[24px]'
                : `w-[504px] max-w-[95%] rounded-card ${step === 'select-notes' ? 'px-[24px] py-[36px]' : 'p-[40px]'}`
          }`}
        >
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isSheet && !inlineHubActive && !consolidationShell && <View className="absolute top-[10px] self-center w-[44px] h-[4px] rounded-[2px] z-[10]" style={{ backgroundColor: colors.border }} />}
            {/* Close Button — hidden inline: the hub's tabs are the exit. */}
            {!inlineHubActive && !consolidationShell && (
              <>
                <Pressable className="absolute top-[11px] right-[11px] w-[24px] h-[24px] items-center justify-center z-[10]" onPress={requestCloseTransferModal}>
                  <CloseIcon color={colors.text} />
                </Pressable>
              </>
            )}

            {step === 'choose-asset' && (
              <ConsolidationAssetList onStart={openTransferModal} onClose={requestCloseTransferModal} />
            )}

            {/* Step: Select Notes */}
            {step === 'select-notes' && isConsolidating && (
              <ConsolidationPanel
                groups={consolidationContextError ? [] : consolidationNoteGroups}
                selected={forcedInputs ?? []} fee={consolidationFee}
                decimals={selectedDecimals} symbol={selectedSymbol}
                error={consolidationContextError ?? transferError}
                onChange={changeConsolidationSelection}
                onReview={() => { if (!consolidationError) { reportTransferError(null); setStep('review'); } }}
                onClose={requestCloseTransferModal}
                onBack={consolidationContext?.fromAssetList ? showConsolidationAssets : undefined}
              />
            )}
            {step === 'select-notes' && !isConsolidating && (
              <>
                {/* Title — hidden inline: the hub tab bar already says Send. */}
                {!inlineHubActive && (<>
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Send Privately
                </Text>
                <Text className="text-[14px] text-center text-[#737373] font-pp-regular">
                  Select notes to spend and enter transfer amount
                </Text>
                </>)}

                {!isSui && <PendingRelayNotice chainId={chainId} owner={connectedAddress} />}

                {/* Asset selector — hidden inline with the title above (the
                    hub card carries token pills + the big amount input). */}
                {!inlineHubActive && (
                <View className="relative w-full z-[20] mb-[12px]">
                  <Pressable
                    className="flex-row items-center justify-between px-[14px] py-[10px] border border-border rounded-control gap-[8px] w-full bg-card-background"
                    onPress={() => setTokenDropdownOpen(!tokenDropdownOpen)}
                  >
                    <View className="flex-row items-center gap-[8px] flex-1">
                      <TokenMark symbol={selectedSymbol} size={18} />
                      <Text className="text-[14px] flex-1 text-text font-pp-regular">
                        {poolDisplayLabel(selectedSymbol, activeEvmChainId)}
                      </Text>
                    </View>
                    {tokenDropdownOpen ? <CaretUpIcon color={colors.text} /> : <CaretDownIcon color={colors.text} />}
                  </Pressable>
                  {tokenDropdownOpen && (
                    <View
                      className="absolute top-[42px] left-0 right-0 z-[100] overflow-hidden rounded-control border border-border bg-menu-background"
                      // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                      style={DROPDOWN_SHADOW}
                    >
                      {(isSui ? [altSymbol] : sourceTokens.map((t) => t.symbol)).map((token, idx, arr) => {
                        return (
                          <Pressable
                            key={token}
                            className={`flex-row items-center gap-[8px] px-[16px] py-[10px] ${idx < arr.length - 1 ? 'border-b' : 'border-b-0'} border-b-border-light ${selectedSymbol === token ? 'bg-primary-soft' : 'bg-transparent'}`}
                            onPress={() => {
                              // SUI is the only Sui asset; the EVM list drives the
                              // selectedToken state.
                              if (token !== altSymbol) {
                                setSelectedToken(token);
                                // Re-clamp the typed amount to the new token's precision from
                                // the chain registry — the old ETH?18:6 literal disagreed with
                                // the parser for any non-stable non-ETH asset (cBTC is 18).
                                setAmount((a) => sanitizeAmountInput(a, getTokenMetadataBySymbol(token, activeEvmChainId)?.decimals ?? 18));
                              }
                              setTokenDropdownOpen(false);
                            }}
                          >
                            <TokenMark symbol={token} size={18} />
                            <Text className={`text-[14px] text-text ${selectedSymbol === token ? 'font-pp-medium' : 'font-pp-regular'}`}>
                              {poolDisplayLabel(token, activeEvmChainId)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
                )}

                {/* Overlay modal only: inline, the notice landed between the
                    hub card and the pair chip, breaking the straddle (and the
                    hub's balance row already tells the story). */}
                {!inlineHubActive && isStellar && stellarLocked ? (
                  <Pressable
                    onPress={() => { stellarSession.unlock().catch((caught: unknown) => { errorToast({ title: stellarUnlockErrorTitle(caught), variant: 'destructive' }); }); }}
                    accessibilityRole="button"
                    className="items-center p-[20px] active:opacity-70"
                  >
                    <Text className="text-[14px] text-center text-text font-pp-medium">Sign in to use your shielded XLM</Text>
                  </Pressable>
                ) : !inlineHubActive && (isStellar ? stellarActiveNotes.length === 0 : isSui ? suiActiveNotes.length === 0 : activeNotes.length === 0) && (
                  <Text className="text-[14px] text-center text-[#737373] font-pp-regular p-[20px]">
                    No active {isStellar ? 'Stellar ' : isSui ? 'Sui ' : ''}notes available for transfer.
                  </Text>
                )}

                {/* Amount input — the box is the hub's input when inline;
                    the validation lines below always render. Inline with
                    nothing to show, the wrapper itself must not render: an
                    empty View still occupies a gap slot, which pushed the
                    pair chip ~16px below its seam. */}
                {(!inlineHubActive || !!amountError || (enteredAmount > 0 && enteredAmountWei > maxSpendableWei)) && (
                <View className="w-full gap-[4px]">
                  {!inlineHubActive && (
                  <View className={`w-full h-[48px] border rounded-control px-[16px] flex-row items-center justify-between bg-card-background ${amountError ? 'border-[#E53935]' : 'border-border-light'}`}>
                    <TextInput
                      className={`text-[18px] flex-1 p-0 m-0 font-pp-regular ${amount ? 'text-text' : 'text-[#999999]'}`}
                      // nw-keep(platform-css): web-only outlineStyle:none removes the focus ring; empty on native
                      style={WEB_NO_OUTLINE}
                      value={amountField.value}
                      placeholder="0.0"
                      placeholderTextColor="#999999"
                      onChangeText={(text) => setAmount(sanitizeAmountInput(amountField.toShares(text), selectedDecimals))}
                      keyboardType="numeric"
                    />
                    <Text className="text-[14px] ml-[8px] text-[#737373] font-pp-medium">
                      {amountField.symbol}
                    </Text>
                  </View>
                  )}
                  <BalanceAmount view={balanceDisplay(amount || '0', selectedSymbol, chainId)} className="text-[12px] text-text-secondary" />
                  {amountField.error ? <Text className="text-[12px] text-danger">{amountField.error}</Text> : null}
                  {amountError && (
                    <Text className="text-[12px] text-[#E53935] font-pp-regular">
                      {displayAmountError}
                    </Text>
                  )}
                  {/* The fee rides on top, so an amount just under the cap (a
                      rounded 36.5 against 36.502932) overflows it. One tap takes
                      the largest amount the fee still fits beside, instead of
                      making the user do the subtraction (Mike, 2026-09-24). */}
                  {amountError && relayFeeExceeds && relayFeeMaxSend > 0n && (
                    <Pressable
                      onPress={() => setAmount(formatUnits(relayFeeMaxSend, selectedDecimals))}
                      accessibilityRole="button"
                      testID="transfer-send-max-instead"
                      hitSlop={6}
                      className="self-start mt-[4px]"
                    >
                      <Text className="text-[12px] text-tint font-pp-sans-medium underline">Send max instead</Text>
                    </Pressable>
                  )}
                  {/* DEV-236: only surface the spend-cap note when it actually
                      bites. The user is trying to send more than one transfer
                      can combine (5-note / 2-lineage circuit caps). */}
                  {/* DEV-437: one tap to the exact cap, which then passes. */}
                  {!!connectedAddress && enteredAmountWei > maxSpendableWei && maxSpendableWei > 0n && (
                    <Pressable
                      onPress={() => setAmount(maxSpendableFormatted)}
                      accessibilityRole="button"
                      testID="transfer-use-max"
                      hitSlop={6}
                      className="self-start mt-[4px]"
                    >
                      <Text className="text-[12px] text-tint font-pp-sans-medium underline">Use max</Text>
                    </Pressable>
                  )}
                  {!!connectedAddress && enteredAmount > 0 && enteredAmountWei > maxSpendableWei && (
                    // Only when the note caps are what binds (DEV-437).
                    overCapReason(eligibleTotalWei, maxSpendableWei) === 'note-caps' &&
                    <Text className="text-[12px] mt-[4px] text-[#737373] font-pp-regular">
                      One transfer combines up to {TRANSFER_MAX_INPUTS} notes from{' '}
                      {TRANSFER_MAX_LABELS} deposits; the most you can send at once is{' '}
                      {isShareSymbol(selectedSymbol) ? balanceDisplay(formatUnits(maxSpendableWei, selectedDecimals), selectedSymbol, chainId).text : tokenAmountLabel(capText(maxSpendableWei, enteredAmountWei, selectedDecimals), selectedSymbol)}.
                    </Text>
                  )}
                </View>
                )}

                {/* OUT side of the pair (same design as Shield/Withdraw):
                    the amount above is what you send, this card is what the
                    recipient gets. Inline, the shared chip straddles the seam
                    to the hub's amount card. The load-bearing PUBLIC-payout
                    warning rides the card's caption. */}
                {receiveAsVisible ? (
                  <SwapPairCard
                    label="Recipient receives"
                    symbol={isSwapSend && receiveAsset ? receiveAsset.symbol : selectedSymbol}
                    chainId={sendChainId}
                    straddle={inlineHubActive}
                    icon="send-outline"
                    onPress={() => { if (receiveAsAvailable) setReceiveSelectorOpen(true); }}
                    disabled={!receiveAsAvailable}
                    testID="send-receive-as"
                    // Send-exact: this card is the recipient's side, so it shows
                    // the NET, not the figure typed into the amount card above.
                    figure={isSwapSend && receiveAsset
                      ? (swapSendPreviewText ?? '—')
                      : (parseFloat(amount) || 0) > 0
                        ? (sendExactActive ? (relayFeeCeiled != null ? `~${formatUnits(recipientAmountWei, selectedDecimals)}` : '—') : amount)
                        : '0'}
                    figureMuted={(isSwapSend && !!receiveAsset) || (parseFloat(amount) || 0) <= 0}
                    captionTone="secondary"
                    caption={isSwapSend && receiveAsset
                      ? (privateSwapSend
                        ? (crossChainSend
                          ? `Your ${displayTokenSymbol(selectedSymbol)} is swapped and bridged, and deposited as a new shielded note for the recipient on ${sendChainName}. Continue to review the rate.`
                          : `Your ${displayTokenSymbol(selectedSymbol)} is swapped into ${displayTokenSymbol(receiveAsset.symbol)} and deposited as a new shielded note for the recipient. Nothing is paid to a wallet. Continue to review the rate.`)
                        : publicSwapPayout
                        ? `Your ${displayTokenSymbol(selectedSymbol)} is swapped into ${displayTokenSymbol(receiveAsset.symbol)} and paid to the recipient on-chain${crossChainSend ? ` on ${sendChainName}` : ''}. ${displayTokenSymbol(receiveAsset.symbol)} can't be delivered as a private note yet, so this is a public withdrawal and continues in Withdraw.`
                        : privateSwapRoute
                          ? (crossChainSend
                            ? `Your ${displayTokenSymbol(selectedSymbol)} is swapped and bridged, and lands as a new shielded note in your own account on ${sendChainName}. Delivery follows this chain's transaction and can take a few minutes. Continue in Swap to review the rate.`
                            : `Your ${displayTokenSymbol(selectedSymbol)} is swapped into ${displayTokenSymbol(receiveAsset.symbol)} and stays shielded, as a new note in your account. Continue in Swap to review the rate.`)
                          : sendsToOwnAccount
                            ? 'This swap route is not available on this network yet.'
                            : 'Enter a valid recipient to choose the swap route.')
                      : !receiveAsAvailable
                        ? `Paying in another token needs the swap route, which isn't live on this network yet. This sends ${displayTokenSymbol(selectedSymbol)} privately.`
                        : `Pick a different token to pay the recipient via swap.`}
                  />
                ) : null}

                {/* Recipient address */}
                <View className="w-full gap-[4px]">
                  <View className={`w-full h-[48px] border rounded-control px-[16px] flex-row items-center justify-between bg-card-background ${recipientError ? 'border-[#E53935]' : 'border-border-light'}`}>
                    <TextInput
                      className={`text-[14px] flex-1 p-0 m-0 font-pp-regular ${recipientInput ? 'text-text' : 'text-[#999999]'}`}
                      // nw-keep(platform-css): web-only outlineStyle:none removes the focus ring; empty on native
                      style={WEB_NO_OUTLINE}
                      value={recipientInput}
                      placeholder={isStellar ? "Recipient Stellar address (G…)" : "Recipient 0x address"}
                      placeholderTextColor="#999999"
                      onChangeText={handleRecipientInputChange}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                  {isSwapSend && publicSwapPayout ? (
                    <Text className="text-[12px] leading-[16px] text-text-secondary font-pp-regular">
                      Paid to this address on-chain, so the recipient and amount are public. Continues in Withdraw. Pick a token that can be delivered privately, or send it to yourself, to keep it private.
                    </Text>
                  ) : null}
                  {isSwapSend && privateSwapSend ? (
                    <Text className="text-[12px] leading-[16px] text-text-secondary font-pp-regular">
                      Stays private: the recipient gets a new shielded note. They need to have set up Privacy Pools on {crossChainSend ? sendChainName : chainDisplayName}.
                    </Text>
                  ) : null}
                  {isSwapSend && privateSwapRoute ? (
                    <Text className="text-[12px] leading-[16px] text-text-secondary font-pp-regular">
                      Stays private: the swapped amount comes back as a new note of your own.
                    </Text>
                  ) : null}
                  {recipientError && (
                    <Text className="text-[12px] text-[#E53935] font-pp-regular">
                      {recipientError}
                    </Text>
                  )}
                  {!recipientError && recipientHelperText && (
                    <Text className="text-[12px] mt-[4px] text-[#737373] font-pp-regular">
                      {recipientHelperText}
                    </Text>
                  )}
                </View>

                {/* One row for both option controls — the privacy toggle on the
                    left, the output-asset chip on the right. They were stacked,
                    which cost the form a whole line for two short controls.
                    Explanations for either one live below the row so neither can
                    push the other's height around.
                    - The relayer-vs-direct checkbox (DEV-237) used to sit
                      here; removed 2026-08-29, every send is relayed now.
                    - "Receive as": pay the recipient in a different token via
                      the intent-swap route. Renders disabled with the reason
                      when the route isn't live, rather than disappearing. */}
                {!isSui && (
                <View className="w-full mt-[4px] gap-[6px]">
                  {/* Fee transparency (QA 2026-08-17): the relayer fee rides
                      ON TOP of the amount — say so on the form, before any
                      guard or relay can. Red once amount + fee stops fitting
                      the spendable balance. */}
                  {/* Net-vs-gross, same control and copy as Withdraw. Only the
                      relayed path has a relayer fee to divide, so the disclosed
                      path and swap-sends do not show it. Unchecking is what
                      makes sending a whole balance possible. */}
                  {!isSui && !isSwapSend && hideAddress && maxGrossIntent ? (
                    // A max entry has nothing left to add a fee on top of, so
                    // the toggle is moot: state the real semantics (as Withdraw does).
                    <Text className="text-[12px] leading-[16px] text-text-secondary font-pp-regular" testID="send-fee-comes-out">
                      {relayFeeCeiled != null
                        ? `The relayer fee comes out of this amount. The recipient receives ~${balanceDisplay(formatUnits(recipientAmountWei, selectedDecimals), selectedSymbol, chainId).text}.`
                        : 'The relayer fee comes out of this amount.'}
                    </Text>
                  ) : !isSui && !isSwapSend && hideAddress ? (
                    <View className="gap-[3px]">
                      <Pressable
                        className="flex-row items-center gap-[8px]"
                        onPress={() => { setReceiveExact((v) => !v); setSentAmountWei(null); setSentUnits(null); }}
                        testID="send-receive-exact"
                      >
                        <CheckboxSquare checked={receiveExact} color={colors.textLight} />
                        <Text className="text-[13px] text-text font-pp-regular">Recipient receives the exact amount</Text>
                      </Pressable>
                      <Text className="text-[12px] leading-[16px] text-text-secondary font-pp-regular">
                        {(() => {
                          const fee = relayFeeCeiled != null && enteredAmountWei > 0n ? ` (~${balanceDisplay(formatUnits(relayFeeCeiled, selectedDecimals), selectedSymbol, chainId).text})` : '';
                          return receiveExact
                            ? `The relayer fee${fee} is added on top of the amount you entered.`
                            : `Sends exactly what you entered: the relayer fee${fee} comes out of it, so the recipient receives ${relayFeeCeiled != null && enteredAmountWei > 0n ? `~${balanceDisplay(formatUnits(recipientAmountWei, selectedDecimals), selectedSymbol, chainId).text}` : 'a little less'}.`;
                        })()}
                      </Text>
                    </View>
                  ) : null}
                </View>
                )}


                {/* Review button — single-step now: amount + recipient on
                    one screen, jumps straight to review. Inline: pinned to
                    the zone bottom so every tab's CTA sits at the same Y. */}
                {/* marginBottom is +3, matching the Withdraw tab. It was -7,
                    which pulled the button 7px past the bottom of its zone and
                    clipped its lower edge and rounded corners (reported
                    2026-08-23). Send was the only tab with a negative value
                    here; every other CTA sits inside its container. */}
                {/* nw-keep(measured-or-inset): auto top margin pins the CTA to the zone bottom */}
                <View className="w-full" style={inlineHubActive ? { marginTop: 'auto', marginBottom: 3 } : undefined}>
                  <Pressable
                    accessibilityRole="button"
                    className={inlineHubActive
                      ? `w-full items-center justify-center rounded-inner py-[16px] bg-button-primary ${canProceedToReview || needsConnect ? 'active:bg-button-primary-pressed' : 'opacity-50'}`
                      : `w-full h-[44px] border rounded-control items-center justify-center bg-card-background ${canProceedToReview || needsConnect ? 'border-[#B8BBBF] opacity-100' : 'border-[#E6E6E6] opacity-50'}`}
                    onPress={async () => {
                      if (needsConnect) { ensureConnected(); return; }
                      if (!canProceedToReview || keystoreCheckPending) return;
                      // Swap-send: this is not a note transfer at all, so it
                      // skips the recipient viewing-key lookup entirely (the
                      // payout is public — the recipient needs no keystore
                      // registration and gets no note) and hands off to the
                      // swap flow with the amount, recipient and output token.
                      // A destination without an asset is not a private send:
                      // the card promises a payout on another chain, and
                      // isSwapSend is false, so without this the press would
                      // quietly execute an ordinary same-chain note transfer
                      // (agy). The network pane auto-picks an asset, so this is
                      // the case where that chain offers none.
                      if (crossChainSend && !receiveAsset) {
                        reportTransferError(`Pick the asset to pay the recipient on ${sendChainName}.`);
                        return;
                      }
                      if (isSwapSend) {
                        reportTransferError(null);
                        handoffSwapSend();
                        return;
                      }
                      // Sui: no EVM keystore viewing-key lookup — the recipient
                      // claims via the one-time receipt, so go straight to review.
                      if (isSui) {
                        reportTransferError(null);
                        setStep('review');
                        return;
                      }
                      const checkedChainId = chainId;
                      const checkedRecipient = recipientAddress.toLowerCase();
                      reportTransferError(null);
                      // Pre-flight: ask the Keystore whether the recipient
                      // has a viewing key registered. If not, the SDK will
                      // fall back to out-of-band semantics — the recipient
                      // can't auto-discover and we'll need to hand the
                      // sender a one-time receipt link instead.
                      //
                      // Privacy: we go through the local viewing-keys
                      // cache (synced from the ASP's bulk endpoint) so
                      // the recipient address never leaves the browser
                      // for this lookup. The cache falls back to the
                      // chain RPC's viewingKeys() only when the ASP
                      // endpoint is 404 (not deployed yet).
                      setKeystoreCheckPending(true);
                      try {
                        const cfg = getChainConfig(checkedChainId);
                        if (!cfg?.contracts) throw new Error(`Unsupported chain: ${checkedChainId}`);
                        const sdkSetup = await import('@/services/sdk-runtime');
                        const { lookupViewingKey } = await import('@/services/viewing-key-cache');
                        const rpc = sdkSetup.createRPCInteractor(checkedChainId, Number(cfg.contracts.fromBlock));
                        const ks = sdkSetup.createKeystoreInteractor(
                          rpc,
                          cfg.contracts.keystoreAddress as SdkAddress,
                          cfg.contracts.keystoreFromBlock,
                        );
                        const result = await lookupViewingKey(
                          checkedChainId,
                          checkedRecipient as SdkAddress,
                          { getViewingKey: (a) => ks.getViewingKey(a) },
                          {
                            keystoreAddress: cfg.contracts.keystoreAddress,
                            useAspCache: IsDefaultPoolActive,
                          },
                        );
                        const current = recipientCheckRef.current;
                        if (
                          current.chainId !== checkedChainId ||
                          current.recipientAddress.toLowerCase() !== checkedRecipient
                        ) {
                          log('info', 'Transfer', 'Ignored stale recipient registration check', {
                            checkedChainId,
                            checkedRecipient: truncateAddress(checkedRecipient),
                          });
                          return;
                        }
                        // A failed lookup must not route to the one-time-link path.
                        if (result.lookupFailed) {
                          log('warn', 'Transfer', 'Recipient registration lookup failed; not treating as unregistered', {
                            source: result.source,
                            aspAvailable: result.aspAvailable,
                          });
                          reportTransferError(RECIPIENT_CHECK_FAILED_MESSAGE, undefined, 'recipient-check');
                          return;
                        }
                        // The ASP registry's answer is the verdict (a miss already
                        // triggered a full registry re-pull inside lookupViewingKey).
                        // Confirming a miss on the pool RPC would name the recipient.
                        const registered = result.viewingKey !== null;
                        setRecipientRegistrationCheck({
                          chainId: checkedChainId,
                          recipientAddress: checkedRecipient,
                          registered,
                        });
                        setRecipientIsRegistered(registered);
                        log('info', 'Transfer', 'Recipient registration check', {
                          registered,
                          source: result.source,
                          aspAvailable: result.aspAvailable,
                        });
                        setStep(registered ? 'review' : 'unregistered-confirm');
                      } catch (err) {
                        const current = recipientCheckRef.current;
                        if (
                          current.chainId !== checkedChainId ||
                          current.recipientAddress.toLowerCase() !== checkedRecipient
                        ) {
                          log('info', 'Transfer', 'Ignored stale recipient registration check failure', {
                            checkedChainId,
                            checkedRecipient: truncateAddress(checkedRecipient),
                          });
                          return;
                        }
                        log('warn', 'Transfer', 'Keystore lookup failed; asking the user to retry', {
                          err: err instanceof Error ? err.message : String(err),
                        });
                        // A failed lookup must not route to the one-time-link path.
                        reportTransferError(RECIPIENT_CHECK_FAILED_MESSAGE, err, 'recipient-check');
                      } finally {
                        setKeystoreCheckPending(false);
                      }
                    }}
                    disabled={!needsConnect && (!canProceedToReview || keystoreCheckPending)}
                  >
                    <Text className={inlineHubActive ? 'font-pp-sans-semi-bold text-[16px] tracking-[0.1px] text-button-primary-text' : 'text-[14px] text-text font-pp-medium'}>
                      {needsConnect
                        ? 'Connect wallet'
                        : keystoreCheckPending
                        ? 'Checking recipient…'
                        // Named for what it does: the next screen is the swap
                        // review, not the transfer review.
                        : isSwapSend ? (publicSwapPayout ? 'Continue in Withdraw' : privateSwapSend ? 'Review Private Swap' : 'Continue in Swap') : 'Review Transfer'}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}


            {/* Step: Unregistered recipient confirmation */}
            {step === 'unregistered-confirm' && (
              <>
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Recipient Not Registered
                </Text>

                <View className="w-full border rounded-control p-[12px] border-warning bg-warning-bg">
                  <Text className="text-[12px] leading-[18px] font-pp-regular text-warning">
                    {truncateAddress(recipientAddress)}
                    <CopyIconButton value={recipientAddress} />
                    {' '}hasn&apos;t registered a viewing key with the pool, so they can&apos;t auto-discover this transfer. You can still send. Afterwards we&apos;ll show a one-time receipt you must share with them so they can claim the funds.
                  </Text>
                  {/* The same explainer the Shield card's hint opens: what the
                      link is, what the recipient does with it, and the fee. */}
                  <Pressable
                    onPress={() => Linking.openURL(UNREGISTERED_DEPOSIT_DOCS_URL)}
                    accessibilityRole="link"
                    hitSlop={6}
                    className="mt-[8px]"
                    testID="transfer-unregistered-learn-more"
                  >
                    <Text className="text-[12px] leading-[18px] font-pp-medium text-warning underline">{LEARN_MORE_UNREGISTERED_LABEL}</Text>
                  </Pressable>
                </View>

                <View className="flex-row gap-[12px] w-full">
                  <Pressable
                    className="flex-1 h-[44px] border rounded-control items-center justify-center border-[#B8BBBF] bg-card-background"
                    onPress={() => {
                      setRecipientIsRegistered(null);
                      setRecipientRegistrationCheck(null);
                      setSentAmountWei(null);
                      setSentUnits(null);
                      setStep('select-notes');
                    }}
                  >
                    <Text className="text-[14px] text-text font-pp-medium">
                      Cancel
                    </Text>
                  </Pressable>
                  <Pressable
                    className="flex-1 h-[44px] border rounded-control items-center justify-center border-[#B8BBBF] bg-card-background"
                    onPress={() => setStep('review')}
                  >
                    <Text className="text-[14px] text-text font-pp-medium">
                      Send one time link
                    </Text>
                  </Pressable>
                </View>
              </>
            )}


            {/* Step: Review */}
            {step === 'review' && isConsolidating && (
              <View className="w-full gap-[16px]" testID="consolidation-confirmation">
                <Text className="font-pp-bold text-[22px] leading-[28px] text-text pr-[28px]">Review consolidation</Text>
                <Text className="font-pp-regular text-[14px] leading-[20px] text-text-secondary">Consolidate the selected notes on {chainDisplayName}. Your funds stay private, minus the relayer fee.</Text>
                <ConsolidationGroupSummary groups={consolidationNoteGroups} selected={forcedInputs ?? []} fee={consolidationFee} />
                <ConsolidationSummary total={consolidationTotal} fee={consolidationFee} decimals={selectedDecimals} symbol={selectedSymbol} />
                <FeeWarning breakdown={relayedFeeBreakdown(consolidationTotal, consolidationFee)} testID="consolidation-fee-warning" />
                {new Set(consolidationSelection?.map((note) => note.label.toLowerCase())).size > 1 && (
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">Each deposit stays separate, but the selected groups share one on-chain transaction.</Text>
                )}
                {(transferError || consolidationError) && <Text accessibilityRole="alert" className="text-[13px] text-warning font-pp-regular">{transferError ?? consolidationError}</Text>}
                <View className="flex-row gap-[10px]">
                  <Pressable accessibilityRole="button" className="h-[46px] px-[18px] border border-border rounded-control items-center justify-center" onPress={backToConsolidationNotes}>
                    <Text className="font-pp-medium text-[14px] text-text">Back</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" testID="consolidation-confirm" disabled={!!consolidationError} onPress={handleConfirm} className={`flex-1 h-[46px] rounded-control bg-button-primary items-center justify-center ${consolidationError ? 'opacity-50' : ''}`}>
                    <Text className="font-pp-medium text-[14px] text-button-primary-text">Consolidate notes</Text>
                  </Pressable>
                </View>
              </View>
            )}
            {step === 'review' && !isConsolidating && (
              <>
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Review Transfer
                </Text>

                {!isSui && <PendingRelayNotice chainId={chainId} owner={connectedAddress} />}

                {/* Transfer details */}
                <View className="w-full gap-[2px]">
                  <Text className="text-[14px] leading-[24px]">
                    <Text className="text-[14px] text-[#737373] font-pp-bold">From: </Text>
                    <Text className="text-[14px] text-[#737373] font-pp-regular">
                      {fromAddress ? truncateAddress(fromAddress) : '—'}
                    </Text>
                    {fromAddress ? <CopyIconButton value={fromAddress} /> : null}
                  </Text>
                  <Text className="text-[14px] leading-[24px]">
                    <Text className="text-[14px] text-[#737373] font-pp-bold">To: </Text>
                    <Text className="text-[14px] text-[#737373] font-pp-regular">
                      {truncateAddress(recipientAddress)}
                    </Text>
                    <CopyIconButton value={recipientAddress} />
                  </Text>
                  <Text className="text-[14px] leading-[24px]">
                    <Text className="text-[14px] text-[#737373] font-pp-bold">Amount: </Text>
                    <Text className="text-[14px] text-[#737373] font-pp-regular">
                      {transferAmountFormatted}
                    </Text>
                  </Text>
                  <Text className="text-[14px] leading-[24px]">
                    <Text className="text-[14px] text-[#737373] font-pp-bold">Chain: </Text>
                    <Text className="text-[14px] text-[#737373] font-pp-regular">
                      {chainDisplayName}
                    </Text>
                  </Text>
                  {relayFeeCeiled != null && (
                    <Text className="text-[14px] leading-[24px]">
                      <Text className="text-[14px] text-[#737373] font-pp-bold">Relayer fee: </Text>
                      <Text className="text-[14px] text-[#737373] font-pp-regular">
                        ~{balanceDisplay(formatUnits(relayFeeCeiled, selectedDecimals), selectedSymbol, chainId).text}
                      </Text>
                    </Text>
                  )}
                  {relayFeeCeiled != null && (
                    <FeeWarning breakdown={relayedFeeBreakdown(enteredAmountWei, relayFeeEstimate)} testID="transfer-fee-warning" />
                  )}
                  {/* Stellar sends are self-signed (no relayed transfer on
                      Stellar yet), so the chain shows this account as sender. */}
                  {isStellar && (
                    <Text className="text-[12px] leading-[18px] text-[#B45309] font-pp-regular" testID="stellar-transfer-linkable">
                      Sent from your Freighter account, so this send is publicly linked to it.
                    </Text>
                  )}
                  {/* DEV-368: the "Notes: 1 input note" line lived here. Dropped
                      on Mike's call: the note count is UTXO-model internals the
                      user has no use for while confirming a transfer. */}
                  {(isSui ? enteredAmountWei < suiChosen.sum : enteredAmountWei < totalSelectedValue) && (
                    <Text className="text-[14px] leading-[24px]">
                      {/* DEV-368: "Remaining", not "Change" — the latter reads
                          as either cash-register change or an edit action. */}
                      <Text className="text-[14px] text-[#737373] font-pp-bold">Remaining: </Text>
                      <Text className="text-[14px] text-[#737373] font-pp-regular">
                        {balanceDisplay(formatUnits((isSui ? suiChosen.sum : totalSelectedValue) - enteredAmountWei, selectedDecimals), selectedSymbol, chainId).text}
                      </Text>
                    </Text>
                  )}
                </View>

                {/* Warning */}
                <View className="w-full border rounded-control p-[12px] border-warning bg-warning-bg">
                  <Text className="text-[12px] leading-[18px] font-pp-regular text-warning">
                    No funds leave the pool. This is a private in-pool transfer.
                  </Text>
                </View>


                {/* Buttons */}
                <View className="flex-row gap-[12px] w-full">
                  <Pressable
                    className="flex-1 h-[44px] border rounded-control items-center justify-center border-[#B8BBBF] bg-card-background"
                    onPress={() => {
                      reportTransferError(null);
                      setSentAmountWei(null);
                      setSentUnits(null);
                      setStep('select-notes');
                    }}
                  >
                    <Text className="text-[14px] text-text font-pp-medium">
                      Back
                    </Text>
                  </Pressable>
                  <Pressable
                    className="flex-1 h-[44px] border rounded-control items-center justify-center border-[#B8BBBF] bg-card-background"
                    onPress={handleConfirm}
                    accessibilityRole="button"
                  >
                    <Text className="text-[14px] text-text font-pp-medium">
                      Confirm Transfer
                    </Text>
                  </Pressable>
                </View>
              </>
            )}

            {/* Step: Loading */}
            {(step === 'loading' || consolidationAwaitingConfirmation) && (
              isConsolidating ? (
                <View className="w-full justify-center gap-[10px] px-[16px] py-[18px]">
                  <Text className="text-center font-pp-sans-semi-bold text-[15px] text-text">
                    Consolidating {transferAmountFormatted}
                  </Text>
                  <FlowProgress message={consolidationAwaitingConfirmation ? 'Waiting for on-chain confirmation…' : loadingMessage} />
                  {consolidationAwaitingConfirmation && <Text className="text-center font-pp-regular text-[13px] text-text-secondary">Confirmation is taking longer than usual. You can close this modal; your balance and history update when the result is known.</Text>}
                </View>
              ) : (
                <>
                  <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                    Processing Transfer
                  </Text>

                  {/* Same horizontal staged indicator the shield flow uses —
                      it derives its phase from the live loading message. */}
                  <View className="w-full items-center justify-center gap-[16px] py-[16px]">
                    <FlowProgress message={loadingMessage} />
                  </View>

                  <View className="items-center gap-[4px]">
                    <Text className="text-center text-text font-pp-regular text-[24px]">
                      {transferAmountFormatted}
                    </Text>
                  </View>
                </>
              )
            )}

            {/* Step: Success */}
            {step === 'success' && isConsolidating && relayPending === 'other-spend' && (
              <View className="w-full gap-[16px]">
                <Text className="font-pp-bold text-[22px] leading-[28px] text-text pr-[28px]">Selected notes already spent</Text>
                <Text className="font-pp-regular text-[14px] leading-[20px] text-text-secondary">These notes were spent by an earlier operation. Nothing was spent twice. Press Back to choose from the updated notes.</Text>
                <Pressable accessibilityRole="button" onPress={backToConsolidationNotes} className="self-start h-[46px] px-[18px] border border-border rounded-control items-center justify-center">
                  <Text className="font-pp-medium text-[14px] text-text">Back</Text>
                </Pressable>
              </View>
            )}
            {step === 'success' && !consolidationAwaitingConfirmation && !(isConsolidating && relayPending === 'other-spend') && (
              <>
                {/* NEVER present an unknown outcome as a success (QA
                    2026-08-17: a pre-broadcast failure landed here and read
                    as a completed send). The receipt below must still show —
                    it is the recipient's only recovery material if the tx
                    DID land — but the framing is a warning, not a
                    celebration. */}
                {outcomeUnknown ? (
                  <>
                    <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                      {isConsolidating ? 'Consolidation outcome unknown' : 'Transfer outcome unknown'}
                    </Text>
                    <View className="w-full border rounded-control p-[12px] border-warning bg-warning-bg">
                      <Text className="text-[13px] leading-[19px] font-pp-medium text-warning">
                        {isConsolidating ? 'This consolidation may still complete. Check your balance and history before trying again.' : 'The transfer may or may not have gone through. Keep the receipt below until you have verified it. If it did not land, your balance is unchanged after a sync and you can send again.'}
                      </Text>
                    </View>
                  </>
                ) : relayPending === 'pending' ? (
                  <>
                    <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                      {isConsolidating ? 'Consolidation pending' : 'Transfer pending'}
                    </Text>
                    <View className="w-full border rounded-control p-[12px] border-warning bg-warning-bg">
                      <Text className="text-[13px] leading-[19px] font-pp-medium text-warning">
                        {isConsolidating ? 'Your consolidation is waiting to be included in a block. Your balance and history update automatically when it completes. Do not consolidate these notes again while it is pending.' : 'The relayer accepted this transfer, but it has not been included in a block yet. It has not failed and can still land. This screen, your balance and your history update on their own when it does. Do not send it again: the funds are held for this transfer until it settles.'}
                      </Text>
                    </View>
                  </>
                ) : relayPending === 'other-spend' ? (
                  <>
                    <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                      Funds already spent
                    </Text>
                    <View className="w-full border rounded-control p-[12px] border-warning bg-warning-bg">
                      <Text className="text-[13px] leading-[19px] font-pp-medium text-warning">
                        {isConsolidating ? 'These notes were already spent by an earlier operation. Nothing was spent twice. Press Back to choose from the updated notes.' : 'An earlier attempt spent the funds this transfer used, so this attempt cannot land. Nothing was spent twice. Check your history for the result of the earlier transfer.'}
                      </Text>
                    </View>
                  </>
                ) : (
                  <>
                    <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                      {isConsolidating ? 'Consolidation complete' : 'Transfer Successful'}
                    </Text>

                    <View className={`items-center justify-center gap-[16px] ${isConsolidating ? 'py-[20px]' : 'py-[16px]'}`}>
                      <CheckCircleIcon color={colors.success} />
                      <Text className="text-[16px] text-center text-success font-pp-medium">
                        {isConsolidating ? 'Transaction confirmed' : 'Transaction submitted'}
                      </Text>
                    </View>
                  </>
                )}

                <View className={`items-center ${isConsolidating ? 'gap-[5px]' : 'gap-[4px]'}`}>
                  <Text className="text-center text-text font-pp-regular text-[24px]">
                    {settledAmountFormatted}
                  </Text>
                  <Text className="text-[14px] text-[#737373] text-center font-pp-regular">
                    {isConsolidating ? 'in your private account' : <>{outcomeUnknown || relayPending ? 'addressed privately to' : 'sent privately to'} {truncateAddress(recipientAddress)}<CopyIconButton value={recipientAddress} /></>}
                  </Text>
                </View>

                {/* One-time receipt — only shown when the recipient
                    didn't have a viewing key registered, so the SDK
                    fell back to out-of-band and there's no on-chain
                    Note event for them to scanCatchAll. We surface
                    BOTH a shareable link (preferred) and the raw JSON
                    (fallback / paranoid mode). */}
                {recipientImportPayload && (
                  <View className="w-full gap-[12px]">
                    <View className="w-full border rounded-control p-[12px] border-[#E53935] bg-danger-bg">
                      <Text className="text-[12px] leading-[18px] font-pp-bold text-danger">
                        IMPORTANT: Share this one-time receipt with the recipient. Shown only here. We can&apos;t recover it.
                      </Text>
                      <Text className="text-[12px] leading-[18px] mt-[4px] font-pp-regular text-danger">
                        {isSui && !isStellar
                          ? 'Send the JSON below. They paste it in Actions → Payments → Import Note to claim.'
                          : 'Send the link below. They open it on this site to claim the funds.'}
                      </Text>
                    </View>

                    {recipientImportUrl && (
                      <View className="w-full border border-border-light rounded-control p-[12px] gap-[8px] bg-background-secondary">
                        {/* DEV-216 hid this box's contents entirely, because the
                            payload IS the claim secret and printing it hands the
                            money to anyone who can see the screen. That left the
                            box looking empty and broken, and gave the sender no
                            way to see they were about to share the right thing.
                            Middle ground (Pat, 2026-08-31): the domain and path
                            in full, then an ellipsis. It shows NO payload
                            characters - the first version kept eight, but every
                            real receipt begins with the same `eyJub3Rl`, so they
                            identified nothing and only implied they did. Not
                            selectable, and Copy remains the only route to the
                            real link. */}
                        <Text
                          selectable={false}
                          numberOfLines={1}
                          className="w-full font-pp-regular text-[12px] text-text-secondary"
                          testID="transfer-receipt-link-preview"
                        >
                          {previewNoteReceiptUrl(recipientImportUrl)}
                        </Text>
                        <Pressable
                          className="w-full items-center py-[11px] px-[12px] rounded-control border border-[#B8BBBF] active:opacity-60"
                          onPress={async () => {
                            if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
                              try {
                                await navigator.clipboard.writeText(recipientImportUrl);
                                setCopiedUrl(true);
                                // Receipt secured — the close warning can stand down.
                                setReceiptLifecycle((prev) => (prev === 'at-risk' ? 'secured' : prev));
                                setTimeout(() => setCopiedUrl(false), 2000);
                              } catch (e) {
                                log('warn', 'Transfer', 'Clipboard write failed', {
                                  err: e instanceof Error ? e.message : String(e),
                                });
                              }
                            }
                          }}
                        >
                          <Text className="text-[12px] text-text font-pp-medium">
                            {copiedUrl ? 'Copied!' : 'Copy Link'}
                          </Text>
                        </Pressable>
                      </View>
                    )}

                    {/* Stellar: the link is the claim route; no JSON import exists there. */}
                    {!isStellar && (
                    <View className="w-full border border-border-light rounded-control p-[12px] gap-[8px] bg-background-secondary">
                      <Text className="text-[12px] leading-[18px] mb-[4px] text-text-secondary font-pp-regular">
                        {isSui
                          ? 'Share the raw JSON (recipient pastes it into Actions → Payments → Import Note):'
                          : 'Or share the raw JSON (recipient pastes it into Actions → Privacy & keys → Import Notes):'}
                      </Text>
                      {/* DEV-216: content hidden — share via the Copy button only. */}
                      <Pressable
                        className="w-full items-center py-[11px] px-[12px] rounded-control border border-[#B8BBBF] active:opacity-60"
                        onPress={async () => {
                          if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
                            try {
                              await navigator.clipboard.writeText(recipientImportPayload);
                              setCopiedPayload(true);
                              // Receipt secured — the close warning can stand down.
                              setReceiptLifecycle((prev) => (prev === 'at-risk' ? 'secured' : prev));
                              setTimeout(() => setCopiedPayload(false), 2000);
                            } catch (e) {
                              log('warn', 'Transfer', 'Clipboard write failed', {
                                err: e instanceof Error ? e.message : String(e),
                              });
                            }
                          }
                        }}
                      >
                        <Text className="text-[12px] text-text font-pp-medium">
                          {copiedPayload ? 'Copied!' : 'Copy JSON'}
                        </Text>
                      </Pressable>
                    </View>
                    )}
                  </View>
                )}

                {txHash && explorerUrl ? (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(explorerUrl)}>
                    <Text className={`text-[14px] underline font-pp-medium ${isConsolidating ? 'text-[#3B82F6]' : 'text-[#627EEA]'}`}>
                      {explorerIsSui ? 'View on Explorer' : `View on ${getExplorerName(explorerChainId)}`}
                    </Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={explorerIsSui ? 'SuiVision' : getExplorerName(explorerChainId)} />
                  </View>
                ) : null}

                <Pressable
                  className={isConsolidating
                    ? 'border rounded-control px-[20px] py-[10px] items-center justify-center border-[#B8BBBF] bg-card-background'
                    : 'w-full h-[44px] border rounded-control items-center justify-center border-[#B8BBBF] bg-card-background'}
                  onPress={requestCloseTransferModal}
                >
                  <Text className="text-[14px] text-text font-pp-medium">
                    Done
                  </Text>
                </Pressable>
              </>
            )}

        </TransferShell>
      )}

      {/* "Receive as" picker — the same sheet the Shield tab uses, with its
          route chips suppressed (they describe entering the pool, not leaving
          it). The network row is pinned to the pool chain: a swap-send is
          same-chain, so offering a chain switch would abandon the Send form for
          a route nothing can serve. */}
      {isOpen && receiveSelectorOpen && receiveAsAvailable && (
        <TokenSelectSheet
          tokens={receiveTokens}
          networks={sendDestinations.map((id) => ({
            id,
            name: id === chainId
              ? chainDisplayName
              : getChainConfig(id)?.displayName || `Chain ${id}`,
          }))}
          selectedAddress={isSwapSend && receiveAsset ? receiveAsset.address : selectedTokenId}
          activeNetworkId={sendChainId}
          chainId={sendChainId}
          isSui={isSui}
          onSelectToken={(t) => {
            const picked = receiveTokens.find((x) => x.address.toLowerCase() === t.address.toLowerCase());
            // Choosing the pool asset means "no swap" — store null rather than
            // the pool token, so isSwapSend can never be true for it.
            // The "same as the pool asset means no swap" rule is a SAME-CHAIN
            // rule. Across chains the list has no plain-send row at all, and the
            // native-asset sentinel is the same address on every chain, so
            // applying it there cleared the pick and quietly turned "pay them on
            // Optimism" back into a local private transfer (kimi BUG A).
            setReceiveAsset(
              picked && (sendChainId !== chainId || !isSameAsset(picked.address))
                ? picked
                : null,
            );
            setReceiveSelectorOpen(false);
          }}
          onSelectNetwork={(id) => {
            // "All networks" is a filter, not a payout target.
            if (id === null) return;
            if (id === sendChainId) return;
            if (!sendDestinations.includes(id)) return;
            setSendChainId(id);
            // Another chain picks that chain's first payable asset with it:
            // leaving this null would keep isSwapSend false while the card said
            // the recipient is paid over there, and the send would quietly stay
            // a local private note.
            // Same rule as the picker: a self-send must default to something the
            // reshield can land in, or the network switch silently re-selects a
            // token this route cannot serve.
            // receiveTokens still belongs to the previous network in this
            // callback. Read the new network's list or invalidation drops the
            // default immediately after the switch.
            const outputs = sendsToOwnAccount
              ? getSwapOutputTokens(id, chainId)
              : thirdPartyReceiveTokens(id, chainId);
            setReceiveAsset(id === chainId ? null : preferredReceiveAsset(outputs, [selectedSymbol]));
          }}
          onClose={() => setReceiveSelectorOpen(false)}
          title="Receive as"
        />
      )}
    </TransferModalContext.Provider>
  );
}
