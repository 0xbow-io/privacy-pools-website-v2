import { normalizeEntrypoints } from '@/services/entrypoints-normalize';
import type {
  LivenessResponse,
  ASPStatusResponse,
  LeafCountsResponse,
  GlobalEventsResponse,
  GlobalEventsParams,
  GlobalStatistics,
  TokenPricesResponse,
  EntrypointsResponse,
  RawEntrypointsResponse,
  NonceResponse,
  ReportAddressRequest,
  ReportAddressResponse,
  WalletScreeningCheckRequest,
  WalletScreeningCheckResponse,
  AssociationSetRootResponse,
  AssociationSetLeavesResponse,
  LabelStatusResponse,
  ASPPublicKeyResponse,
  EventSnapshotResponse,
  AssetsStatsResponse,
  YieldDepositsResponse,
  PpUsdcRateHistoryResponse,
  PpUsdcVaultMetricsResponse,
  PpUsdcApyWindow,
  AssetStatisticsResponse,
  PointsEpochsResponse,
  PointsRateLeavesResponse,
} from '@/services/api-types';
import { ASP_URL, LEGACY_CONFIG } from '@/config/env';
import { EgressRefusedError, type EgressIntent } from '@/services/egress-policy';
import { policedFetch } from '@/services/egress-fetch';
import { AspBackoffError } from '@/services/asp-backoff';

class APIError extends Error {
  constructor(
    public statusCode: number,
    public statusText: string,
    public url: string,
  ) {
    super(`API request failed: ${statusCode} ${statusText} (${url})`);
    this.name = 'APIError';
  }
}

/** The server's own one-line reason from an error body, when it gives one. */
async function readErrorReason(response: Response): Promise<string | null> {
  try {
    const body = await response.text();
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message.slice(0, 120) : null;
  } catch {
    return null;
  }
}

// TTL for the entrypoints feed. resolveConfiguredEntrypoint() calls
// getEntrypoints() on every invocation (including per ASP fast-path scan, the
// label-decision feed and the association-set probe), and the feed changes only
// when a pool is deployed. The public-feed grid refetches it every five minutes
// with `{ refresh: true }`, and the TTL is a minute LONGER than that period, so
// every other caller reads the copy the grid last refreshed. With the TTL equal
// to the period, a grid tick could land a few ms before the copy expired, skip
// the refetch, and leave the request to whichever caller came next (a discovery
// pass, a proof, a form): e2e run 38272204833 flagged that GET inside "open the
// Withdraw tab and type an amount".
export const ENTRYPOINTS_GRID_MS = 5 * 60_000;
export const ENTRYPOINTS_TTL_MS = ENTRYPOINTS_GRID_MS + 60_000;

// How long a FAILED entrypoints fetch is remembered when there is no earlier
// answer to fall back on. It used to be forgotten at once so "the next caller
// could retry", and during the 2026-10-01 throttle that turned ~1 request a
// minute into 13 to 38: every caller retried, each retry was throttled too.
const ENTRYPOINTS_FAILURE_TTL_MS = 15_000;

// How old the last good entrypoints answer may be and still stand in for a
// failed refresh: three normal refreshes. Older, the failure propagates.
const ENTRYPOINTS_LAST_GOOD_MAX_AGE_MS = 3 * ENTRYPOINTS_TTL_MS;

/**
 * The entrypoint as the ASP is sent it: lowercase, always. The ASP matches it
 * case-insensitively (checked against prod 2026-10-01), and the app was sending
 * two spellings of the same address (lowercase from the snapshot cache key,
 * checksummed from the feed), so one spelling on the wire means one cache key
 * everywhere and one request shape for every client.
 */
function aspEntrypoint(entrypoint: string | undefined): string | undefined {
  return entrypoint ? entrypoint.toLowerCase() : entrypoint;
}

// Ceiling on a single ASP request, including reading its body. Generous enough
// for the largest feed this client pulls on a slow connection, and short enough
// that a stalled connection surfaces as an error the flow can report.
const ASP_REQUEST_TIMEOUT_MS = 45_000;

class APIClient {
  constructor(private baseUrl: string = ASP_URL) {}

  private entrypointsCache?: { at: number; ttl: number; promise: Promise<EntrypointsResponse> };

  /** The last answer the feed gave, served when a refresh fails. */
  private entrypointsLastGood?: { at: number; response: EntrypointsResponse };

  /**
   * The ASP chokepoint.
   *
   * Every call this client makes is checked against the route allowlist in
   * services/egress-policy.ts before it leaves, and an undeclared route, query
   * key or header is REFUSED rather than sent. Adding an ASP call therefore
   * means declaring it there, which is the review step the two 2026-09-10
   * leaks never got.
   *
   * `intent` is how a caller says "this lookup names one user, deliberately,
   * because the user asked for it". It is passed at the call site on purpose:
   * a targeted read must be written down where someone chose it, not inherited
   * from a shared helper.
   */
  private async request<T>(
    path: string,
    init?: RequestInit,
    intent?: EgressIntent,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    let response: Response;
    // Bound every ASP request. A connection that goes idle (a tab sitting on a
    // form for a couple of minutes) can be dropped by something in the middle
    // without either end being told, and the next request on it stalls instead
    // of failing — the promise simply never settles. `createSession` awaits one
    // of these (`/entrypoints`) with no ceiling of its own, so an unbounded
    // request here becomes a transfer stuck on "Syncing latest pool state..."
    // forever. The relayer client already does this (services/egress-http-client).
    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), ASP_REQUEST_TIMEOUT_MS);
    if (init?.signal) {
      if (init.signal.aborted) abort.abort();
      else init.signal.addEventListener('abort', () => abort.abort(), { once: true });
    }
    try {
      try {
        response = await policedFetch('asp', this.baseUrl, url, {
          ...init,
          headers,
          signal: abort.signal,
        }, intent);
      } catch (err) {
        if (err instanceof EgressRefusedError) throw err;
        // Nothing was sent: the ASP throttled an earlier request and the window
        // is still open. Same shape as the ASP's own answer, so the "the ASP is
        // rate limiting" handling (isRateLimitError) applies unchanged.
        if (err instanceof AspBackoffError) {
          throw new APIError(429, `Rate limit exceeded, retrying in ${Math.ceil(err.retryInMs / 1000)}s`, url);
        }
        if (abort.signal.aborted && !init?.signal?.aborted) {
          throw new APIError(0, 'The request took too long. Check your connection and try again.', url);
        }
        throw new APIError(0, err instanceof Error ? err.message : 'Network request failed', url);
      }

      if (!response.ok) {
        // Keep the server's reason: a 403 is "Rate limit exceeded" on the ASP,
        // and without it the UI could only say the balance was unavailable.
        const reason = await readErrorReason(response);
        // HTTP/2 has no reason phrase, so statusText can be empty.
        throw new APIError(response.status, [response.statusText, reason].filter(Boolean).join(': '), url);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new APIError(response.status, 'Invalid JSON response', url);
      }

      if (data === null || data === undefined) {
        throw new APIError(response.status, 'Empty response body', url);
      }

      if (typeof data !== 'object') {
        throw new APIError(response.status, 'Response is not a JSON object', url);
      }

      return data as T;
    } finally {
      // The body read rides the same signal, so the timer only stops once the
      // response is fully in hand.
      clearTimeout(abortTimer);
    }
  }

  private buildQuery(params: Record<string, string | number | boolean | undefined>): string {
    const entries = Object.entries(params).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    );
    if (entries.length === 0) return '';
    const searchParams = new URLSearchParams(
      entries.map(([k, v]) => [k, String(v)]),
    );
    return `?${searchParams.toString()}`;
  }

  // ── Health ───────────────────────────────────────────────────

  getHealth(chainId: number): Promise<LivenessResponse> {
    return this.request<LivenessResponse>(`/${chainId}/health/liveness`);
  }

  getASPHealth(chainId: number): Promise<ASPStatusResponse> {
    return this.request<ASPStatusResponse>(`/${chainId}/health/asp`);
  }

  getLeafHealth(chainId: number): Promise<LeafCountsResponse> {
    return this.request<LeafCountsResponse>(`/${chainId}/health/leaves`);
  }

  // ── Global public ────────────────────────────────────────────

  /**
   * The public activity feed. It takes no account filter: asking for one
   * account's rows tells the ASP which rows are that account's
   * (services/egress-policy.ts refuses the parameter).
   */
  getGlobalEvents(params: GlobalEventsParams = {}): Promise<GlobalEventsResponse> {
    const query = this.buildQuery({
      page: params.page,
      perPage: params.perPage,
      action: params.action,
      status: params.status,
      chainId: params.chainId,
      token: params.token,
      includeRagequit: params.includeRagequit,
      entrypoint: params.entrypoint,
    });
    return this.request<GlobalEventsResponse>(`/global/public/events${query}`);
  }

  getGlobalStatistics(): Promise<GlobalStatistics> {
    return this.request<GlobalStatistics>('/global/public/statistics');
  }

  /**
   * Per-asset statistics (asp-v2 PR #92) — the pool-scoped counterpart of
   * getGlobalStatistics, keyed by token ADDRESS via the X-Asset header.
   * 404s on the deployed API until the PR ships; callers fold that to null.
   */
  getAssetStatistics(chainId: number | string, tokenAddress: string): Promise<AssetStatisticsResponse> {
    return this.request<AssetStatisticsResponse>(`/${chainId}/public/asset-statistics`, {
      // Lowercased — the ASP rejects
      // checksummed addresses with 404 (kimi round 1, latent until asp-v2 #92).
      headers: { 'X-Asset': tokenAddress.toLowerCase() },
    });
  }

  getTokenPrices(chainId?: string): Promise<TokenPricesResponse> {
    const query = chainId !== undefined ? this.buildQuery({ chainId }) : '';
    return this.request<TokenPricesResponse>(`/global/public/token-prices${query}`);
  }

  // Per-asset stats (includes growth24h per asset). `chainId` can be 'all'.
  getAssetsStats(chainId: string | number): Promise<AssetsStatsResponse> {
    return this.request<AssetsStatsResponse>(`/${chainId}/public/assets-stats`);
  }

  // NOTE: there is deliberately no wrapper for
  // /public/deposits-larger-than. It takes the amount the user is about to
  // withdraw, which is the same integer that appears in the withdrawal on
  // chain shortly afterwards, so calling it links this client to that
  // withdrawal. Count locally against a caller-independent feed instead
  // (asp-v2#127, /public/deposit-amounts).

  // ── Yield portfolio feeds (ppUSDC) ───────────────────────────
  //
  // asp-v2 PR #90 (issue #89). Caller-independent public feeds: the server
  // never learns which deposit/note a caller cares about, so clients download
  // and join locally. All three 404 while the chain has no yield pool
  // configured — callers MUST route that through
  // loadYieldFeed()/isYieldFeedUnavailableError() (services/yield-feeds.ts)
  // and render "unavailable", not an error.
  //
  // Cursor + pagination (asp-v2@5f6b522): the deposit and rate-history feeds
  // return at most one page per response, and `lastSyncedId` is the LAST ROW
  // RETURNED — not the feed head. These methods fetch ONE page; callers must
  // drain to catch up (services/yield-feeds.ts drainYieldFeedPages, used by
  // hooks/use-yield-feeds.ts). Passing the previous `lastSyncedId` as
  // `sinceId` resumes from that cursor.

  getYieldDeposits(chainId: string | number, sinceId?: string): Promise<YieldDepositsResponse> {
    const query = this.buildQuery({ sinceId });
    return this.request<YieldDepositsResponse>(`/${chainId}/public/yield-deposits${query}`);
  }

  /**
   * `asset` selects one share on a chain that has several (mainnet: ppUSDC,
   * ppUSDT, ppETH). It is a share address from build config, never anything of
   * the user's. Omitted, the server answers for its default share.
   */
  getPpUsdcRateHistory(chainId: string | number, sinceId?: string, asset?: string): Promise<PpUsdcRateHistoryResponse> {
    const query = this.buildQuery({ asset: asset?.toLowerCase(), sinceId });
    return this.request<PpUsdcRateHistoryResponse>(`/${chainId}/public/ppusdc-rate-history${query}`);
  }

  /**
   * Latest assets-per-share plus the NET ppUSDC realized APY and the DERIVED
   * GROSS Aave supply APY (gross = net / (1 − feeBps)) — distinct figures, see
   * PpUsdcVaultMetricsResponse. `window` defaults server-side (30d).
   */
  getPpUsdcVaultMetrics(
    chainId: string | number,
    window?: PpUsdcApyWindow,
  ): Promise<PpUsdcVaultMetricsResponse> {
    const query = this.buildQuery({ window });
    return this.request<PpUsdcVaultMetricsResponse>(`/${chainId}/public/ppusdc-vault-metrics${query}`);
  }

  /**
   * `refresh` is for the public-feed grid only: it refetches on the grid's
   * clock whatever the cache holds. Every other caller reads the cache.
   */
  getEntrypoints(opts?: { refresh?: boolean }): Promise<EntrypointsResponse> {
    const now = Date.now();
    if (!opts?.refresh && this.entrypointsCache && now - this.entrypointsCache.at < this.entrypointsCache.ttl) {
      return this.entrypointsCache.promise;
    }
    const promise: Promise<EntrypointsResponse> = this.request<RawEntrypointsResponse>('/global/public/entrypoints')
      .then(normalizeEntrypoints)
      .then((response) => {
        this.entrypointsLastGood = { at: Date.now(), response };
        return response;
      })
      .catch((err) => {
        // A failed refresh is remembered, not retried by every caller. With an
        // earlier answer in hand, keep serving it: the feed only changes when
        // a pool is deployed, and an unresolvable entrypoint used to send the
        // snapshot and decision reads out unscoped, under a second cache key.
        // Only a recent answer from this same ASP (the cache is per client,
        // so per base URL): routing older than this could point pool-scoped
        // reads at a retired entrypoint after a redeploy, so the failure
        // propagates instead.
        const lastGood = this.entrypointsLastGood
          && Date.now() - this.entrypointsLastGood.at < ENTRYPOINTS_LAST_GOOD_MAX_AGE_MS
          ? this.entrypointsLastGood.response
          : undefined;
        if (this.entrypointsCache?.promise === promise) {
          const remembered = lastGood ? Promise.resolve(lastGood) : Promise.reject(err);
          // The rejected placeholder must not surface as unhandled.
          remembered.catch(() => {});
          this.entrypointsCache = { at: Date.now(), ttl: ENTRYPOINTS_FAILURE_TTL_MS, promise: remembered };
        }
        if (lastGood) return lastGood;
        throw err;
      });
    this.entrypointsCache = { at: now, ttl: ENTRYPOINTS_TTL_MS, promise };
    return promise;
  }

  // The self-report flow is the one place the user deliberately tells the ASP
  // their own address, so the intent is inherent to the method rather than
  // something a caller chooses.
  getReportAddressNonce(address: string): Promise<NonceResponse> {
    const query = this.buildQuery({ address });
    return this.request<NonceResponse>(
      `/global/public/report-address/nonce${query}`,
      undefined,
      'user-report-address',
    );
  }

  reportAddress(body: ReportAddressRequest): Promise<ReportAddressResponse> {
    return this.request<ReportAddressResponse>(
      '/global/public/report-address',
      { method: 'POST', body: JSON.stringify(body) },
      'user-report-address',
    );
  }

  // The wallet screening check: the user asks whether 0xbow services refuse
  // their own connected wallet. Like the self-report, naming the address is
  // the point of the request, and the SIWE signature means only the wallet
  // itself can be checked.
  getScreeningNonce(address: string): Promise<NonceResponse> {
    const query = this.buildQuery({ address });
    return this.request<NonceResponse>(
      `/global/public/screening/nonce${query}`,
      undefined,
      'user-wallet-screening',
    );
  }

  checkWalletScreening(body: WalletScreeningCheckRequest): Promise<WalletScreeningCheckResponse> {
    return this.request<WalletScreeningCheckResponse>(
      '/global/public/screening/check',
      { method: 'POST', body: JSON.stringify(body) },
      'user-wallet-screening',
    );
  }

  // ── ASP data ─────────────────────────────────────────────────

  getAssociationSetRoot(chainId: string, entrypoint?: string): Promise<AssociationSetRootResponse> {
    // No legacy override: the ASP does not expose /association-set/{id}/root,
    // and the SDK builds the witness root locally from leaves
    // (see WitnessPreparationService.associationSetRoot ← aspProofs[0].root).
    // In legacy mode this returns the current/new ASP root, which is harmless
    // because it is not used in the spend public input.
    // entrypoint disambiguates which pool on a multi-pool chain.
    const query = this.buildQuery({ chainId, entrypoint: aspEntrypoint(entrypoint) });
    return this.request<AssociationSetRootResponse>(`/association-set/root${query}`);
  }

  getAssociationSetLeaves(chainId: string, entrypoint?: string): Promise<AssociationSetLeavesResponse> {
    if (LEGACY_CONFIG) {
      return this.request<AssociationSetLeavesResponse>(
        `/association-set/${LEGACY_CONFIG.mtId}/leaves`,
      );
    }
    // entrypoint disambiguates which pool on a multi-pool chain.
    const query = this.buildQuery({ chainId, entrypoint: aspEntrypoint(entrypoint) });
    return this.request<AssociationSetLeavesResponse>(`/association-set/leaves${query}`);
  }

  /**
   * ONE label's decision, by name.
   *
   * This is the per-note read the whole privacy exercise is about, so the
   * caller must say why it is allowed to happen. There is no default: a sync
   * path that forgets the argument is refused, which is the correct failure
   * direction.
   */
  getLabelStatus(
    labelHash: string,
    chainId: string | undefined,
    entrypoint: string | undefined,
    intent: EgressIntent,
  ): Promise<LabelStatusResponse> {
    // chainId + entrypoint disambiguate pools; without them the ASP returns the
    // first match (label_hash carries no pool scope on-chain).
    const query = this.buildQuery({ chainId, entrypoint: aspEntrypoint(entrypoint) });
    return this.request<LabelStatusResponse>(
      `/labels/${encodeURIComponent(labelHash)}/status${query}`,
      undefined,
      intent,
    );
  }

  /** Pool-wide declined decisions; combine with POI decisions and published leaves locally. */
  getRejectedLabels(chainId?: string, entrypoint?: string): Promise<{ labels: string[] }> {
    const query = this.buildQuery({ chainId, entrypoint: aspEntrypoint(entrypoint) });
    return this.request<{ labels: string[] }>(`/labels/rejected${query}`);
  }

  getPoiRequiredLabels(chainId?: string, entrypoint?: string): Promise<{ labels: string[] }> {
    const query = this.buildQuery({ chainId, entrypoint: aspEntrypoint(entrypoint) });
    return this.request<{ labels: string[] }>(`/labels/poi-required${query}`);
  }

  getASPPublicKey(): Promise<ASPPublicKeyResponse> {
    return this.request<ASPPublicKeyResponse>('/public-key');
  }

  /**
   * 196-byte change probe for the event snapshot: snapshotBlockNumber plus the
   * per-kind counts. Used to decide whether the ~900KB payload needs refetching
   * at all (services/snapshot-source.ts).
   *
   * Caveat that matters: this reflects the IPFS snapshot pipeline, not the DB
   * payload head, so it can trail the payload by a block or two. That is safe as
   * a cache gate because a cached payload carries its own snapshotBlockNumber
   * and the note index scans the chain above it; see snapshot-cache.ts.
   */
  getEventSnapshotLatest(
    chainId: number,
    entrypoint?: string,
  ): Promise<{
    snapshotBlockNumber?: string | number;
    depositCount?: number;
    transactCount?: number;
    ragequitCount?: number;
  }> {
    const query = this.buildQuery({ entrypoint: aspEntrypoint(entrypoint) });
    return this.request(`/${chainId}/public/event-snapshot/latest${query}`);
  }

  /** One page of a pool's published points epochs; page forward with the returned `lastSyncedId`. */
  getPointsEpochs(chainId: number, entrypoint?: string, sinceId?: string): Promise<PointsEpochsResponse> {
    const query = this.buildQuery({ sinceId, entrypoint: aspEntrypoint(entrypoint) });
    return this.request<PointsEpochsResponse>(`/${chainId}/public/points/epochs${query}`);
  }

  /**
   * An epoch's whole rate table, never a single asset's leaf. The response is
   * Hex throughout; the path segment stays a decimal epoch number.
   */
  getPointsRateLeaves(chainId: number, epochNumber: bigint, entrypoint?: string): Promise<PointsRateLeavesResponse> {
    if (epochNumber < 0n) throw new Error('points: epoch number must be non-negative');
    const query = this.buildQuery({ entrypoint: aspEntrypoint(entrypoint) });
    return this.request<PointsRateLeavesResponse>(`/${chainId}/public/points/epochs/${epochNumber.toString(10)}/rate-leaves${query}`);
  }

  getEventSnapshot(chainId: number, entrypoint?: string): Promise<EventSnapshotResponse> {
    // entrypoint pool-scopes the snapshot on multi-pool chains (dropped when
    // undefined, so single-pool calls are unchanged).
    const query = this.buildQuery({ entrypoint: aspEntrypoint(entrypoint) });
    return this.request<EventSnapshotResponse>(`/${chainId}/public/event-snapshot/payload${query}`);
  }

  /**
   * Filtered chain-state payload from the v2 ASP. Backs the SDK fast
   * path used by ChunkedRPCInteractor — passing `include=leaves` (or
   * `keystoreLeaves`) avoids the rest of the snapshot bloat, and
   * `sinceBlock` enables incremental sync. Returns the same
   * EventSnapshotResponse shape as the unfiltered call; consumers pull
   * the slice they asked for.
   *
   * RPC is the fallback when this 404s or errors.
   *
   * One array per on-chain event type: `transacts` is the WHOLE Transacted
   * stream. The ASP briefly split zero-fee (self-relayed) transfers out into a
   * `privateTransfers` section keyed on `withdrawn_value != 0`, which silently
   * truncated `transacts` for every consumer — spend detection, transfer
   * classification, the claim path's on-chain lookup. That split is gone; don't
   * reintroduce a per-kind section here. Transfer-vs-withdrawal can only be
   * decided client-side anyway, since it needs the sender's viewing key.
   */
  getEventSnapshotPayload(
    chainId: number,
    include?: ReadonlyArray<
      'deposits' | 'transacts' | 'ragequits' | 'leaves' | 'keystoreLeaves' | 'notes'
    >,
    sinceBlock?: bigint,
    entrypoint?: string,
  ): Promise<EventSnapshotResponse> {
    const params = new URLSearchParams();
    if (include && include.length > 0) params.set('include', include.join(','));
    if (sinceBlock != null) params.set('sinceBlock', String(sinceBlock));
    // entrypoint pool-scopes the snapshot (each pool has its own state tree).
    if (entrypoint) params.set('entrypoint', entrypoint.toLowerCase());
    const query = params.toString() ? `?${params}` : '';
    return this.request<EventSnapshotResponse>(`/${chainId}/public/event-snapshot/payload${query}`);
  }
}

export type AspLeafRow = import('@/services/api-types').SnapshotLeaf;

export { APIClient, APIError };
export default new APIClient();
