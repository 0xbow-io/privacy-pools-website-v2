/**
 * The points epochs, as a public-feed-grid definition.
 *
 * Per chain: every published epoch of the build's pool and each epoch's whole
 * rate table. These are the only inputs points accrual takes from the ASP, and
 * they are the same bytes for every client; the balance is computed locally
 * (hooks/use-points.ts). Registered for every supported EVM chain on a fixed
 * cadence, so neither the request set nor its timing depends on the wallet or
 * on whether anyone opened the Portfolio page.
 *
 * The epoch list is refetched whole each tick: it grows by one row a month, and
 * refetching it is how a corrected epoch is noticed. A rate table is downloaded
 * once per (epoch, rateRoot, correctedAt) and reused after that.
 *
 * Wire format: every integer the points API serves (epoch numbers, roots,
 * leaves, unix-second timestamps) is a 32-byte big-endian `0x` Hex string.
 * Rows in the old decimal / ISO format are refused here rather than read with
 * the wrong meaning. Everything is held in memory only, so nothing in the old
 * format survives a reload.
 *
 * APP-ONLY MODULE: reaches the api client.
 */
import apiClient from '@/services/api-client';
import type { PointsEpoch, PointsRateLeavesResponse } from '@/services/api-types';
import { resolveConfiguredEntrypoint } from '@/services/pool-entrypoint';
import { loadYieldFeed, type YieldFeedResult } from '@/services/yield-feeds';

export const feedPointsEpochs = (chainId: number | string) => `points-epochs:${chainId}`;

export const POINTS_FEED_INTERVAL_MS = 30 * 60_000;

/**
 * Pages of the epoch list a single tick may read: the SDK's POINTS_FEED_MAX_PAGES.
 * Reaching it fails the feed rather than publishing a partial history.
 */
export const MAX_EPOCH_PAGES = 100;

export type PublishedPointsEpoch = { epoch: PointsEpoch; rateLeaves: PointsRateLeavesResponse };

/** Published epochs that carry a rate table, ascending by epoch number. */
export type PointsFeedValue = { epochs: PublishedPointsEpoch[] };

const rateTableCache = new Map<string, PointsRateLeavesResponse>();

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** A Hex wire integer as a bigint; throws on anything else (e.g. a pre-Hex decimal value). */
export function parsePointsHex(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new Error(`points feed: ${field} is not a 32-byte hex value`);
  }
  return BigInt(value);
}

/**
 * Refuses a rate table that is not in the Hex format before it is cached. The
 * SDK still validates every field and recomputes the root against the epoch's
 * rateRoot (epochParamsFromRateLeaves); this only keeps an old-format table
 * out of the cache.
 */
function assertRateLeavesFormat(rateLeaves: PointsRateLeavesResponse, epochNumber: bigint): void {
  if (parsePointsHex(rateLeaves.epochNumber, 'rateLeaves.epochNumber') !== epochNumber) {
    throw new Error('points feed: rate leaves are for another epoch');
  }
  parsePointsHex(rateLeaves.rateRoot, 'rateLeaves.rateRoot');
  if (rateLeaves.rateScale != null) parsePointsHex(rateLeaves.rateScale, 'rateLeaves.rateScale');
  if (!Array.isArray(rateLeaves.leaves)) throw new Error('points feed: rate leaves missing');
  for (const leaf of rateLeaves.leaves) {
    if (!Array.isArray(leaf) || leaf.length !== 2) throw new Error('points feed: malformed rate leaf');
    parsePointsHex(leaf[0], 'rate leaf tokenId');
    parsePointsHex(leaf[1], 'rate leaf rate');
  }
}

function rateTableKey(chainId: number, epoch: PointsEpoch): string {
  const epochNumber = parsePointsHex(epoch.epochNumber, 'epochNumber');
  const rateRoot = epoch.rateRoot === null ? '' : parsePointsHex(epoch.rateRoot, 'rateRoot');
  const correctedAt = epoch.correctedAt == null ? '' : parsePointsHex(epoch.correctedAt, 'correctedAt');
  return `${chainId}:${epochNumber}:${rateRoot}:${correctedAt}`;
}

async function loadAllEpochs(chainId: number, entrypoint: string | undefined): Promise<PointsEpoch[]> {
  const byNumber = new Map<bigint, PointsEpoch>();
  let sinceId: string | undefined;
  for (let page = 1; ; page += 1) {
    const response = await apiClient.getPointsEpochs(chainId, entrypoint, sinceId);
    if (response.epochs.length === 0) break;
    for (const epoch of response.epochs) byNumber.set(parsePointsHex(epoch.epochNumber, 'epochNumber'), epoch);
    if (response.lastSyncedId === sinceId) break;
    if (page >= MAX_EPOCH_PAGES) throw new Error(`points feed: epoch list incomplete after ${page} pages`);
    sinceId = response.lastSyncedId;
  }
  return [...byNumber.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, epoch]) => epoch);
}

export async function fetchPointsFeed(chainId: number): Promise<YieldFeedResult<PointsFeedValue>> {
  return loadYieldFeed(async () => {
    const entrypoint = await resolveConfiguredEntrypoint(chainId);
    const epochs = await loadAllEpochs(chainId, entrypoint);
    const published: PublishedPointsEpoch[] = [];
    for (const epoch of epochs) {
      parsePointsHex(epoch.snapshotTime, 'snapshotTime');
      // An epoch published before the keeper carried rate tables pays nothing
      // the client can price.
      if (!epoch.rateRoot) continue;
      const key = rateTableKey(chainId, epoch);
      let rateLeaves = rateTableCache.get(key);
      if (!rateLeaves) {
        // The path takes the epoch number in decimal; the row carries it as Hex.
        const epochNumber = parsePointsHex(epoch.epochNumber, 'epochNumber');
        rateLeaves = await apiClient.getPointsRateLeaves(chainId, epochNumber, entrypoint);
        assertRateLeavesFormat(rateLeaves, epochNumber);
        rateTableCache.set(key, rateLeaves);
      }
      published.push({ epoch, rateLeaves });
    }
    return { epochs: published };
  });
}
