import { describe, expect, test } from 'bun:test';

import {
  recordAspBlockTimestamps,
  getAspBlockTimestamp,
  aspBlockTimestampCount,
  toHexSeconds,
  __resetAspBlockTimestamps,
} from '@/services/asp-block-timestamps';

const CHAIN = 11155111;

/**
 * These hints replace ~450 eth_getBlockByNumber calls per cold load, so the
 * parsing has to be exactly right: the value ends up inside
 * Poseidon(TAG, commitment, timestamp), where a wrong timestamp produces a leaf
 * that does not exist on-chain and fails only inside the circuit.
 */
describe('toHexSeconds', () => {
  test('converts ISO 8601 to hex unix seconds', () => {
    // 2026-08-27T14:08:12Z = 1787839692 = 0x6a9044cc
    expect(toHexSeconds('2026-08-27T14:08:12.000Z')).toBe('0x6a9044cc');
  });

  test('treats a millisecond epoch as milliseconds and a second epoch as seconds', () => {
    expect(toHexSeconds(1787839692000)).toBe('0x6a9044cc');
    expect(toHexSeconds(1787839692)).toBe('0x6a9044cc');
    expect(toHexSeconds('1787839692000')).toBe('0x6a9044cc');
    expect(toHexSeconds('1787839692')).toBe('0x6a9044cc');
  });

  test('passes hex through, lowercased', () => {
    expect(toHexSeconds('0x6A9044CC')).toBe('0x6a9044cc');
  });

  test('accepts bigint seconds', () => {
    expect(toHexSeconds(1787839692n)).toBe('0x6a9044cc');
  });

  test('returns null for anything unparseable, never a guess', () => {
    for (const bad of [null, undefined, '', '   ', 'not-a-date', {}, [], NaN, -1]) {
      expect(toHexSeconds(bad)).toBeNull();
    }
  });

  test('rejects strings Date.parse would silently invent a date from', () => {
    // Found by this test: Date.parse('-5') is 988675200000, so '-5' used to
    // become a plausible 2001 timestamp. Fabricating a value is the one thing
    // this must never do, since it lands inside a commitment leaf.
    for (const bad of ['-5', 'Aug 27 2026', '27/08/2026', 'Thu Aug 27 2026']) {
      expect(toHexSeconds(bad)).toBeNull();
    }
  });

  test('an all-digit string stays an epoch, which is not the same thing', () => {
    // '5' and '2026' are deliberately NOT rejected: an all-digit string is an
    // epoch by contract, and the ASP sends decimal epochs on some feeds. The
    // rejection above is only for text Date.parse would guess a date from.
    expect(toHexSeconds('5')).toBe('0x5');
    expect(toHexSeconds('2026')).toBe('0x7ea');
  });

  test('still accepts the postgres-style timestamp shape', () => {
    expect(toHexSeconds('2026-08-27 14:08:12+00')).toBe('0x6a9044cc');
  });
});

describe('recordAspBlockTimestamps', () => {
  test('records hex or decimal block numbers under one key', () => {
    __resetAspBlockTimestamps();
    recordAspBlockTimestamps(CHAIN, [{ blockNumber: '0xa7c4c4', blockTimestamp: '2026-08-27T14:08:12.000Z' }]);

    // Same block, either notation.
    expect(getAspBlockTimestamp(CHAIN, '0xa7c4c4')).toBe('0x6a9044cc');
    expect(getAspBlockTimestamp(CHAIN, 10_994_884n)).toBe('0x6a9044cc');
  });

  test('skips rows with no usable timestamp, so an older ASP records nothing', () => {
    __resetAspBlockTimestamps();
    const n = recordAspBlockTimestamps(CHAIN, [
      { blockNumber: '0x1' },
      { blockNumber: '0x2', blockTimestamp: null },
      { blockNumber: '0x3', blockTimestamp: 'garbage' },
    ]);

    expect(n).toBe(0);
    expect(aspBlockTimestampCount(CHAIN)).toBe(0);
    expect(getAspBlockTimestamp(CHAIN, '0x1')).toBeNull();
  });

  test('skips rows with no block number', () => {
    __resetAspBlockTimestamps();
    expect(recordAspBlockTimestamps(CHAIN, [{ blockTimestamp: '2026-08-27T14:08:12.000Z' }])).toBe(0);
  });

  test('first writer wins, so a bad late row cannot displace a good one', () => {
    __resetAspBlockTimestamps();
    recordAspBlockTimestamps(CHAIN, [{ blockNumber: '0x1', blockTimestamp: 1787839692 }]);
    recordAspBlockTimestamps(CHAIN, [{ blockNumber: '0x1', blockTimestamp: 1 }]);

    expect(getAspBlockTimestamp(CHAIN, '0x1')).toBe('0x6a9044cc');
  });

  test('keeps chains apart', () => {
    __resetAspBlockTimestamps();
    recordAspBlockTimestamps(CHAIN, [{ blockNumber: '0x1', blockTimestamp: 1787839692 }]);

    expect(getAspBlockTimestamp(1, '0x1')).toBeNull();
    expect(getAspBlockTimestamp(CHAIN, '0x1')).not.toBeNull();
  });

  test('tolerates a malformed rows array without throwing', () => {
    __resetAspBlockTimestamps();
    expect(() =>
      recordAspBlockTimestamps(CHAIN, [null as never, undefined as never, 42 as never]),
    ).not.toThrow();
  });
});
