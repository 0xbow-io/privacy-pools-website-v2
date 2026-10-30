/**
 * THE list of public feeds this app fetches.
 *
 * Static on purpose, and that is the whole design. A feed declared here is
 * attempted by every client that loads the app, targeting the same wall-clock
 * grid, whatever the user then does — so asking for the all-chains
 * assets-stats stops meaning "this user opened Explore", and "this client
 * went quiet for forty seconds" stops meaning "this user was signing a
 * withdrawal". The yield feeds joined them on 2026-09-21: the rate history and
 * deposit facts had exactly one trigger in the app, expanding a position's
 * yield row, so the request announced that expansion and the chain it was on.
 * Everything else still says what it always said (the activity feeds still
 * pause for transactions — see the ratchet in
 * services/__tests__/no-activity-correlated-polling.test.ts), and migrating
 * one means moving its definition here, not wrapping its useQuery.
 *
 * Adding a feed here costs every user a request they may not need. That is the
 * trade: a request set that varies per session is a fingerprint, and a request
 * set that is a build constant removes that choice from the session. Only
 * CALLER-INDEPENDENT data belongs here: the zero-argument signature does not
 * prevent a closure from capturing user state, so definitions need review.
 *
 * See services/public-feed-scheduler.ts for the timing argument in full.
 *
 * APP-ONLY MODULE. It reaches config/chains and config/tokens through the
 * price service, which a bun test cannot import (react-native). Read feed keys
 * from here in components; never import this from a test.
 */
import apiClient from '@/services/api-client';
import { publicFeeds } from '@/services/public-feed-scheduler';
import { aspBackoff, probeAsp, startAspRequests, stopAspRequests } from '@/services/egress-fetch';
import { ASP_BACKOFF_PROBE_MS } from '@/services/asp-backoff';
import type {
  AssetsStatsResponse,
  EntrypointsResponse,
  GlobalStatistics,
  PpUsdcRateHistoryResponse,
  PpUsdcVaultMetricsResponse,
  TokenPricesResponse,
  YieldDepositsResponse,
} from '@/services/api-types';
import type { YieldFeedResult } from '@/services/yield-feeds';
import {
  feedPpUsdcRateHistory,
  feedPpUsdcVaultMetrics,
  feedYieldDeposits,
  feedYieldRateHistory,
  fetchPpUsdcRateHistoryFeed,
  fetchPpUsdcVaultMetricsFeed,
  fetchYieldDepositsFeed,
  fetchYieldRateHistoryFeed,
  RATE_HISTORY_INTERVAL_MS,
  YIELD_DEPOSITS_INTERVAL_MS,
} from '@/services/yield-feed-grid';
import { getConfiguredYieldDeployments } from '@/config/yield';
import { getAllPrices, getTokenPrices } from '@/services/price-service';
import { getChainConfig, supportedEvmChainIds } from '@/config/chains';
import {
  feedLabelDecisions,
  LABEL_DECISIONS_INTERVAL_MS,
  LABEL_DECISIONS_MAX_AGE_MS,
  type LabelDecisions,
} from '@/services/label-decision-feed';
import {
  ASP_PUBLIC_KEY_INTERVAL_MS,
  ASP_PUBLIC_KEY_RETRY_MS,
  ASSOCIATION_SET_INTERVAL_MS,
  FEED_ASP_PUBLIC_KEY,
  feedAssociationSet,
  fetchAspPublicKey,
  fetchPoolLabelDecisions,
  refreshPoolAssociationSet,
} from '@/services/public-asp-cache';
import {
  EVENT_SNAPSHOT_INTERVAL_MS,
  feedEventSnapshot,
  feedPoolLeaves,
  POOL_LEAVES_INTERVAL_MS,
  refreshPoolEventSnapshot,
  refreshPoolLeaves,
} from '@/services/snapshot-source';
import { FULL_RESYNC_INTERVAL_MS, refreshViewingKeyRegistry, type SyncOutcome } from '@/services/viewing-key-cache';
import {
  NULLIFYING_KEY_HASH_INTERVAL_MS,
  NULLIFYING_KEY_HASH_RETRY_MS,
  syncNullifyingKeyHashes,
  type NullifyingKeyHashSyncOutcome,
} from '@/services/nullifying-key-hash-cache';
import { ASP_URL, LEGACY_CONFIG } from '@/config/env';
import {
  feedLifiVerifiedTokens,
  fetchLifiVerifiedTokens,
  LIFI_VERIFIED_TOKENS_INTERVAL_MS,
} from '@/services/lifi-token-list';
import { fetchGasPrice } from '@/services/gas-price';
import { POINTS_ENABLED } from '@/config/points';
import { feedPointsEpochs, fetchPointsFeed, POINTS_FEED_INTERVAL_MS, type PointsFeedValue } from '@/services/points-feed';
import { feedGasPrice, GAS_PRICE_INTERVAL_MS } from '@/services/transfer-fee-estimate';
import { WALLET_TOKEN_MAINNET_IDS } from '@/services/wallet-tokens';
import {
  ASSET_STATISTICS_INTERVAL_MS,
  feedAssetStatistics,
  fetchAssetStatisticsFeed,
  type AssetStatisticsByToken,
} from '@/services/asset-statistics-feed';
import {
  FEED_SHARE_RATE_BOOK,
  FEED_SHARE_RATES,
  SHARE_RATE_INTERVAL_MS,
  fetchShareRateBook,
  fetchShareRates,
} from '@/services/share-rate-feed';

/** One minute, the cadence the hand-rolled queries already used. */
const MINUTE = 60_000;

export const FEED_ASSETS_STATS_ALL = 'assets-stats:all';
export const FEED_GLOBAL_STATISTICS = 'global-statistics';
export const FEED_ENTRYPOINTS = 'entrypoints';
/** Keyed by chain because prices are per-chain; the chain is a build constant. */
export const feedTokenPrices = (chainId: number | string) => `token-prices:${chainId}`;
export const feedPriceMap = (chainId: number | string) => `price-map:${chainId}`;
export const feedViewingKeyRegistry = (chainId: number | string) => `viewing-key-registry:${chainId}`;
export const feedNullifyingKeyHashRegistry = (chainId: number | string) => `nullifying-key-hash-registry:${chainId}`;

let registered = false;
let unsubscribeBackoff: (() => void) | undefined;

/**
 * Declare every public feed and begin the cadence.
 *
 * Called from the app root. Repeated starts are idempotent; an effect cleanup
 * followed by a restart resumes the grid without another bootstrap attempt.
 * Replacing the scheduler module during development creates a new instance;
 * Fast Refresh module replacement is not a production traffic guarantee.
 */
export function startPublicFeeds(): void {
  if (!registered) {
    registered = true;
    // A known supported endpoint owns recovery, never a caller racing for a
    // probe slot (which leaked user intent and let 404 feeds monopolise it).
    publicFeeds.register({
      key: 'asp-backoff-probe',
      intervalMs: ASP_BACKOFF_PROBE_MS,
      fetch: () => probeAsp(ASP_URL),
    });
    // All configured shares, held or not. UI cache reads cannot schedule RPCs.
    publicFeeds.register({ key: FEED_SHARE_RATE_BOOK, intervalMs: SHARE_RATE_INTERVAL_MS, fetch: fetchShareRateBook });
    publicFeeds.register({ key: FEED_SHARE_RATES, intervalMs: SHARE_RATE_INTERVAL_MS, fetch: fetchShareRates });
    publicFeeds.register<AssetsStatsResponse>({
      key: FEED_ASSETS_STATS_ALL,
      // Explore's TVL / APY / 24h growth. The server's figures move hourly
      // (growth24h is a day-long window), so two minutes is plenty.
      intervalMs: 2 * MINUTE,
      // 'all' is a supported scope, so this is one request for every chain and
      // the same request for every user. It used to run only while the Explore
      // page was mounted, which made its presence a statement about which page
      // this client was looking at.
      fetch: () => apiClient.getAssetsStats('all'),
    });
    publicFeeds.register<GlobalStatistics>({
      key: FEED_GLOBAL_STATISTICS,
      // Landing-page totals. Nothing is decided from them; two minutes.
      intervalMs: 2 * MINUTE,
      // Protocol-wide totals with no chain breakdown and no caller scope. It
      // used to stop polling while a transaction was in flight, which told the
      // ASP exactly when this client was signing one.
      fetch: () => apiClient.getGlobalStatistics(),
    });
    // Both of these used to have NO interval at all: they refreshed on mount,
    // on window focus, and on a cache invalidation. Focus is the problem. The
    // withdrawal flow sends the user to their wallet to sign and back, and
    // coming back refetches every stale query — a burst bracketing the exact
    // signing moment. The entrypoints feed's own cache was 60s and a signing
    // round trip routinely exceeded that, so it really did reach the network.
    publicFeeds.register<EntrypointsResponse>({
      key: FEED_ENTRYPOINTS,
      // Changes only when a pool is deployed. Each tick refetches, and the
      // client's entrypoints TTL (services/api-client.ts) outlasts the period,
      // so while the grid runs no other caller fetches it.
      intervalMs: 5 * MINUTE, // ENTRYPOINTS_GRID_MS in services/api-client.ts
      fetch: () => apiClient.getEntrypoints({ refresh: true }),
    });
    // The ASP's public key, which a deposit's ASP ciphertext is sealed to.
    // Fetched as a deposit was being prepared, it announced the deposit.
    publicFeeds.register<string>({
      key: FEED_ASP_PUBLIC_KEY,
      intervalMs: ASP_PUBLIC_KEY_INTERVAL_MS,
      retryMs: ASP_PUBLIC_KEY_RETRY_MS,
      fetch: fetchAspPublicKey,
    });
    // Register a fixed scope set so chain selection never starts a new feed.
    // Raw and mapped views share the same cached, in-flight price response.
    for (const chainId of supportedEvmChainIds) {
      // The chain's gas price, from which the relayer's transfer fee is
      // estimated (services/transfer-fee-estimate.ts). One parameterless RPC
      // read per chain: the relayer is never asked, so its load does not
      // grow with the number of open tabs.
      publicFeeds.register<bigint>({
        key: feedGasPrice(chainId),
        intervalMs: GAS_PRICE_INTERVAL_MS,
        fetch: () => fetchGasPrice(chainId),
      });
      publicFeeds.register<TokenPricesResponse>({
        key: feedTokenPrices(chainId),
        intervalMs: 5 * MINUTE,
        fetch: () => getTokenPrices(String(chainId)),
      });
      publicFeeds.register<Record<string, number>>({
        key: feedPriceMap(chainId),
        intervalMs: 5 * MINUTE,
        fetch: () => getAllPrices(String(chainId)),
      });
      // The pool's event snapshot: the whole payload once at page load, a
      // delta on each instant after it (services/snapshot-source.ts). On the
      // grid because every reader used to pull it on its own clock, and some
      // of those clocks were the user's: a spend being prepared, a deposit
      // confirming, a claim being pasted. Readers only ever read the copy.
      publicFeeds.register<string>({
        key: feedEventSnapshot(chainId),
        intervalMs: EVENT_SNAPSHOT_INTERVAL_MS,
        fetch: async () => (await refreshPoolEventSnapshot(chainId)).snapshotBlockNumber,
      });
      // Per-asset statistics for every catalogued asset of the chain. The pool
      // page fetched its own asset's when it opened, which said which page this
      // client had just opened and, in the X-Asset header, which asset.
      publicFeeds.register<AssetStatisticsByToken>({
        key: feedAssetStatistics(chainId),
        intervalMs: ASSET_STATISTICS_INTERVAL_MS,
        fetch: () => fetchAssetStatisticsFeed(chainId),
      });
      // The pool's state and keystore leaves, which every spend proof is built
      // against. Fetched while the proof was being prepared, they put a
      // request on the wire at the moment of the spend; the proof now reads
      // this copy and sweeps the blocks above it over RPC. A legacy build
      // scans its old pool's leaves from RPC and needs none.
      if (!LEGACY_CONFIG) {
        publicFeeds.register<string>({
          key: feedPoolLeaves(chainId),
          intervalMs: POOL_LEAVES_INTERVAL_MS,
          fetch: async () => (await refreshPoolLeaves(chainId)).snapshotBlockNumber,
        });
      }
      // The ASP's rejected / poi-required decisions. On the grid because the
      // alternative was fetching them inside witness construction, which put
      // two requests on the wire immediately before every relayed spend. The
      // payloads measured 411 and 13 bytes on prod, so the fixed cadence is
      // cheaper than the polling it replaces.
      publicFeeds.register<LabelDecisions>({
        key: feedLabelDecisions(chainId),
        intervalMs: LABEL_DECISIONS_INTERVAL_MS,
        retryMs: 30_000,
        // Past this a spend is refused, so a tab coming back from idle (or
        // out of an ASP backoff) refreshes these at once instead of showing
        // "unavailable" until the next instant.
        maxAgeMs: LABEL_DECISIONS_MAX_AGE_MS,
        fetch: () => fetchPoolLabelDecisions(chainId),
      });
      // The association set's root, and its leaves when the root moved. Both
      // used to be pulled by whoever read them first: a 60s probe keyed to the
      // chain the user had selected, every discovery pass, and witness
      // construction, which put a root probe on the wire as a spend was being
      // proved. A legacy build reads its frozen set by id and needs none.
      if (!LEGACY_CONFIG) {
        publicFeeds.register<string | null>({
          key: feedAssociationSet(chainId),
          intervalMs: ASSOCIATION_SET_INTERVAL_MS,
          // A spend cannot be proved without the set: retry a failed first load on
          // a 30s grid (still wall-clock, nothing about the user) until it lands.
          // Was 15s: root + leaves x 7 chains = 56 requests a minute while the
          // ASP was failing, which kept a throttle from ever clearing.
          retryMs: 30_000,
          fetch: () => refreshPoolAssociationSet(chainId),
        });
      }
      // The yield feeds. Registered for EVERY supported chain, not only the
      // ones with a yield deployment configured: which chains this client asks
      // about is itself a statement, and the dormant chains answer a 404 that
      // costs a few hundred bytes. Whether a chain has yield is public build
      // config, but making the request set depend on it would still mean a
      // client's traffic changed the moment a deployment was added, and the
      // point of this list is that the set is a build constant.
      //
      // Cadence: the server snapshots the vault hourly (intervalSeconds 3600),
      // so a ten-minute grid is comfortably inside the data's own resolution.
      // The history and deposit feeds ACCUMULATE (services/yield-feed-grid.ts):
      // the first tick bootstraps, later ticks resume from the server's cursor,
      // so the 68 KB mainnet history is downloaded once and not every tick.
      publicFeeds.register<YieldFeedResult<PpUsdcRateHistoryResponse>>({
        key: feedPpUsdcRateHistory(chainId),
        intervalMs: 10 * MINUTE,
        fetch: () => fetchPpUsdcRateHistoryFeed(chainId),
      });
      // Small (737 bytes on mainnet) and the headline APY, so it refreshes on
      // the faster grid the other small feeds use.
      publicFeeds.register<YieldFeedResult<PpUsdcVaultMetricsResponse>>({
        key: feedPpUsdcVaultMetrics(chainId),
        intervalMs: 5 * MINUTE,
        fetch: () => fetchPpUsdcVaultMetricsFeed(chainId),
      });
      // The viewing-key registry's full re-pull (services/viewing-key-cache.ts
      // FULL_RESYNC_INTERVAL_MS). Used to fire from `lookupViewingKey` on a
      // recipient's first cache miss each minute, which meant the request's
      // TIMING announced the moment a user checked a recipient even though
      // the bulk payload hides the address. On the grid instead: the same
      // request, on the same schedule, whether or not anyone looked anything
      // up (review of #130). `refreshViewingKeyRegistry` is itself throttled
      // to the same interval, so an extra tick before that window elapses is
      // a cheap no-op read, not a second request.
      const chainKeystoreAddress = LEGACY_CONFIG?.keystore ?? getChainConfig(chainId)?.contracts?.keystoreAddress;
      publicFeeds.register<SyncOutcome>({
        key: feedViewingKeyRegistry(chainId),
        intervalMs: FULL_RESYNC_INTERVAL_MS,
        fetch: () => refreshViewingKeyRegistry(chainId, chainKeystoreAddress),
      });
      // The nullifying-key-hash registry (services/nullifying-key-hash-cache.ts).
      // The keystore identity check at sign-in and before a deposit reads this
      // local copy instead of asking the chain RPC about the user's own
      // account; pulled here so its timing is the grid's, not the sign-in's.
      publicFeeds.register<NullifyingKeyHashSyncOutcome>({
        key: feedNullifyingKeyHashRegistry(chainId),
        intervalMs: NULLIFYING_KEY_HASH_INTERVAL_MS,
        // A failed pull retries on the short grid so a write waiting on a
        // current registry is not left for a whole window. A 404 (feed not
        // deployed on this ASP) is not retried.
        retryMs: NULLIFYING_KEY_HASH_RETRY_MS,
        retryOnError: true,
        fetch: async () => {
          const outcome = await syncNullifyingKeyHashes(chainId, chainKeystoreAddress);
          if (!outcome.ok && outcome.reason !== 'not-deployed') throw new Error(`nullifying-key-hashes sync failed: ${outcome.reason}`);
          return outcome;
        },
      });
      // Yield earned (services/yield-earned.ts). For every chain this build
      // configures a yield deployment on: the whole deposits feed, and the
      // rate history of EVERY configured share there. The list comes from
      // build config (flags + deployment table, never the on-chain probe and
      // never the wallet), so it is the same for every client of this build.
      // Nothing reads these except by the grid's cache: the portfolio cannot
      // start, stop or re-key them.
      // Points (services/points-feed.ts): the pool's published epochs and their
      // rate tables, for every chain whatever the wallet holds. A balance is
      // computed locally from them; nothing about it is asked of the ASP.
      if (POINTS_ENABLED) {
        publicFeeds.register<YieldFeedResult<PointsFeedValue>>({
          key: feedPointsEpochs(chainId),
          intervalMs: POINTS_FEED_INTERVAL_MS,
          fetch: () => fetchPointsFeed(chainId),
        });
      }
      const yieldShares = getConfiguredYieldDeployments(chainId).map((d) => d.ppUSDC.toLowerCase());
      if (yieldShares.length > 0) {
        publicFeeds.register<YieldFeedResult<YieldDepositsResponse>>({
          key: feedYieldDeposits(chainId),
          intervalMs: YIELD_DEPOSITS_INTERVAL_MS,
          fetch: () => fetchYieldDepositsFeed(chainId),
        });
        for (const share of new Set(yieldShares)) {
          publicFeeds.register<YieldFeedResult<PpUsdcRateHistoryResponse>>({
            key: feedYieldRateHistory(chainId, share),
            intervalMs: RATE_HISTORY_INTERVAL_MS,
            fetch: () => fetchYieldRateHistoryFeed(chainId, share),
          });
        }
      }
    }
    // LiFi's verified token list, the Shield pay picker's spam signal next to
    // Alchemy's price. Fetched when the Shield tab opened, it said "this user
    // is about to deposit" to LiFi; here every client asks for every mainnet
    // this build lists wallet tokens on.
    for (const chainId of WALLET_TOKEN_MAINNET_IDS) {
      publicFeeds.register<Set<string>>({
        key: feedLifiVerifiedTokens(chainId),
        intervalMs: LIFI_VERIFIED_TOKENS_INTERVAL_MS,
        fetch: () => fetchLifiVerifiedTokens(chainId),
      });
    }
  }
  // Recovery refreshes stale decisions and missing proof inputs, all chains.
  // Healthy feeds keep their grid; user activity cannot trigger this callback.
  unsubscribeBackoff ??= aspBackoff.onWindowEnd(() => publicFeeds.refreshStale());
  startAspRequests();
  publicFeeds.start();
}

export function stopPublicFeeds(): void {
  publicFeeds.stop();
  unsubscribeBackoff?.();
  unsubscribeBackoff = undefined;
  stopAspRequests();
}
