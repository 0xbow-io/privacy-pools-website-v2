import type { Hash } from '@privacy-pools-v2/sdk';
import { LEGACY_CONFIG } from '@/config/env';
import { createBulkLabelCache } from '@/services/bulk-label-cache';
import {
  feedLabelDecisions,
  readLabelDecisions,
  type LabelDecisions,
} from '@/services/label-decision-feed';
import { resolveConfiguredEntrypoint } from '@/services/pool-entrypoint';
import { feedData, publicFeeds } from '@/services/public-feed-scheduler';

export function normalizeHashString(value: string): Hash {
  // ASP currently returns association-set roots/leaves as decimal strings.
  // The SDK witness builder expects 0x-prefixed, 64-char zero-padded hex strings.
  return `0x${BigInt(value).toString(16).padStart(64, '0')}` as Hash;
}

// Share each sync burst while bounding how long approvals and revocations stay cached.
const BULK_LABELS_TTL_MS = 5_000;

// Persist only the whole pool's public leaves, never account data. The root
// selects the snapshot; each write removes older roots for the same pool.
// Rejections have their own TTL because revocation need not change that root.
const LEAF_STORE_PREFIX = 'ppv2_assoc_leaves_v1:';
const leafStore = {
  read(poolKey: string, root: string): readonly string[] | null {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
      const raw = window.localStorage.getItem(`${LEAF_STORE_PREFIX}${poolKey}:${root}`);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  },
  write(poolKey: string, root: string, list: readonly string[]): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      this.remove(poolKey);
      window.localStorage.setItem(`${LEAF_STORE_PREFIX}${poolKey}:${root}`, JSON.stringify(list));
    } catch {
      // Quota or private-mode failure: purely a cache, so carry on.
    }
  },
  remove(poolKey: string): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const keys = Object.keys(window.localStorage).filter(k => k.startsWith(`${LEAF_STORE_PREFIX}${poolKey}:`));
      keys.forEach(k => window.localStorage.removeItem(k));
    } catch { /* Storage can be unavailable in private mode. */ }
  },
};

/**
 * The ASP's X25519 key, which every deposit's ASP ciphertext is sealed to. The
 * SDK asks for it while it prepares a deposit, so fetching it then put a
 * request on the wire as the user was about to deposit. It is one global value
 * that changes only with an ASP key rotation, so the grid re-reads it slowly.
 */
export const FEED_ASP_PUBLIC_KEY = 'asp-public-key';
export const ASP_PUBLIC_KEY_INTERVAL_MS = 30 * 60_000;
/**
 * Until the first key arrives, a deposit cannot be sealed, so a failed fetch
 * (a 5xx, a dropped connection) is retried on this grid instead of waiting the
 * full interval. A throttled one waits out the ASP backoff instead (60s, then
 * 110s), since the backoff refuses these retries locally until it ends.
 */
export const ASP_PUBLIC_KEY_RETRY_MS = 15_000;

const X25519_KEY = /^0x(?!0{64}$)[0-9a-fA-F]{64}$/;

export async function fetchAspPublicKey(): Promise<string> {
  const { default: apiClient } = await import('@/services/api-client');
  const { publicKey } = await apiClient.getASPPublicKey();
  if (typeof publicKey !== 'string' || !X25519_KEY.test(publicKey)) {
    throw new Error('/public-key returned an empty or malformed key');
  }
  return publicKey;
}

/**
 * The key the grid holds, or null. Never a request while the grid owns it;
 * fetched directly only when nothing does (tests, a build without the grid).
 */
export async function heldAspPublicKey(): Promise<string | null> {
  if (!publicFeeds.registered().includes(FEED_ASP_PUBLIC_KEY)) return fetchAspPublicKey().catch(() => null);
  const held = feedData(publicFeeds.read<string>(FEED_ASP_PUBLIC_KEY));
  return typeof held === 'string' && X25519_KEY.test(held) ? held : null;
}

/**
 * Grid period of the association-set feed: an 87-byte root probe, and the
 * leaves only when the root moved. The cadence the root poll it replaces had,
 * and the label decisions'. A spend proof checks the set against the
 * registry's on-chain root, so a set the grid has not caught up with yet fails
 * that check and the next instant repairs it.
 */
export const ASSOCIATION_SET_INTERVAL_MS = 60_000;

export function feedAssociationSet(chainId: number | string): string {
  return `association-set:${chainId}`;
}

// Async chunks can evaluate this module more than once. Share one cache so
// concurrent SDK and public queries reuse the same fetch and persisted snapshot.
const LEAF_CACHE_FLAG = '__ppv2LeafCache';
export const approvedLabelCache = ((): ReturnType<typeof createBulkLabelCache> => {
  const existing = (globalThis as Record<string, unknown>)[LEAF_CACHE_FLAG];
  if (existing) return existing as ReturnType<typeof createBulkLabelCache>;
  const created = createBulkLabelCache({
    fetchRoot: async (chainId: number) => {
      const entrypoint = await resolveConfiguredEntrypoint(chainId).catch(() => undefined);
      const { default: apiClient } = await import('@/services/api-client');
      const res = await apiClient.getAssociationSetRoot(String(chainId), entrypoint);
      return res?.root !== undefined && res.root !== null ? String(res.root) : null;
    },
    mapLeaf: normalizeHashString,
    ttlMs: BULK_LABELS_TTL_MS,
    store: leafStore,
    onDecision: (line) => { try { console.log(`[perf] · ${line}`); } catch { /* ignore */ } },
    // Every read of a chain the grid refreshes is answered from what it holds:
    // the SDK reads this set during discovery and while it prepares a spend.
    owns: (chainId: number) => publicFeeds.registered().includes(feedAssociationSet(chainId)),
  });
  (globalThis as Record<string, unknown>)[LEAF_CACHE_FLAG] = created;
  return created;
})();

function associationSetLeafSource(chainId: number, entrypoint: string | undefined) {
  return {
    getLeaves: async () => {
      const { default: apiClient } = await import('@/services/api-client');
      const response = await apiClient.getAssociationSetLeaves(String(chainId), entrypoint);
      return response.leaves;
    },
  };
}

/** Public leaves in served order, through the shared pool/root cache. */
export async function getPoolAssociationSetLeaves(chainId: number): Promise<readonly string[]> {
  const entrypoint = await resolveConfiguredEntrypoint(chainId).catch(() => undefined);
  const poolKey = `${chainId}:${(entrypoint ?? '').toLowerCase()}`;
  // The source is only consulted on a miss, and the cache is keyed by pool, so
  // a fresh adapter object per call is fine.
  return approvedLabelCache.leaves(associationSetLeafSource(chainId, entrypoint), chainId, poolKey);
}

/**
 * The feed grid's refresh of one chain's association set, and the only path
 * that asks the ASP for it once the grid runs. Resolves to the root it holds.
 */
export async function refreshPoolAssociationSet(chainId: number): Promise<string | null> {
  const entrypoint = await resolveConfiguredEntrypoint(chainId).catch(() => undefined);
  const poolKey = `${chainId}:${(entrypoint ?? '').toLowerCase()}`;
  const { root } = await approvedLabelCache.refresh(associationSetLeafSource(chainId, entrypoint), chainId, poolKey);
  return root;
}

export async function bulkApprovedLabels(
  provider: { getLeaves: () => Promise<Hash[]> },
  chainId: number,
): Promise<Set<string>> {
  // Pool-scoped key, matching the decision cache below: the provider instance is
  // rebuilt on every session build, so keying the cache on it refetched 525KB
  // each time.
  const entrypoint = await resolveConfiguredEntrypoint(chainId).catch(() => undefined);
  const poolKey = `${chainId}:${(entrypoint ?? '').toLowerCase()}`;
  return approvedLabelCache.approved(provider, chainId, poolKey);
}

/**
 * The ONLY thing in the app that requests /labels/*. It is called by the public
 * feed scheduler on a fixed grid and by nothing else — see
 * services/label-decision-feed.ts for why, and services/public-feeds.ts for the
 * registration. Both routes are fetched together so a half-snapshot ("rejected
 * landed, poi-required did not") cannot exist.
 */
export async function fetchPoolLabelDecisions(chainId: number): Promise<LabelDecisions> {
  if (LEGACY_CONFIG) return { rejected: [], poiRequired: [], entrypoint: null };
  const entrypoint = await resolveConfiguredEntrypoint(chainId);
  // No pool scope means no request: a chain-wide /labels call would be a
  // different question than the one we are allowed to ask.
  if (!entrypoint) throw new Error('ASP label decisions unavailable');
  const { default: apiClient } = await import('@/services/api-client');
  const [rejected, poiRequired] = await Promise.all([
    apiClient.getRejectedLabels(String(chainId), entrypoint),
    apiClient.getPoiRequiredLabels(String(chainId), entrypoint),
  ]);
  return {
    rejected: rejected.labels.map(normalizeHashString),
    poiRequired: poiRequired.labels.map(normalizeHashString),
    entrypoint,
  };
}

/**
 * PURE READ of the scheduled snapshot. Synchronous on purpose: the signature is
 * the proof that asking this question cannot put a request on the wire, which
 * is what regressed when a `forceFresh` fetch was added inside witness
 * construction.
 *
 * Throws rather than degrading to "nothing is blocked" — an unknown decision
 * set must never read as permission.
 */
export function getPoolLabelDecisions(chainId: number): {
  rejected: ReadonlySet<string>;
  poiRequired: ReadonlySet<string>;
} {
  if (LEGACY_CONFIG) return { rejected: new Set<string>(), poiRequired: new Set<string>() };
  const read = readLabelDecisions(
    publicFeeds.read<LabelDecisions>(feedLabelDecisions(chainId)),
    Date.now(),
  );
  if (!read.ok) throw new Error('ASP label decisions unavailable');
  return {
    rejected: new Set(read.decisions.rejected),
    poiRequired: new Set(read.decisions.poiRequired),
  };
}

/** Decisions that veto spending even while a label remains in the tree. */
export function getPoolBlockedLabelHashes(chainId: number): ReadonlySet<string> {
  if (LEGACY_CONFIG) return new Set<string>();
  const { rejected, poiRequired } = getPoolLabelDecisions(chainId);
  return new Set([...rejected, ...poiRequired]);
}
