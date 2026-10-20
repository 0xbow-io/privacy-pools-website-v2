// API response DTOs matching the configured ASP API Gateway OpenAPI spec.

// ── Health ───────────────────────────────────────────────────

export interface LivenessResponse {
  status: string;
}

export interface ASPStatusResponse {
  status: string;
  missingLeaves?: unknown[][];
  currentLeaves: unknown[][];
  error?: string;
}

export interface LeafCountsResponse {
  [key: string]: unknown;
}

// ── Asset metadata (embedded in events) ──────────────────────

export interface AssetMetadata {
  asset: string;
  chainId: number;
  chainName: string;
  tokenSymbol: string;
  tokenAddress: string;
  assetAddress: string;
  denomination: number;
}

// ── Global events ────────────────────────────────────────────

export interface GlobalEvent {
  type: 'deposit' | 'withdrawal' | 'ragequit' | 'transfer';
  eventId: number;
  createdAt: string;
  amount: string;
  address: string;
  txHash: string;
  timestamp: number;
  reviewStatus?: 'pending' | 'approved' | 'declined' | 'poi_required';
  aspRoot?: string;
  label?: string;
  /** Deposits: who funded it. 'bridged_pool' is a swap out of a pool on
   *  another network; 'pool' a swap out of a pool on this one; 'wallet' and
   *  'bridged_wallet' a wallet, possibly through a LI.FI route. */
  fundingSource?: string;
  asset: AssetMetadata;
}

export interface GlobalEventsResponse {
  page: number;
  perPage: number;
  total: number;
  events: GlobalEvent[];
  filters?: Record<string, unknown>;
}

/** Query parameters for GET /global/public/events. */
export interface GlobalEventsParams {
  page?: number;
  perPage?: number;
  action?: 'deposit' | 'withdrawal' | 'ragequit' | 'transfer';
  status?: 'pending' | 'approved' | 'declined';
  chainId?: number;
  token?: string;
  includeRagequit?: boolean;
  /** Entrypoint contract address — scopes events to one pool. */
  entrypoint?: string;
}

// ── Global statistics ────────────────────────────────────────

export interface TimeBasedStats {
  tvl: string;
  tvlUsd: string;
  avgDepositSize: string;
  avgDepositSizeUsd: string;
  // ── asp-v2 PR #92 (issue #91) additions ────────────────────────────────
  // OPTIONAL on purpose: the deployed API does not send them yet (verified
  // live 2026-07-28 — /global/public/statistics has neither). Absence means
  // "server predates PR #92" and every consumer must OMIT the figure (no $0,
  // no dash). They appear automatically on the normal fetch cadence once the
  // PR deploys. Mirrors apps/api-gateway/src/dto/public-api.dto.ts
  // (TimeBasedStatsDto) on asp-v2@feat/91-median-deposit-transfers-count.
  /** Median deposit in native token, raw units ("0" on the global endpoint, which aggregates across tokens). */
  medianDepositSize?: string;
  /** Median deposit in USD — the typical deposit, unskewed by whales. */
  medianDepositSizeUsd?: string;
  /**
   * In-pool transfers (Transacted events with 2+ output commitments). With
   * this field present, `totalWithdrawalsCount` covers external exits ONLY —
   * the two are disjoint.
   */
  totalTransfersCount?: number;
  // ───────────────────────────────────────────────────────────────────────
  totalDepositsCount: number;
  totalDepositsValue: string;
  totalDepositsValueUsd: string;
  totalWithdrawalsCount: number;
  totalWithdrawalsValue: string;
  totalWithdrawalsValueUsd: string;
}

export interface GlobalStatistics {
  allTime: TimeBasedStats;
  last24h: TimeBasedStats;
  cacheTimestamp: string;
}

// ── Entrypoints ──────────────────────────────────────────────

export interface PoolEntrypoint {
  poolId: string;
  chainId: string;
  entrypoint: string;
  // Absent on the legacy chain-grouped response (it has no pool vault), so
  // optional. Present once asp-v2 multi-pool ships. Used to match the feed
  // entry to THIS site's configured pool (chains.ts poolAddress).
  poolVault?: string;
  fromBlock: number;
}

export interface EntrypointsResponse {
  pools: PoolEntrypoint[];
  cacheTimestamp: string;
}

// asp-v2 is migrating /global/public/entrypoints from a chain-grouped map to
// a flat pools[] (multi-pool support). Until that deploys, the live API still
// returns the legacy shape, so apiClient.getEntrypoints() normalizes BOTH into
// EntrypointsResponse. These raw types capture what may arrive on the wire.
export interface LegacyEntrypointChainConfig {
  entrypoint: string;
  fromBlock: number;
  chainId: string;
}

export interface RawEntrypointsResponse {
  pools?: PoolEntrypoint[];
  chains?: Record<string, LegacyEntrypointChainConfig>;
  cacheTimestamp: string;
}

// ── Report address ───────────────────────────────────────────

export interface NonceResponse {
  nonce: string;
  message: string;
  expiresAt: string;
}

export interface ReportAddressRequest {
  address: string;
  nonce: string;
  message: string;
  signature: string;
  reason?: string;
}

export interface ReportAddressResponse {
  success: boolean;
  message: string;
  depositsDeclined: number;
}

// ── Wallet screening ─────────────────────────────────────────

export interface WalletScreeningCheckRequest {
  address: string;
  nonce: string;
  message: string;
  signature: string;
}

/** Only whether 0xbow services refuse the wallet. The ASP never says why. */
export interface WalletScreeningCheckResponse {
  denied: boolean;
}

// ── Association set ──────────────────────────────────────────

export interface AssociationSetRootResponse {
  root: string;
}

export interface AssociationSetLeavesResponse {
  leaves: string[];
}

// ── Labels ───────────────────────────────────────────────────

export interface LabelStatusResponse {
  status: 'pending' | 'approved' | 'rejected' | 'unknown';
  timestamp?: number;
}

// ── ASP public key ───────────────────────────────────────────

export interface ASPPublicKeyResponse {
  publicKey: string;
}

// ── Token prices ─────────────────────────────────────────────
// Note: The OpenAPI spec for GET /global/public/token-prices has no
// response schema. The interface below is derived from the actual API
// response observed from GET /global/public/token-prices.

export interface TokenPrice {
  chainId: string;
  tokenSymbol: string;
  priceUsd: string;
}

export interface TokenPricesResponse {
  prices: TokenPrice[];
  cacheTimestamp: string;
}

// ── Event Snapshot ───────────────────────────────────────────

export interface SnapshotDeposit {
  txHash: string;
  logIndex: number;
  depositAddress: string;
  outputCommitment: string;
  depositedValue: string;
  fee: string;
  blockNumber: string;
  blockTimestamp: string;
  asset: string;
}

export interface SnapshotTransact {
  txHash: string;
  logIndex: number;
  outputCommitments: string[];
  nullifierHashes: string[];
  caller: string;
  withdrawnValue: string;
  encryptedPayload: string | null;
  blockNumber: string | null;
  blockTimestamp: string;
  asset: string;
}

export interface SnapshotRagequit {
  txHash: string;
  logIndex: number;
  ragequitter: string;
  withdrawnValue: string;
  commitment: string;
  nullifierHash: string;
  label: string;
  blockNumber: string;
  blockTimestamp: string;
  asset: string;
}

export interface SnapshotLeaf {
  leaf: string;
  leafIndex: string;
  root: string;
  blockNumber: string;
  blockTimestamp: string;
  eventType: string;
}

// Raw on-chain Note event — `data` is pre-split into ephemeralPubKey +
// encryptedPayload, the shape note discovery consumes.
export interface SnapshotNote {
  txHash: string;
  logIndex: number;
  hint: string;
  ephemeralPubKey: string;
  encryptedPayload: string;
  blockNumber: string;
  blockTimestamp: string | null;
}

export interface EventSnapshotResponse {
  chainId: string;
  snapshotBlockNumber: string;
  generatedAt: string;
  deposits: SnapshotDeposit[];
  transacts: SnapshotTransact[];
  ragequits: SnapshotRagequit[];
  leaves: SnapshotLeaf[];
  keystoreLeaves: SnapshotLeaf[];
  notes: SnapshotNote[];
  /**
   * asp-v2#150, optional and additive: the pool state the ASP derived from its
   * own indexed rows at snapshotBlockNumber, checked against the chain by
   * services/snapshot-pool-state.ts. Decimal strings.
   */
  poolState?: SnapshotPoolStateWire;
}

export interface SnapshotPoolStateWire {
  blockNumber: string;
  stateRoot: string | null;
  stateLeafCount: string;
  lastLeafIndex: string | null;
  keystoreRoot: string | null;
  keystoreLeafCount: string;
  ragequitCount: string;
}

// GET /:chainId/public/assets-stats
export interface AssetStats {
  withdrawalsCount?: number;
  transfersCount?: number;
  asset: string;
  chainId: string;
  tokenSymbol: string;
  tokenAddress: string;
  totalDepositsValueUsd: string;
  totalDepositsValue?: string;
  totalDepositsCount?: number;
  totalInAssetValueUsd: string;
  totalInAssetValue?: string;
  pendingDepositsValueUsd: string;
  pendingDepositsValue?: string;
  pendingDepositsCount?: number;
  acceptedDepositsValueUsd?: string;
  acceptedDepositsValue?: string;
  acceptedDepositsCount?: number;
  growth24h: number | null;
  pendingGrowth24h: number | null;
}

export interface AssetsStatsResponse {
  assets: AssetStats[];
  cacheTimestamp: string;
}

// ── Yield portfolio feeds (ppUSDC) ───────────────────────────
//
// Mirrors asp-v2 PR #92's per-asset statistics endpoint
// (GET /:chainId/public/asset-statistics, header X-Asset: <token address>).
// Same TimeBasedStats windows as the global payload but SCOPED TO ONE ASSET —
// the only correct source for a pool page's median/transfers rows (the global
// aggregate spans every pool; review P1, codex+kimi 2026-07-28). 404 on the
// deployed API today; consumers fail closed.
export interface AssetStatistics {
  asset: string;
  chainId: string;
  tokenSymbol: string;
  tokenAddress: string;
  allTime: TimeBasedStats;
  last24h: TimeBasedStats;
}

export interface AssetStatisticsResponse {
  asset: AssetStatistics;
  cacheTimestamp: string;
}

// Mirrors asp-v2 PR #90 (issue #89), branch feat/yield-portfolio-data:
//   apps/api-gateway/src/controllers/public.controller.ts  (routes, params)
//   apps/api-gateway/src/services/public.service.ts        (response shapes)
//   apps/api-gateway/src/utils/yield-apy.util.ts           (APY derivation)
// All three feeds are CONFIG-GATED DORMANT server-side: they 404 until the
// chain's pool_configuration carries privacy_pool_router / pp_yield_token, so
// every consumer must treat 404 as "unavailable", never as an error
// (services/yield-feeds.ts + hooks/use-yield-feeds.ts do exactly that).
//
// Nullability is copied from the server verbatim — a column the indexer could
// not fill stays null rather than being coerced to 0.

/**
 * One yield deposit fact: PPRouter.Deposited correlated with the same-tx
 * PoolVault.Deposited, keyed by the output commitment. Raw on-chain values, so
 * clients apply their own fee/basis policy and match their own commitments
 * locally (the feed is caller-independent — no label/address filters exist).
 */
export interface YieldDepositFact {
  /** yield_deposit_event.id — the cursor value (decimal string, bigserial). */
  id: string;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  blockTimestamp: string;
  outputCommitment: string;
  /** Underlying (e.g. USDC) paid in, raw units. */
  grossUnderlying: string | null;
  /** ppUSDC shares credited to the note, raw units. */
  noteShares: string | null;
  /** Total ppUSDC shares minted by the deposit, raw units. */
  totalSharesMinted: string | null;
  /** Server-computed totalSharesMinted − noteShares (null when either is null). */
  vettingFeeShares: string | null;
  /**
   * The share token minted (lowercased). One chain can carry several shares.
   * Required, as in the SDK's YieldDepositFactRowSchema and in every row
   * api-v2 serves (mainnet + BSC, 2026-09-24). The payload is not validated at
   * runtime, so a row without it still fails closed: toYieldDepositFacts
   * (services/yield-earned.ts) then drops the whole feed, and earned shows "—".
   */
  asset: string;
}

/**
 * GET /:chainId/public/yield-deposits?sinceId=<lastSyncedId>
 *
 * PAGINATED since asp-v2@5f6b522 (PR #90 review fixes): each response holds at
 * most YIELD_FEED_PAGE_SIZE rows (services/yield-feeds.ts) and `lastSyncedId`
 * is the id of the LAST ROW RETURNED — not the feed head. Clients page by
 * feeding it back as `sinceId` until a short (or empty) page signals caught-up
 * (drainYieldFeedPages does this).
 */
export interface YieldDepositsResponse {
  deposits: YieldDepositFact[];
  /** Last row returned (page cursor); on an empty page, the caller's own cursor. */
  lastSyncedId: string;
}

/** One ppUSDC assets-per-share observation. */
export interface PpUsdcRateSnapshot {
  /** ppusdc_rate_snapshot.id — the cursor value (decimal string, bigserial). */
  id: string;
  /** PPYieldToken.exchangeRate: assets per share, raw asset units. */
  exchangeRate: string;
  shareDecimals: number | null;
  assetDecimals: number | null;
  /** Protocol yield fee at this observation, basis points. */
  feeBps: number | null;
  observationBlock: string;
  observationTimestamp: string;
}

/**
 * GET /:chainId/public/ppusdc-rate-history?sinceId=<lastSyncedId>
 *
 * PAGINATED since asp-v2@5f6b522 — same protocol as YieldDepositsResponse:
 * ≤ YIELD_FEED_PAGE_SIZE snapshots per response, `lastSyncedId` = last row
 * returned, page until a short page.
 */
export interface PpUsdcRateHistoryResponse {
  chainId: string;
  /** Lowercased ppUSDC (PPYieldToken) address the snapshots were read from. */
  ppUsdcAddress: string;
  /** Documented capture cadence of the snapshot job, seconds. */
  intervalSeconds: number;
  snapshots: PpUsdcRateSnapshot[];
  /** Last row returned (page cursor); on an empty page, the caller's own cursor. */
  lastSyncedId: string;
}

/** Trailing window accepted by the vault-metrics endpoint's `window` param. */
export type PpUsdcApyWindow = '7d' | '30d' | '90d';

/**
 * GET /:chainId/public/ppusdc-vault-metrics?window=7d|30d|90d
 *
 * `netRealizedApy` is what a ppUSDC holder actually earned (annualized
 * exchangeRate growth, net of the protocol yield fee). `grossAaveApy` is that
 * same yield BEFORE the fee: gross = net / (1 − feeBps). The two are NOT
 * interchangeable — never substitute one for the other in a display.
 */
export interface PpUsdcVaultMetricsResponse {
  chainId: string;
  ppUsdcAddress: string;
  /** null when the chain is configured but no snapshot has landed yet. */
  latest: {
    exchangeRate: string;
    shareDecimals: number | null;
    assetDecimals: number | null;
    observationBlock: string;
    observationTimestamp: string;
  } | null;
  netRealizedApy: {
    /** null when the window holds no usable pair of observations. */
    apyBps: number | null;
    windowDays: number;
    methodology: string;
    fromBlock: string | null;
    fromTimestamp: string | null;
    toBlock: string | null;
    toTimestamp: string | null;
  };
  grossAaveApy: {
    apyBps: number | null;
    feeBps: number | null;
    /** Provenance, e.g. 'derived' (server derives it from net + feeBps). */
    source: string;
    methodology: string;
  };
}

/**
 * The ASP's points DTOs, as the SDK types them: one definition for both. Epoch
 * and block numbers, roots, rate leaves, rateScale, cohortEdges and unix-second
 * timestamps (snapshotTime, createdAt, correctedAt) are 32-byte big-endian `0x`
 * Hex strings. cliffSeconds, the leaf counts and cohortWeights stay numbers.
 */
export type { PointsEpoch, RateLeavesResponseDto as PointsRateLeavesResponse } from '@privacy-pools-v2/sdk';

export interface PointsEpochsResponse {
  epochs: import('@privacy-pools-v2/sdk').PointsEpoch[];
  /** Opaque keyset cursor (decimal row id), not Hex. */
  lastSyncedId: string;
}
