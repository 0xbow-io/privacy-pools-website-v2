// Share → underlying at the time of a past transaction, without asking the RPC
// about that transaction. The vault's rate is read on a block grid that depends
// only on the pool's start block and the chain head, so every client asks for
// the same blocks; a transaction's rate is interpolated locally between the two
// grid points around it. The rate only grows and moves ~1e-4 a day, so the
// interpolation error is far below display precision.
import { formatUnits, multicall3Abi, type Address } from 'viem';
import { displayTokenSymbol } from '@/services/share-display';
import { formatTokenBalance } from '@/services/token-format';
import { SHARE_CONVERT_ABI, type ShareDeploymentRef } from '@/services/share-rates';

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const RATE_GRID_POINTS = 64;
const READ_CONCURRENCY = 8;

export type RatePoint = { block: bigint; timestampSec: number; assetsPerShare: bigint };

export type ShareRateSeries = {
  ref: ShareDeploymentRef;
  /** Grid reads, oldest first. Empty when the endpoint cannot serve past state. */
  history: RatePoint[];
  /** The rate at the head block, or null when even that read failed. */
  current: RatePoint | null;
};

/** Where a transaction sits on the chain. Either coordinate is enough. */
export type TxPosition = { timestampSec?: number | null; block?: bigint | null };

/** A share→underlying rate resolved for one transaction. */
export type ShareConversion = {
  assetsPerShare: bigint;
  shareDecimals: number;
  /** Underlying symbol as the user knows it (ETH for a WETH vault). */
  symbol: string;
  decimals: number;
  /** False when today's rate stood in because no past rate was readable. */
  atTx: boolean;
};

/**
 * Block multiples of a power-of-two step covering (fromBlock, latest), at most
 * `maxPoints` of them. The step only changes when the span doubles, so clients
 * reading at about the same time request identical blocks.
 */
export function rateGridBlocks(fromBlock: bigint, latest: bigint, maxPoints = RATE_GRID_POINTS): bigint[] {
  if (latest <= fromBlock || maxPoints < 1) return [];
  const span = latest - fromBlock;
  let step = 1n;
  while (span / step >= BigInt(maxPoints)) step *= 2n;
  const out: bigint[] = [];
  for (let b = ((fromBlock + step - 1n) / step) * step; b < latest; b += step) out.push(b);
  return out;
}

function coordinate(p: RatePoint, by: 'block' | 'time'): bigint {
  return by === 'block' ? p.block : BigInt(p.timestampSec);
}

/** Linear interpolation over sorted points; no extrapolation beyond sampled coverage. */
export function interpolateAssetsPerShare(points: readonly RatePoint[], at: TxPosition): bigint | null {
  if (points.length === 0) return null;
  const by: 'block' | 'time' | null = at.block != null ? 'block' : at.timestampSec != null ? 'time' : null;
  if (!by) return null;
  const x = by === 'block' ? (at.block as bigint) : BigInt(Math.floor(at.timestampSec as number));
  const first = points[0];
  const last = points[points.length - 1];
  const xFirst = coordinate(first, by);
  const xLast = coordinate(last, by);
  if (x < xFirst || x > xLast) return null;
  if (x === xFirst) return first.assetsPerShare;
  if (x === xLast) return last.assetsPerShare;
  for (let i = 1; i < points.length; i += 1) {
    const hi = points[i];
    const xHi = coordinate(hi, by);
    if (x > xHi) continue;
    const lo = points[i - 1];
    const xLo = coordinate(lo, by);
    if (xHi === xLo) return hi.assetsPerShare;
    return lo.assetsPerShare + ((hi.assetsPerShare - lo.assetsPerShare) * (x - xLo)) / (xHi - xLo);
  }
  return null;
}

export function sharesToAssets(sharesWei: bigint, assetsPerShare: bigint, shareDecimals: number): bigint {
  return (sharesWei * assetsPerShare) / 10n ** BigInt(shareDecimals);
}

export function convertShares(c: ShareConversion, sharesWei: bigint): bigint {
  return sharesToAssets(sharesWei, c.assetsPerShare, c.shareDecimals);
}

/** The rate at the transaction's position, or today's rate when no past one was readable. */
export function shareConversionAt(series: ShareRateSeries, at: TxPosition | null): ShareConversion | null {
  const points = series.current ? [...series.history, series.current] : series.history;
  const past = series.history.length > 0 && at ? interpolateAssetsPerShare(points, at) : null;
  const rate = past ?? series.current?.assetsPerShare ?? null;
  if (rate == null) return null;
  return {
    assetsPerShare: rate,
    shareDecimals: series.ref.shareDecimals,
    symbol: displayTokenSymbol(series.ref.underlyingSymbol),
    decimals: series.ref.underlyingDecimals,
    atTx: past != null,
  };
}

/** "10.95 USDT (at transaction time)", or "≈ 10.96 USDT" when today's rate stood in. */
export function shareValueLabel(c: ShareConversion, sharesWei: bigint): string {
  const { symbol } = c;
  const amount = Number(formatUnits(convertShares(c, sharesWei), c.decimals));
  const text = `${formatTokenBalance(amount, symbol)} ${symbol}`;
  return c.atTx ? `${text} (at transaction time)` : `≈ ${text}`;
}

type MulticallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: unknown };

export type RateHistoryClient = {
  getBlockNumber: () => Promise<bigint>;
  multicall: (args: {
    multicallAddress: Address;
    blockNumber: bigint;
    allowFailure: true;
    contracts: readonly unknown[];
  }) => Promise<MulticallResult[]>;
};

/**
 * One multicall per grid block for every share on the chain plus the block's
 * timestamp. Failed blocks (no archive state, vault not yet deployed) are
 * skipped, and a share whose past reads all fail keeps only its current rate.
 */
export async function readShareRateSeries(
  client: RateHistoryClient,
  refs: readonly ShareDeploymentRef[],
  fromBlock: bigint,
): Promise<ShareRateSeries[]> {
  const series = refs.map((ref) => ({ ref, history: [] as RatePoint[], current: null as RatePoint | null }));
  if (refs.length === 0) return series;
  const latest = await client.getBlockNumber();
  const blocks = [...rateGridBlocks(fromBlock, latest), latest];
  const contracts = [
    ...refs.map((ref) => ({
      address: ref.share as Address,
      abi: SHARE_CONVERT_ABI,
      functionName: 'convertToAssets' as const,
      args: [10n ** BigInt(ref.shareDecimals)] as const,
    })),
    { address: MULTICALL3_ADDRESS as Address, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' as const },
  ];
  const readBlock = async (block: bigint) => {
    try {
      const res = await client.multicall({ multicallAddress: MULTICALL3_ADDRESS, blockNumber: block, allowFailure: true, contracts });
      const ts = res[refs.length];
      if (ts?.status !== 'success') return;
      const timestampSec = Number(ts.result as bigint);
      refs.forEach((_, i) => {
        const r = res[i];
        if (r?.status !== 'success' || typeof r.result !== 'bigint' || r.result <= 0n) return;
        const point = { block, timestampSec, assetsPerShare: r.result };
        if (block === latest) series[i].current = point;
        else series[i].history.push(point);
      });
    } catch {
      /* fail-soft: a missing grid point widens the interpolation span */
    }
  };
  for (let i = 0; i < blocks.length; i += READ_CONCURRENCY) {
    await Promise.all(blocks.slice(i, i + READ_CONCURRENCY).map(readBlock));
  }
  for (const s of series) s.history.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  return series;
}
