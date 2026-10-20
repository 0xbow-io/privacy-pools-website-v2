// Pure folding logic for the ASP's per-asset stats rows, kept OUT of the hook so
// it is testable without pulling react-native in through the provider import
// chain (same reason services/yield-feeds.ts is a plain module).
import type { AssetsStatsResponse } from '@/services/api-types';

/**
 * Select only explicitly attributed rows from the all-chains feed. Its ASP
 * handler concatenates per-chain rows, but its totals and cacheTimestamp are
 * aggregate metadata, so this deliberately returns rows, not a per-chain
 * response. Unknown chains must never fall back to the user's active chain:
 * consumers key by address and native-token addresses collide across chains.
 */
export function assetStatsRowsForChain(
  response: AssetsStatsResponse | undefined,
  chainId: number,
): AssetsStatsResponse['assets'] {
  return (response?.assets ?? []).filter((row) => {
    const id = Number(row.chainId);
    return Number.isSafeInteger(id) && id > 0 && id === chainId;
  });
}

/**
 * Parse an ASP numeric string (or number) into a finite number, or null.
 * Guards every figure the page renders against `NaN`/`undefined` leaking into
 * a formatter — the ASP returns numbers as strings and occasionally omits a
 * field entirely.
 */
export function finiteOrNull(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** Sum of decimal-string USD figures; null when no row carried one. */
function sumUsd(values: (string | undefined | null)[]): string | undefined {
  const nums = values.map(finiteOrNull).filter((n): n is number => n !== null);
  return nums.length ? String(nums.reduce((a, b) => a + b, 0)) : undefined;
}

/** Sum of base-unit amounts. BigInt, not float: these are wei-scale. */
function sumBaseUnits(values: (string | undefined | null)[]): string | undefined {
  let total = 0n;
  let seen = false;
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    try {
      total += BigInt(v);
      seen = true;
    } catch {
      // Non-integer string (the ASP occasionally sends a decimal) — skip it
      // rather than throw; the USD figure is the one the UI actually renders.
    }
  }
  return seen ? total.toString() : undefined;
}

/** Sum of counts; undefined when no row carried one. */
function sumCounts(values: (number | undefined | null)[]): number | undefined {
  const nums = values.map((v) => finiteOrNull(v)).filter((n): n is number => n !== null);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : undefined;
}

type RawAssetStat = NonNullable<AssetsStatsResponse['assets']>[number];

/**
 * Collapses the ASP's per-POOL rows into one row per (chain, token).
 *
 * Sums are the right fold for totals, counts and balances. `growth24h` is NOT
 * summable (it is a rate), and there is no pool-level weight in the payload to
 * average it honestly — so it survives only when the rows agree; otherwise it is
 * dropped and the card omits the figure, per the same policy the rest of this
 * page follows (an unknown value is omitted, never guessed or zeroed).
 */
export function foldRowsPerAsset(rows: RawAssetStat[], fallbackChainId: number): RawAssetStat[] {
  const groups = new Map<string, RawAssetStat[]>();
  for (const row of rows) {
    const address = String(row.tokenAddress || '').toLowerCase();
    if (!address) continue;
    const chainId = finiteOrNull(row.chainId) ?? fallbackChainId;
    const key = `${chainId}:${address}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const out: RawAssetStat[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      out.push(bucket[0]);
      continue;
    }
    const growths = [...new Set(bucket.map((r) => finiteOrNull(r.growth24h)).filter((g) => g !== null))];
    out.push({
      ...bucket[0],
      totalDepositsValueUsd: sumUsd(bucket.map((r) => r.totalDepositsValueUsd)) ?? bucket[0].totalDepositsValueUsd,
      totalDepositsValue: sumBaseUnits(bucket.map((r) => r.totalDepositsValue)),
      totalDepositsCount: sumCounts(bucket.map((r) => r.totalDepositsCount)),
      withdrawalsCount: sumCounts(bucket.map((r) => r.withdrawalsCount)),
      transfersCount: sumCounts(bucket.map((r) => r.transfersCount)),
      acceptedDepositsValueUsd: sumUsd(bucket.map((r) => r.acceptedDepositsValueUsd)),
      acceptedDepositsValue: sumBaseUnits(bucket.map((r) => r.acceptedDepositsValue)),
      acceptedDepositsCount: sumCounts(bucket.map((r) => r.acceptedDepositsCount)),
      totalInAssetValueUsd: sumUsd(bucket.map((r) => r.totalInAssetValueUsd)) ?? bucket[0].totalInAssetValueUsd,
      totalInAssetValue: sumBaseUnits(bucket.map((r) => r.totalInAssetValue)),
      pendingDepositsValueUsd: sumUsd(bucket.map((r) => r.pendingDepositsValueUsd)) ?? bucket[0].pendingDepositsValueUsd,
      pendingDepositsValue: sumBaseUnits(bucket.map((r) => r.pendingDepositsValue)),
      pendingDepositsCount: sumCounts(bucket.map((r) => r.pendingDepositsCount)),
      growth24h: growths.length === 1 ? growths[0] : null,
    } as RawAssetStat);
  }
  return out;
}
