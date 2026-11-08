import { describe, expect, test } from 'bun:test';
import { computeYieldEarned, yieldEarnedEventsFromSnapshot } from '@privacy-pools-v2/sdk';

import type { PpUsdcRateHistoryResponse, YieldDepositsResponse } from '@/services/api-types';
import {
  LOADING_USD,
  feedValue,
  missingSectionDrops,
  pendingValueDisplay,
  yieldEarnedRow,
  yieldEarnedTileDisplay,
  type YieldEarnedRow,
  toYieldDepositFacts,
  toYieldEarnedEntry,
  toYieldRateSeries,
  totalYieldEarnedUsd,
  understatementRoundsToZero,
  yieldEarnedDisplay,
  yieldEarnedEventsForChain,
  yieldEarnedKey,
  yieldEarnedNotesForShare,
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
    ({ status: 'ok', earnedTotal, maxUnderstatement, assetDecimals, heldShares: 1n });

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
    // A bound that shows at display precision: the floor of the range, marked as one.
    expect(yieldEarnedDisplay(ok(5_009_999n, 10_000n), 'USDC')).toEqual({ text: '+5+ USDC', amount: 5, lowerBound: true });
    expect(yieldEarnedDisplay(ok(1_239_999n, 7_048n), 'USDC')).toEqual({ text: '+1.23+ USDC', amount: 1.23, lowerBound: true });
    expect(yieldEarnedDisplay(ok(4_000n, 7_048n), 'USDC')).toEqual({ text: '0+ USDC', amount: 0, lowerBound: true });
    expect(yieldEarnedDisplay({ status: 'unavailable', reason: 'no-rate-series' }, 'USDC')).toBeNull();
    expect(yieldEarnedDisplay(undefined, 'USDC')).toBeNull();
  });

  test('the USD total sums the priced rows and flags the ones it could not count', () => {
    const a: YieldEarnedRow = { state: 'ok', display: { text: '+1.00 USDC', amount: 1 } };
    const b: YieldEarnedRow = { state: 'ok', display: { text: '+0.01000 ETH', amount: 0.01 } };
    const none: YieldEarnedRow = { state: 'unavailable' };
    expect(totalYieldEarnedUsd([])).toEqual({ state: 'unavailable' });
    const both = totalYieldEarnedUsd([{ earned: a, underlyingPriceUsd: 1 }, { earned: b, underlyingPriceUsd: 2500 }]);
    expect(both.state === 'ok' ? both.usd : null).toBeCloseTo(26, 9);
    expect(both).toMatchObject({ state: 'ok', partial: false, loading: false });
    // A row with no figure no longer holds the tile on "—" (prod 2026-10-21).
    expect(totalYieldEarnedUsd([{ earned: a, underlyingPriceUsd: 1 }, { earned: none, underlyingPriceUsd: 2500 }]))
      .toEqual({ state: 'ok', usd: 1, partial: true, loading: false });
    expect(totalYieldEarnedUsd([{ earned: a, underlyingPriceUsd: 1 }, { earned: b, underlyingPriceUsd: 0 }]))
      .toEqual({ state: 'ok', usd: 1, partial: true, loading: false });
    expect(totalYieldEarnedUsd([{ earned: b, underlyingPriceUsd: 0 }])).toEqual({ state: 'unavailable' });
    expect(totalYieldEarnedUsd([{ earned: none, underlyingPriceUsd: 1 }])).toEqual({ state: 'unavailable' });
    expect(totalYieldEarnedUsd([{ earned: { state: 'ok', display: { text: '0.00 ETH', amount: 0 } }, underlyingPriceUsd: 0 }]))
      .toEqual({ state: 'ok', usd: 0, partial: false, loading: false });
  });

  test('a large position with a rate-valued flow gets a figure, not "—" (QA of #67, Ethereum USDC)', () => {
    // Mainnet ppUSDC's real hourly steps (public rate history, 2026-09-04).
    const rateSeries = toYieldRateSeries(
      rateHistory([[T0, '1000038'], [T0 + 3600, '1000042'], [T0 + 7200, '1000200']]),
      SHARE,
    );
    // A note received between two observations (a swap into the share, a
    // transfer in): valued off the bracket, whose width is the bound.
    const compute = (shares: bigint) => computeYieldEarned({
      share: SHARE,
      shareDecimals: 18,
      notes: [{ commitment: COMMITMENT_HEX, nullifier: '0x1234', shares, status: 'ACTIVE' as never, createdAt: T0 + 1800, originatedHere: false }],
      depositFacts: [],
      rateSeries,
      events: {
        deposits: [],
        spends: [{ txHash: '0x01', at: T0 + 1800, nullifierHashes: ['0xdead'], outputCommitments: [COMMITMENT_HEX], withdrawnShares: null }],
        ragequits: [],
      } as never,
      exchangeRateNow: 1_000_200n,
      now: T0 + 7300,
    });
    const big = toYieldEarnedEntry(compute(1762n * 10n ** 18n), 6);
    // One hour of drift on 1762 shares: 7048 raw, over the 5000 (half a cent) USDC shows.
    expect(big).toEqual({ status: 'ok', earnedTotal: 278_396n, maxUnderstatement: 7_048n, assetDecimals: 6, heldShares: 1762n * 10n ** 18n });
    expect(understatementRoundsToZero(7_048n, 6, 'USDC')).toBe(false);
    expect(yieldEarnedDisplay(big, 'USDC')).toEqual({ text: '+0.27+ USDC', amount: 0.27, lowerBound: true });
    // The same flow on a small position rounds away and prints exactly, as the USDT rows did.
    const small = toYieldEarnedEntry(compute(477n * 10n ** 16n), 6);
    expect(yieldEarnedDisplay(small, 'USDT')?.lowerBound).toBeUndefined();
    // The tile counts the lower bound and says it is one.
    const total = totalYieldEarnedUsd([
      { earned: yieldEarnedRow(big, 'USDC', true), underlyingPriceUsd: 1 },
      { earned: yieldEarnedRow(small, 'USDT', true), underlyingPriceUsd: 1 },
    ]);
    expect(total.state === 'ok' && total.partial).toBe(true);
    expect(total.state === 'ok' ? total.usd : 0).toBeGreaterThan(0.27);
  });

  test('stored notes of a share reduce like the SDK reduces live ones', () => {
    const notes = [
      { commitment: '0x01', value: '100', tokenId: SHARE.toUpperCase().replace('0X', '0x'), status: 'ACTIVE', createdAtBlock: '0x10', isOwned: true, depositSecret: '0x1' },
      { commitment: '0x02', value: '5', tokenId: SHARE, status: 'SPENT', createdAtBlock: '0x20', isOwned: true },
      { commitment: '0x03', value: '7', tokenId: OTHER_SHARE, status: 'ACTIVE', isOwned: true },
      { commitment: '0x04', value: '9', tokenId: SHARE, status: 'ACTIVE', isOwned: false },
    ] as unknown as Parameters<typeof yieldEarnedNotesForShare>[0];
    const out = yieldEarnedNotesForShare(notes, SHARE, (c) => `${c}ff` as `0x${string}`, (b) => Number(BigInt(b)));
    expect(out).toEqual([
      { commitment: '0x01', nullifier: '0x01ff', shares: 100n, status: 'ACTIVE', createdAt: 16, originatedHere: true },
      { commitment: '0x02', nullifier: '0x02ff', shares: 5n, status: 'SPENT', createdAt: 32, originatedHere: false },
    ] as never);
  });

  test('positions are keyed by chain and lowercased share', () => {
    expect(yieldEarnedKey(1, '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6')).toBe(`1:${SHARE}`);
  });
});

// Nathaniel, QA of #67 (prod, Optimism USDC 967.37 at 3.77%): "Yield earned
// $0.00" in the header and "0 USDC" on the row while the figure was loading.
describe('loading is not zero, and neither is unavailable', () => {
  const okEntry = (earnedTotal: bigint, heldShares: bigint): YieldEarnedEntry =>
    ({ status: 'ok', earnedTotal, maxUnderstatement: 0n, assetDecimals: 6, heldShares });
  const usd = (n: number) => `$${n.toFixed(2)}`;

  test('a row with no entry yet, or one waiting on an input, is loading', () => {
    expect(yieldEarnedRow(undefined, 'USDC', true)).toEqual({ state: 'loading' });
    expect(yieldEarnedRow({ status: 'loading', reason: 'deposits-feed-loading' }, 'USDC', true)).toEqual({ state: 'loading' });
    expect(yieldEarnedRow({ status: 'loading', reason: 'rate-history-loading' }, 'USDC', true)).toEqual({ state: 'loading' });
  });

  test('a 0 computed over no notes, for a row that holds shares, is loading (the observed "0 USDC")', () => {
    // What the SDK answers before the account's notes reach it: ok, nothing held, 0 earned.
    const beforeNotes = computeYieldEarned({
      share: SHARE,
      shareDecimals: 18,
      notes: [],
      depositFacts: [],
      rateSeries: toYieldRateSeries(rateHistory([[T0, '1000000'], [T0 + 3600, '1000100']]), SHARE),
      events: { deposits: [], spends: [], ragequits: [] } as never,
      exchangeRateNow: 1_000_100n,
      now: T0 + 3700,
    });
    const entry = toYieldEarnedEntry(beforeNotes, 6);
    expect(entry).toMatchObject({ status: 'ok', earnedTotal: 0n, heldShares: 0n });
    // The row holds 967 USDC worth of shares, so that 0 is "not yet".
    expect(yieldEarnedRow(entry, 'USDC', true)).toEqual({ state: 'loading' });
    // A row with nothing held left (all withdrawn) keeps a real 0.
    expect(yieldEarnedRow(entry, 'USDC', false)).toEqual({ state: 'ok', display: { text: '0 USDC', amount: 0 } });
  });

  test('a computed 0 over held shares (a deposit minutes old) is a real 0', () => {
    expect(yieldEarnedRow(okEntry(0n, 967n * 10n ** 18n), 'USDC', true))
      .toEqual({ state: 'ok', display: { text: '0 USDC', amount: 0 } });
    expect(yieldEarnedRow(okEntry(1_234_567n, 10n ** 18n), 'USDC', true))
      .toEqual({ state: 'ok', display: { text: '+1.23 USDC', amount: 1.234567 } });
  });

  test('unavailable stays unavailable, with no spinner', () => {
    expect(yieldEarnedRow({ status: 'unavailable', reason: 'deposit-fact-missing' }, 'USDC', true)).toEqual({ state: 'unavailable' });
    expect(yieldEarnedTileDisplay(totalYieldEarnedUsd([{ earned: { state: 'unavailable' }, underlyingPriceUsd: 1 }]), usd)).toBeNull();
  });

  test('the tile: placeholder and spinner while nothing is known, never "$0.00"', () => {
    const loading = totalYieldEarnedUsd([{ earned: { state: 'loading' }, underlyingPriceUsd: 1 }]);
    expect(loading).toEqual({ state: 'loading' });
    expect(yieldEarnedTileDisplay(loading, usd)).toEqual({ text: LOADING_USD, loading: true });
    expect(LOADING_USD).not.toContain('0');
    // Loading beside unavailable: still loading, a figure may come.
    expect(totalYieldEarnedUsd([
      { earned: { state: 'loading' }, underlyingPriceUsd: 1 },
      { earned: { state: 'unavailable' }, underlyingPriceUsd: 1 },
    ])).toEqual({ state: 'loading' });
  });

  test('the tile: the known part as a lower bound, with a spinner, while other rows load', () => {
    const total = totalYieldEarnedUsd([
      { earned: { state: 'ok', display: { text: '+2.50 USDC', amount: 2.5 } }, underlyingPriceUsd: 1 },
      { earned: { state: 'loading' }, underlyingPriceUsd: 1 },
    ]);
    expect(total).toEqual({ state: 'ok', usd: 2.5, partial: true, loading: true });
    expect(yieldEarnedTileDisplay(total, usd)).toEqual({ text: '$2.50+', loading: true });
    // Every row computed, one of them a real 0: a plain figure, no spinner.
    const done = totalYieldEarnedUsd([
      { earned: { state: 'ok', display: { text: '+2.50 USDC', amount: 2.5 } }, underlyingPriceUsd: 1 },
      { earned: { state: 'ok', display: { text: '0 USDC', amount: 0 } }, underlyingPriceUsd: 1 },
    ]);
    expect(yieldEarnedTileDisplay(done, usd)).toEqual({ text: '$2.50', loading: false });
    // Only a real 0: "$0.00" is allowed then, and only then.
    const zero = totalYieldEarnedUsd([{ earned: { state: 'ok', display: { text: '0 USDC', amount: 0 } }, underlyingPriceUsd: 1 }]);
    expect(yieldEarnedTileDisplay(zero, usd)).toEqual({ text: '$0.00', loading: false });
  });

  test('pending: placeholder and spinner while loading or syncing, a real 0 once synced', () => {
    const base = { pageLoading: false, accountSyncing: false, ratesLoading: false, value: 0, valueUnavailable: false, formatUsd: usd };
    expect(pendingValueDisplay({ ...base, pageLoading: true })).toEqual({ text: LOADING_USD, loading: true });
    // Mid-sync a 0 is "none found yet".
    expect(pendingValueDisplay({ ...base, accountSyncing: true })).toEqual({ text: LOADING_USD, loading: true });
    // Mid-sync a figure found so far shows, with the spinner.
    expect(pendingValueDisplay({ ...base, accountSyncing: true, value: 12 })).toEqual({ text: '$12.00', loading: true });
    // Pending shares waiting on the share rate: loading. A failed rate: unavailable, no spinner.
    expect(pendingValueDisplay({ ...base, valueUnavailable: true, ratesLoading: true })).toEqual({ text: LOADING_USD, loading: true });
    expect(pendingValueDisplay({ ...base, valueUnavailable: true })).toEqual({ text: 'Value unavailable', loading: false });
    // Synced, nothing pending: a computed 0.
    expect(pendingValueDisplay(base)).toEqual({ text: '$0.00', loading: false });
  });
});
