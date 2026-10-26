import { swapRouteKinds, withSwapRouteWithdrawals, type SwapRouteKind } from '@/services/swap-route-evidence';
import { hideEmptyBalanceRow } from '@/services/pool-slug';
import { loadStoredAccountExport } from '@/components/sdk-provider';
import { mergeNotesByCommitment } from '@/services/note-sets';
import { isTransferRouteCaller } from '@/config/relayer';
import { isWithdrawalRouteCaller } from '@/config/route-callers';
import { isSwapRouteCaller } from '@/config/intent-swaps';
import { debugSafeRow, debugSafeSpend, hexKey, projectOwnOutputs, type OwnOutputProjection, type SwapLeg, type SwapOutLeg } from '@/services/swap-rows';
import { buildLineageTransferRow, buildSpendRows, countSpendActions, decorateOwnRows } from '@/services/activity-rows';
import { getSwapRecordsRevision, readAllSwapRecords, subscribeSwapRecords } from '@/services/swap-records-store';
import { readAllWithdrawRecipients } from '@/services/withdraw-recipients-store';
import { findWithdrawRecipientIn, type WithdrawRecipient } from '@/services/withdraw-recipients-core';
import { collectReceivedTransfers, onlyClassifiedNotes, receiptSkipTxHashes, tagNotesByChain } from '@/services/received-transfers';
import { contentKey } from '@/services/content-key';
import { useContentStable } from '@/hooks/use-content-stable';
import { registerDebugSnapshot } from '@/services/debug-snapshots';
import { depositRowChainPolicy } from '@/services/deposit-row-chain';
import { noteIdentitySets, depositMatchesMyNotes, mergeNoteIdentitySets } from '@/services/deposit-ownership';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { perfPhaseStart, perfPhaseEnd } from '@/services/perf-trace';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, ReactNode } from 'react';
import type { PendingDeposit } from '@/services/balance-reconcile';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount, useBalance, useReadContracts } from 'wagmi';
import { erc20Abi, formatUnits } from 'viem';
import type { Address } from 'viem';
import { getPinnedYieldDeployments } from '@/config/yield';
import apiClient from '@/services/api-client';
import { buildPaidRequestTxHashSet } from '@/services/paid-requests-store';
import { buildSentTxHashSet, readAllSentTransfers } from '@/services/sent-transfers-store';
import { recordedTransferPayee } from '@/services/transfer-payee';
import { priceFromMap } from '@/services/price-map-merge';
import { depositsNeedingViewingKeyCheck, isNoteForViewingKey, normalizeCommitment, ownershipSettled, ownershipVerdictPending, resolveDepositOwnership, viewingKeyVerdicts, type NoteDecrypter } from '@/services/deposit-ownership';
import { getNoteCiphertextsRevision, noteCiphertextsFor, subscribeNoteCiphertexts, type NoteCiphertext } from '@/services/note-ciphertexts';
import { useLeafGate } from '@/hooks/use-leaf-gate';
import { useNotes } from '@/hooks/use-notes';
import type { Note } from '@/services/sdk-types';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { buildOutgoingDepositTxHashSet } from '@/services/outgoing-deposits-store';
import { buildOwnActionMap, isOwnDepositOutput, readAllOwnActions, type OwnAction } from '@/services/own-actions-store';
import { readClaimedInputMap } from '@/services/claim-records-store';
import type { NoteCounts } from '@/services/self-transfer-row';
import { findOwnActionIn, noteTimeMs, ownDepositBridgeAllowed } from '@/services/own-actions-core';
import { deriveStellarActivity, stellarSentRecipientLookup, type StellarActivityNote } from '@/services/stellar-activity';
import { buildOwnHistoryEvents, ownDepositReviewStatus, type ActivityEvent } from '@/services/own-history-rows';
import { useLabelDecisionsByChain } from '@/hooks/use-label-decisions-by-chain';
import {
  noteMatchPriority,
  depositRowOutcome,
  projectDepositFunds,
  projectReceivedFunds,
  isLiveNoteStatus,
  reviewOutcome,
  type FundsProjection,
  type FundsState,
  type FundsStateReason,
  type RegistrationStatus,
  type TransactionOutcome,
} from '@/services/funds-state';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useLiveNotesChainId } from '@/hooks/use-live-notes-chain-id';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { useSuiClientQuery } from '@mysten/dapp-kit';
import { usePoolSession } from '@/hooks/use-pool-session';
import { mergeClaimsByPayment, reconstructUserSpends, snapshotTimestampToMs, type UserSpend } from '@/services/outgoing-transfers';
import { spendsFromSnapshot } from '@/services/pending-relays-core';
import { settlePendingRelaysBySpends } from '@/services/pending-relays-store';
import { feedEventType, feedLooksLikeTransfer } from '@/services/transact-shape';
import { readAnchorTxHashesForChains } from '@/services/anchor-stamps-store';
import type { AssetsStatsResponse, EntrypointsResponse, GlobalEvent, GlobalStatistics, TokenPrice, TokenPricesResponse, SnapshotDeposit, SnapshotRagequit, SnapshotTransact } from '@/services/api-types';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { usePublicFeed } from '@/hooks/use-public-feed';
import { whenActive } from '@/services/activity-signal';
import { feedData, publicFeeds } from '@/services/public-feed-scheduler';
import { feedEventSnapshot } from '@/services/snapshot-source';
import {
  FEED_ASSETS_STATS_ALL,
  FEED_ENTRYPOINTS,
  FEED_GLOBAL_STATISTICS,
  feedPriceMap,
  feedTokenPrices,
} from '@/services/public-feeds';
import { assetStatsRowsForChain } from '@/services/stats-asset-fold';
import { getChainConfig, supportedChainIds, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { useStellarBalance } from '@/hooks/use-stellar-balance';
import { fetchSuiApprovedSet } from '@/services/sui-witness/asp-labels';
import { calculateLabelHash } from '@/services/sui-witness/crypto';
import { getKnownTokenMetadata, getTokenMetadata, resolveTokenMetadata, formatTokenBalance, NATIVE_ASSET_ADDRESS, isStablecoin } from '@/config/tokens';
import { formatCompactTokenAmount } from '@/services/explore-pools';
import { useDebug } from '@/components/debug-provider';
import { formatUsd } from '@/services/format-fiat';
import { useTxActivity } from '@/components/tx-activity-provider';
import { useLatchedWhile } from '@/hooks/use-latched-while';
import { usePendingOwnRows } from '@/hooks/use-pending-own-rows';
import { expiredPendingOwnRows, reconcileFeedRows } from '@/services/feed-reconciliation';
import { mergeChainResults, ownTransfersPendingChainIds, pendingHistoryChainIds } from '@/services/per-chain-history';
import { readAllGlobalEventPages, type ChainEventsRead } from '@/services/global-events-pages';
import { prunePendingOwnRows } from '@/services/pending-own-rows-store';
import { rowUsd as computeRowUsd } from '@/services/pool-row-usd';
import { isShareSymbol, displayTokenSymbol } from '@/services/share-display';
import { useShareRates } from '@/hooks/use-share-rates';
import { useYieldEarned } from '@/hooks/use-yield-earned';
import { missingSectionDrops, type YieldEarnedByShare } from '@/services/yield-earned';
import { NATIVE_MOCK_ACTIVE } from '@/constants/native-mock';
import { getNativeMockPoolsValue } from '@/services/native-mock-data';

// --- Types ---

export type PoolAsset = {
  name: string;
  color: string;
  percent: number;
};

export type MyPoolsStats = {
  acceptedFundsValue: string;
  /** The same accepted-funds figure as a raw USD number, for surfaces that
      re-format it themselves (payroll's display-currency toggle). */
  acceptedFundsUsd: number;
  acceptedFundsChange: string;
  acceptedFundsLabel: string;
  pendingValue: string;
  pendingChange: string;
  totalDeposits: number;
  totalTransfers: number;
  totalWithdrawals: number;
  /** Private swaps (the Swap tab), one per swap. Their output deposits are
   *  not in totalDeposits. */
  totalSwaps: number;
  assets: PoolAsset[];
};

export type MyPool = {
  id: string;
  name: string;
  tokenAddress: string;
  /** Chain the holding lives on — rows badge it, and it keys the row id. */
  chainId: number;
  balance: string;
  balanceToken: string;
  /** Full-precision decimal balance (no rounding) — safe for max-fill. */
  balanceTokenExact: string;
  pending: string;
  pendingToken: string;
  /** Full-precision decimal pending balance (no rounding). */
  pendingTokenExact: string;
  poolAccounts: number;
};

export type AvailableAsset = {
  id: string;
  name: string;
  poolValue: string;
  poolValueToken: string;
  walletBalance: string;
  walletBalanceToken: string;
  privacyScore: number;
};

export type PoolEntry = {
  id: string;
  name: string;
  tokenAddress: string;
  chainId: number;
  poolValue: string;
  /**
   * TVL in USD as a number, for ranking. `poolValue` is display-formatted
   * ("$184.32k"), so sorting by it means parsing a k/M suffix back out — this
   * carries the value the formatter was given instead.
   */
  poolValueUsd: number;
  poolValueToken: string;
  /** TVL in the pool token as a number: `poolValueToken` is display-compact ("1.23K ppUSDC"), unparseable. */
  poolValueTokenAmount: number;
  /** DEV-240/219: cumulative approved deposits ("Total funds accepted"), USD. */
  fundsAccepted: string;
  change24h: string;
  privacyScore: number;
};

export type Transaction = {
  id: string;
  address: string;
  fullAddress: string;
  type: string;
  chain: string;
  chainId: number;
  asset: string;
  tokenAddress: string;
  rawAmount: string;
  tokenAmount: number;
  usdValue: number;
  value: string;
  timestamp: number;
  status: string;
  txHash: string;
  reviewStatus: string;
  aspRoot: string | null;
  label: string | null;
  /** Current fund availability (services/funds-state.ts). Absent = nothing to
   *  overlay on the historical `status` outcome. */
  fundsState?: FundsState;
  fundsReason?: FundsStateReason;
  /** Status of the local note backing this row, when one matched. */
  noteStatus?: string;
  /**
   * The commitment of my own deposit, from the event snapshot
   * (services/own-history-rows.ts): its note is matched by it exactly. A row
   * built from the snapshot carries no ASP verdict (`reviewStatus` empty) and
   * derives one locally; a public row keeps the ASP's.
   */
  ownCommitment?: string;
  isOptimistic?: boolean;
  /** Set on rows synthesized from note lineage (#215) so the UI uses this
   *  reliable in/out instead of the sender-stamp guess in classifyTransfer.
   *  'self': every output is my own note and only the relayer fee left my
   *  balance (services/self-transfer-row.ts). The row's amount is that fee. */
  direction?: 'in' | 'out' | 'self';
  /** On a 'self' row with the Consolidate action's shape only
   *  (UserSpend.consolidation): how many of my notes it spent and created.
   *  Its presence is what labels the row a consolidation. */
  noteCounts?: NoteCounts;
  /** On a 'self' row: total value of the notes it created, raw units. */
  movedAmountRaw?: string;
  /** On a reconstructed Transfer Out row: the relayer fee the tx paid (its
   *  withdrawnValue on the transfer route), raw units. Absent when direct. */
  relayFeeRaw?: string;
  /**
   * On a 'Swap' row: the output leg (services/swap-rows.ts). The row's own
   * asset and amount are the source leg; its status, review and funds fields
   * are the output note's. Never in a debug snapshot.
   */
  swapOut?: SwapOutLeg;
  /** On this device's own receive-as Withdrawal: the payout, ≈ the quote
   *  recorded at send time (services/swap-records-core.ts). */
  receivedAs?: SwapLeg;
  /** On this device's own Shield swap-and-shield Deposit: the quoted wallet
   *  input, marked approximate because no actual debit was recorded. */
  swappedFrom?: SwapLeg;
  /** On this device's own cross-chain swap that did not deposit: how the
   *  bridge ended. The row is then a Withdrawal. */
  delivery?: 'recovered' | 'refunded' | 'failed';
  /** On a Withdrawal: the caller was a RelaySwaps contract, so the value
   *  went through a swap route (services/swap-route-evidence.ts). */
  viaSwap?: boolean;
  /** On my own swap-route Withdrawal: a private swap-send, whose output note
   *  is another account's. The recipient is never stored (DEV-512). */
  sentToOther?: boolean;
  /** Deposits: the ASP feed's funding tag (GlobalEvent.fundingSource). */
  fundingSource?: string;
  /** The address is this device's own record of where a withdrawal went,
   *  not the feed's. Kept out of debug snapshots. */
  recordedRecipient?: boolean;
  /** On a claim's Transfer In row (DEV-450): the claim tx, and what it cost
   *  (withdrawn by the claim: relayer fee plus any gas top-up), raw units. The
   *  row's own txHash is the payment that delivered the note. */
  claimTxHash?: string;
  claimCostRaw?: string;
  /** On a claim's Transfer In row: a registration rode along in the claim tx
   *  (registerAndRelay), so the row reads "Transfer In & registration". */
  /** On a claim row of a payment claimed over several txs: all of them. */
  claimTxHashes?: string[];
  withRegistration?: boolean;
  /** A relayed spend made only to set up the account (DEV-574): the gasless
   *  registration, or the gas top-up that pays for the viewing key. */
  setupKind?: 'registration' | 'gas-top-up';
  /** True for rows synthesized from local note lineage (#215), not from an ASP
   *  event. They're personal (only meaningful in the 'mine' scope) and are kept
   *  out of the global 'all' feed. */
  isLineageSynthetic?: boolean;
};

export type PoolsData = {
  myPools: MyPool[];
  /** Rows dropped from `myPools` because the pool was emptied (DEV-466). An
   *  empty `myPools` with this above 0 is a known zero, not "not loaded". */
  hiddenEmptyPools?: number;
  myPoolsStats: MyPoolsStats;
  availableAssets: AvailableAsset[];
  allPools: PoolEntry[];
  transactions: Transaction[];
  /** Received-transfer rows synthesized from local note lineage (#215). Kept
   *  OUT of `transactions` (the global feed) so they only surface in the
   *  connected user's "My Transactions" scope. */
  lineageRows: Transaction[];
  /** The ASP's event total per public-feed chain (deposits, transfers,
   *  withdrawals, ragequits), so a count is the protocol's, not the rows held. */
  publicEventTotalsByChain?: Readonly<Record<number, number>>;
  priceMap: Record<string, number>;
  /** True while the USD price query is still in flight — every $ figure
   *  computes to 0 until it lands, so loading gates must treat this as
   *  "value not known yet", not a real zero. */
  pricesLoading: boolean;
  // Tx hashes the ASP labels 'withdrawal' that are actually transfers
  // (outputCommitments >= 2), + whether that discriminator has loaded.
  transferTxHashes: Set<string>;
  /** Output commitments per tx hash (lowercase), from the public snapshot.
   *  Lets a Transfer Out row find the one-time receipt a send with no change
   *  note stored before broadcast under its recipient commitment (DEV-413). */
  transactOutputsByTx?: ReadonlyMap<string, readonly string[]>;
  /** What the snapshot proves about each swap route tx, by chain and hash
   *  (services/swap-route-evidence.ts). */
  swapRouteKinds: ReadonlyMap<string, SwapRouteKind>;
  /** Tx hashes this device recorded as my own confirmed anchors. Local, so it
   *  does not wait on the ASP snapshot the lineage rows need. */
  anchorTxHashes: ReadonlySet<string>;
  transferClassificationReady: boolean;
  /**
   * Whether my own spends are still being classified for the CURRENT notes +
   * snapshot (keys held, snapshot loaded, run neither done nor failed). A
   * Transact row whose direction can only come from that classification must
   * not render yet (DEV-394: a mid-flight change note read as Transfer In).
   */
  spendClassificationPending: boolean;
  /**
   * Whether the account's holdings on the ACTIVE chain are known, as opposed to
   * not loaded yet: nothing can be held (no identity, wallet not reconnecting),
   * a persisted export exists for this identity + chain, or a discovery pass
   * completed here this session. The hub's spend tabs offer what is held; until
   * this is true they must not read an empty set as "holds nothing" and reset a
   * valid pick to ETH (codex P2 on 7974a5e).
   */
  holdingsReady: boolean;
  /**
   * Visible chains whose history has not loaded yet (public feed, own feed or
   * event snapshot). Anything built from the full history, like the accounting
   * export, is incomplete until this is empty.
   */
  historyPendingChainIds: number[];
  /**
   * Chains where a Transfer row may still turn out to be mine: keys are held
   * but my spends there are not classified yet (first run still going, or the
   * chain's event snapshot not loaded). A row there with no direction is not
   * yet known to be a stranger's, so it must not read "Private".
   */
  ownTransfersPendingChainIds: number[];
  /** The connected wallet's own deposits and ragequit exits over FULL history,
   *  from the (un-windowed) EVM event snapshot. The windowed feed drops events
   *  older than its window; the accounting export folds these back in so a tax
   *  ledger stays complete. EVM-only (the snapshot has no Sui events). */
  /** Snapshot deposits carry their chain now that the snapshot spans chains. */
  myDeposits: Array<SnapshotDeposit & { chainId?: number }>;
  myExits: Array<SnapshotRagequit & { chainId?: number }>;
  /** The EVM default-chain id snapshot-sourced deposit/exit rows are tagged with. */
  defaultChainId: number;
  /** Tx hashes of the user's own INTERNAL spends (self merge/split) from the
   *  nullifier reconstruction. These get no lineage row (nothing external
   *  moved), so nothing replaces their ASP feed row in the personal scope —
   *  and with SPENT notes now valid 'in' signals, that leftover row would
   *  classify (and export) as a received transfer. Consumers suppress these
   *  rows before direction/accounting classification. Empty until the spend
   *  reconstruction is ready. */
  internalTxHashes: Set<string>;
  /** Deposits the ASP approved that the balance row still shows as pending
   *  (no local note matched). Drives the reconcile resync below. */
  unmatchedApprovedDeposits: PendingDeposit[];
  /** Signal 3 (services/deposit-ownership.ts) for deposits this wallet
   *  submitted, lowercase tx hashes. `notMine`: sealed to another account, so
   *  authored, not owned. `pending`: still being decided, so no surface may
   *  claim them either way yet. */
  depositOwnership: { notMine: ReadonlySet<string>; pending: ReadonlySet<string> };
};

type PoolsContextType = {
  data: PoolsData;
  /**
   * Yield earned per share position of the session's chain, keyed
   * `${chainId}:${share}` (services/yield-earned.ts). Computed on a fixed
   * cadence here, app-wide, so no screen can cause it.
   */
  yieldEarned: YieldEarnedByShare;
  /**
   * Raw wallet balance of every pinned yield SHARE token on `chainId`, keyed by
   * lowercase share address. Read by the same fixed-cadence balance poll as
   * every other wallet token (services/loose-share-unwrap.ts).
   */
  walletShareBalances?: { chainId: number; owner: string; balances: Record<string, bigint>; allowances: Record<string, bigint> };
  statistics: GlobalStatistics | null;
  isLoading: boolean;
  error: string | null;
  /** Entrypoint contract address scoping the events feed ('' = all pools). */
};

// --- Helpers ---

const TOKEN_DECIMALS: Record<string, number> = {
  ETH: 18,
  USDC: 6,
  USDT: 6,
  DAI: 18,
  WETH: 18,
  SUI: 9, // MIST base units
  XLM: 7, // stroops
};

const TOKEN_COLORS: Record<string, string> = {
  ETH: '#627EEA',
  USDC: '#2775CA',
  USDT: '#26A17B',
  DAI: '#F5AC37',
  WETH: '#EC1C79',
  SUI: '#4DA2FF',
  XLM: '#0F0F0F',
};

// Compact USD format, canonical rules in services/format-fiat.ts. Re-exported
// here so the stats cards and pool pages keep their existing import path.
export { formatUsd };

// Same pool-size shape as Explore (services/explore-pools.ts).
const formatTokenAmount = formatCompactTokenAmount;

function computeChange24h(stats: GlobalStatistics | undefined): string {
  if (!stats) return '+0.0%';
  const depositsUsd = parseFloat(stats.last24h.totalDepositsValueUsd) || 0;
  const withdrawalsUsd = parseFloat(stats.last24h.totalWithdrawalsValueUsd) || 0;
  const tvlUsd = parseFloat(stats.allTime.tvlUsd) || 1;
  const net = depositsUsd - withdrawalsUsd;
  const pct = (net / tvlUsd) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function normalizeEventTimestamp(timestamp: number): number {
  // ASP currently returns unix milliseconds. Keep a seconds fallback for older payloads.
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

// The ASP reports `denomination: 18` for EVERY asset — Sui coins (native SUI
// is 9-decimal MIST) and 6-decimal stablecoins alike, on every chain: a
// 5-USDC deposit arrives as amount "5000000" with denomination 18 and
// rendered as "<0.01 USDC" (QA 2026-08-18; previously read as a Sui-only
// quirk). Our per-chain registry knows the real decimals, so it wins
// whenever it KNOWS the token; the event field stays the fallback for
// assets we don't carry metadata for.
function eventDenomination(event: ActivityEvent): number {
  const known = getKnownTokenMetadata(event.asset.tokenAddress, event.asset.chainId);
  if (known) return known.decimals;
  return event.asset.denomination || 18;
}

function mapEventToTransaction(
  event: ActivityEvent,
  priceMap: Record<string, number>,
  transferTxHashes: Set<string>,
  withdrawalRouteTxHashes: ReadonlySet<string>,
): Transaction {
  // ASP returns the token *address* as tokenSymbol — using it directly meant
  // 'USDC' was actually '0x1C7D...' uppercased and never matched the stable
  // list. Resolve the real symbol via getTokenMetadata first.
  const resolvedSymbol = getTokenMetadata(event.asset.tokenAddress, event.asset.chainId).symbol.toUpperCase();
  const stableFallback = isStablecoin(resolvedSymbol) ? 1 : 0;
  // Activity lists every chain at once, so the row's OWN chain's price: the
  // bare address key is the active chain's, and every EVM chain shares the
  // native sentinel, which priced a BNB deposit as ETH on Ethereum.
  const price = priceFromMap(priceMap, { chainId: event.asset.chainId, address: event.asset.tokenAddress, symbol: resolvedSymbol })
    || priceMap[event.asset.tokenSymbol]
    || stableFallback;
  const denomination = eventDenomination(event);
  const tokenAmount = parseFloat(event.amount) / 10 ** denomination;
  const usdValue = tokenAmount * price;

  const normalizedTimestamp = normalizeEventTimestamp(event.timestamp);

  const typeMap: Record<string, string> = {
    deposit: 'Deposit',
    withdrawal: 'Withdrawal',
    ragequit: 'Exit',
    transfer: 'Transfer',
  };

  // The ASP types a Transacted event 'withdrawal' or, by its own arity
  // guess, 'transfer', with `amount` set to what left the pool (for a
  // transfer, the relayer fee). The event snapshot corrects it: the log's
  // caller where it names the route, else arity (services/transact-shape.ts).
  const rawType = feedEventType(event.type, String(event.txHash).toLowerCase(), transferTxHashes, withdrawalRouteTxHashes);

  // Review -> outcome lives in services/funds-state.ts (declined -> failed,
  // poi_required -> pending outcome + an 'at risk' fund state below).

  // A feed deposit with no reviewStatus: the ASP stopped publishing per-deposit
  // verdicts (publicFeed.hideReviewStatus, DEV-587), since each one dates the
  // deposit's leaf. The deposit happened, so it reads completed; my own rows
  // derive their verdict below.
  const feedHidesVerdict = rawType === 'deposit' && event.reviewStatus === undefined
    && typeof event.eventId !== 'string';
  // Withdrawals and ragequits don't carry a reviewStatus from the API.
  // If they've been recorded on-chain they are effectively completed.
  const effectiveReviewStatus = event.reviewStatus
    ?? (feedHidesVerdict ? '' : rawType === 'deposit' ? 'pending' : 'approved');
  // My deposit from the event snapshot (a local string id; the ASP's ids are
  // numbers): no ASP verdict, so the row claims none until its note is
  // matched and one is derived locally. A public row keeps the ASP's, even
  // when it carries the commitment of the own row it covers.
  const commitment = 'commitment' in event ? event.commitment : undefined;
  const noVerdict = rawType === 'deposit' && (typeof event.eventId === 'string' || feedHidesVerdict);

  return {
    id: event.eventId.toString(),
    address: event.address.length >= 10
      ? `${event.address.slice(0, 6)}...${event.address.slice(-4)}`
      : event.address,
    fullAddress: event.address,
    type: typeMap[rawType] || rawType,
    chain: getChainConfig(event.asset.chainId)?.displayName || event.asset.chainName || 'ETH',
    chainId: event.asset.chainId,
    asset: getTokenMetadata(event.asset.tokenAddress, event.asset.chainId).symbol,
    tokenAddress: event.asset.tokenAddress,
    rawAmount: event.amount,
    tokenAmount,
    usdValue,
    value: formatUsd(usdValue),
    timestamp: normalizedTimestamp,
    status: feedHidesVerdict ? 'completed' : reviewOutcome(effectiveReviewStatus),
    txHash: event.txHash,
    reviewStatus: noVerdict ? '' : effectiveReviewStatus,
    // Declined / Proof-required deposits are 'at risk' before any local note
    // is consulted; the note merge below refines approved rows.
    ...(rawType === 'deposit'
      ? fundsFields(projectDepositFunds({
          reviewStatus: effectiveReviewStatus,
          noteStatus: null,
          leafReady: false,
          leafConfirmed: false,
          registration: 'unknown',
          discoveryReady: false,
        }))
      : {}),
    aspRoot: event.aspRoot || null,
    label: event.label || null,
    ...(commitment ? { ownCommitment: commitment } : {}),
    ...(rawType === 'deposit' && typeof event.fundingSource === 'string' && event.fundingSource ? { fundingSource: event.fundingSource } : {}),
  };
}

// The recipient is not recoverable from chain data (it is the recipient's
// note, not ours), but when WE were the sender we wrote it down locally. A
// tester read his own payment-request payment as missing money because this
// row was anonymous (Mike, 2026-08-26). Sent transfers, paid payment requests
// and own withdrawals are all keyed by txHash; any one names the payee.
// The withdrawal list is read once per pass and handed in.
function recordedRecipient(txHash: string, withdrawRecipients: readonly WithdrawRecipient[]): string | null {
  return recordedTransferPayee(txHash) ?? findWithdrawRecipientIn(withdrawRecipients, txHash) ?? null;
}

/** Spread a fund-state projection onto a row (nothing when there is none). */
function fundsFields(p: FundsProjection | null): Pick<Transaction, 'fundsState' | 'fundsReason'> {
  return p ? { fundsState: p.state, fundsReason: p.reason } : {};
}

function asOutcome(status: string): TransactionOutcome {
  return status === 'completed' || status === 'failed' ? status : 'pending';
}

function resolveTokenSymbol(tokenId: string, chainId?: number): string {
  return getTokenMetadata(tokenId, chainId).symbol;
}

const EMPTY_STATS: MyPoolsStats = {
  acceptedFundsValue: '$0',
  acceptedFundsUsd: 0,
  acceptedFundsChange: '0%',
  acceptedFundsLabel: '',
  pendingValue: '$0',
  pendingChange: '0%',
  totalDeposits: 0,
  totalTransfers: 0,
  totalWithdrawals: 0,
  totalSwaps: 0,
  assets: [],
};

const EMPTY_DATA: PoolsData = {
  myPools: [],
  myPoolsStats: EMPTY_STATS,
  availableAssets: [],
  allPools: [],
  transactions: [],
  lineageRows: [],
  priceMap: {},
  pricesLoading: true,
  transferTxHashes: new Set(),
  swapRouteKinds: new Map(),
  anchorTxHashes: new Set(),
  transferClassificationReady: false,
  spendClassificationPending: false,
  holdingsReady: false,
  historyPendingChainIds: [],
  ownTransfersPendingChainIds: [],
  myDeposits: [],
  myExits: [],
  defaultChainId: 0,
  internalTxHashes: new Set(),
  unmatchedApprovedDeposits: [] as PendingDeposit[],
  depositOwnership: { notMine: new Set<string>(), pending: new Set<string>() },
};

// --- Context ---

const PoolsContext = createContext<PoolsContextType | undefined>(undefined);

// Match the SDK's label-hash format (padStart(64) lowercase) so a hashed note
// label can be checked against the association-set leaves (which are stored
// already normalized this way).
function normalizeHashValue(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return `0x${BigInt(value).toString(16).padStart(64, '0')}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

type EventSnapshotDrops = NonNullable<ReturnType<typeof missingSectionDrops>>;

type SnapshotChainSections = {
  deposits: (SnapshotDeposit & { chainId: number })[];
  transacts: (SnapshotTransact & { chainId: number })[];
  ragequits: (SnapshotRagequit & { chainId: number })[];
  drops?: EventSnapshotDrops;
};

type TaggedEventSnapshot = Omit<SnapshotChainSections, 'drops'> & {
  loadedChainIds: number[];
  dropsByChain: Record<number, EventSnapshotDrops>;
};

type FeedChainRows = { events: GlobalEvent[]; byChain: Record<number, GlobalEvent[]>; totalsByChain: Record<number, number>; completeByChain: Record<number, boolean>; allTotalsLoaded: boolean; loadedChainIds: number[] };

/**
 * Signal 3 for the deposits this wallet submitted, and which of them a pass has
 * settled, for the wallet + viewing key it was computed for.
 */
type ViewingKeyOwnership = { identity: string | null; verdicts: ReadonlyMap<string, boolean>; settled: ReadonlySet<string> };

const NO_VIEWING_KEY_OWNERSHIP: ViewingKeyOwnership = { identity: null, verdicts: new Map(), settled: new Set() };

function sameOwnership(prev: ViewingKeyOwnership, identity: string, verdicts: ReadonlyMap<string, boolean>, settled: ReadonlySet<string>): boolean {
  if (prev.identity !== identity) return false;
  if (prev.verdicts.size !== verdicts.size || prev.settled.size !== settled.size) return false;
  for (const [k, v] of prev.verdicts) if (verdicts.get(k) !== v) return false;
  for (const k of prev.settled) if (!settled.has(k)) return false;
  return true;
}

// One decrypter per app: the note codec carries a Poseidon instance, and the
// verdict pass reruns on every notes change.
let noteDecrypterPromise: Promise<NoteDecrypter> | null = null;
function noteDecrypter(): Promise<NoteDecrypter> {
  if (!noteDecrypterPromise) {
    noteDecrypterPromise = import('@/services/sdk-setup').then(async ({ createCryptoService, createNoteComputationService }) => {
      const crypto = createCryptoService();
      const codec = await createNoteComputationService();
      return {
        ecdh: (privateKey, publicKey) => crypto.ecdh(privateKey, publicKey),
        decrypt: (ciphertext, secret) => crypto.decrypt(ciphertext, secret),
        decodeNotePayload: (bytes) => codec.decodeNotePayload(bytes),
      } satisfies NoteDecrypter;
    });
    noteDecrypterPromise.catch(() => { noteDecrypterPromise = null; });
  }
  return noteDecrypterPromise;
}

function mergeFeedChains(
  chainIds: readonly number[],
  settled: readonly PromiseSettledResult<ChainEventsRead>[],
  previous: FeedChainRows | undefined,
): FeedChainRows {
  const { rows, loadedChainIds } = mergeChainResults(
    chainIds,
    settled,
    previous && {
      loadedChainIds: previous.loadedChainIds,
      rowsFor: (cid) => ({ events: previous.byChain[cid] ?? [], total: previous.totalsByChain?.[cid] ?? 0, complete: previous.completeByChain?.[cid] ?? false }),
    },
  );
  const byChain: Record<number, GlobalEvent[]> = {};
  const totalsByChain: Record<number, number> = {};
  const completeByChain: Record<number, boolean> = {};
  for (const [cid, read] of rows) {
    byChain[cid] = read.events;
    totalsByChain[cid] = read.total;
    completeByChain[cid] = read.complete;
  }
  // Totals are kept per chain in the cache (a later tick that fails for one
  // chain falls back to its held total, not 0), but the header publishes them
  // only once every visible chain has one, never a partial sum.
  const allTotalsLoaded = chainIds.every((cid) => loadedChainIds.includes(cid));
  return { events: [...rows.values()].flatMap((read) => read.events), byChain, totalsByChain, completeByChain, allTotalsLoaded, loadedChainIds };
}

// A fresh {} default made every render while the price query was pending a NEW
// identity for the data memo's dependency, re-running the whole pass (and its
// per-chain account-export reads) for a reason unrelated to prices.

function RealPoolsProvider({ children }: { children: ReactNode }) {
  const defaultChain = useActiveEvmChain();
  const { address, status: accountStatus } = useAccount();
  // Address to attribute "my" activity (deposit/transfer/withdrawal counts) to:
  // the active-chain account, so a Sui session counts its Sui address instead
  // of the (empty) wagmi EVM address. Falls back to the EVM address.
  const { address: multiChainAddress } = useMultiChainWallet();
  const myAddress = multiChainAddress ?? address;
  const { notes } = useNotes();
  const { keystoreManager, identityMode, keysReady, sessionAddress, syncedHoldings, poolSession, sessionTarget } = usePoolSession();
  // The identity "my" activity is attributed to. An ACCOUNT-KEY session has no
  // wallet at all, so the wallet-only myAddress left it with none: its own
  // history rows were never built, and the deposit / transfer / withdrawal
  // counts read as 0. The public feed is a 50-row window PER CHAIN, so without
  // them a key session sees only whatever of its activity has not yet scrolled
  // out (Pat measured 2 rows against the wallet session's 30, 2026-08-31).
  // BRANCH on identityMode rather than falling back only when the wallet is
  // absent: a key session may ALSO have a wallet connected (deposits require
  // one), and that wallet is a payer, not the account whose history this is.
  // The non-key branch keeps myAddress, so on Sui it stays the Sui address and
  // an existing wallet session is byte-identical.
  const myActivityAddress = identityMode === 'key' ? sessionAddress : myAddress;
  // Keystore registration drives the Claim projection: an approved, spendable
  // note on an UNREGISTERED wallet is claimable, not ready.
  const { status: registrationStatus } = useKeystoreRegistrationModal();

  // The ONE association-set gate (services/leaf-gate.ts + hooks/use-leaf-gate.ts).
  //
  // This used to be a local effect that hashed labels against the session
  // leaves, while the withdraw modal ran its OWN fetch and its own unpadded
  // normaliser — two sources, two moments, two answers, which is how one
  // screen could show a balance the withdraw form contradicted. Same policy as
  // before (fail-open: trust ACTIVE until the set is known), now expressed
  // against shared facts.
  const leafGate = useLeafGate(notes);
  // Every chain's published label decisions, for the verdict of my own
  // deposit rows built from the event snapshot. Read off the feed grid only.
  const labelDecisionsByChain = useLabelDecisionsByChain();
  const leafState = useMemo(
    () => ({ ready: leafGate.status === 'ready', confirmed: leafGate.confirmed }),
    [leafGate],
  );
  const { log, isDebugEnabled } = useDebug();
  const { txPending } = useTxActivity();
  // Our own operations the feeds do not describe yet (a deposit this client
  // just broadcast). Local ledger, merged below by (chain, tx hash, row type);
  // services/feed-reconciliation.ts. This is what lets the four feeds below
  // poll on a fixed cadence through a transaction: a row of ours coming back
  // from the ASP is recognised as ours and shown once, not counted again.
  const pendingOwnRows = usePendingOwnRows();
  // Live vault rates, so the hero total prices a share the way its ROW does.
  const { rateFor } = useShareRates();

  // A fixed cadence for the wallet reads: the number an observer sees is a
  // build constant, not a function of what the user is doing.
  const WALLET_BALANCE_POLL_MS = 30_000;

  // Whose balances these are. The latch below freezes a figure while a
  // transaction is in flight, and without this it would keep showing the old
  // account's number after a wallet or chain switch mid-send.
  const walletReadIdentity = `${address ?? ''}:${defaultChain.id}`;

  // Connected wallet's native balance, on a FIXED cadence.
  //
  // Be accurate about what changed here. This read was
  // `refetchInterval: txPending ? false : undefined`, and `undefined` is not a
  // poll — with no query defaults set, both branches meant "no timer", so this
  // particular site never had a silence window to leak. The `txPending` gate
  // was decoration, and the "wagmi watches new blocks aggressively" comment it
  // carried was v1 folklore.
  //
  // The interval is therefore a deliberate ADDITION, and a UX one before it is
  // a privacy one: the ERC-20 read below genuinely needed a cadence (its
  // `!txPending` flip was the only thing refreshing it), and a wallet whose
  // native balance never refreshes while its tokens do is the kind of
  // inconsistency that produces a bug report nobody can reproduce. One cadence
  // for every wallet read in this provider, and the latch keeps the figure
  // steady mid-send so the poll cannot overwrite what the user is reading.
  const { data: liveEthWalletBalance } = useBalance({
    address,
    // The chain the app is showing, not the one the wallet happens to sit on —
    // otherwise every wallet-balance surface reads the wrong chain until the
    // user switches networks in their wallet.
    chainId: defaultChain.id,
    query: { refetchInterval: WALLET_BALANCE_POLL_MS },
  });
  const ethWalletBalance = useLatchedWhile(liveEthWalletBalance, txPending, walletReadIdentity);

  // Read-only, from the app-wide scheduler. This used to stop polling while a
  // transaction was in flight, so the ASP saw our traffic go quiet for exactly
  // as long as a withdrawal took to settle — the disclosure's join, by silence
  // instead of by a value. services/public-feed-scheduler.ts.
  const statisticsFeed = usePublicFeed<GlobalStatistics>(FEED_GLOBAL_STATISTICS);
  const statistics = feedData(statisticsFeed);
  const statsError = statisticsFeed.status === 'error' ? statisticsFeed.error : null;

  // Events are chain-scoped: query the ACTIVE chain (SUI testnet = 102 when the
  // Sui wallet drives the session), not the EVM default — otherwise SUI deposits
  // indexed by the ASP (and their pending/approved reviewStatus) never surface.
  const { activeChainId } = useChainRouter();
  // Transactions (All) is a multi-chain aggregate — the app serves Sui + EVM
  // pools, so the feed shows activity from every VISIBLE chain, not just the
  // active one (product direction). Sui is gated strictly behind debug
  // (?debug=1) for now — a non-debug user never sees Sui rows, even if Sui is
  // somehow the active chain. Per-wallet views ("My Transactions", balances,
  // counts) still scope by the connected address.
  const feedChainIds = useMemo(
    () => supportedChainIds.filter(
      // Stellar is not indexed by the 0xbow ASP events API at all.
      (cid) => getChainConfig(cid)?.chainType === 'evm'
        || (getChainConfig(cid)?.chainType === 'sui' && isDebugEnabled),
    ),
    [isDebugEnabled],
  );
  const queryClient = useQueryClient();
  const globalEventsKey = ['globalEvents', feedChainIds.join(',')];
  const { data: eventsResponse, error: eventsError } = useQuery({
    queryKey: globalEventsKey,
    queryFn: async () => {
      // A tab that loaded with nobody looking fetches when someone arrives.
      await whenActive();
      const previous = queryClient.getQueryData<FeedChainRows>(globalEventsKey);
      const settled = await Promise.allSettled(
        // Every row, not a first-page window: the All list and its count are
        // the protocol's activity (services/global-events-pages.ts). Page 1 is
        // read each tick and merged onto the rows already held, so a tick is
        // one request per chain; deeper pages only on first load or a burst.
        // Read on this query's fixed cadence, never on a scroll.
        feedChainIds.map((cid) =>
          readAllGlobalEventPages((page, perPage) => apiClient.getGlobalEvents({
            page,
            perPage,
            includeRagequit: true,
            chainId: cid,
          }), {
            previous: previous?.loadedChainIds.includes(cid)
              ? { events: previous.byChain[cid] ?? [], total: previous.totalsByChain?.[cid] ?? 0, complete: previous.completeByChain?.[cid] ?? false }
              : undefined,
          }),
        ),
      );
      // One chain failing must not blank the feed, but if EVERY visible chain
      // failed, surface the error rather than render a silent empty feed.
      if (!settled.some((r) => r.status === 'fulfilled') && settled.length > 0) {
        throw (settled[0] as PromiseRejectedResult).reason ?? new Error('all event feeds failed');
      }
      return mergeFeedChains(feedChainIds, settled, previous);
    },
    staleTime: 30_000,
    // A fixed cadence, whatever the user is doing. This poll used to stop
    // while a transaction was in flight, so the ASP saw this client go quiet
    // for exactly the length of every deposit or spend. The pause guarded an
    // optimistic row that lived INSIDE this cache and that a tick would wipe;
    // that row is a local ledger entry now (services/feed-reconciliation.ts)
    // and the merge below recognises our own operation when the feed returns
    // it, so nothing here needs to know about transactions any more.
    //
    // Two minutes. This is the explorer/activity list: one request per chain
    // per tick, and at 15s it was the largest single source of ASP traffic
    // (12 requests a minute, more with retries) in an idle tab. Our own
    // operations show at once from the local ledger, not from this poll.
    refetchInterval: 120_000,
  });

  // Sui analog of leafState (issue #214): an ACTIVE Sui note is only
  // spendable once its label is admitted to the Sui ASP association set —
  // the transact proof needs the membership path, so counting unapproved
  // notes as available overstates the balance right after a deposit.
  const isSuiActive = activeChainId === SUI_TESTNET_ID;
  // Stellar: native XLM only. Its notes are ACTIVE only once the SDK has seen
  // their label in the association set, so no separate leaf gate is needed.
  const isStellarActive = activeChainId === STELLAR_TESTNET_ID;
  const stellarWallet = useStellarWallet();
  // The Stellar account's on-chain note origins (read on its own sync clock),
  // for the activity rows below. Null until the account has synced.
  const { noteOrigins: stellarNoteOrigins } = useStellarSession();
  const { data: stellarWalletBalance } = useStellarBalance(
    isStellarActive && stellarWallet.isConnected ? stellarWallet.address : null,
  );
  // Connected Sui wallet's native SUI balance — the amount available to shield.
  // Powers the SUI row in "Available Assets to Shield" (below), which otherwise
  // showed the Sepolia EVM assets even when Sui is the active chain.
  const { data: suiWalletBalanceData } = useSuiClientQuery(
    'getBalance',
    { owner: (isSuiActive && multiChainAddress) || '' },
    { enabled: isSuiActive && !!multiChainAddress },
  );
  const suiWalletMist = suiWalletBalanceData?.totalBalance ? BigInt(suiWalletBalanceData.totalBalance) : 0n;
  const { data: suiApprovedSet } = useQuery({
    queryKey: ['suiApprovedSet'],
    queryFn: async () => { await whenActive(); return fetchSuiApprovedSet(); },
    enabled: isSuiActive,
    staleTime: 15_000,
    // Fixed cadence. This pause was defensive: the set only decides which of
    // OUR notes are spendable yet, nothing is counted from it, and a refresh
    // mid-transaction can only admit a label sooner. (The Sui deposit path
    // never flagged activity at all, so the gate was dead for deposits.)
    refetchInterval: 15_000,
  });
  const [suiLeafState, setSuiLeafState] = useState<{ ready: boolean; confirmed: Set<string> }>({
    ready: false,
    confirmed: new Set(),
  });
  useEffect(() => {
    if (!isSuiActive) {
      setSuiLeafState({ ready: false, confirmed: new Set() });
      return;
    }
    // Set not fetched yet (or fetch failing): stay not-ready and trust ACTIVE
    // status, mirroring the EVM leafState fallback.
    if (!suiApprovedSet) return;
    let cancelled = false;
    (async () => {
      const values = new Set(suiApprovedSet.values.map(String));
      const confirmed = new Set<string>();
      for (const note of notes) {
        if (!note.label) continue;
        const label = BigInt(note.label);
        const key = suiApprovedSet.kind === 'labels' ? label : await calculateLabelHash(label);
        if (values.has(String(key))) confirmed.add(note.commitment);
      }
      if (!cancelled) setSuiLeafState({ ready: true, confirmed });
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuiActive, suiApprovedSet, notes]);

  // ASP currently classifies every Transacted event as `withdrawal`, even
  // when it's actually a private transfer (1 nullifier, 2 outputs, only
  // the relayer fee leaves the pool). Pull the per-chain event-snapshot
  // and build a set of txHashes whose Transacted has 2+ output commitments
  // — those are transfers, not withdrawals. Scoped to the three sections this
  // reads; it is NOT sharing note discovery's cache (different query key).
  // EVERY feed chain, not just the active one.
  //
  // The events feed already fans out across feedChainIds, but this snapshot
  // fetched `defaultChain.id` alone — so everything derived from it (the
  // transfer/withdrawal discriminator, deposit ownership, the outgoing-spend
  // reconstruction) existed only for whichever chain the app happened to be
  // on. Sitting on Optimism, every Sepolia row went unclassified and
  // undecrypted, which is exactly what Artem reported ("sepolia tx-es are not
  // processed\decrypted. sepolia snapshot isnt fetched from asp", 2026-08-28).
  //
  // Entries are TAGGED with their chain on the way in. The sections carry no
  // chainId of their own, and consumers below key by chain (the native
  // sentinel address is shared, so an untagged merge would let Sepolia ETH and
  // Citrea cBTC collide — the bug the old `${defaultChain.id}:${addr}` keys
  // were working around).
  //
  // Cost stays bounded: services/snapshot-source caches per pool and polls a
  // 196-byte version probe, so a chain whose snapshot has not moved re-reads
  // nothing. Sui is excluded — the snapshot has no Sui events.
  const snapshotChainIds = useMemo(
    () => feedChainIds.filter((cid) => getChainConfig(cid)?.chainType === 'evm'),
    [feedChainIds],
  );
  const eventSnapshotKey = ['eventSnapshot', snapshotChainIds.join(',')];
  const { data: eventSnapshot, isError: eventSnapshotFailed } = useQuery({
    queryKey: eventSnapshotKey,
    queryFn: async () => {
      await whenActive();
      const { loadPoolEventSnapshot } = await import('@/services/snapshot-source');
      const settled = await Promise.allSettled(
        snapshotChainIds.map((cid) => loadPoolEventSnapshot(cid)),
      );
      // All chains failing is NOT an empty snapshot: `undefined` is the
      // not-loaded signal every consumer gates readiness on, and returning an
      // empty payload would assert "this user has no deposits anywhere".
      if (!settled.some((r) => r.status === 'fulfilled')) throw new Error('No event snapshot could be loaded for any chain');
      const previous = queryClient.getQueryData<TaggedEventSnapshot>(eventSnapshotKey);
      // A chain whose refetch failed keeps its last good sections; one that
      // never loaded stays out of `loadedChainIds`, and consumers must not read
      // its missing spends as "never spent".
      const { rows, loadedChainIds } = mergeChainResults<SnapshotChainSections>(
        snapshotChainIds,
        settled.map((r, i) => {
          if (r.status !== 'fulfilled') return r;
          const cid = snapshotChainIds[i];
          const payload = r.value;
          return {
            status: 'fulfilled' as const,
            value: {
              deposits: (payload.deposits ?? []).map((d) => ({ ...d, chainId: cid })),
              transacts: (payload.transacts ?? []).map((t) => ({ ...t, chainId: cid })),
              ragequits: (payload.ragequits ?? []).map((q) => ({ ...q, chainId: cid })),
              // A section missing from a chain's payload is lost rows, not zero rows.
              drops: missingSectionDrops(payload),
            },
          };
        }),
        previous && {
          loadedChainIds: previous.loadedChainIds,
          rowsFor: (cid) => ({
            deposits: previous.deposits.filter((d) => d.chainId === cid),
            transacts: previous.transacts.filter((t) => t.chainId === cid),
            ragequits: previous.ragequits.filter((q) => q.chainId === cid),
            drops: previous.dropsByChain[cid],
          }),
        },
      );
      const sections = [...rows.values()];
      const deposits = sections.flatMap((c) => c.deposits);
      const transacts = sections.flatMap((c) => c.transacts);
      const ragequits = sections.flatMap((c) => c.ragequits);
      const dropsByChain: TaggedEventSnapshot['dropsByChain'] = {};
      for (const [cid, c] of rows) if (c.drops) dropsByChain[cid] = c.drops;
      const snapshot: TaggedEventSnapshot = { deposits, transacts, ragequits, loadedChainIds, dropsByChain };
      return snapshot;
    },
    staleTime: 60_000,
    // Fixed cadence. This pause was defensive too: everything derived from the
    // snapshot is already keyed on what THIS account owns (our nullifiers in
    // reconstructUserSpends, our commitments in myDeposits / myExits, tx-hash
    // sets everywhere else), so our own transact arriving mid-flight is
    // classified as ours by construction, and the My-transactions merge
    // (services/transfer-direction.ts) already replaces the feed's row for the
    // same hash with the reconstructed one. Arriving earlier changes nothing.
    //
    // A read of the copy the public feed grid keeps (services/snapshot-source.ts):
    // no tick, focus or invalidation here can send a request. The effect below
    // re-reads it as soon as the grid lands a refresh; this interval is only a
    // backstop for a missed notification.
    refetchInterval: 120_000,
  });
  useEffect(() => {
    const unsubscribes = snapshotChainIds.map((cid) => publicFeeds.subscribe(feedEventSnapshot(cid), () => {
      void queryClient.invalidateQueries({ queryKey: ['eventSnapshot'] });
    }));
    return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  }, [snapshotChainIds, queryClient]);

  // #215 follow-up: reconstruct the user's OUTGOING spends (transfers AND
  // withdrawals) cross-device from on-chain Transacted events + their own notes
  // (no contract change, no per-device sender-stamp). See
  // services/outgoing-transfers.ts + the gist. `ready` gates the lineage-row
  // synthesis below: until spends are classified, an own-spend change note
  // can't be told apart from a received transfer, and rendering it as
  // 'Transfer In' both shows a wrong row and suppresses the real outgoing row
  // (the exact regression reported on #215/#214).
  // `forNotes` / `forSnapshot` pin the result to the exact inputs it was
  // computed from, so `spendsReady` below is false SYNCHRONOUSLY on the first
  // render with new notes or a new snapshot: an effect-time reset ran one
  // render late, and that render could already paint my own change note as
  // Transfer In (codex, 2026-09-04, round 2).
  const [userSpends, setUserSpends] = useState<{ ready: boolean; list: UserSpend[]; forNotes?: readonly Note[]; forSnapshot?: unknown; forIdentity?: string; failed?: boolean }>({ ready: false, list: [] });
  // EVERY chain's notes, not just the live session's. The snapshot carries
  // every chain's transacts and "is this row mine" reads every chain's notes,
  // so reconstructing from the session chain alone left an own spend on
  // another chain mine but unexplained: "Transfer · Private" with no amount
  // (Mike, 2026-09-24). Same identity precedence as the balances below.
  const storedNoteSets = useMemo(() => {
    const identity = sessionAddress ?? myAddress;
    if (!identity) return [];
    return supportedChainIds
      .filter((cid) => getChainConfig(cid)?.chainType === 'evm')
      .map((cid) => ({ chainId: cid, notes: (loadStoredAccountExport(identity, cid)?.notes ?? []) as unknown as typeof notes }));
    // syncedHoldings: another chain's stored export is written by a background
    // sync without the live notes changing, and its spends must be picked up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, sessionAddress, myAddress, syncedHoldings]);
  // Note: matched with the session's nullifying key. Prod chains share one
  // (HKDF) scheme; a staging Sepolia keccak keystore simply matches nothing,
  // so its rows keep their previous rendering.
  // Each note carries the chain whose store holds it: a same-chain swap is
  // proven by an output note on the spend's own chain (services/outgoing-transfers.ts).
  const liveChainId = useLiveNotesChainId();
  const freshSpendNotes = useMemo(
    () => mergeNotesByCommitment(
      liveChainId === null ? [] : notes.map((n) => ({ ...n, chainId: liveChainId })),
      storedNoteSets.map((set) => set.notes.map((n) => ({ ...n, chainId: set.chainId }))),
    ),
    [notes, storedNoteSets, liveChainId],
  );
  // The same notes, tagged with their chain, for the received rows. Stellar's
  // are classified by services/stellar-activity.ts instead.
  const receivedCandidates = useMemo(
    () => tagNotesByChain(activeChainId === STELLAR_TESTNET_ID || liveChainId === null ? null : { chainId: liveChainId, notes }, storedNoteSets),
    [notes, storedNoteSets, activeChainId, liveChainId],
  );
  // Same notes, same array. Every notes poll and background holdings sync
  // rebuilt this list with identical content, and `spendsReady` below is pinned
  // to the array's identity, so each no-op refresh re-ran classification and My
  // transactions hid then re-showed its rows while it did: the table flickered
  // with nothing new in it (Pat, 2026-09-25). A real change (a new note, a
  // status flip) still produces a new array and a fresh classification.
  // Keyed once per rebuilt array, not per render: serialising every note on
  // each PoolsProvider render would cost more than the re-render it saves.
  const freshSpendNotesKey = useMemo(() => contentKey(freshSpendNotes), [freshSpendNotes]);
  const spendNotes = useContentStable(freshSpendNotes, freshSpendNotesKey);
  const spendsForCurrentInputs = userSpends.forNotes === spendNotes && userSpends.forSnapshot === eventSnapshot;
  const spendsReady = userSpends.ready && spendsForCurrentInputs;
  // Still to come, as opposed to merely not ready: without keys, before the
  // snapshot, or after a failed run, no classification is coming, and a hold on
  // `!spendsReady` would hide note-only Transfer rows for good.
  const spendClassificationPending = !!keystoreManager && eventSnapshot?.transacts !== undefined
    && !spendsReady && !(userSpends.failed && spendsForCurrentInputs);
  // The last completed run's spends, still usable while the next is pending
  // for the same identity: what they say about txs they saw stays true.
  const spendIdentity = (sessionAddress ?? myAddress ?? '').toLowerCase();
  const spendsUsable = spendsReady
    || (spendClassificationPending && userSpends.ready && userSpends.forIdentity === spendIdentity);
  useEffect(() => {
    const transacts = eventSnapshot?.transacts;
    if (transacts === undefined) {
      setUserSpends({ ready: false, list: [] });
      return;
    }
    if (spendNotes.length === 0 || transacts.length === 0) {
      setUserSpends({ ready: true, list: [], forNotes: spendNotes, forSnapshot: eventSnapshot, forIdentity: spendIdentity });
      return;
    }
    if (!keystoreManager) {
      // No session keys — spends can't be classified, so stay not-ready
      // rather than emitting misclassified received rows.
      setUserSpends({ ready: false, list: [] });
      return;
    }
    let cancelled = false;
    (async () => {
      const { createHashService } = await import('@/services/sdk-runtime');
      const hashService = await createHashService();
      if (cancelled) return;
      const nullifyingKey = keystoreManager.getPrivateNullifyingKey();
      const anchorOwner = (identityMode === 'key' ? sessionAddress : address)?.toLowerCase() ?? null;
      const anchorTxHashes = anchorOwner ? readAnchorTxHashesForChains(anchorOwner, supportedChainIds) : undefined;
      const crossChainOutputCommitments = new Set(readAllSwapRecords().flatMap((r) => (r.kind === 'cross-chain' ? [r.commitment] : [])));
      // Received notes this device claimed (DEV-574): their spend is the claim.
      const claimedInputs = readClaimedInputMap();
      const list = reconstructUserSpends(spendNotes, transacts, nullifyingKey, hashService, { anchorTxHashes, isTransferRouteCaller, isSwapRouteCaller, crossChainOutputCommitments, claimedInputs });
      if (!cancelled) setUserSpends({ ready: true, list, forNotes: spendNotes, forSnapshot: eventSnapshot, forIdentity: spendIdentity });
    })().catch((err: unknown) => {
      // Not ready, and not pending either: a run that threw is not coming
      // back for these inputs, so nothing may wait on it.
      log('warn', 'PoolsProvider', 'Spend classification failed', { err: err instanceof Error ? err.message : String(err) });
      if (!cancelled) setUserSpends({ ready: false, list: [], failed: true, forNotes: spendNotes, forSnapshot: eventSnapshot });
    });
    return () => {
      cancelled = true;
    };
  }, [spendNotes, eventSnapshot, keystoreManager, identityMode, sessionAddress, address, defaultChain.id, log, spendIdentity]);

  // Relays still pending on this device settle here once the snapshot shows
  // their nullifiers spent. The snapshot is already polled on a fixed cadence,
  // so this adds no request (services/pending-relays-core.ts).
  useEffect(() => {
    const transacts = eventSnapshot?.transacts;
    if (!transacts || transacts.length === 0) return;
    const byChain = new Map<number, typeof transacts>();
    for (const t of transacts) {
      const list = byChain.get(t.chainId) ?? [];
      list.push(t);
      byChain.set(t.chainId, list);
    }
    for (const [cid, list] of byChain) settlePendingRelaysBySpends(cid, spendsFromSnapshot(list));
  }, [eventSnapshot]);

  const transferTxHashes = useMemo(() => {
    // My own sends, stamped on this device at send time. The snapshot lags the
    // activity feed by a minute or two, and until its transact arrived a fresh
    // send rendered with the ASP's Withdrawal / fee amount (codex, 2026-09-04).
    // `notes` is in the deps so a discovery pass after a send recomputes this.
    const set = buildSentTxHashSet();
    // A paid payment request is a private transfer that leaves no
    // sent-transfers stamp, only a paid-request record; without it the
    // payment rendered as a Withdrawal with the fee amount during the lag.
    for (const hash of buildPaidRequestTxHashSet()) set.add(hash);
    for (const t of eventSnapshot?.transacts ?? []) {
      // The caller when it names the route, else arity, because the global
      // feed cannot see a stranger's input labels (services/transact-shape.ts).
      if (feedLooksLikeTransfer(t.outputCommitments?.length ?? 0, {
        transfer: isTransferRouteCaller(t.caller, t.chainId),
        withdrawal: isWithdrawalRouteCaller(t.caller, t.chainId),
      })) {
        set.add(String(t.txHash).toLowerCase());
      }
    }
    return set;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- notes: recompute after a post-send discovery pass (the stamp store is read synchronously)
  }, [eventSnapshot, notes]);
  // Logs a withdrawal route submitted (config/route-callers.ts). The ASP now
  // types some Transacted events 'transfer' by its own arity guess, which a
  // relayed mixed-label withdrawal fails; the caller corrects it.
  const withdrawalRouteTxHashes = useMemo(() => {
    const set = new Set<string>();
    for (const t of eventSnapshot?.transacts ?? []) {
      if (isWithdrawalRouteCaller(t.caller, t.chainId)) set.add(String(t.txHash).toLowerCase());
    }
    return set;
  }, [eventSnapshot]);
  // What each chain's own events prove about a swap route's txs, for every
  // row alike (services/swap-route-evidence.ts).
  const swapRouteKindsByTx = useMemo(
    () => swapRouteKinds({ transacts: eventSnapshot?.transacts ?? [], deposits: eventSnapshot?.deposits ?? [] }, isSwapRouteCaller),
    [eventSnapshot],
  );
  const transactOutputsByTx = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of eventSnapshot?.transacts ?? []) {
      const key = String(t.txHash).toLowerCase();
      const list = map.get(key) ?? [];
      for (const c of t.outputCommitments ?? []) list.push(String(c).toLowerCase());
      map.set(key, list);
    }
    return map;
  }, [eventSnapshot]);
  // Per-snapshot facts the received rows read: every chain's deposit outputs
  // (a deposit root is never a receipt), and each transact's chain and block
  // time (a received row replaces the feed row and keeps its time; a stored
  // note can still carry a block number).
  const snapshotTxIndex = useMemo(() => {
    const depositCommitments = new Set<string>();
    for (const dep of eventSnapshot?.deposits ?? []) {
      const canonical = normalizeCommitment(dep.outputCommitment);
      if (canonical) depositCommitments.add(canonical);
    }
    const chainIds = new Map<string, number>();
    const times = new Map<string, number>();
    for (const t of eventSnapshot?.transacts ?? []) {
      const key = String(t.txHash).toLowerCase();
      chainIds.set(key, t.chainId);
      const ms = snapshotTimestampToMs(t.blockTimestamp);
      if (ms > 0 && !times.has(key)) times.set(key, ms);
    }
    return { depositCommitments, chainIds, times };
  }, [eventSnapshot]);
  // Whether the transfer/withdrawal discriminator has loaded. Until it has, a
  // transfer the ASP labels 'withdrawal' can't be told apart from a real
  // withdrawal — consumers that care (e.g. the accounting CSV) must wait.
  const transferClassificationReady = eventSnapshot !== undefined;
  // The chains the spends on screen were classified against: the current run's,
  // else the last completed run's while the next is pending (spendsUsable), else
  // none yet; null when no run is coming (it failed).
  const classifiedSnapshot = (spendsReady || spendsUsable) ? userSpends.forSnapshot as typeof eventSnapshot : undefined;
  const ownTransfersPending = useMemo(() => ownTransfersPendingChainIds({
    keysHeld: !!keystoreManager,
    snapshotChainIds,
    loadedChainIds: eventSnapshot?.loadedChainIds,
    classifiedChainIds: classifiedSnapshot ? classifiedSnapshot.loadedChainIds ?? [] : spendClassificationPending ? [] : null,
  }), [keystoreManager, snapshotChainIds, eventSnapshot, classifiedSnapshot, spendClassificationPending]);

  // Both price reads come from the scheduler. They used to have no interval at
  // all, so they refreshed on mount, on window FOCUS, and on invalidation —
  // and focus is the one that matters: the withdrawal flow sends the user to
  // their wallet to sign and back, so returning refetched every stale query in
  // a burst bracketing the signature.
  const priceMapFeed = usePublicFeed<Record<string, number>>(feedPriceMap(defaultChain.id));
  // EVERY chain's prices, not just the default chain's.
  //
  // This read was one chain's feed, and on prod that chain is Ethereum, whose
  // rows are ETH / ppUSDC / ppUSDT / ppETH. A balance denominated in any other
  // chain's asset therefore had no row to find and was priced at 0: Citrea cBTC
  // and BNB USDT both showed $0.00 against a real amount (QA, 2026-09-22),
  // while the ASP was serving both figures correctly all along.
  //
  // `useAllChainsPriceMap` reads the same scheduler grid, so this adds no
  // request and no component-triggered fetch. It merges the per-chain feeds and
  // hands back the bare keys with the ACTIVE chain applied last, which is what
  // the lookups below expect, plus a `chainId:key` twin for anything spanning
  // chains. Passing the session chain is what decides the native sentinel:
  // every EVM chain shares one native address, so without it a cBTC row would
  // read mainnet ETH's price, which is a wrong number rather than a missing one.
  const priceMap = useAllChainsPriceMap(isSuiActive || isStellarActive ? undefined : activeChainId);
  const pricesError = priceMapFeed.status === 'error' ? priceMapFeed.error : null;
  const pricesLoading = priceMapFeed.status === 'empty';

  const tokenPricesFeed = usePublicFeed<TokenPricesResponse>(feedTokenPrices(defaultChain.id));
  const tokenPricesResponse = feedData(tokenPricesFeed);
  const tokenPricesError = tokenPricesFeed.status === 'error' ? tokenPricesFeed.error : null;

  // Per-asset TVL and 24h change. Authoritative source for pool value —
  // summing the client-side events pane under-counts whenever the user
  // hasn't paged through the full history.
  // Served from the SAME all-chains feed the Explore page reads, filtered here
  // to this chain. One request instead of two, and the filtering is done
  // locally on purpose: asking the ASP for one chain's slice is a (small)
  // statement about which chain this client cares about, and the whole payload
  // is the same for everyone.
  //
  // Filtered rather than passed through: the consumers below key by token
  // ADDRESS alone, so rows from another chain sharing an address would collide.
  const assetsStatsFeed = usePublicFeed<AssetsStatsResponse>(FEED_ASSETS_STATS_ALL);
  const assetsStatsAll = feedData(assetsStatsFeed);
  const assetsStats = useMemo(
    () => assetStatsRowsForChain(assetsStatsAll, defaultChain.id),
    [assetsStatsAll, defaultChain.id],
  );

  // Same story: no interval, so its only refresh triggers were mount, focus
  // and invalidation. Its own client cache is 60s, and a signing round trip
  // routinely takes longer than that, so the refocus really did reach the ASP.
  const entrypoints = feedData(usePublicFeed<EntrypointsResponse>(FEED_ENTRYPOINTS));

  const isLoading = !statistics && !statsError;

  const error = useMemo(() => {
    const e = statsError || eventsError || pricesError || tokenPricesError;
    return e ? (e instanceof Error ? e.message : String(e)) : null;
  }, [statsError, eventsError, pricesError, tokenPricesError]);

  const supportedTokenPrices = useMemo(
    // Guard against ASP price rows with a missing tokenSymbol — they'd
    // throw on the downstream `.toLowerCase()` inside a render-time
    // useMemo and white-screen the app.
    () => (tokenPricesResponse?.prices ?? []).filter(
      (price) => !!price.tokenSymbol && Number(price.chainId) === defaultChain.id,
    ),
    [defaultChain.id, tokenPricesResponse?.prices],
  );

  const nonNativeSupportedTokenPrices = useMemo(
    // `tokenSymbol` may be a symbol ("ETH") or an address depending on the
    // ASP endpoint; resolve before deciding native-ness so we don't try to
    // read an ERC-20 balance for native ETH.
    () => supportedTokenPrices.filter((price) => !resolveTokenMetadata(price.tokenSymbol, defaultChain.id).isNative),
    [supportedTokenPrices, defaultChain.id],
  );

  const erc20BalanceContracts = useMemo(
    () => {
      if (!address) return [];

      const priced = nonNativeSupportedTokenPrices
        .map((price) => ({
          // Resolve symbol-or-address to the real ERC-20 contract address;
          // `tokenSymbol` is now a symbol ("USDC") from /token-prices.
          address: resolveTokenMetadata(price.tokenSymbol, defaultChain.id).address as Address,
          abi: erc20Abi,
          functionName: 'balanceOf' as const,
          args: [address],
        }));
      // Pinned yield share tokens are appended AFTER the priced list (which is
      // consumed positionally below), so loose shares in the wallet can be
      // found and unwrapped. A static, config-derived list on the same
      // cadence: nothing here depends on a note or on what the user is doing.
      const extra = getPinnedYieldDeployments(defaultChain.id)
        .map((d) => d.ppUSDC as Address)
        .filter((share, i, all) => all.findIndex((x) => x.toLowerCase() === share.toLowerCase()) === i)
        .map((share) => ({ address: share, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address] }));
      const allowances = getPinnedYieldDeployments(defaultChain.id)
        .filter((d) => !!d.zap)
        .map((d) => ({ address: d.ppUSDC, abi: erc20Abi, functionName: 'allowance' as const, args: [address, d.zap!] }));
      return [...priced, ...extra, ...allowances];
    },
    [address, nonNativeSupportedTokenPrices, defaultChain.id],
  );

  // `enabled` gates on data readiness only. It used to carry `&& !txPending`,
  // which disabled the read for the length of every transaction and then
  // refetched the instant it settled — a burst timed to the on-chain event.
  //
  // That flip was ALSO the only thing that refreshed these balances, so it has
  // to be replaced, not just removed: without a cadence, a user who spends
  // their whole token balance sees the pre-spend figure until they reload, and
  // the next deposit is built against it and rejected by the wallet.
  const { data: liveErc20Balances } = useReadContracts({
    contracts: erc20BalanceContracts.map((c) => ({ ...c, chainId: defaultChain.id })),
    query: {
      enabled: !!address && erc20BalanceContracts.length > 0,
      refetchInterval: WALLET_BALANCE_POLL_MS,
    },
  });
  // The token LIST is part of this read's identity, not just the account and
  // chain. `erc20Balances` is consumed positionally (`erc20Balances?.[index]`
  // against `erc20BalanceContracts`), and the list is derived from the ASP's
  // token-prices feed — so if that feed reorders or grows while a transaction
  // is in flight, a latch keyed only on account:chain would hold the OLD array
  // and index it against the NEW list, showing one token's balance under
  // another's name. Including the addresses makes that a reset instead.
  const erc20BalancesIdentity = `${walletReadIdentity}:${erc20BalanceContracts.map((c) => c.address).join(',')}`;
  const erc20Balances = useLatchedWhile(liveErc20Balances, txPending, erc20BalancesIdentity);

  const walletShareBalances = useMemo(() => {
    if (!address) return undefined;
    const shares = new Set(getPinnedYieldDeployments(defaultChain.id).map((d) => d.ppUSDC.toLowerCase()));
    const balances: Record<string, bigint> = {};
    const allowances: Record<string, bigint> = {};
    erc20BalanceContracts.forEach((c, i) => {
      const key = c.address.toLowerCase();
      const r = erc20Balances?.[i];
      if (shares.has(key) && r?.status === 'success' && typeof r.result === 'bigint') {
        if (c.functionName === 'allowance') allowances[key] = r.result;
        else balances[key] = r.result;
      }
    });
    return { chainId: defaultChain.id, owner: address, balances, allowances };
  }, [address, defaultChain.id, erc20BalanceContracts, erc20Balances]);

  // The feeds and our own pending operations, reconciled ONCE per pass:
  // public rows deduped, own-history rows deduped against them and filtered to
  // the visible chains, and every pending row of ours that no feed row
  // describes yet. A pending row a feed row now covers is `settled`, and the
  // effect prunes it from the ledger along with any entry past its age bound.
  // Both judgements run off the render path (the clock is impure in render).
  //
  // Our own history comes from the event snapshot, which every client
  // downloads whole: the deposits and ragequits of this account's notes or
  // activity address, including those the public window has evicted
  // (services/own-history-rows.ts). Nothing here asks the ASP which rows are
  // ours. The snapshot carries no Sui events, so a Sui session's own rows are
  // the public window's.
  const ownHistoryEvents = useMemo(() => buildOwnHistoryEvents({
    deposits: eventSnapshot?.deposits ?? [],
    ragequits: eventSnapshot?.ragequits ?? [],
    activityAddress: myActivityAddress ?? null,
    ownedCommitments: spendNotes.map((n) => String(n.commitment ?? '')),
    chainName: (cid) => getChainConfig(cid)?.displayName ?? `Chain ${cid}`,
  }), [eventSnapshot, myActivityAddress, spendNotes]);
  const reconciled = useMemo(() => reconcileFeedRows<GlobalEvent & { commitment?: string }, ActivityEvent>({
    publicRows: eventsResponse?.events ?? [],
    ownRows: ownHistoryEvents,
    visibleChainIds: new Set(feedChainIds),
    pendingOwn: pendingOwnRows,
  }), [eventsResponse, ownHistoryEvents, feedChainIds, pendingOwnRows]);
  useEffect(() => {
    prunePendingOwnRows([...reconciled.settled, ...expiredPendingOwnRows(pendingOwnRows, Date.now())]);
  }, [reconciled, pendingOwnRows]);

  const historyPendingChainIds = useMemo(() => pendingHistoryChainIds({
    feedChainIds,
    snapshotChainIds,
    publicLoadedChainIds: eventsResponse?.loadedChainIds,
    snapshotLoadedChainIds: eventSnapshot?.loadedChainIds,
  }), [feedChainIds, snapshotChainIds, eventsResponse, eventSnapshot]);

  const swapRecordsRevision = useSyncExternalStore(subscribeSwapRecords, getSwapRecordsRevision, getSwapRecordsRevision);

  // Signal 3 of services/deposit-ownership.ts. A deposit this wallet paid for
  // is not this account's when its Note payload was sealed to another viewing
  // key (a payment, a deposit for another address, another account funded from
  // this wallet). Trial decryption over the ciphertexts the snapshot and
  // discovery already downloaded, so it asks nothing of the network. A deposit
  // the wallet submitted is SETTLED, verdict or not, once nothing more can come
  // for it (ownershipSettled), which is what lets ownershipVerdictPending
  // release it.
  const noteCiphertextsRevision = useSyncExternalStore(subscribeNoteCiphertexts, getNoteCiphertextsRevision, getNoteCiphertextsRevision);
  const [viewingKeyOwnershipState, setViewingKeyOwnership] = useState<ViewingKeyOwnership>(NO_VIEWING_KEY_OWNERSHIP);
  const viewingKeyVerdictCacheRef = useRef(new Map<string, boolean>());
  const ownershipWallet = identityMode === 'wallet' ? (address?.toLowerCase() ?? null) : null;
  const ownershipIdentity = ownershipWallet && keystoreManager
    ? `${ownershipWallet}:${keystoreManager.getViewingKeyPair().publicKey.toLowerCase()}`
    : null;
  // Another wallet's or key's answer is no answer here.
  const viewingKeyOwnership = ownershipIdentity !== null && viewingKeyOwnershipState.identity === ownershipIdentity
    ? viewingKeyOwnershipState
    : NO_VIEWING_KEY_OWNERSHIP;
  useEffect(() => {
    const wallet = ownershipWallet;
    const identity = ownershipIdentity;
    if (!wallet || !identity || !keystoreManager) return;
    // The snapshot carries the ciphertexts. Settling before it lands would
    // publish the depositor fallback for a moment and then take it back.
    if (eventSnapshot === undefined && !eventSnapshotFailed) return;
    const submitted = new Map<string, { chainId: number; commitment?: string; inSnapshot: boolean }>();
    for (const d of eventSnapshot?.deposits ?? []) {
      if (d.depositAddress?.toLowerCase() === wallet) submitted.set(d.txHash.toLowerCase(), { chainId: d.chainId, commitment: d.outputCommitment, inSnapshot: true });
    }
    for (const e of eventsResponse?.events ?? []) {
      if (e.type !== 'deposit' || !e.txHash || e.address?.toLowerCase() !== wallet) continue;
      const txHash = e.txHash.toLowerCase();
      if (!submitted.has(txHash)) submitted.set(txHash, { chainId: Number(e.asset.chainId), inSnapshot: false });
    }
    const ciphertextsOf = (txHash: string) => noteCiphertextsFor(submitted.get(txHash)?.chainId ?? 0, txHash);
    const settled: ReadonlySet<string> = new Set([...submitted].filter(([txHash, d]) => ownershipSettled({
      inSnapshot: d.inSnapshot,
      hasCiphertexts: ciphertextsOf(txHash).length > 0,
      chainSnapshotLoaded: !!eventSnapshot?.loadedChainIds.includes(d.chainId),
    })).map(([txHash]) => txHash));
    const owned = new Set(notes.map((n) => normalizeCommitment(String(n.commitment ?? ''))).filter((c): c is string => !!c));
    const needed = depositsNeedingViewingKeyCheck(
      [...submitted].map(([txHash, d]) => ({ txHash, commitment: d.commitment, depositor: wallet })),
      { ownedCommitments: owned, paidRequestTxHashes: new Set(), connectedAddress: wallet },
    ).filter((txHash) => ciphertextsOf(txHash).length > 0);
    const cache = viewingKeyVerdictCacheRef.current;
    const keyOf = (txHash: string) => `${identity}:${submitted.get(txHash)?.chainId}:${txHash}:${ciphertextsOf(txHash).length}`;
    const publish = (opens?: (ciphertext: NoteCiphertext) => boolean) => {
      const verdicts = new Map<string, boolean>();
      for (const txHash of needed) {
        let verdict = cache.get(keyOf(txHash));
        if (verdict === undefined && opens) {
          verdict = viewingKeyVerdicts([txHash], ciphertextsOf, opens).get(txHash);
          if (verdict !== undefined) cache.set(keyOf(txHash), verdict);
        }
        if (verdict !== undefined) verdicts.set(txHash, verdict);
      }
      setViewingKeyOwnership((prev) => (sameOwnership(prev, identity, verdicts, settled) ? prev : { identity, verdicts, settled }));
    };
    let cancelled = false;
    noteDecrypter()
      .then((decrypter) => {
        if (cancelled) return;
        const uncached = needed.some((txHash) => !cache.has(keyOf(txHash)));
        publish(uncached ? isNoteForViewingKey(decrypter, keystoreManager.getViewingKeyPair().privateKey) : undefined);
      })
      .catch(() => {
        // Settle anyway, with no new verdicts: nothing stays held, and the
        // depositor fallback stands as it did before.
        if (!cancelled) publish();
      });
    return () => { cancelled = true; };
  }, [ownershipWallet, ownershipIdentity, keystoreManager, eventSnapshot, eventSnapshotFailed, eventsResponse, notes, noteCiphertextsRevision]);

  const data = useMemo<PoolsData>(() => {
    // Everything the PUBLIC feed says plus our own not-yet-indexed operations,
    // ours first: the exact contents the cache used to hold while the deposit
    // flow injected its optimistic row there. Pool/balance derivations keep
    // reading this; the own-history supplement joins the LIST only, below.
    const publicRows = reconciled.publicRows;
    const feedEvents = [...reconciled.pendingRows, ...publicRows];
    // The transactions LIST stays a multi-chain aggregate (feedEvents, by
    // product direction), but every POOL/BALANCE derivation below keys its
    // maps by bare token address — and multiple EVM chains share the native
    // sentinel 0xeee… (ETH on mainnet, cBTC on Citrea in the staging build),
    // so cross-chain events would merge into one corrupted row (mixed
    // symbol, summed TVL, wrong deep link). Derive pools and balances from
    // the ACTIVE EVM chain's events only; non-EVM (Sui) rows keep their
    // existing prefixed-key handling. On the single-EVM mainline build this
    // filter passes everything, exactly as before.
    const events = feedEvents.filter((event) => {
      const cid = Number(event.asset?.chainId);
      if (!Number.isFinite(cid)) return true;
      return cid === defaultChain.id || getChainConfig(cid)?.chainType !== 'evm';
    });
    const tokenPrices = supportedTokenPrices;

    // Authoritative per-asset TVL + 24h change from the ASP. Keyed by the
    // token's lowercase address. Summing events in the browser is lossy
    // (we only have the latest page), so prefer this when it's available.
    //
    // The ASP currently returns "0.00" for stablecoin USD values (no price
    // feed wired up server-side). Re-derive from totalInAssetValue × $1 in
    // that case so the UI stops showing $0.00 pools that actually hold USDC.
    const tvlByAddress = new Map<
      string,
      { tvlUsd: number; tokenAmount: number; growth24h: number | null; symbol: string; fundsAcceptedUsd: number }
    >();
    for (const s of assetsStats) {
      const addrKey = String(s.tokenAddress || '').toLowerCase();
      if (!addrKey) continue;
      const meta = getTokenMetadata(addrKey, Number(s.chainId) || defaultChain.id);
      const raw = parseFloat(s.totalInAssetValue ?? '0') || 0;
      const tokenAmount = raw > 0 ? raw / 10 ** meta.decimals : 0;
      let tvlUsd = parseFloat(s.totalInAssetValueUsd) || 0;
      if (tvlUsd === 0 && tokenAmount > 0) {
        if (isStablecoin(meta.symbol)) {
          tvlUsd = tokenAmount;
        } else {
          const price = priceMap[addrKey] || priceMap[meta.symbol] || 0;
          if (price > 0) tvlUsd = tokenAmount * price;
        }
      }
      // DEV-219/240: "Total funds accepted" = cumulative approved deposits
      // (acceptedDepositsValueUsd), NOT current TVL. Re-derive for stablecoins
      // the ASP returns as $0, mirroring the TVL fallback above.
      const acceptedRaw = parseFloat(s.acceptedDepositsValue ?? s.totalDepositsValue ?? '0') || 0;
      const acceptedTokenAmount = acceptedRaw > 0 ? acceptedRaw / 10 ** meta.decimals : 0;
      let fundsAcceptedUsd = parseFloat(s.acceptedDepositsValueUsd ?? s.totalDepositsValueUsd ?? '0') || 0;
      if (fundsAcceptedUsd === 0 && acceptedTokenAmount > 0) {
        if (isStablecoin(meta.symbol)) {
          fundsAcceptedUsd = acceptedTokenAmount;
        } else {
          const price = priceMap[addrKey] || priceMap[meta.symbol] || 0;
          if (price > 0) fundsAcceptedUsd = acceptedTokenAmount * price;
        }
      }
      tvlByAddress.set(addrKey, {
        tvlUsd,
        tokenAmount,
        growth24h: s.growth24h,
        symbol: meta.symbol,
        fundsAcceptedUsd,
      });
    }

    // --- Build token pool info from events ---
    const tokenInfoMap = new Map<
      string,
      {
        symbol: string;
        tokenAddress: string;
        chainName: string;
        chainId: number;
        denomination: number;
        netUsd: number;
        // Cumulative deposit USD (deposits only, no withdrawals) — the
        // event-derived fallback for "Total funds accepted" when the ASP has no
        // per-pool stats (e.g. Sui).
        depositsUsd: number;
      }
    >();
    for (const event of events) {
      const metadata = getTokenMetadata(event.asset.tokenAddress, event.asset.chainId);
      const tokenKey = event.asset.tokenAddress.toLowerCase();
      const { chainName, chainId } = event.asset;
      const denomination = eventDenomination(event);
      if (!tokenInfoMap.has(tokenKey)) {
        tokenInfoMap.set(tokenKey, {
          symbol: metadata.symbol,
          tokenAddress: event.asset.tokenAddress,
          chainName,
          chainId,
          denomination,
          netUsd: 0,
          depositsUsd: 0,
        });
      }
      const price = priceMap[tokenKey] || priceMap[metadata.symbol] || 0;
      const tokenAmount = parseFloat(event.amount) / 10 ** denomination;
      const usdValue = tokenAmount * price;
      const info = tokenInfoMap.get(tokenKey)!;
      if (event.type === 'deposit') {
        info.netUsd += usdValue;
        // "Funds accepted" counts APPROVED deposits only (a pending/declined
        // deposit isn't accepted yet). ASP marks Sui deposits 'approved' once
        // admitted; treat a missing status as approved (EVM stats path unused).
        if (event.reviewStatus === undefined || event.reviewStatus === 'approved') {
          info.depositsUsd += usdValue;
        }
      } else {
        info.netUsd -= usdValue;
      }
    }

    // If no events yet but we have statistics, add a default ETH pool
    if (tokenInfoMap.size === 0 && statistics) {
      const tvlUsd = parseFloat(statistics.allTime.tvlUsd) || 0;
      tokenInfoMap.set(NATIVE_ASSET_ADDRESS.toLowerCase(), {
        symbol: 'ETH',
        tokenAddress: NATIVE_ASSET_ADDRESS,
        chainName: defaultChain.displayName,
        chainId: defaultChain.id,
        denomination: 18,
        netUsd: tvlUsd,
        depositsUsd: tvlUsd,
      });
    }

    // --- Compute privacy score per token from deposit counts ---
    // Prefer the ASP's authoritative totalDepositsCount (full history) and
    // fall back to the local 50-event page only when the assets-stats
    // endpoint hasn't responded — otherwise every pool collapses to the
    // baseline 50% because the page rarely contains >25 fresh deposits.
    const depositCountByToken = new Map<string, number>();
    for (const s of assetsStats) {
      const addrKey = String(s.tokenAddress || '').toLowerCase();
      if (!addrKey) continue;
      depositCountByToken.set(addrKey, s.totalDepositsCount ?? 0);
    }
    for (const event of events) {
      if (event.type !== 'deposit') continue;
      const tokenKey = event.asset.tokenAddress.toLowerCase();
      if (depositCountByToken.has(tokenKey)) continue; // already from ASP
      const count = depositCountByToken.get(tokenKey) || 0;
      depositCountByToken.set(tokenKey, count + 1);
    }

    function computePrivacyScore(tokenKey: string): number {
      const depositCount = depositCountByToken.get(tokenKey) || 0;
      // Score 0-100 where 50 = neutral. More deposits → higher score.
      return Math.min(100, 50 + depositCount * 2);
    }

    // --- Build wallet balance map from on-chain data ---
    const walletBalances: Record<string, number> = {};
    if (ethWalletBalance) {
      const nativeBalance = Number(formatUnits(ethWalletBalance.value, ethWalletBalance.decimals));
      walletBalances[NATIVE_ASSET_ADDRESS.toLowerCase()] = nativeBalance;
      walletBalances[defaultChain.nativeCurrency.symbol] = nativeBalance;
    }

    if (!(NATIVE_ASSET_ADDRESS.toLowerCase() in walletBalances)) {
      walletBalances[NATIVE_ASSET_ADDRESS.toLowerCase()] = 0;
    }

    nonNativeSupportedTokenPrices.forEach((price, index) => {
      const metadata = resolveTokenMetadata(price.tokenSymbol, Number(price.chainId));
      const tokenKey = metadata.address.toLowerCase();
      const contractResult = erc20Balances?.[index];
      const balanceRaw = contractResult?.status === 'success' ? contractResult.result : 0n;
      const balance = typeof balanceRaw === 'bigint' ? Number(formatUnits(balanceRaw, metadata.decimals)) : 0;
      walletBalances[tokenKey] = balance;
      walletBalances[metadata.symbol] = balance;
    });

    for (const price of tokenPrices) {
      // /token-prices returns a bare symbol ("USDC"), not an address —
      // resolve it to the real token address so this key matches the
      // event-derived key and dedups (otherwise we get phantom $0 pools
      // keyed by the literal symbol string).
      const metadata = resolveTokenMetadata(price.tokenSymbol, Number(price.chainId));
      const tokenKey = metadata.address.toLowerCase();
      if (tokenInfoMap.has(tokenKey)) continue;
      tokenInfoMap.set(tokenKey, {
        symbol: metadata.symbol,
        tokenAddress: metadata.address,
        chainName: defaultChain.displayName,
        chainId: defaultChain.id,
        denomination: metadata.decimals,
        netUsd: 0,
        depositsUsd: 0,
      });
    }

    // --- allPools ---
    // A withdraw-only (legacy) asset has no public pool any more: the ASP's
    // assets-stats omits it and its price row is gone, so a card built from its
    // old events would read "$0 TVL" and inflate the "pools live" count. The
    // user's OWN balance in it lives in myPools, which is notes-driven.
    const allPools: PoolEntry[] = Array.from(tokenInfoMap.entries())
      .filter(([, info]) => !getTokenMetadata(info.tokenAddress, info.chainId).withdrawOnly)
      .map(([tokenKey, info]) => {
      // Resolve the display symbol from the token address instead of trusting
      // info.symbol — the ASP currently returns the address as `tokenSymbol`,
      // so anywhere we trust it verbatim we end up labelling pools "0X1C7D".
      const resolved = getTokenMetadata(info.tokenAddress, info.chainId);
      const displaySymbol = resolved.symbol;
      const price = priceMap[tokenKey] || priceMap[displaySymbol] || priceMap[info.symbol] || 0;
      // Prefer the ASP's authoritative TVL; fall back to event-summed netUsd
      // if the assets-stats endpoint hasn't responded yet.
      const statsEntry = tvlByAddress.get(tokenKey);
      const tvl = Math.max(0, statsEntry?.tvlUsd ?? info.netUsd);
      const perAssetGrowth = statsEntry?.growth24h;
      const change24h = perAssetGrowth == null
        ? '+0.0%'
        : `${perAssetGrowth >= 0 ? '+' : ''}${perAssetGrowth.toFixed(1)}%`;
      // Prefer the raw token amount the ASP already gave us — it's
      // independent of the price feed. Only divide tvl/price as a last
      // resort, and never render "0 USDC" when we know the pool holds
      // tokens but the price map happens to be empty.
      const rawTokenAmount = statsEntry?.tokenAmount ?? 0;
      const derivedTokenAmount = price > 0 ? tvl / price : 0;
      const tokenAmount = rawTokenAmount > 0 ? rawTokenAmount : derivedTokenAmount;
      return {
        id: displaySymbol.toLowerCase(),
        name: displaySymbol,
        tokenAddress: info.tokenAddress,
        chainId: info.chainId,
        poolValue: formatUsd(tvl),
        poolValueUsd: tvl,
        poolValueTokenAmount: tokenAmount,
        poolValueToken: tokenAmount > 0
          ? formatTokenAmount(tokenAmount, displaySymbol)
          : `0 ${displaySymbol}`,
        // "Total funds accepted" prefers the ASP's cumulative-approved-deposits
        // stat; when the ASP has no per-pool stats (Sui), fall back to the
        // event-summed deposit total so the column isn't a misleading $0.
        fundsAccepted: formatUsd(Math.max(0, statsEntry?.fundsAcceptedUsd ?? info.depositsUsd)),
        change24h,
        privacyScore: computePrivacyScore(tokenKey),
      };
    });

    // --- availableAssets ---
    // On the Sui chain the only shieldable asset is native SUI — show that
    // (with the connected wallet's SUI balance), not the Sepolia EVM tokens.
    // Otherwise the ETH/USDC "Deposit" buttons would open the Sui modal.
    const availableAssetsRaw: AvailableAsset[] = isStellarActive
      ? [
          (() => {
            const xlmPrice = priceMap['XLM'] || priceMap['xlm'] || 0;
            const walletNum = Number(stellarWalletBalance?.spendable ?? 0n) / 10 ** TOKEN_DECIMALS.XLM;
            const xlmPool = allPools.find((p) => p.chainId === STELLAR_TESTNET_ID);
            const connected = stellarWallet.isConnected;
            return {
              id: 'xlm',
              name: 'XLM',
              poolValue: xlmPool?.poolValue ?? formatUsd(0),
              poolValueToken: xlmPool?.poolValueToken ?? '0 XLM',
              walletBalance: connected ? formatUsd(walletNum * xlmPrice) : '–',
              walletBalanceToken: connected ? formatTokenAmount(walletNum, 'XLM') : '–',
              privacyScore: 50,
            };
          })(),
        ]
      : isSuiActive
      ? [
          (() => {
            const suiPrice = priceMap['SUI'] || priceMap['sui'] || 0;
            const walletNum = Number(suiWalletMist) / 10 ** TOKEN_DECIMALS.SUI;
            const suiPool = allPools.find((p) => p.chainId === SUI_TESTNET_ID);
            return {
              id: 'sui',
              name: 'SUI',
              poolValue: suiPool?.poolValue ?? formatUsd(0),
              poolValueToken: suiPool?.poolValueToken ?? '0 SUI',
              walletBalance: multiChainAddress ? formatUsd(walletNum * suiPrice) : '–',
              walletBalanceToken: multiChainAddress ? formatTokenAmount(walletNum, 'SUI') : '–',
              privacyScore: 50,
            };
          })(),
        ]
      : tokenPrices
      .map((price: TokenPrice) => {
        const metadata = resolveTokenMetadata(price.tokenSymbol, Number(price.chainId));
        const tokenKey = metadata.address.toLowerCase();
        const info = tokenInfoMap.get(tokenKey);
        const stableFallback = isStablecoin(metadata.symbol) ? 1 : 0;
        const resolvedPrice = parseFloat(price.priceUsd) || priceMap[tokenKey] || priceMap[metadata.symbol] || stableFallback;
        // Same TVL source as the All Pools table — ASP's authoritative
        // tvlByAddress (already patched to re-derive for stables the server
        // returns as $0). Falling back to event-summed netUsd only when the
        // assets-stats endpoint hasn't responded yet.
        const statsEntry = tvlByAddress.get(tokenKey);
        const tvl = Math.max(0, statsEntry?.tvlUsd ?? info?.netUsd ?? 0);
        const rawTokenAmount = statsEntry?.tokenAmount ?? 0;
        const derivedTokenAmount = resolvedPrice > 0 ? tvl / resolvedPrice : 0;
        const poolTokenAmount = rawTokenAmount > 0 ? rawTokenAmount : derivedTokenAmount;
        const walletNum = walletBalances[tokenKey] ?? 0;
        const walletUsd = walletNum * resolvedPrice;

        return {
          id: tokenKey,
          name: metadata.symbol,
          poolValue: formatUsd(tvl),
          poolValueToken: poolTokenAmount > 0
            ? formatTokenAmount(poolTokenAmount, metadata.symbol)
            : `0 ${displayTokenSymbol(metadata.symbol)}`,
          walletBalance: address ? formatUsd(walletUsd) : '–',
          walletBalanceToken: address ? formatTokenAmount(walletNum, metadata.symbol) : '–',
          privacyScore: computePrivacyScore(tokenKey),
          walletNumericBalance: walletNum,
        };
      })
      .filter((asset) => !address || asset.walletNumericBalance > 0)
      .map(({ walletNumericBalance: _walletNumericBalance, ...asset }) => asset);

    // Two price entries can resolve to the same on-chain asset (e.g. an ETH and
    // a wrapped/duplicate symbol both mapping to the native address), which
    // produced duplicate rows and a React key collision. Keep the first per id.
    const seenAssetIds = new Set<string>();
    const availableAssets: AvailableAsset[] = availableAssetsRaw.filter((asset) => {
      if (seenAssetIds.has(asset.id)) return false;
      seenAssetIds.add(asset.id);
      return true;
    });

    // --- transactions ---
    // The list is a multi-chain aggregate on every build (Pat, 2026-08-18 —
    // supersedes the 2026-07-31 active-chain-only staging direction): rows
    // carry chain badges, and "my transactions" spans every pool and chain.
    // The account's own snapshot rows merge in (deduped by the reconciler
    // above) so their history survives the public feed's 50-row per-chain
    // window. Our pending rows are flagged so a consumer can tell a row the
    // ASP has not confirmed from one it has.
    const feedRows: Transaction[] = [
      ...reconciled.pendingRows.map((e) => ({ ...mapEventToTransaction(e, priceMap, transferTxHashes, withdrawalRouteTxHashes), isOptimistic: true })),
      ...publicRows.map((e) => mapEventToTransaction(e, priceMap, transferTxHashes, withdrawalRouteTxHashes)),
      ...reconciled.ownRows.map((e) => mapEventToTransaction(e, priceMap, transferTxHashes, withdrawalRouteTxHashes)),
    ];
    const transactionsBase = withSwapRouteWithdrawals(feedRows, swapRouteKindsByTx).sort((a, b) => b.timestamp - a.timestamp);

    // The ACTIVE ACCOUNT's own deposits and ragequit exits over FULL history,
    // straight from the un-windowed EVM event snapshot. Computed here (before
    // the count strip) because every "my activity" figure must come from an
    // unbounded source: the public events feed is a 50-row window, so a
    // wallet whose activity scrolled out of it would show zero Deposits /
    // Transfers / Withdrawals while holding a real balance (the exact
    // "accounting is broken" report, 2026-08-03).
    //
    // Identity-aware scoping: with an imported account key the connected
    // wallet is only the PAYER, so payer-address equality is NOT ownership —
    // wallet B's unrelated history must never enter key-account A's ledger,
    // and A's deposits funded by another payer must not be missed. In key
    // mode ownership is the exact owned commitment (deposit outputCommitment
    // / exited commitment); in wallet mode the depositing/ragequitting
    // address is the account, plus owned commitments (deposits funded into
    // this account by a different payer). EVM-only: the snapshot carries no
    // Sui events, so a Sui wallet gets empty lists.
    const walletIdentityLc = identityMode === 'wallet' ? (address?.toLowerCase() ?? null) : null;
    // Canonical form on BOTH sides. Notes carry 0x-hex, the ASP snapshot
    // carries DECIMAL, and a bare .toLowerCase() can never bridge two number
    // bases — so this set never matched a snapshot commitment and the
    // strongest ownership signal was dead code (see
    // services/deposit-ownership.ts normalizeCommitment).
    const ownedCommitments = new Set(
      notes.map((n) => normalizeCommitment(String(n.commitment ?? ''))).filter((c): c is string => !!c),
    );
    // Ownership, not authorship. The depositAddress clause below is the OLD
    // heuristic and it is wrong for "Pay via Wallet": that is an ordinary
    // deposit submitted by the payer for someone else, so it matched here and
    // inflated the user's deposit count exactly as it inflated their balance.
    // resolveDepositOwnership keeps the depositor test only as the last resort,
    // behind commitment ownership and the local payment stamp.
    const viewingKeyMatches = viewingKeyOwnership.verdicts;
    // Deposits this device recorded as its own need no verdict: a fresh shield
    // must read pending at once, before any snapshot has seen it.
    const locallyKnownDepositTxHashes = new Set<string>([
      ...reconciled.pendingRows.map((e) => String(e.txHash ?? '').toLowerCase()),
      ...readAllOwnActions().filter((a) => a.kind === 'shield').map((a) => a.txHash),
    ]);
    const ownershipPending = (txHash: string | null | undefined, depositorIsMe: boolean) => ownershipVerdictPending({
      txHash,
      depositorIsMe,
      keysHeld: identityMode === 'wallet' && !!keystoreManager,
      locallyKnown: !!txHash && locallyKnownDepositTxHashes.has(txHash.toLowerCase()),
      snapshot: eventSnapshot !== undefined ? 'loaded' : eventSnapshotFailed ? 'failed' : 'loading',
      verdicts: viewingKeyMatches,
      settled: viewingKeyOwnership.settled,
    });
    const depositOwnershipInputs = {
      ownedCommitments,
      paidRequestTxHashes: buildPaidRequestTxHashSet(walletIdentityLc),
      // Plain "Deposit to another address" (depositFor) stamps: same story as
      // the payment stamp, the deposit is the RECIPIENT's, not this wallet's.
      outgoingDepositTxHashes: buildOutgoingDepositTxHashSet(walletIdentityLc),
      connectedAddress: walletIdentityLc ?? null,
      viewingKeyMatches,
    };
    const myDeposits = identityMode
      ? (eventSnapshot?.deposits ?? []).filter((d) => {
          const ownership = resolveDepositOwnership(
            { txHash: d.txHash, commitment: d.outputCommitment, depositor: d.depositAddress },
            depositOwnershipInputs,
          );
          // The depositor fallback is a guess: not counted while its answer is coming.
          return ownership.mine && (ownership.definitive || !ownershipPending(d.txHash, true));
        })
      : [];
    const myExits = identityMode
      ? (eventSnapshot?.ragequits ?? []).filter((r) =>
          (walletIdentityLc != null && r.ragequitter?.toLowerCase() === walletIdentityLc)
          || ownedCommitments.has(normalizeCommitment(r.commitment) ?? ''))
      : [];

    // Per-token count of the user's OWN deposits, for the "DEPOSITS" column
    // and the strip total. EVM counts come from the FULL-HISTORY snapshot
    // deposits above (ownership-exact, not windowed); the classified feed
    // only fills in while the snapshot hasn't loaded, and always for Sui
    // (the snapshot carries no Sui events). NOT from the note count —
    // change/received/spent notes are not deposits.
    const myDepositCountByToken = new Map<string, number>();
    // Stellar's personal activity (deposit / received rows + counts), from the
    // account's own notes: the ASP feed does not index Stellar.
    const stellarActivity = activeChainId === STELLAR_TESTNET_ID
      ? deriveStellarActivity(notes as unknown as StellarActivityNote[], stellarNoteOrigins, {
          chainId: STELLAR_TESTNET_ID,
          chainName: getChainConfig(STELLAR_TESTNET_ID)?.displayName || 'Stellar',
          symbol: 'XLM',
          decimals: TOKEN_DECIMALS.XLM,
          priceUsd: priceMap['XLM'] || priceMap['xlm'] || 0,
          ownAddress: stellarWallet.isConnected ? stellarWallet.address ?? '' : '',
          sentRecipient: stellarSentRecipientLookup(readAllSentTransfers(), STELLAR_TESTNET_ID),
        })
      : null;
    {
      // Snapshot deposits are already identity-scoped above. Count them even
      // when a key account has no connected payer wallet.
      if (eventSnapshot !== undefined) {
        for (const dep of myDeposits) {
          const addr = String(dep.asset || '').toLowerCase();
          if (!addr) continue;
          // Chain-qualified: the snapshot is the ACTIVE chain's, and the native
          // sentinel is shared, so a bare-address key showed Sepolia's ETH
          // count on the Citrea cBTC row (kimi review, finding 6).
          // The deposit's OWN chain now that the snapshot spans chains; it was
          // defaultChain.id because there was only ever one chain's snapshot.
          const k = `${dep.chainId}:${addr}`;
          myDepositCountByToken.set(k, (myDepositCountByToken.get(k) ?? 0) + 1);
        }
      }

      const connectedLc = myActivityAddress?.toLowerCase() ?? '';
      if (connectedLc) {
        for (const tx of transactionsBase) {
          if (tx.type !== 'Deposit') continue;
          const isSuiRow = tx.chainId === SUI_TESTNET_ID;
          // EVM rows are covered by the snapshot above once it has loaded;
          // double-counting a deposit that appears in both sources would
          // inflate the column.
          if (!isSuiRow && eventSnapshot !== undefined) continue;
          // Per-token map keyed by chain + address, so shared native sentinels
          // cannot merge across chains. The old active-chain-only filter here
          // existed because the snapshot covered one chain; the fallback now
          // covers every EVM chain the snapshot itself does not.
          if (tx.fullAddress.toLowerCase() !== connectedLc) continue;
          // Sui deposits each carry a fresh random tokenId, but the pool is
          // keyed by the 'sui' symbol in myPools — key the count the same way
          // so the per-asset DEPOSITS column resolves (EVM stays by address).
          const k = tx.chainId === SUI_TESTNET_ID
            ? `${SUI_TESTNET_ID}:sui`
            : `${tx.chainId}:${tx.tokenAddress.toLowerCase()}`;
          myDepositCountByToken.set(k, (myDepositCountByToken.get(k) || 0) + 1);
        }
      }

      // Stellar is in neither the snapshot nor the feed. Count from the
      // account's own notes (services/stellar-activity.ts), the same source as
      // its activity rows. Local data only.
      if (stellarActivity && stellarActivity.depositCount > 0) {
        myDepositCountByToken.set(`${STELLAR_TESTNET_ID}:xlm`, stellarActivity.depositCount);
      }
    }

    // --- myPools (from user notes) ---
    // Key by token address (not symbol) so unknown tokens with same fallback
    // symbol don't collide. Carry the address forward so the UI can render
    // the proper logo via the same getTokenMetadata path the rest of the app
    // uses.
    // On Sui every note is the native SUI asset (9-decimal MIST); the note's
    // tokenId is a random 160-bit id, so resolveTokenSymbol would mislabel it
    // as an unknown 18-decimal token and render 0.0000. Force SUI here, and
    // key by symbol so every random-tokenId note merges into one SUI pool.
    const isSuiChain = activeChainId === SUI_TESTNET_ID;
    const isStellarChain = activeChainId === STELLAR_TESTNET_ID;
    // Single-asset non-EVM chains: one row per chain, forced symbol/decimals.
    const nonEvmAsset = isSuiChain
      ? { chainId: SUI_TESTNET_ID, ticker: 'SUI', decimals: TOKEN_DECIMALS.SUI }
      : isStellarChain
        ? { chainId: STELLAR_TESTNET_ID, ticker: 'XLM', decimals: TOKEN_DECIMALS.XLM }
        : null;
    // Identity the note exports are persisted under: the SESSION address (in
    // key mode the connected wallet is only the payer, so the wallet address
    // reads an empty bucket — kimi review, finding 5).
    const exportIdentity = sessionAddress ?? myAddress;
    // ONE account-export read per chain per pass. Three loops below each reload
    // the same per-(address, chainId) buckets, so a single execution of this memo
    // was doing 14 synchronous sessionStorage reads in wallet mode and 9 in an
    // account-key one, each a getItem plus a JSON.parse plus an identity scan over
    // every note in the blob, on the main thread. With ~12 mounted useNotes
    // instances and six notesRevision bumps per cross-chain sweep, that is where
    // the hundreds of reads per page load came from (measured 2026-09-01).
    //
    // Scoped to THIS execution and never returned, so it cannot serve a stale
    // note: a save or a wipe produces a new memo run with a fresh map. That is the
    // whole reason it lives here rather than in the storage layer, where caching
    // spendable-note data needs exact invalidation on every mutation path.
    const storedExportByChain = new Map<number, ReturnType<typeof loadStoredAccountExport>>();
    // The export itself (null when none is stored), so presence is answered
    // from the same single read as the notes (holdingsReady below).
    const storedExportForChain = (cid: number) => {
      if (!storedExportByChain.has(cid)) storedExportByChain.set(cid, loadStoredAccountExport(exportIdentity!, cid));
      return storedExportByChain.get(cid) ?? null;
    };
    const storedNotesForChain = (cid: number) => storedExportForChain(cid)?.notes ?? [];
    const sessionChainId = nonEvmAsset ? nonEvmAsset.chainId : defaultChain.id;
    // Keyed by CHAIN + token: the native sentinel 0xeee… is shared by every EVM
    // chain, so a chain-blind key merged ETH and cBTC into one corrupted row.
    // otherLive: a live note that is neither balance nor pending (REJECTED,
    // INACTIVE). Its value is still the user's, so it keeps the row listed.
    const notesByToken = new Map<string, { balance: bigint; pending: bigint; otherLive?: boolean; count: number; symbol: string; tokenAddress: string; chainId: number }>();
    for (const note of notes) {
      const tokenAddr = String(note.tokenId || '');
      const key = nonEvmAsset ? `${nonEvmAsset.chainId}:${nonEvmAsset.ticker}` : `${sessionChainId}:${tokenAddr.toLowerCase()}`;
      const symbol = nonEvmAsset ? nonEvmAsset.ticker : resolveTokenSymbol(tokenAddr, defaultChain.id);
      const entry = notesByToken.get(key) || { balance: 0n, pending: 0n, count: 0, symbol, tokenAddress: tokenAddr, chainId: sessionChainId };
      const val = BigInt(note.value);
      const status = String(note.status);
      if (status === 'active' || status === 'ACTIVE') {
        // Spendable only once the association-set leaf is published. Until the
        // leaf set is computed (ready=false) we trust ACTIVE status (today's
        // behavior); once ready, an ACTIVE note whose leaf isn't in the set is
        // counted as pending so home matches the withdraw screen (issue #214).
        // Sui notes gate on the Sui ASP association set the same way
        // (suiLeafState); until it loads, ACTIVE is trusted.
        const gate = isStellarChain ? { ready: false, confirmed: new Set<string>() } : isSuiChain ? suiLeafState : leafState;
        if (!gate.ready || gate.confirmed.has(note.commitment)) {
          entry.balance += val;
        } else {
          entry.pending += val;
        }
      } else if (status === 'pending' || status === 'PENDING') {
        entry.pending += val;
      } else if (val > 0n && isLiveNoteStatus(status)) {
        entry.otherLive = true;
      }
      entry.count++;
      notesByToken.set(key, entry);
    }

    // Merge in user-deposit events that don't have a matching SDK note yet,
    // so a just-submitted deposit is visible while discovery catches up. We
    // dedupe by txHash so notes already represented above aren't double-counted.
    // These go to PENDING, never spendable balance: an unmatched deposit event
    // is not a proven-spendable note (discovery may lag, or the deposit may
    // already be spent — its change note carries the spend tx hash, not the
    // deposit's, so it never dedupes here). Counting it as spendable overstated
    // the balance and masked a stranded change-note bug (issue #213/#214).
    // Wallet mode alone may use payer-address equality here; in key mode the
    // connected EVM address is only a payer and does not identify note ownership.
    // Requiring ready keys also keeps locked `myPools` limited to persisted
    // notes, which is how callers distinguish a real cache from public feed
    // evidence. Deposit flows initialize keys before they can submit, so the
    // Deposits the ASP approved that the balance row still counts as pending
    // (no local note matched). Filled inside the loop that decides the row.
    const unmatchedApprovedDeposits: PendingDeposit[] = [];
    // just-submitted discovery fallback remains available when it is needed.
    if (identityMode === 'wallet' && keysReady && address) {
      const connectedAddress = address.toLowerCase();
      const noteTxHashes = new Set<string>();
      for (const note of notes) {
        if (note.txHash) noteTxHashes.add(String(note.txHash).toLowerCase());
      }
      // The fallback below now spans chains, so the dedupe has to as well: a
      // deposit already represented by a stored note on ANOTHER chain would
      // otherwise be added again as pending, counting the same funds twice
      // (kimi review, finding 9).
      // Labels too: a deposit executed by someone else on my behalf (LiFi's
      // executor on a cross-chain shield) names THEM as depositor, and only
      // the label ties the row to my note (services/deposit-ownership.ts).
      const ownedNoteIdentity = noteIdentitySets(notes);
      if (exportIdentity) {
        for (const cid of supportedChainIds) {
          // Session chain NOT skipped: its live notes are empty in an
          // account-key session until a sync runs, and these are Sets, so
          // the overlap with `notes` above costs nothing.
          if (getChainConfig(cid)?.chainType !== 'evm') continue;
          const stored = storedNotesForChain(cid);
          for (const note of stored) {
            if (note.txHash) noteTxHashes.add(String(note.txHash).toLowerCase());
          }
          mergeNoteIdentitySets(ownedNoteIdentity, noteIdentitySets(stored));
        }
      }
      // Deposits this wallet made ON BEHALF OF SOMEONE ELSE ("Pay via Wallet"
      // on a payment request). On-chain they are indistinguishable from the
      // user's own deposits — the payee lives inside noteAddressHash — and
      // prepareDepositFor persists no local note, so the txHash dedupe below
      // can never catch them. Without this the payer's balance grows by every
      // payment they make.
      const paidRequestTxHashes = depositOwnershipInputs.paidRequestTxHashes;
      const outgoingDepositTxHashes = depositOwnershipInputs.outgoingDepositTxHashes;
      // Filled by the loop below; see the note where it is pushed to.

      // feedEvents, not the active-chain-filtered `events`: a deposit on another
      // chain should surface as pending on THAT chain's row until its notes
      // sync there (this is what makes the row-chain re-key below meaningful).
      for (const event of feedEvents) {
        if (event.type !== 'deposit') continue;
        // Mine if I am the depositor OR one of my notes claims the row (label
        // / tx hash) — the depositor is LiFi's executor on a cross-chain
        // shield, and without this the row was neither counted nor resynced.
        const depositorIsMe = event.address.toLowerCase() === connectedAddress;
        if (!depositorIsMe && !depositMatchesMyNotes({ txHash: event.txHash ?? null, label: event.label ?? null, tokenAddress: event.asset.tokenAddress }, ownedNoteIdentity)) continue;
        if (event.reviewStatus === 'declined') continue;
        if (event.txHash && noteTxHashes.has(event.txHash.toLowerCase())) continue;
        if (event.txHash && paidRequestTxHashes.has(event.txHash.toLowerCase())) continue;
        if (event.txHash && outgoingDepositTxHashes.has(event.txHash.toLowerCase())) continue;
        // Paid for from this wallet but encrypted to another account: there is
        // no note here to wait for, so it is neither pending nor worth a resync.
        if (event.txHash && viewingKeyMatches.get(event.txHash.toLowerCase()) === false) continue;
        // Whose it is is still being decided: claim no pending balance for it
        // yet, and do not count it as a disagreement worth resyncing.
        if (ownershipPending(event.txHash, depositorIsMe)) continue;

        const tokenAddr = event.asset.tokenAddress;
        const eventChainId = Number(event.asset.chainId) || sessionChainId;
        const key = nonEvmAsset ? `${nonEvmAsset.chainId}:${nonEvmAsset.ticker}` : `${eventChainId}:${tokenAddr.toLowerCase()}`;
        const symbol = nonEvmAsset ? nonEvmAsset.ticker : resolveTokenSymbol(tokenAddr, eventChainId);
        const entry = notesByToken.get(key) || { balance: 0n, pending: 0n, count: 0, symbol, tokenAddress: tokenAddr, chainId: eventChainId };
        const value = BigInt(event.amount);

        // An approved deposit with NO matching local note is not proven
        // spendable: either discovery hasn't materialised its note yet, or the
        // deposit has already been (partly) spent — a spend's change note
        // carries the SPEND tx hash, never the deposit's, so it can never dedupe
        // by txHash here. Counting its gross value as spendable `balance`
        // overstates what the wallet can actually withdraw (and masked a
        // stranded change-note bug, where home read ~correct while withdraw was
        // short). Surface it as pending/syncing instead; it only becomes
        // spendable once its note is discovered ACTIVE (then it dedupes above).
        entry.pending += value;
        // ...and record that we did. This is the row saying "pending" about a
        // deposit My transactions calls completed, which is the disagreement a
        // user actually sees. Collected HERE, inside the filter that decides
        // the row, so the reconciler can never chase a mismatch the row is not
        // showing (services/balance-reconcile.ts). Only APPROVED counts: a
        // still-under-review deposit reads pending in both places, which is
        // the two surfaces agreeing.
        if (event.reviewStatus === 'approved' && event.txHash) {
          unmatchedApprovedDeposits.push({ txHash: event.txHash.toLowerCase(), chainId: eventChainId });
        }

        entry.count++;
        notesByToken.set(key, entry);
      }
    }

    // Holdings on the OTHER chains (Pat, 2026-08-18: balances are multichain).
    // The session only ever loads the ACTIVE chain's notes, so the rest come
    // from the same per-(address, chainId) exports the session persists —
    // local reads, no network. Their association-set leaves are only computed
    // for the active chain, so these trust ACTIVE status exactly like the
    // active chain does before leafState is ready.
    if (!nonEvmAsset && exportIdentity) {
      for (const cid of supportedChainIds) {
        if (cid === sessionChainId) continue;
        if (getChainConfig(cid)?.chainType !== 'evm') continue;
        const stored = { notes: storedNotesForChain(cid) };
        for (const note of stored?.notes ?? []) {
          const tokenAddr = String(note.tokenId || '');
          const key = `${cid}:${tokenAddr.toLowerCase()}`;
          const symbol = resolveTokenSymbol(tokenAddr, cid);
          const entry = notesByToken.get(key)
            || { balance: 0n, pending: 0n, count: 0, symbol, tokenAddress: tokenAddr, chainId: cid };
          let value: bigint;
          try { value = BigInt(note.value); } catch { continue; }
          const status = String(note.status);
          if (status === 'active' || status === 'ACTIVE') entry.balance += value;
          else if (status === 'pending' || status === 'PENDING') entry.pending += value;
          else if (value > 0n && isLiveNoteStatus(status)) entry.otherLive = true;
          else continue; // spent / inactive notes hold no value
          entry.count++;
          notesByToken.set(key, entry);
        }
      }
    }

    // Per-row USD, captured while the row resolves its own decimals + price;
    // myPoolsStats sums THESE so the headline can't drift from the rows.
    const rowUsd = new Map<string, { symbol: string; balanceUsd: number; pendingUsd: number }>();
    // An emptied pool has nothing left to show: the row is dropped, for every
    // pool kind (Mike, DEV-466; it used to be legacy pools only, Pat
    // 2026-09-18). Any balance, pending amount or other live note keeps it.
    let hiddenEmptyPools = 0;
    // Chain-agnostic: it reads only amounts, so Sui/Stellar rows follow it too.
    const myPools: MyPool[] = Array.from(notesByToken.values()).filter((entry) => {
      const hide = hideEmptyBalanceRow(BigInt(entry.balance), BigInt(entry.pending), entry.otherLive === true);
      if (hide) hiddenEmptyPools += 1;
      return !hide;
    }).map((entry) => {
      const meta = getTokenMetadata(entry.tokenAddress, entry.chainId);
      // Sui note tokenIds are random ids getTokenMetadata can't know — it would
      // report 18 decimals and render MIST amounts as 0.0000. Use SUI's 9.
      const decimals = nonEvmAsset ? nonEvmAsset.decimals : meta.decimals;
      const balanceNum = Number(entry.balance) / 10 ** decimals;
      const pendingNum = Number(entry.pending) / 10 ** decimals;
      const stableFallback = isStablecoin(entry.symbol) ? 1 : 0;
      // Address lookup ONLY for the session chain: priceMap is fetched for that
      // chain and keys the shared native sentinel 0xeee… to ETH, which priced
      // Citrea's cBTC row as ether (kimi review, finding 1). Foreign rows fall
      // to the symbol price, then the stablecoin floor.
      const price = (entry.chainId === sessionChainId ? priceMap[entry.tokenAddress.toLowerCase()] : 0)
        || priceMap[entry.symbol]
        || stableFallback;
      // A SHARE is worth its underlying at the live vault rate, and cannot be
      // priced by its own symbol: there is no "ppETH" in the feed, so the
      // lookup above falls to the 0 floor. The balances CARD already converts
      // and prices correctly, which is how the hero came to read $9 over rows
      // of $9 + $14 + $0 (prod, 2026-09-22). services/pool-row-usd.ts is the
      // one conversion both now read.
      const shareRate = isShareSymbol(entry.symbol) ? rateFor(entry.chainId, entry.tokenAddress) : undefined;
      const balanceUsdValue = computeRowUsd({ amount: balanceNum, rate: shareRate, plainPrice: price, priceMap });
      const pendingUsdValue = computeRowUsd({ amount: pendingNum, rate: shareRate, plainPrice: price, priceMap });
      // The hero total must be the sum of the ROWS: re-deriving decimals from
      // the static TOKEN_DECIMALS table and a symbol-only price made the total
      // disagree with the rows it summarises (kimi review, finding 7).
      rowUsd.set(`${entry.chainId}:${entry.symbol.toLowerCase()}`, {
        symbol: entry.symbol,
        balanceUsd: balanceUsdValue,
        pendingUsd: pendingUsdValue,
      });
      return {
        // Chain-qualified: the same symbol can hold value on several chains.
        id: `${entry.chainId}:${entry.symbol.toLowerCase()}`,
        name: entry.symbol,
        tokenAddress: entry.tokenAddress,
        chainId: entry.chainId,
        balance: formatUsd(balanceUsdValue),
        // formatTokenBalance, not a bare toFixed(4): a tiny cBTC shield rounded
        // to "0.0000 cBTC" here while the Deposit row in My transactions (which
        // already goes through it) read "<0.0001 cBTC" — the balances row above
        // asserted the holding was empty while the row below proved it was not
        // (Pat, 2026-09-01). It also gives stablecoins their usual 2dp, and
        // inherits the shared threshold whenever that moves.
        balanceToken: `${formatTokenBalance(balanceNum, entry.symbol)} ${entry.symbol}`, // raw-data: parsed as a number (action-hub); renders apply approxUnderlyingText
        // Exact decimal from the raw base-unit sum: display values above are
        // rounded for layout, but a tap-to-max must never overshoot the
        // spendable balance, so it consumes this string.
        balanceTokenExact: formatUnits(BigInt(entry.balance), decimals),
        pending: formatUsd(pendingUsdValue),
        pendingToken: `${formatTokenBalance(pendingNum, entry.symbol)} ${entry.symbol}`, // raw-data: parsed as a number (action-hub); renders apply approxUnderlyingText
        pendingTokenExact: formatUnits(BigInt(entry.pending), decimals),
        // "DEPOSITS" column = the user's actual deposits for this asset, not
        // the note count (which also includes received/change/spent notes).
        poolAccounts: myDepositCountByToken.get(
          nonEvmAsset ? `${nonEvmAsset.chainId}:${nonEvmAsset.ticker.toLowerCase()}` : `${entry.chainId}:${entry.tokenAddress.toLowerCase()}`,
        ) ?? 0,
      };
    });

    // Who the rows below belong to. Gates BOTH the deposit-row enrichment and
    // the lineage synthesis at ~1720 (received transfers + reconstructed
    // spends), so a null here costs an account-key session every Transfer In,
    // Transfer Out and Withdrawal row it has.
    // BRANCHED on identityMode, not a null-coalesce: a key session can have a
    // funding wallet connected (deposits require one) and that wallet is a
    // payer, not the account being viewed. The non-key branch keeps the wagmi
    // address, so an existing wallet session is byte-identical. Companion to
    // the feed-supplement gate fixed in 2652413.
    const connectedAddress = (identityMode === 'key' ? sessionAddress : address)?.toLowerCase() ?? null;
    // My own confirmed anchors, read once per pass. This is the LOCAL signal
    // that does not wait on the ASP: the reconstructed spends below need the event
    // SNAPSHOT, which lags the activity FEED by a minute or two after a claim,
    // and in that window my anchor's own output note rendered as an incoming
    // payment I never received (Pat, 2026-09-01, keystoreless run). Memo-scope
    // so the merge can use it too, not just the lineage loop.
    const anchorTxHashes = readAnchorTxHashesForChains(connectedAddress, supportedChainIds);
    // Candidate notes for matching the user's deposit events. SDK notes carry
    // no parent linkage (parentCommitmentHash never survives the Note schema),
    // so every note is considered — the label/token filters below scope the
    // match. The old `parentCommitmentHash === null` filter matched nothing
    // (the field is undefined), which left every deposit row on its raw ASP
    // status regardless of the local note state (#213).
    // Indexed BY CHAIN. The balance has been multichain since 2026-08-18, but
    // this matcher was not: an Optimism deposit was matched against the active
    // (Sepolia) session's notes, found nothing, and rendered pending forever —
    // "all OP tx show pending" (Pat, 2026-08-28). The other chains' notes come
    // from the same per-(address, chainId) exports the balance reads, so the
    // two surfaces now consult the same set for the same chain.
    // A chain-blind pool was also free to mis-match: the native sentinel
    // 0xeee… and a round amount are shared across EVM chains, so a Sepolia
    // note could satisfy an Optimism row's token+value filter.
    const depositCandidatesByChain = new Map<number, Array<Note & {
      normalizedTokenId: string; normalizedLabel: string; normalizedValueDec: string;
    }>>();
    const seenDepositCandidates = new Set<string>();
    const addDepositCandidate = (cid: number, note: Note) => {
      let normalizedValueDec: string;
      try { normalizedValueDec = BigInt(note.value).toString(); } catch { return; }
      // A note can reach the same chain's pool twice now (live manager AND
      // the persisted export below), so dedupe by commitment as we add.
      const dedupeKey = `${cid}:${String(note.commitment ?? '').toLowerCase()}`;
      if (note.commitment) {
        if (seenDepositCandidates.has(dedupeKey)) return;
        seenDepositCandidates.add(dedupeKey);
      }
      const pool = depositCandidatesByChain.get(cid) ?? [];
      pool.push({
        ...note,
        normalizedTokenId: String(note.tokenId ?? '').toLowerCase(),
        normalizedLabel: String(note.label ?? '').toLowerCase(),
        normalizedValueDec,
      });
      depositCandidatesByChain.set(cid, pool);
    };
    for (const note of notes) addDepositCandidate(sessionChainId, note);
    if (!nonEvmAsset && exportIdentity) {
      for (const cid of supportedChainIds) {
        // Session chain NOT skipped, for the same reason as the identity
        // sets above: the live manager is empty in an account-key session
        // until a sync runs, which left THIS chain's deposit rows on their
        // raw ASP status. The commitment dedupe above absorbs the overlap.
        if (getChainConfig(cid)?.chainType !== 'evm') continue;
        for (const note of storedNotesForChain(cid)) {
          addDepositCandidate(cid, note as unknown as Note);
        }
      }
    }
    const NO_CANDIDATES: Array<Note & {
      normalizedTokenId: string; normalizedLabel: string; normalizedValueDec: string;
    }> = [];

    // Global, not per chain: one note must not back two rows, whichever chains
    // they claim to be on.
    const matchedDepositCommitments = new Set<string>();
    // The balance's OWN ledger of which approved deposits it counted pending.
    // The row reads it rather than re-deriving the verdict, so the two surfaces
    // cannot contradict each other (#213).
    const balancePendingTxHashes = new Set(unmatchedApprovedDeposits.map((d) => d.txHash));

    // Every note I hold, on every chain, as identity sets for ownership.
    const allOwnedNoteIdentity = noteIdentitySets(
      [...depositCandidatesByChain.values()].flat(),
    );

    // For the verdict of my own snapshot deposit rows (see ownDepositReviewStatus):
    // which notes the session gate judged.
    const gateJudgedCommitments = new Set(notes.map((n) => String(n.commitment)));

    const transactions: Transaction[] = transactionsBase.map((tx) => {
      if (tx.type !== 'Deposit') return tx;
      if (!connectedAddress) return tx;
      // A row built from the snapshot names its commitment and is mine or
      // authored by me by construction (services/own-history-rows.ts).
      const ownCommitment = tx.ownCommitment ? normalizeCommitment(tx.ownCommitment) : null;
      // No ASP verdict on the row: it comes from the snapshot, or the feed hides
      // verdicts (DEV-587). Every row past the ownership check below is mine.
      const derived = !tx.reviewStatus;
      // Ownership: the depositor is me, OR one of my notes claims the row.
      // A cross-chain shield is executed on the destination by LiFi's
      // executor, so the row names it as depositor; the label still ties
      // the deposit to my note (services/deposit-ownership.ts).
      const depositorIsMe = tx.fullAddress.toLowerCase() === connectedAddress;
      const claimedByNote = depositMatchesMyNotes({ txHash: tx.txHash ?? null, label: tx.label ?? null, commitment: tx.ownCommitment, tokenAddress: tx.tokenAddress }, allOwnedNoteIdentity);
      if (!depositorIsMe && !claimedByNote && !ownCommitment) return tx;

      const normalizedTxLabel = tx.label?.toLowerCase() ?? null;
      const normalizedTxToken = tx.tokenAddress.toLowerCase();
      const normalizedTxAmountDec = tx.rawAmount;

      // This row's OWN chain decides which notes may back it, whether the
      // active chain's association set applies, and whether "absent on this
      // device" is a claim we are entitled to make (services/deposit-row-chain.ts).
      const txChainId = Number(tx.chainId) || sessionChainId;
      const depositCandidateNotes = depositCandidatesByChain.get(txChainId) ?? NO_CANDIDATES;
      const chainPolicy = depositRowChainPolicy({
        txChainId,
        activeChainId: sessionChainId,
        balanceCountsPending: !!tx.txHash && balancePendingTxHashes.has(tx.txHash.toLowerCase()),
      });

      const candidateNotes = depositCandidateNotes
        .filter((note) => !matchedDepositCommitments.has(normalizeCommitment(note.commitment) ?? note.commitment))
        .filter((note) => note.normalizedTokenId === normalizedTxToken)
        .filter((note) => {
          // The snapshot row's own note, and no other.
          if (ownCommitment) return normalizeCommitment(note.commitment) === ownCommitment;
          if (normalizedTxLabel) {
            return note.normalizedLabel === normalizedTxLabel;
          }
          // Value alone can only back a row I paid for myself: for a row that
          // someone else deposited, an equal amount proves nothing.
          return depositorIsMe && note.normalizedValueDec === normalizedTxAmountDec;
        })
        .sort((a, b) => {
          // REJECTED ranks right after ACTIVE (services/funds-state.ts): it is
          // the lineage's live note and must not hide behind a SPENT sibling.
          const byStatus = noteMatchPriority(String(a.status)) - noteMatchPriority(String(b.status));
          if (byStatus !== 0) return byStatus;

          const byValue = BigInt(b.value) - BigInt(a.value);
          if (byValue !== 0n) return byValue > 0n ? 1 : -1;

          return a.commitment.localeCompare(b.commitment);
        });

      const matchedNote = candidateNotes[0];
      if (!matchedNote && derived) {
        // A deposit I made FOR someone else: its note, and with it any local
        // evidence of the review, is the recipient's. The deposit itself
        // happened, so the row says that and claims no verdict.
        const hash = tx.txHash.toLowerCase();
        if (depositOwnershipInputs.outgoingDepositTxHashes.has(hash) || depositOwnershipInputs.paidRequestTxHashes.has(hash)
          || viewingKeyMatches.get(hash) === false || ownershipPending(hash, depositorIsMe)) {
          return { ...tx, status: 'completed', reviewStatus: '', fundsState: undefined, fundsReason: undefined };
        }
        // A feed row with no note yet reads pending (syncing) below, like an approved one did.
        if (ownCommitment) return tx;
      }
      if (!matchedNote) {
        // #213: an ASP-approved deposit with NO local note (neither by label
        // nor by txHash) is counted as PENDING by the balance merge above —
        // its funds aren't locally spendable (discovery lag, another device's
        // deposit, or a stranded lineage). Show the row as pending too so the
        // transactions list agrees with the balance. Only once local notes
        // exist at all: with an empty/locked session everything would flip.
        if (chainPolicy.showAsMissing && tx.status === 'completed') {
          // Approved on-chain, absent on this device: 'invisible' (syncing).
          return {
            ...tx,
            status: 'pending',
            ...fundsFields(projectDepositFunds({
              reviewStatus: tx.reviewStatus,
              noteStatus: null,
              leafReady: chainPolicy.leafGated && leafState.ready,
              leafConfirmed: false,
              registration: registrationStatus,
              discoveryReady: true,
            })),
          };
        }
        return tx;
      }

      matchedDepositCommitments.add(normalizeCommitment(matchedNote.commitment) ?? matchedNote.commitment);

      const noteStatus = String(matchedNote.status);
      const leafConfirmed = chainPolicy.leafGated && leafState.confirmed.has(matchedNote.commitment);
      // A snapshot row has no ASP verdict: derive it from what this device
      // holds, the pool's published decisions first.
      // An exited note derives no verdict (null): the deposit happened, and
      // the row reads completed without claiming one.
      const derivedReview = derived
        ? ownDepositReviewStatus({
            label: matchedNote.label,
            noteStatus,
            decisions: labelDecisionsByChain.get(txChainId) ?? null,
            leafConfirmed: chainPolicy.leafGated && leafState.ready && gateJudgedCommitments.has(matchedNote.commitment)
              ? leafConfirmed
              : null,
          })
        : null;
      const reviewStatus = derived ? derivedReview ?? '' : tx.reviewStatus;
      const eventOutcome = !derived ? asOutcome(tx.status) : derivedReview ? reviewOutcome(derivedReview) : 'completed';
      // The note refines the OUTCOME only where it settles it; a REJECTED note
      // keeps the event's outcome (the deposit did happen) and is projected to
      // 'at risk' below instead of reading pending forever.
      // depositRowOutcome, not noteOutcome: an ACTIVE note must not outrank the
      // ASP verdict. While the review is still pending the funds are not
      // spendable and the balance counts them pending, so the row must agree.
      let rowStatus: string = depositRowOutcome(noteStatus, eventOutcome);
      // Align with the leaf-gated spendable split (#214): an ACTIVE note whose
      // association-set leaf isn't published yet is counted as pending by the
      // balance, so its deposit row reads pending too until the leaf lands.
      if (rowStatus === 'completed' && noteStatus.toUpperCase() === 'ACTIVE'
        && chainPolicy.leafGated && leafState.ready && !leafConfirmed) {
        rowStatus = 'pending';
      }

      return {
        ...tx,
        status: rowStatus,
        reviewStatus,
        noteStatus,
        ...fundsFields(projectDepositFunds({
          reviewStatus,
          noteStatus,
          leafReady: chainPolicy.leafGated && leafState.ready,
          leafConfirmed,
          registration: registrationStatus,
          discoveryReady: true,
        })),
      };
    });

    // Count of distinct incoming transfers (received lineage rows), for the
    // strip below — set when the lineage block runs.
    let receivedTransferCount = 0;
    // --- #215: lineage rows for received/sent activity with no event row ---
    // The global events feed only attributes deposits to the connected address
    // and is windowed, so received transfers and the internal spends of a
    // lineage have no row even though they back the balance. Synthesize them
    // from owned notes: a non-deposit ROOT note => received ('in'); a CHILD note
    // (it exists because the user spent its parent) => sent ('out'), amount =
    // parent.value - change.value. Deposit roots are skipped (they have a
    // Deposit row); determined against the full snapshot deposit set, not just
    // the recent feed, so old deposits aren't mislabeled as received.
    const lineageRows: Transaction[] = [];
    // The spend rows below, which the counts read.
    let spendRows: Transaction[] = [];
    // This device's swap records (services/swap-records-core.ts) and my notes
    // on every chain by commitment: a cross-chain swap's destination note and
    // a Shield swap's deposit note are found through them. Local reads only.
    const swapRecords = connectedAddress ? readAllSwapRecords() : [];
    const notesByCommitment = new Map<string, { status: string; label: string; commitment: string; value: string; tokenId: string; txHash: string }>();
    for (const { note, chainId } of receivedCandidates) {
      notesByCommitment.set(`${chainId}|${hexKey(String(note.commitment))}`, {
        status: String(note.status), label: String(note.label ?? ''), commitment: String(note.commitment), value: String(note.value), tokenId: String(note.tokenId), txHash: String(note.txHash ?? ''),
      });
    }
    const noteOn = (chainId: number, commitment: string) => notesByCommitment.get(`${chainId}|${hexKey(commitment)}`) ?? null;
    // What THIS device did per tx hash (services/own-actions-core.ts). A note
    // from my own Shield or swap-in is a Deposit row while the ASP has not
    // indexed the event; my own withdraw / send change is covered by the spend
    // row once classified. Neither may read as Transfer In (Pat, 2026-09-04).
    const ownActions = connectedAddress ? buildOwnActionMap(defaultChain.id) : new Map<string, OwnAction>();
    // Status of own outputs with no ASP row, from local evidence only. The
    // leaf gate and the registration status are the SESSION chain's; another
    // chain's note is judged on its status alone.
    const projectLocalOutputs = (chainId: number, outputs: readonly { status: string; commitment: string }[]): OwnOutputProjection | null => {
      const sessionChain = chainId === defaultChain.id;
      return projectOwnOutputs(
        outputs.map((o) => ({ noteStatus: o.status, leafConfirmed: sessionChain && leafState.confirmed.has(o.commitment) })),
        { leafReady: sessionChain && leafState.ready, registration: sessionChain ? registrationStatus : 'unknown' },
      );
    };
    // --- own shield / swap outputs: deliberately NOT behind `spendsReady` ---
    // Spend classification re-runs (and reads not-ready) for a render whenever
    // the notes array changes, which is exactly the moment a fresh deposit note
    // lands. The confirm-time feed refetch drops the optimistic Deposit row in
    // that same window, so this row has to exist without waiting for the
    // classifier. The local stamp already proves the note is not a received
    // transfer, which is all the classifier would have added (codex, 2026-09-04).
    if (connectedAddress) {
      // Deposits the SNAPSHOT already knows (it carries no review verdict).
      const snapshotCommitments = new Set<string>();
      for (const dep of myDeposits) {
        const canonical = normalizeCommitment(dep.outputCommitment);
        if (canonical) snapshotCommitments.add(canonical);
      }
      // THIS chain's PUBLIC feed window (not the personal history merged into
      // `transactions`, not another chain's rows): a deposit older than its
      // oldest row is absent because the window evicted it, not because the
      // ASP lags. null = the window holds no row for this chain.
      // publicRows, not feedEvents: our own pending row is not part of the
      // ASP's window and must not set its oldest edge (a pending row alone on
      // an otherwise empty chain would have made "now" the cutoff).
      const publicFeedHashes = new Set<string>();
      for (const e of publicRows) {
        if (Number(e.asset?.chainId) === defaultChain.id && e.txHash) publicFeedHashes.add(String(e.txHash).toLowerCase());
      }
      let oldestFeedTs: number | null = null;
      for (const t of transactions) {
        if (t.chainId !== defaultChain.id || !(t.timestamp > 0)) continue;
        if (!publicFeedHashes.has(String(t.txHash || '').toLowerCase())) continue;
        if (oldestFeedTs === null || t.timestamp < oldestFeedTs) oldestFeedTs = t.timestamp;
      }
      // Deposit rows already on THIS chain (optimistic or ASP): the only rows
      // this synthesized Deposit may stand in for. A cross-chain swap's source
      // tx row on another chain is not one.
      const depositRowHashesOnChain = new Set<string>();
      for (const t of transactions) {
        if (t.type === 'Deposit' && t.chainId === defaultChain.id && t.txHash) depositRowHashesOnChain.add(String(t.txHash).toLowerCase());
      }
      // Grouped per creating tx and SUMMED (a batch deposit is several notes
      // under one hash), commitment-deduped.
      const ownDepositByTx = new Map<string, { first: (typeof notes)[number]; sum: bigint; commitments: Set<string>; action: OwnAction; outputs: { status: string; commitment: string }[] }>();
      for (const note of notes) {
        const txHash = String(note.txHash || '').toLowerCase();
        if (!txHash || depositRowHashesOnChain.has(txHash)) continue;
        const ownAction = ownActions.get(txHash);
        if (!ownAction || !isOwnDepositOutput(ownAction, String(note.tokenId || ''))) continue;
        const canonical = normalizeCommitment(String(note.commitment)) ?? '';
        // 0 while the SDK still holds the block NUMBER there (healed later).
        const noteTs = noteTimeMs(note.createdAtBlock);
        if (!ownDepositBridgeAllowed({
          feedLoaded: eventsResponse !== undefined,
          snapshotLoaded: eventSnapshot !== undefined,
          snapshotKnows: snapshotCommitments.has(canonical),
          oldestFeedTs,
          noteTs,
          actionTs: ownAction.timestamp,
        })) continue;
        let depositRaw: bigint;
        try { depositRaw = BigInt(note.value); } catch { continue; }
        const commitment = String(note.commitment || '').toLowerCase();
        const output = { status: String(note.status), commitment: String(note.commitment) };
        const entry = ownDepositByTx.get(txHash);
        if (!entry) {
          ownDepositByTx.set(txHash, { first: note, sum: depositRaw, commitments: new Set([commitment]), action: ownAction, outputs: [output] });
        } else if (!entry.commitments.has(commitment)) {
          entry.commitments.add(commitment);
          entry.sum += depositRaw;
          entry.outputs.push(output);
        }
      }
      for (const [, entry] of ownDepositByTx) {
        const commitment = String(entry.first.commitment);
        // No ASP row for this output, so the verdict comes from what is already
        // local: a SPENT note was spent privately, which only an approved note
        // can be, and a leaf in the published association set is approved by
        // definition. Hard-coding 'pending' kept a swap output that had long
        // since been approved and spent reading "Pending" forever (QA
        // 2026-09-24). An ACTIVE note alone proves nothing: our own deposit
        // turns ACTIVE before the review lands (see depositRowOutcome). Every
        // output must carry its own evidence for the row to read approved.
        const projected = projectLocalOutputs(defaultChain.id, entry.outputs);
        if (!projected) continue;
        const row = buildLineageTransferRow(entry.first, 'in', entry.sum, defaultChain.id, priceMap);
        // A note whose block time is not healed yet would sort to 1970 and drop
        // out of every "latest" slice: the device's own stamp time stands in.
        const timestamp = row.timestamp > 0 ? row.timestamp : entry.action.timestamp;
        lineageRows.push({
          ...row,
          timestamp,
          id: `lineage-deposit-${commitment}`,
          type: 'Deposit',
          direction: undefined,
          reviewStatus: projected.reviewStatus,
          status: projected.status,
          noteStatus: projected.noteStatus,
          ...fundsFields(projected.funds),
        });
      }
    }
    // Only synthesize once the deposit snapshot has loaded AND the user's own
    // spends are classified (userSpends.ready): an old deposit root (outside
    // the recent event window, hence not in matchedDepositCommitments) or an
    // own-spend change note would otherwise be briefly — or, before the spend
    // classification existed, permanently — mislabeled as a received transfer.
    // While the NEXT run is pending, the last run's spends stand in (same
    // identity only), so a re-classification does not blank the list. Only
    // notes that run saw can become receipts then: the change of a send it
    // never saw is not among them, and that tx's feed row stays held
    // (filterMineEvents, DEV-394) until it is classified.
    if (connectedAddress && eventSnapshot !== undefined && spendsUsable) {
      // Change of my own spends, claims, anchors and stamped actions is not a
      // receipt, and nor is a note of a tx another row explains. The SDK's Note
      // carries no parent linkage that survives storage (see #215), so these
      // tx-level facts are the only discriminator.
      const allOwnActions = readAllOwnActions();
      const skipTxHashes = receiptSkipTxHashes({
        spends: userSpends.list,
        anchorTxHashes,
        localTxHashes: [
          ...allOwnActions.map((a) => a.txHash),
          ...buildSentTxHashSet(),
          ...buildPaidRequestTxHashSet(),
        ],
        rows: [...transactions, ...lineageRows],
      });
      // A deposit root is never a receipt. The snapshot covers every chain's
      // deposits; the feed-matched set covers one the snapshot has not caught
      // up with yet.
      const depositCommitments = new Set([...snapshotTxIndex.depositCommitments, ...matchedDepositCommitments]);
      const received = collectReceivedTransfers(spendsReady ? receivedCandidates : onlyClassifiedNotes(receivedCandidates, userSpends.forNotes ?? []), {
        skipTxHashes,
        depositCommitments,
        txChainIds: snapshotTxIndex.chainIds,
        sessionChainId: defaultChain.id,
        // A chain missing from the snapshot or its feeds hides its deposits and
        // spends, and every note on it would read as received.
        loadedChainIds: eventSnapshot.loadedChainIds,
        pendingChainIds: historyPendingChainIds,
        spendChainIds: new Set(userSpends.list.flatMap((s) => (s.chainId !== undefined ? [s.chainId] : []))),
      });
      receivedTransferCount = received.length;
      const seenLineageTx = new Set<string>();
      for (const entry of received) {
        seenLineageTx.add(entry.txHash);
        const receivedStatus = String(entry.first.status);
        // The leaf gate and the registration status are the SESSION chain's.
        // Another chain's note is judged on its status alone.
        const sessionChain = entry.chainId === defaultChain.id;
        lineageRows.push({
          ...buildLineageTransferRow(entry.first, 'in', entry.sum, entry.chainId, priceMap, snapshotTxIndex.times.get(entry.txHash)),
          // The sender is not recoverable: the row wears the privacy shield,
          // not my own address.
          address: '',
          fullAddress: '',
          noteStatus: receivedStatus,
          // A received note on an unregistered wallet is the Claim case; a
          // REJECTED one is at risk. Same projector as deposits.
          ...fundsFields(projectReceivedFunds({
            noteStatus: receivedStatus,
            leafReady: sessionChain && leafState.ready,
            leafConfirmed: sessionChain && leafState.confirmed.has(String(entry.first.commitment)),
            registration: sessionChain ? registrationStatus : 'unknown',
          })),
        });
      }

      // Outgoing rows ('Transfer Out' with the exact recipient-facing amount,
      // 'Withdrawal' with the value that left the pool) from the cross-device
      // reconstruction (services/outgoing-transfers.ts): reliable amount +
      // direction, no per-device stamp. 'internal' spends (self merge/split)
      // get no row.
      //
      // These are ALWAYS emitted, even when an ASP event row exists for the
      // same tx (that row is still in the windowed global feed). The ASP row
      // is misdirected: on a device with no local sent-stamp, classifyTransfer
      // sees the sender's change note and renders the spend as 'Transfer In'.
      // The My Transactions merge dedupes by txHash and prefers the lineage
      // row, so the reconstructed 'out'/'Withdrawal' row replaces the ASP row.
      // (We keep the seenLineageTx guard only so a spend tx that also produced
      // a received 'in' row above — impossible today, since 'in' skips
      // my own spends — can't double-emit.)
      // One row per claimed payment, however many notes it arrived as.
      const allOwnActionsForSetup = readAllOwnActions();
      const withdrawRecipients = readAllWithdrawRecipients();
      spendRows = buildSpendRows({
        spends: mergeClaimsByPayment(userSpends.list),
        seenTxHashes: seenLineageTx,
        defaultChainId: defaultChain.id,
        feedRows: transactions,
        priceMap,
        projectLocalOutputs,
        recipientOf: (txHash) => recordedRecipient(txHash, withdrawRecipients),
        records: swapRecords,
        noteOn,
        depositCommitments: new Set([...snapshotTxIndex.depositCommitments].map(hexKey)),
        setupKindOf: (chainId, txHash) => {
          const kind = findOwnActionIn(allOwnActionsForSetup, txHash, chainId)?.kind;
          return kind === 'setup-gas' ? 'gas-top-up' : kind === 'setup-register' ? 'registration' : null;
        },
      });
      lineageRows.push(...spendRows);
    }
    // A Shield swap-and-shield's Deposit rows say what the wallet paid; my own
    // withdrawals' feed rows carry what my lineage rows say about them.
    const decorated = decorateOwnRows({ feedRows: transactions, lineageRows, records: swapRecords, noteOn, priceMap });
    for (let i = 0; i < transactions.length; i++) transactions[i] = decorated.feedRows[i];
    for (let i = 0; i < lineageRows.length; i++) lineageRows[i] = decorated.lineageRows[i];
    // Stellar: deposit + received rows from the account's own notes. Nothing in
    // the ASP feed covers them, so there is nothing to dedupe against.
    if (stellarActivity) lineageRows.push(...stellarActivity.rows);
    // Which lineage gate is actually shutting for an account-key session.
    // Same ppv2_debug switch as the note trace that localised the feed bug.
    if (typeof localStorage !== 'undefined') {
      try {
        if (localStorage.getItem('ppv2_debug') === '1') {
          console.log('[lineage] gate', {
            identityMode,
            connectedAddress,
            hasSnapshot: eventSnapshot !== undefined,
            userSpendsReady: spendsReady,
            userSpendsCount: userSpends.list.length,
            userSpendKinds: userSpends.list.map((s) => s.kind),
            liveNotes: notes.length,
            receivedRows: receivedTransferCount,
            lineageRows: lineageRows.length,
            aspRows: transactions.length,
          });
        }
      } catch { /* storage unavailable */ }
    }
    // lineageRows are returned SEPARATELY (not merged into `transactions`): the
    // shared `transactions` feed is consumed by global/pool surfaces (latest
    // activity, notifications, pool counts) that must stay ASP-event-only. Only
    // "My Transactions" merges lineageRows, in its personal scope.

    // --- myPoolsStats ---
    let totalBalanceUsd = 0;
    let totalPendingUsd = 0;
    const assetPercentages: PoolAsset[] = [];

    for (const row of rowUsd.values()) {
      totalBalanceUsd += row.balanceUsd;
      totalPendingUsd += row.pendingUsd;
      assetPercentages.push({
        name: row.symbol,
        color: TOKEN_COLORS[row.symbol] || '#999999',
        percent: row.balanceUsd,
      });
    }

    // Normalize asset percentages
    const totalAssetValue = assetPercentages.reduce((s, a) => s + a.percent, 0) || 1;
    for (const a of assetPercentages) {
      a.percent = Math.round((a.percent / totalAssetValue) * 100);
    }

    // Count deposits / transfers / withdrawals attributable to this account,
    // from UNBOUNDED sources: deposits from the full-history snapshot (via
    // myDepositCountByToken above), transfers/withdrawals from the
    // nullifier-matched spend reconstruction + received lineage + snapshot
    // exits. The public events feed is a 50-row window — counting from it
    // showed 0/0/0 for any wallet whose activity scrolled out of the window
    // even while it held a real balance. The feed remains only as a
    // best-effort stand-in while the spend classification is still loading.
    let totalDeposits = 0;
    for (const c of myDepositCountByToken.values()) totalDeposits += c;

    const connectedLc = myActivityAddress?.toLowerCase() ?? '';
    let totalTransfers = 0;
    let totalWithdrawals = 0;
    let totalSwaps = 0;
    if (connectedLc) {
      if (spendsUsable) {
        const counts = countSpendActions({
          spends: mergeClaimsByPayment(userSpends.list),
          spendRows,
          receivedCount: receivedTransferCount,
          exitCount: myExits.length,
          depositCount: totalDeposits,
          snapshotDeposits: eventSnapshot !== undefined ? myDeposits : [],
        });
        totalTransfers = counts.transfers;
        totalWithdrawals = counts.withdrawals;
        totalSwaps = counts.swaps;
        totalDeposits = counts.deposits;
      } else {
        for (const tx of transactionsBase) {
          if (tx.fullAddress.toLowerCase() !== connectedLc) continue;
          if (tx.type === 'Transfer') totalTransfers += 1;
          else if (tx.type === 'Withdrawal' || tx.type === 'Exit') totalWithdrawals += 1;
        }
      }
    }

    // Stellar activity is counted from its notes and events (the loops above see none).
    if (stellarActivity) {
      totalTransfers += stellarActivity.receivedCount + stellarActivity.sentCount;
      totalWithdrawals += stellarActivity.withdrawalCount;
    }

    const myPoolsStats: MyPoolsStats = {
      acceptedFundsValue: formatUsd(totalBalanceUsd),
      acceptedFundsUsd: totalBalanceUsd,
      acceptedFundsChange: computeChange24h(statistics),
      acceptedFundsLabel: 'past 24h',
      pendingValue: formatUsd(totalPendingUsd),
      pendingChange: '0%',
      totalDeposits,
      totalTransfers,
      totalWithdrawals,
      totalSwaps,
      assets: assetPercentages,
    };

    // (myDeposits / myExits are computed earlier in this memo — before the
    // count strip — from the un-windowed event snapshot; the accounting
    // export folds them in so it isn't bounded by the recent-events window.)

    const internalTxHashes = new Set(
      userSpends.list.filter((s) => s.kind === 'internal').map((s) => s.txHash.toLowerCase()),
    );

    // Holdings on the active chain: known, or merely not loaded yet? See the
    // field doc. Sui reads the dapp-kit balance directly, so it is always known.
    const holdingsReady = exportIdentity == null
      ? accountStatus !== 'reconnecting' && accountStatus !== 'connecting'
      : !!nonEvmAsset || storedExportForChain(activeChainId) != null || syncedHoldings.has(`${exportIdentity.toLowerCase()}:${activeChainId}`);
    const depositOwnership = {
      notMine: new Set([...viewingKeyMatches].filter(([, mine]) => !mine).map(([txHash]) => txHash)),
      pending: new Set<string>(),
    };
    if (walletIdentityLc) {
      for (const tx of transactions) {
        if (tx.type !== 'Deposit' || !tx.txHash || tx.fullAddress.toLowerCase() !== walletIdentityLc) continue;
        const ownership = resolveDepositOwnership({ txHash: tx.txHash, commitment: tx.ownCommitment, depositor: tx.fullAddress }, depositOwnershipInputs);
        if (!ownership.definitive && ownershipPending(tx.txHash, true)) depositOwnership.pending.add(tx.txHash.toLowerCase());
      }
    }
    return { myPools, hiddenEmptyPools, myPoolsStats, availableAssets, allPools, transactions, lineageRows, priceMap, pricesLoading, transferTxHashes, transactOutputsByTx, swapRouteKinds: swapRouteKindsByTx, anchorTxHashes, transferClassificationReady, spendClassificationPending, myDeposits, myExits, defaultChainId: defaultChain.id, internalTxHashes, unmatchedApprovedDeposits, depositOwnership, holdingsReady, historyPendingChainIds, ownTransfersPendingChainIds: ownTransfersPending, publicEventTotalsByChain: eventsResponse?.allTotalsLoaded ? eventsResponse.totalsByChain : {} };
  }, [
    historyPendingChainIds,
    ownTransfersPending,
    // A swap recorded, or its delivery outcome learned, re-reads the records.
    swapRecordsRevision,
    viewingKeyOwnership,
    eventSnapshotFailed,
    keystoreManager,
    // The hero total converts shares through these; without it the total keeps
    // the pre-rate figure while the rows update (kimi finding 7's failure mode).
    rateFor,
    eventSnapshot,
    activeChainId,
    address,
    identityMode,
    keysReady,
    myAddress,
    myActivityAddress,
    multiChainAddress,
    suiWalletMist,
    stellarWalletBalance,
    stellarWallet.isConnected,
    stellarWallet.address,
    stellarNoteOrigins,
    defaultChain.displayName,
    defaultChain.id,
    defaultChain.nativeCurrency.symbol,
    transferClassificationReady,
    spendsReady,
    spendClassificationPending,
    spendsUsable,
    erc20Balances,
    eventsResponse,
    reconciled,
    feedChainIds,
    sessionAddress,
    accountStatus,
    syncedHoldings,
    // Consumed for the authoritative TVL map — without it a refresh that only
    // changes the assets-stats response leaves TVL/accepted-funds stale until
    // an unrelated dependency moves (visible after a chain switch).
    assetsStats,
    transferTxHashes,
    withdrawalRouteTxHashes,
    swapRouteKindsByTx,
    transactOutputsByTx,
    ethWalletBalance,
    notes,
    leafState,
    labelDecisionsByChain,
    registrationStatus,
    userSpends,
    spendNotes,
    receivedCandidates,
    snapshotTxIndex,
    nonNativeSupportedTokenPrices,
    priceMap,
    pricesLoading,
    statistics,
    supportedTokenPrices,
  ]);

  useEffect(() => {
    const connectedAddress = address?.toLowerCase() ?? null;
    const recentEvents = (eventsResponse?.events ?? []).slice(0, 10);
    const matchingDeposits = recentEvents.filter(
      (event) => event.type === 'deposit' && event.address.toLowerCase() === connectedAddress,
    );

    log('debug', 'PoolsBalance', 'Computed pools snapshot', {
      chainId: defaultChain.id,
      connectedAddress,
      noteCount: notes.length,
      myPoolsCount: data.myPools.length,
      acceptedFundsValue: data.myPoolsStats.acceptedFundsValue,
      pendingValue: data.myPoolsStats.pendingValue,
      recentEventCount: recentEvents.length,
      recentMatchingDepositCount: matchingDeposits.length,
      recentMatchingDeposits: matchingDeposits.map((event) => ({
        eventId: event.eventId,
        amount: event.amount,
        reviewStatus: event.reviewStatus ?? null,
        tokenAddress: event.asset.tokenAddress,
        timestamp: event.timestamp,
      })),
      notes: notes.map((note) => ({
        commitment: note.commitment,
        tokenId: note.tokenId,
        value: note.value,
        status: note.status,
        txHash: note.txHash,
      })),
    });
  }, [
    address,
    data.myPools,
    data.myPoolsStats.acceptedFundsValue,
    data.myPoolsStats.pendingValue,
    defaultChain.id,
    eventsResponse?.events,
    log,
    notes,
  ]);

  // An approved deposit with no local note stays pending in the balance until
  // discovery materialises it. That used to trigger extra discovery passes of
  // its own, so the accounts with such a deposit, and only those, produced a
  // request set of their own. The grid's discovery passes (sdk-provider)
  // settle it on the same schedule as everyone else's.

  // Debug recording snapshot (services/debug-snapshots.ts): every note on every
  // chain with every field, the reconstructed spends, balances and every row
  // the activity table is built from, with its spent status.
  const debugPoolsRef = useRef({ notes, data, userSpends, spendsReady, identity: sessionAddress ?? myAddress });
  useEffect(() => {
    debugPoolsRef.current = { notes, data, userSpends, spendsReady, identity: sessionAddress ?? myAddress };
  });
  useEffect(() => registerDebugSnapshot('pools', () => {
    const cur = debugPoolsRef.current;
    const storedNotesByChain: Record<string, unknown> = {};
    if (cur.identity) {
      for (const cid of supportedChainIds) {
        const exp = loadStoredAccountExport(cur.identity, cid);
        if (exp) storedNotesByChain[String(cid)] = exp;
      }
    }
    return {
      identity: cur.identity ?? null,
      sessionChainNotes: cur.notes,
      storedAccountExportsByChain: storedNotesByChain,
      // No swap outputs or pairing (services/swap-rows.ts).
      userSpends: { ready: cur.userSpends.ready, spendsReady: cur.spendsReady, list: cur.userSpends.list.map(debugSafeSpend) },
      myPools: cur.data.myPools,
      myPoolsStats: cur.data.myPoolsStats,
      transactions: cur.data.transactions.map(debugSafeRow),
      lineageRows: cur.data.lineageRows.map(debugSafeRow),
      myDeposits: cur.data.myDeposits,
      myExits: cur.data.myExits,
      internalTxHashes: [...(cur.data.internalTxHashes ?? [])],
      transferTxHashes: [...(cur.data.transferTxHashes ?? [])],
      anchorTxHashes: [...(cur.data.anchorTxHashes ?? [])],
      unmatchedApprovedDeposits: cur.data.unmatchedApprovedDeposits,
      depositOwnership: { notMine: [...cur.data.depositOwnership.notMine], pending: [...cur.data.depositOwnership.pending] },
      spendClassificationPending: cur.data.spendClassificationPending,
      holdingsReady: cur.data.holdingsReady,
    };
  }), []);

  const yieldEarned = useYieldEarned({
    session: poolSession,
    chainId: sessionTarget?.chainId ?? null,
    snapshot: eventSnapshot,
  });

  return (
    <PoolsContext.Provider value={{ data, yieldEarned, walletShareBalances, statistics: statistics || null, isLoading, error }}>
      {children}
    </PoolsContext.Provider>
  );
}

/**
 * Native mock mode (constants/native-mock) renders fixed data instead of the
 * real provider, so nothing syncs or fetches for the mock account. Web: the
 * flag is a constant false and the mock module is empty.
 */
function NativeMockPoolsProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => getNativeMockPoolsValue(), []);
  if (!value) return <RealPoolsProvider>{children}</RealPoolsProvider>;
  return <PoolsContext.Provider value={value}>{children}</PoolsContext.Provider>;
}

export function PoolsProvider({ children }: { children: ReactNode }) {
  return NATIVE_MOCK_ACTIVE
    ? <NativeMockPoolsProvider>{children}</NativeMockPoolsProvider>
    : <RealPoolsProvider>{children}</RealPoolsProvider>;
}

export function usePools() {
  const context = useContext(PoolsContext);
  if (context === undefined) {
    throw new Error('usePools must be used within a PoolsProvider');
  }
  return context;
}
