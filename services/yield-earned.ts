/**
 * Yield earned: the pure half. Maps what ppv2 already holds onto the inputs of
 * the SDK's `PoolSessionYieldEarned.compute` (v2-monorepo#431), and its answer
 * onto what the portfolio prints.
 *
 * WHERE THE INPUTS COME FROM. Nothing here fetches, and nothing the caller
 * hands in was fetched for this:
 *   - rate history per share and the deposits feed: the public-feed grid
 *     (services/yield-feed-grid.ts, registered in services/public-feeds.ts),
 *     read from its cache;
 *   - pool events: the ASP event snapshot PoolsProvider already polls;
 *   - the live rate: the one no-argument `exchangeRate()` the SDK's compute
 *     reads itself.
 * So no request carries or is timed by a commitment, a nullifier, a label or
 * which position the user is looking at.
 *
 * Pure: no client, no config, no clock. Bun tests import this directly.
 */
import { formatUnits } from 'viem';
import type {
  Address,
  EventSnapshotDrops,
  Hash,
  Hex,
  YieldDepositFact as SdkYieldDepositFact,
  YieldEarned,
  YieldEarnedEvents,
  YieldRateObservation,
  YieldRateSeries,
} from '@privacy-pools-v2/sdk';

import type {
  PpUsdcRateHistoryResponse,
  SnapshotDeposit,
  SnapshotRagequit,
  SnapshotTransact,
  YieldDepositsResponse,
} from '@/services/api-types';
import { displayFractionDigits, formatTokenBalance } from '@/services/token-format';
import type { YieldFeedResult } from '@/services/yield-feeds';

/** Key of one share position: chain + lowercased share address. */
export function yieldEarnedKey(chainId: number, share: string): string {
  return `${chainId}:${share.toLowerCase()}`;
}

/** What the portfolio keeps per share position. Never a note, never a commitment. */
export type YieldEarnedEntry =
  | {
      status: 'ok';
      /** `valueOut + heldUnderlyingNow - valueIn`, raw underlying units. */
      earnedTotal: bigint;
      /** The most `earnedTotal` can understate the true figure, raw underlying units. */
      maxUnderstatement: bigint;
      /** Decimals of the underlying the two figures are in. */
      assetDecimals: number;
    }
  | { status: 'unavailable'; reason: string };

export type YieldEarnedByShare = ReadonlyMap<string, YieldEarnedEntry>;

export const EMPTY_YIELD_EARNED: YieldEarnedByShare = new Map();

// ── Feeds -> SDK inputs ────────────────────────────────────────────────────

/**
 * A grid feed state as the compute's input:
 *   - `undefined`: not loaded yet, so do not compute (a null here would read as
 *     "the feed is not served" and turn into a confident "unavailable");
 *   - `null`: the ASP answered 404, the SDK's "feed not served";
 *   - the value otherwise.
 */
export function feedValue<T>(result: YieldFeedResult<T> | undefined): T | null | undefined {
  if (result === undefined) return undefined;
  return result.status === 'ok' ? result.value : null;
}

function isoToSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function toBigInt(value: string | null | undefined): bigint | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

/** Decimal or hex commitment to the canonical 32-byte hex the SDK types carry. */
function toPaddedHex(value: string): Hex | null {
  try {
    const n = BigInt(value);
    if (n < 0n) return null;
    return `0x${n.toString(16).padStart(64, '0')}` as Hex;
  } catch {
    return null;
  }
}

/**
 * One share's rate history as the SDK's `YieldRateSeries`, the same reduction
 * the SDK's own `HttpASPDataProvider.getYieldRateSeries` does. Fails closed
 * (null) on anything that one would reject: a page for a different share, rows
 * that disagree on decimals, a row that does not parse. Null makes the compute
 * answer `no-rate-series`, which shows "—".
 */
export function toYieldRateSeries(
  response: PpUsdcRateHistoryResponse | null,
  share: string,
): YieldRateSeries | null {
  if (response === null) return null;
  const shareKey = share.toLowerCase();
  if ((response.ppUsdcAddress ?? '').toLowerCase() !== shareKey) return null;
  let shareDecimals: number | null = null;
  let assetDecimals: number | null = null;
  const observations: YieldRateObservation[] = [];
  for (const row of response.snapshots) {
    if (row.shareDecimals !== null && row.shareDecimals !== undefined) {
      if (shareDecimals !== null && shareDecimals !== row.shareDecimals) return null;
      shareDecimals = row.shareDecimals;
    }
    if (row.assetDecimals !== null && row.assetDecimals !== undefined) {
      if (assetDecimals !== null && assetDecimals !== row.assetDecimals) return null;
      assetDecimals = row.assetDecimals;
    }
    const timestamp = isoToSeconds(row.observationTimestamp);
    const exchangeRate = toBigInt(row.exchangeRate);
    const block = toBigInt(row.observationBlock);
    if (timestamp === null || exchangeRate === null || block === null) return null;
    observations.push({ timestamp, exchangeRate, block });
  }
  if (observations.length > 0 && (shareDecimals === null || assetDecimals === null)) return null;
  observations.sort((a, b) => a.timestamp - b.timestamp);
  return {
    share: shareKey as Address,
    shareDecimals: shareDecimals ?? 0,
    assetDecimals: assetDecimals ?? 0,
    observations,
  };
}

/**
 * The chain's deposits feed narrowed to one share, as the SDK's
 * `YieldDepositFact[]`. Rows without value columns are skipped, as the SDK
 * skips them (the compute then reports `deposit-fact-missing` if one of them
 * was ours). A row that does not parse makes the whole feed null: a fact we
 * cannot read is not a fact we may leave out silently.
 */
export function toYieldDepositFacts(
  response: YieldDepositsResponse | null,
  share: string,
): SdkYieldDepositFact[] | null {
  if (response === null) return null;
  const shareKey = share.toLowerCase();
  const facts: SdkYieldDepositFact[] = [];
  for (const row of response.deposits) {
    // Typed as required, but the payload is not validated: a row that does not
    // name its share cannot be attributed, so the whole feed fails closed.
    if (!row.asset) return null;
    if (row.asset.toLowerCase() !== shareKey) continue;
    if (row.grossUnderlying === null || row.noteShares === null || row.totalSharesMinted === null) continue;
    const grossUnderlying = toBigInt(row.grossUnderlying);
    const noteShares = toBigInt(row.noteShares);
    const totalSharesMinted = toBigInt(row.totalSharesMinted);
    const vettingFeeShares = row.vettingFeeShares == null ? null : toBigInt(row.vettingFeeShares);
    const outputCommitment = toPaddedHex(row.outputCommitment);
    const blockTimestamp = isoToSeconds(row.blockTimestamp);
    if (
      grossUnderlying === null || noteShares === null || totalSharesMinted === null
      || (row.vettingFeeShares != null && vettingFeeShares === null)
      || outputCommitment === null || blockTimestamp === null
    ) {
      return null;
    }
    facts.push({
      outputCommitment,
      asset: shareKey as Address,
      txHash: row.txHash as Hash,
      grossUnderlying,
      noteShares,
      totalSharesMinted,
      vettingFeeShares: vettingFeeShares ?? totalSharesMinted - noteShares,
      blockTimestamp,
    });
  }
  return facts;
}

/** The chain-tagged snapshot PoolsProvider holds (every EVM chain merged). */
export type ChainTaggedSnapshot = {
  deposits: readonly (SnapshotDeposit & { chainId: number })[];
  transacts: readonly (SnapshotTransact & { chainId: number })[];
  ragequits: readonly (SnapshotRagequit & { chainId: number })[];
  /**
   * Per chain, the sections that lost rows, in the SDK's `drops` shape. Absent
   * for a chain whose sections all arrived. The SDK's reducer reads it: lost
   * transacts or ragequits mark the events incomplete, so an exited position is
   * never valued as still held.
   */
  dropsByChain?: Readonly<Record<number, EventSnapshotDrops>>;
};

/** The SDK's `yieldEarnedEventsFromSnapshot`, injected so this module stays off the SDK runtime. */
export type SnapshotEventsReducer = (snapshot: {
  deposits: never[];
  transacts: never[];
  ragequits: never[];
  drops?: EventSnapshotDrops;
}) => YieldEarnedEvents;

/**
 * One chain's rows of the merged snapshot, through the SDK's own reducer.
 * The rows are the ASP's raw ones (decimal strings): the reducer only reads
 * commitments, nullifiers, tx hashes, ISO timestamps and `withdrawnValue`, and
 * the compute normalises every key with BigInt, which takes either spelling.
 * The chain's `drops`, when any, go along with them.
 */
export function yieldEarnedEventsForChain(
  snapshot: ChainTaggedSnapshot,
  chainId: number,
  reduce: SnapshotEventsReducer,
): YieldEarnedEvents {
  const mine = <T extends { chainId: number }>(rows: readonly T[]) => rows.filter((r) => r.chainId === chainId);
  const drops = snapshot.dropsByChain?.[chainId];
  return reduce({
    deposits: mine(snapshot.deposits) as never[],
    transacts: mine(snapshot.transacts) as never[],
    ragequits: mine(snapshot.ragequits) as never[],
    ...(drops ? { drops } : {}),
  });
}

/**
 * The drops record for one chain's raw payload. ppv2 does not run the SDK's
 * tolerant parser on this payload (rows are passed through as served), so the
 * only loss it can see is a whole section missing. That is recorded as a drop
 * of unknown size and height: fail closed, never "no spends".
 */
export function missingSectionDrops(payload: {
  deposits?: unknown;
  transacts?: unknown;
  ragequits?: unknown;
}): EventSnapshotDrops | undefined {
  const drops: EventSnapshotDrops = {};
  for (const section of ['deposits', 'transacts', 'ragequits'] as const) {
    if (!Array.isArray(payload[section])) drops[section] = { dropped: 1, earliestDroppedBlock: null };
  }
  return Object.keys(drops).length > 0 ? drops : undefined;
}

/** The SDK's answer reduced to what the portfolio keeps. */
export function toYieldEarnedEntry(result: YieldEarned, assetDecimals: number): YieldEarnedEntry {
  if (result.status !== 'ok') return { status: 'unavailable', reason: result.reason };
  return {
    status: 'ok',
    earnedTotal: result.earnedTotal,
    maxUnderstatement: result.maxUnderstatement,
    assetDecimals,
  };
}

// ── Display ────────────────────────────────────────────────────────────────

/**
 * Does `maxUnderstatement` round to zero at the precision `symbol` is shown
 * with? The SDK sets no threshold and says to show the figure only when it
 * does. Half a display unit, compared in integers:
 * `bound * 2 * 10^digits < 10^assetDecimals`.
 */
export function understatementRoundsToZero(
  maxUnderstatement: bigint,
  assetDecimals: number,
  symbol: string,
): boolean {
  if (maxUnderstatement < 0n) return false;
  const digits = displayFractionDigits(symbol);
  return maxUnderstatement * 2n * 10n ** BigInt(digits) < 10n ** BigInt(assetDecimals);
}

export type YieldEarnedDisplay = {
  /** e.g. "+1.23 USDC", "<0.01 USDC", "0.00 USDC". */
  text: string;
  /** The figure in underlying units, for a USD total. */
  amount: number;
};

/**
 * The row's earned text in the underlying (`symbol` is the display symbol:
 * USDC, USDT, ETH), or null for "—".
 *
 * Null when the SDK gave no figure, and when its understatement bound does not
 * round to zero at display precision: the figure is then a lower bound whose
 * gap is visible, and the table has no way to say "at least". A negative
 * figure is only possible within the bound (the SDK answers `inconsistent`
 * beyond it), so it prints as zero.
 */
export function yieldEarnedDisplay(entry: YieldEarnedEntry | undefined, symbol: string): YieldEarnedDisplay | null {
  if (!entry || entry.status !== 'ok') return null;
  if (!understatementRoundsToZero(entry.maxUnderstatement, entry.assetDecimals, symbol)) return null;
  const value = entry.earnedTotal > 0n ? entry.earnedTotal : 0n;
  const amount = Number(formatUnits(value, entry.assetDecimals));
  const formatted = formatTokenBalance(amount, symbol);
  if (value === 0n) return { text: `${formatted} ${symbol}`, amount: 0 };
  if (formatted.startsWith('<')) return { text: `${formatted} ${symbol}`, amount };
  return { text: `+${formatted} ${symbol}`, amount };
}

/**
 * The page's total, in USD, or null for "—". Every real yield row must have a
 * figure and a price: a sum that silently skips a position understates it.
 */
export function totalYieldEarnedUsd(
  rows: readonly { earned: YieldEarnedDisplay | null; underlyingPriceUsd: number }[],
): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const row of rows) {
    if (!row.earned) return null;
    if (row.earned.amount === 0) continue;
    if (!(row.underlyingPriceUsd > 0)) return null;
    total += row.earned.amount * row.underlyingPriceUsd;
  }
  return total;
}
