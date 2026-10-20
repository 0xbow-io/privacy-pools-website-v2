/**
 * Block timestamps the ASP volunteered, kept apart from chain-derived ones.
 *
 * PURE module (no react-native/DOM imports) so bun tests can exercise it.
 *
 * WHY THIS EXISTS. The note-events feed is a whole-pool block-range payload we
 * already fetch, and since asp-v2#117 every row carries `blockTimestamp`. Before
 * that, a client holding those logs still had to learn each block's timestamp
 * from the chain, one `eth_getBlockByNumber` per event-bearing block: measured
 * 2026-08-27, ~450 per cold balance load with ~72 shed by a rate-limited RPC.
 * Harvesting the timestamps the feed already carries removes that entire class
 * of request.
 *
 * WHY IT IS A SEPARATE STORE, NOT MERGED INTO THE INDEX'S CACHE. Provenance is
 * the whole point of services/onchain-note-index.ts: a timestamp read from the
 * chain is trusted directly, while an ASP-sourced one must prove itself against
 * the on-chain leaf set (Poseidon(TAG, commitment, timestamp) must be a real
 * leaf). If these values were written into the index's own block-timestamp map
 * they would be indistinguishable from chain reads, and a wrong or malicious
 * value would be trusted - failing only inside a zk circuit, much later. So
 * they live here, are read as HINTS, and every commitment dated from a hint
 * stays outside the chain-verified set.
 *
 * PRIVACY. Recording is a side effect of a bulk fetch that names no note. This
 * module never issues a request and never keys anything by commitment.
 */

/** Chain id -> (decimal block number string -> hex unix-seconds timestamp). */
const byChain = new Map<number, Map<string, string>>();

/** Bound: pool-wide tails are small, but a long-lived tab should not grow forever. */
const MAX_PER_CHAIN = 50_000;

/** Normalise a hex-or-decimal block number to a decimal string key. */
function blockKey(block: string | bigint | number): string | null {
  try {
    return BigInt(block).toString();
  } catch {
    return null;
  }
}

/**
 * ISO 8601 / epoch seconds / epoch millis -> hex unix SECONDS, matching what
 * viem's getBlock().timestamp yields, since both feed the same leaf hash.
 * Returns null for anything unparseable: an absent timestamp is retried from
 * the chain, a fabricated one would silently produce a leaf that does not exist.
 */
export function toHexSeconds(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'bigint') return value >= 0n ? `0x${value.toString(16)}` : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    const secs = value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
    return `0x${secs.toString(16)}`;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return trimmed.toLowerCase();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) return null;
      const secs = n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
      return `0x${secs.toString(16)}`;
    }
    // Only a plausible ISO-8601 date is handed to Date.parse. Without this
    // gate, Date.parse is alarmingly permissive: Date.parse('-5') returns
    // 988675200000, so the string '-5' became a real-looking 2001 timestamp.
    // Fabricating a timestamp is the one thing this function must never do, so
    // anything that is not date-shaped is rejected outright.
    if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(trimmed)) return null;
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return `0x${Math.floor(ms / 1000).toString(16)}`;
  }
  return null;
}

/**
 * Record (block, timestamp) pairs harvested from a bulk ASP payload. Rows
 * without a usable timestamp are skipped rather than defaulted - an older ASP
 * deployment simply does not carry the field yet, and the chain remains the
 * fallback.
 */
export function recordAspBlockTimestamps(
  chainId: number,
  rows: ReadonlyArray<{ blockNumber?: unknown; blockTimestamp?: unknown }>,
): number {
  let recorded = 0;
  let store = byChain.get(chainId);
  for (const row of rows) {
    if (row?.blockNumber == null) continue;
    const key = blockKey(row.blockNumber as string);
    if (key === null) continue;
    const ts = toHexSeconds(row.blockTimestamp);
    if (ts === null) continue;
    if (!store) {
      store = new Map<string, string>();
      byChain.set(chainId, store);
    }
    // First writer wins: repeated payloads carry the same immutable value, and
    // never overwriting keeps one bad late row from displacing a good earlier one.
    if (!store.has(key)) {
      store.set(key, ts);
      recorded += 1;
    }
  }
  if (store && store.size > MAX_PER_CHAIN) {
    // Drop the oldest blocks; a tail scan asks for the recent end.
    const keep = Array.from(store.entries())
      .sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? 1 : -1))
      .slice(0, MAX_PER_CHAIN);
    byChain.set(chainId, new Map(keep));
  }
  return recorded;
}

/** Hex unix-seconds timestamp for a block, or null when we have no hint. */
export function getAspBlockTimestamp(chainId: number, block: string | bigint): string | null {
  const key = blockKey(block);
  if (key === null) return null;
  return byChain.get(chainId)?.get(key) ?? null;
}

/** How many hints are held for a chain (diagnostics and tests). */
export function aspBlockTimestampCount(chainId: number): number {
  return byChain.get(chainId)?.size ?? 0;
}

/** Test seam. */
export function __resetAspBlockTimestamps(): void {
  byChain.clear();
}
