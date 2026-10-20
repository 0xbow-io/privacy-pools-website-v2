import { describe, expect, test } from 'bun:test';
import { computeYieldEarned, yieldEarnedEventsFromSnapshot } from '@privacy-pools-v2/sdk';

import type { PpUsdcRateHistoryResponse, YieldDepositsResponse } from '@/services/api-types';
import {
  feedValue,
  missingSectionDrops,
  toYieldDepositFacts,
  toYieldEarnedEntry,
  toYieldRateSeries,
  totalYieldEarnedUsd,
  understatementRoundsToZero,
  yieldEarnedDisplay,
  yieldEarnedEventsForChain,
  yieldEarnedKey,
  type ChainTaggedSnapshot,
  type SnapshotEventsReducer,
  type YieldEarnedEntry,
} from '@/services/yield-earned';

const SHARE = '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6';
const OTHER_SHARE = '0xa4cf419558ef36cc6ffb666195684dc963910426';
// A commitment as the ASP serves it: decimal.
const COMMITMENT_DEC = '14430310383053476341834276543445841403175606727452137046646934167914007902559';
const COMMITMENT_HEX = `0x${BigInt(COMMITMENT_DEC).toString(16).padStart(64, '0')}` as const;
const T0 = Date.parse('2026-09-04T20:00:00.000Z') / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();

function rateHistory(rows: [number, string][], share = SHARE): PpUsdcRateHistoryResponse {
  return {
    chainId: '1',
    ppUsdcAddress: share,
    intervalSeconds: 3600,
    lastSyncedId: String(rows.length),
    snapshots: rows.map(([at, rate], i) => ({
      id: String(i + 1),
      exchangeRate: rate,
      shareDecimals: 18,
      assetDecimals: 6,
      feeBps: 2000,
      observationBlock: String(25_906_000 + i),
      observationTimestamp: iso(at),
    })),
  };
}

function depositsFeed(extra: Partial<YieldDepositsResponse['deposits'][number]> = {}): YieldDepositsResponse {
  return {
    lastSyncedId: '2',
    deposits: [
      {
        id: '1',
        txHash: '0xb8317ccb768053bb03df5950b66e0deebaccdfea6cc736e86144226c293fa9d2',
        logIndex: 29,
        blockNumber: '25906428',
        blockTimestamp: iso(T0 + 60),
        outputCommitment: COMMITMENT_DEC,
        asset: SHARE,
        grossUnderlying: '100000000',
        noteShares: '100000000000000000000',
        totalSharesMinted: '100000000000000000000',
        vettingFeeShares: '0',
        ...extra,
      },
      {
        id: '2',
        txHash: '0x5c639024c3bc4f5e9da55ebf31175c8cbbd35833b1cf02783315443767d1f533',
        logIndex: 73,
        blockNumber: '25906438',
        blockTimestamp: iso(T0 + 120),
        outputCommitment: '12345',
        asset: OTHER_SHARE,
        grossUnderlying: '5000000',
        noteShares: '5000000000000000000',
        totalSharesMinted: '5000000000000000000',
        vettingFeeShares: '0',
      },
    ],
  };
}

describe('feed -> SDK input mapping', () => {
  test('feedValue separates not-loaded from not-served', () => {
    expect(feedValue(undefined)).toBeUndefined();
    expect(feedValue({ status: 'unavailable' })).toBeNull();
    expect(feedValue({ status: 'ok', value: 7 })).toBe(7);
  });

  test('rate history becomes an ascending YieldRateSeries for its share', () => {
    const series = toYieldRateSeries(rateHistory([[T0 + 3600, '1000100'], [T0, '1000000']]), SHARE.toUpperCase().replace('0X', '0x'));
    expect(series).toEqual({
      share: SHARE,
      shareDecimals: 18,
      assetDecimals: 6,
      observations: [
        { timestamp: T0, exchangeRate: 1_000_000n, block: 25_906_001n },
        { timestamp: T0 + 3600, exchangeRate: 1_000_100n, block: 25_906_000n },
      ],
    });
  });

  test('rate history fails closed: 404, another share, disagreeing decimals, junk rows', () => {
    expect(toYieldRateSeries(null, SHARE)).toBeNull();
    expect(toYieldRateSeries(rateHistory([[T0, '1000000']], OTHER_SHARE), SHARE)).toBeNull();
    const split = rateHistory([[T0, '1000000'], [T0 + 3600, '1000100']]);
    split.snapshots[1].assetDecimals = 18;
    expect(toYieldRateSeries(split, SHARE)).toBeNull();
    const junk = rateHistory([[T0, '1000000']]);
    junk.snapshots[0].exchangeRate = '1e6';
    expect(toYieldRateSeries(junk, SHARE)).toBeNull();
    const undated = rateHistory([[T0, '1000000']]);
    undated.snapshots[0].observationTimestamp = 'not a date';
    expect(toYieldRateSeries(undated, SHARE)).toBeNull();
  });

  test('deposit facts keep only the share asked about, as padded hex and bigints', () => {
    const facts = toYieldDepositFacts(depositsFeed(), SHARE);
    expect(facts).toEqual([{
      outputCommitment: COMMITMENT_HEX,
      asset: SHARE,
      txHash: '0xb8317ccb768053bb03df5950b66e0deebaccdfea6cc736e86144226c293fa9d2',
      grossUnderlying: 100_000_000n,
      noteShares: 100n * 10n ** 18n,
      totalSharesMinted: 100n * 10n ** 18n,
      vettingFeeShares: 0n,
      blockTimestamp: T0 + 60,
    }]);
    expect(toYieldDepositFacts(depositsFeed(), OTHER_SHARE)).toHaveLength(1);
    expect(toYieldDepositFacts(null, SHARE)).toBeNull();
  });

  test('deposit facts skip rows without values, and refuse rows they cannot read', () => {
    expect(toYieldDepositFacts(depositsFeed({ grossUnderlying: null }), SHARE)).toEqual([]);
    expect(toYieldDepositFacts(depositsFeed({ vettingFeeShares: null }), SHARE)?.[0].vettingFeeShares).toBe(0n);
    expect(toYieldDepositFacts(depositsFeed({ asset: undefined }), SHARE)).toBeNull();
    expect(toYieldDepositFacts(depositsFeed({ noteShares: '-1' }), SHARE)).toBeNull();
    expect(toYieldDepositFacts(depositsFeed({ blockTimestamp: 'x' }), SHARE)).toBeNull();
  });

  test('pool events come from one chain of the merged snapshot, through the SDK reducer', () => {
    const snapshot: ChainTaggedSnapshot = {
      deposits: [
        { chainId: 1, txHash: '0x01', logIndex: 0, depositAddress: '0x', outputCommitment: COMMITMENT_DEC, depositedValue: '1', fee: '0', blockNumber: '1', blockTimestamp: iso(T0), asset: SHARE },
        { chainId: 56, txHash: '0x02', logIndex: 0, depositAddress: '0x', outputCommitment: '99', depositedValue: '1', fee: '0', blockNumber: '1', blockTimestamp: iso(T0), asset: SHARE },
      ],
      transacts: [
        { chainId: 56, txHash: '0x03', logIndex: 0, outputCommitments: [], nullifierHashes: ['5'], caller: '0x', withdrawnValue: '0', encryptedPayload: null, blockNumber: '2', blockTimestamp: iso(T0), asset: SHARE },
      ],
      ragequits: [],
    };
    const events = yieldEarnedEventsForChain(snapshot, 1, yieldEarnedEventsFromSnapshot as unknown as SnapshotEventsReducer);
    expect(events.deposits).toEqual([{ commitment: COMMITMENT_DEC as `0x${string}` }]);
    expect(events.spends).toEqual([]);
    expect(events.incomplete).toBeUndefined();
  });

  test("a chain's lost spend or ragequit rows reach the SDK, which marks the events incomplete", () => {
    const base = { deposits: [], transacts: [], ragequits: [] };
    const reduce = yieldEarnedEventsFromSnapshot as unknown as SnapshotEventsReducer;
    // Only the chain whose rows were lost is incomplete.
    const lost: ChainTaggedSnapshot = { ...base, dropsByChain: { 1: { transacts: { dropped: 2, earliestDroppedBlock: null } } } };
    expect(yieldEarnedEventsForChain(lost, 1, reduce).incomplete).toBe(true);
    expect(yieldEarnedEventsForChain(lost, 56, reduce).incomplete).toBeUndefined();
    // A section missing from the raw payload is recorded as lost, never as none.
    expect(missingSectionDrops({ deposits: [], transacts: [], ragequits: [] })).toBeUndefined();
    const missing = missingSectionDrops({ deposits: [], ragequits: [] });
    expect(missing?.transacts?.dropped).toBeGreaterThan(0);
    expect(yieldEarnedEventsForChain({ ...base, dropsByChain: { 1: missing! } }, 1, reduce).incomplete).toBe(true);
    expect(yieldEarnedEventsForChain({ ...base, dropsByChain: { 1: missingSectionDrops({ deposits: [], transacts: [] })! } }, 1, reduce).incomplete).toBe(true);
  });

  test('the mapped inputs are what the SDK computes a real figure from', () => {
    const rateSeries = toYieldRateSeries(rateHistory([[T0, '1000000'], [T0 + 3600, '1005000']]), SHARE);
    const depositFacts = toYieldDepositFacts(depositsFeed(), SHARE);
    const events = yieldEarnedEventsForChain(
      {
        deposits: [{ chainId: 1, txHash: '0x01', logIndex: 0, depositAddress: '0x', outputCommitment: COMMITMENT_DEC, depositedValue: '1', fee: '0', blockNumber: '1', blockTimestamp: iso(T0 + 60), asset: SHARE }],
        transacts: [],
        ragequits: [],
      },
      1,
      yieldEarnedEventsFromSnapshot as unknown as SnapshotEventsReducer,
    );
    const result = computeYieldEarned({
      share: SHARE,
      shareDecimals: 18,
      notes: [{
        commitment: COMMITMENT_HEX,
        nullifier: '0x1234',
        shares: 100n * 10n ** 18n,
        status: 'ACTIVE' as never,
        createdAt: T0 + 60,
        originatedHere: true,
      }],
      depositFacts,
      rateSeries,
      events,
      exchangeRateNow: 1_010_000n,
      now: T0 + 7200,
    });
    expect(result.status).toBe('ok');
    const entry = toYieldEarnedEntry(result, rateSeries!.assetDecimals);
    // 100 shares held at 1.01, bought for exactly 100 USDC.
    expect(entry).toMatchObject({ status: 'ok', earnedTotal: 1_000_000n, assetDecimals: 6 });
    expect(yieldEarnedDisplay(entry, 'USDC')?.text).toBe('+1 USDC');
  });

  test('an own deposit the feed has not indexed yet is no figure, not a guess', () => {
    const result = computeYieldEarned({
      share: SHARE,
      shareDecimals: 18,
      notes: [{ commitment: COMMITMENT_HEX, nullifier: '0x1234', shares: 10n ** 18n, status: 'ACTIVE' as never, createdAt: T0 + 60, originatedHere: true }],
      depositFacts: [],
      rateSeries: toYieldRateSeries(rateHistory([[T0, '1000000']]), SHARE),
      events: { deposits: [{ commitment: COMMITMENT_HEX }], spends: [], ragequits: [] },
      exchangeRateNow: 1_000_000n,
      now: T0 + 7200,
    });
    const entry = toYieldEarnedEntry(result, 6);
    expect(entry).toEqual({ status: 'unavailable', reason: 'deposit-fact-missing' });
    expect(yieldEarnedDisplay(entry, 'USDC')).toBeNull();
  });
});

describe('display threshold', () => {
  const ok = (earnedTotal: bigint, maxUnderstatement: bigint, assetDecimals = 6): YieldEarnedEntry =>
    ({ status: 'ok', earnedTotal, maxUnderstatement, assetDecimals });

  test('the bound must round to zero at display precision (half a unit)', () => {
    // USDC shows cents: half a cent is 5000 raw units.
    expect(understatementRoundsToZero(4_999n, 6, 'USDC')).toBe(true);
    expect(understatementRoundsToZero(5_000n, 6, 'USDC')).toBe(false);
    // ETH shows five decimals: half of 1e-5 ETH is 5e12 wei.
    expect(understatementRoundsToZero(4_999_999_999_999n, 18, 'ETH')).toBe(true);
    expect(understatementRoundsToZero(5_000_000_000_000n, 18, 'ETH')).toBe(false);
    expect(understatementRoundsToZero(-1n, 6, 'USDC')).toBe(false);
  });

  test('figures in the underlying, "—" (null) when there is none or the bound shows', () => {
    expect(yieldEarnedDisplay(ok(1_234_567n, 2n), 'USDC')).toEqual({ text: '+1.23 USDC', amount: 1.234567 });
    expect(yieldEarnedDisplay(ok(3_000n, 2n), 'USDT')).toEqual({ text: '+0.003 USDT', amount: 0.003 });
    expect(yieldEarnedDisplay(ok(0n, 0n), 'USDC')).toEqual({ text: '0 USDC', amount: 0 });
    // Negative only within the bound: printed as zero, never red.
    expect(yieldEarnedDisplay(ok(-2n, 3n), 'USDC')).toEqual({ text: '0 USDC', amount: 0 });
    expect(yieldEarnedDisplay(ok(12_345_000_000_000_000n, 3n, 18), 'ETH')).toEqual({ text: '+0.01235 ETH', amount: 0.012345 });
    expect(yieldEarnedDisplay(ok(5_000_000n, 10_000n), 'USDC')).toBeNull();
    expect(yieldEarnedDisplay({ status: 'unavailable', reason: 'no-rate-series' }, 'USDC')).toBeNull();
    expect(yieldEarnedDisplay(undefined, 'USDC')).toBeNull();
  });

  test('the USD total needs every row, and a price for every non-zero row', () => {
    const a = { text: '+1.00 USDC', amount: 1 };
    const b = { text: '+0.01000 ETH', amount: 0.01 };
    expect(totalYieldEarnedUsd([])).toBeNull();
    expect(totalYieldEarnedUsd([{ earned: a, underlyingPriceUsd: 1 }, { earned: b, underlyingPriceUsd: 2500 }])).toBeCloseTo(26, 9);
    expect(totalYieldEarnedUsd([{ earned: a, underlyingPriceUsd: 1 }, { earned: null, underlyingPriceUsd: 2500 }])).toBeNull();
    expect(totalYieldEarnedUsd([{ earned: b, underlyingPriceUsd: 0 }])).toBeNull();
    expect(totalYieldEarnedUsd([{ earned: { text: '0.00 ETH', amount: 0 }, underlyingPriceUsd: 0 }])).toBe(0);
  });

  test('positions are keyed by chain and lowercased share', () => {
    expect(yieldEarnedKey(1, '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6')).toBe(`1:${SHARE}`);
  });
});
