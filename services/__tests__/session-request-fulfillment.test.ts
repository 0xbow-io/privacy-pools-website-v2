import { describe, expect, test } from 'bun:test';

import { paidSessionRequestIds } from '../session-request-fulfillment';

const USDC = '0xA4cF419558Ef36CC6FfB666195684dC963910426';
const T0 = 1_790_000_000_000; // ms
const sec = (ms: number) => `0x${Math.floor(ms / 1000).toString(16)}`;
const req = (id: string, amount: bigint, at = T0) => ({ requestId: id, chainId: 1, tokenAddress: USDC, amount: `0x${amount.toString(16)}`, createdAtMs: at });
const note = (c: string, value: bigint, at: number, tx = `0x${c.padStart(64, '0')}`) => ({ commitment: c, tokenId: USDC.toLowerCase(), value: value.toString(), createdAtBlock: sec(at), txHash: tx });
const notOwn = () => false;

describe('paidSessionRequestIds', () => {
  test('a received note of exactly the requested token and value, after the request, pays it', () => {
    expect([...paidSessionRequestIds([req('a', 1200n)], [note('1', 1200n, T0 + 5_000)], 1, notOwn)]).toEqual(['a']);
  });

  test('a different value, an earlier note, another chain or our own tx does not', () => {
    expect(paidSessionRequestIds([req('a', 1200n)], [note('1', 1201n, T0 + 5_000)], 1, notOwn).size).toBe(0);
    expect(paidSessionRequestIds([req('a', 1200n)], [note('1', 1200n, T0 - 3_600_000)], 1, notOwn).size).toBe(0);
    expect(paidSessionRequestIds([req('a', 1200n)], [note('1', 1200n, T0 + 5_000)], 10, notOwn).size).toBe(0);
    expect(paidSessionRequestIds([req('a', 1200n)], [note('1', 1200n, T0 + 5_000)], 1, () => true).size).toBe(0);
  });

  test('one note pays one request, oldest first', () => {
    const paid = paidSessionRequestIds([req('new', 10n, T0 + 1_000), req('old', 10n, T0)], [note('1', 10n, T0 + 9_000)], 1, notOwn);
    expect([...paid]).toEqual(['old']);
  });

  test('two equal requests and one payment: only the oldest is paid', () => {
    const paid = paidSessionRequestIds([req('a', 10n, T0), req('b', 10n, T0 + 1_000)], [note('1', 10n, T0 + 9_000)], 1, notOwn);
    expect([...paid]).toEqual(['a']);
  });

  test('a request two notes could have paid stays open', () => {
    const paid = paidSessionRequestIds([req('a', 10n)], [note('1', 10n, T0 + 5_000), note('2', 10n, T0 + 6_000)], 1, notOwn);
    expect(paid.size).toBe(0);
  });

  test('a note whose time is not healed yet is not evidence', () => {
    expect(paidSessionRequestIds([req('a', 5n)], [{ commitment: '1', tokenId: USDC, value: '5', createdAtBlock: '0x16e3600', txHash: '0x' + '1'.repeat(64) }], 1, notOwn).size).toBe(0);
  });
});
