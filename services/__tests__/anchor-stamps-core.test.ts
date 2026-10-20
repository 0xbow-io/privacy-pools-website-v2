import { describe, expect, test } from 'bun:test';

import {
  MAX_ANCHOR_STAMPS,
  isAnchorTx,
  parseAnchorStamps,
  selectAnchorTxHashes,
  withAnchorStamps,
  type AnchorStamp,
} from '@/services/anchor-stamps-core';

const OWNER = '0x7742C09a07645f6984F4d06B5A1b7f5b618e763C';
const CHAIN = 11155111;
const TX = '0x6a76f388166e564de3ed05d942afc615a3f2404b44a14ce55a3dec241d8bb33b';
const C1 = '0x1aff8e22f639d4cbc34be37e14cfc9392aba4213d094301d6064a31f2fa041e7';
const C2 = '0x0ca253da5ae7c0de87be106edfc2acab4c9caec893c38b8ff98817a8af951d41';

describe('anchor stamps core', () => {
  test('records a confirmed anchor and recognises its transaction', () => {
    const s = withAnchorStamps([], OWNER, CHAIN, TX, [C1]);
    expect(s.length).toBe(1);
    expect(isAnchorTx(s, OWNER, CHAIN, TX)).toBe(true);
  });

  test('matches owner, tx and commitment case-insensitively', () => {
    const s = withAnchorStamps([], OWNER.toLowerCase(), CHAIN, TX.toUpperCase(), [C1.toUpperCase()]);
    expect(isAnchorTx(s, OWNER.toUpperCase(), CHAIN, TX.toLowerCase())).toBe(true);
    expect(selectAnchorTxHashes(s, OWNER, CHAIN).has(TX.toLowerCase())).toBe(true);
  });

  test('scopes by owner and chain, so one account never reads another as anchored', () => {
    const s = withAnchorStamps([], OWNER, CHAIN, TX, [C1]);
    expect(isAnchorTx(s, '0xdead00000000000000000000000000000000beef', CHAIN, TX)).toBe(false);
    expect(isAnchorTx(s, OWNER, 1, TX)).toBe(false);
  });

  test('an unrecorded transaction is NOT an anchor: absence is not a claim', () => {
    // The whole safety property. A device with no stamp - a different browser,
    // or one that cleared storage - must fall back to the neutral fee row, and
    // never to a confident label in either direction.
    const s = withAnchorStamps([], OWNER, CHAIN, TX, [C1]);
    expect(isAnchorTx(s, OWNER, CHAIN, '0xother')).toBe(false);
    expect(isAnchorTx([], OWNER, CHAIN, TX)).toBe(false);
  });

  test('is idempotent: the same leg recorded twice stays one entry', () => {
    const once = withAnchorStamps([], OWNER, CHAIN, TX, [C1]);
    const twice = withAnchorStamps(once, OWNER, CHAIN, TX, [C1]);
    expect(twice.length).toBe(1);
  });

  test('a relayed claim maps one transaction to several spent commitments', () => {
    // The gasless branch submits ONE transact for every input.
    const s = withAnchorStamps([], OWNER, CHAIN, TX, [C1, C2]);
    expect(s.length).toBe(2);
    expect(selectAnchorTxHashes(s, OWNER, CHAIN).size).toBe(1);
  });

  test('a self-funded claim keeps each leg on its own transaction', () => {
    // One transact per note, so two notes are two hashes - never one hash
    // credited with commitments it did not spend.
    let s = withAnchorStamps([], OWNER, CHAIN, '0xaaa', [C1]);
    s = withAnchorStamps(s, OWNER, CHAIN, '0xbbb', [C2]);
    expect(s.map((e) => e.commitment)).toEqual([C1.toLowerCase(), C2.toLowerCase()]);
    expect(selectAnchorTxHashes(s, OWNER, CHAIN).size).toBe(2);
    expect(s.find((e) => e.txHash === '0xaaa')?.commitment).toBe(C1.toLowerCase());
    expect(s.find((e) => e.txHash === '0xbbb')?.commitment).toBe(C2.toLowerCase());
  });

  test('a missing owner or tx hash is a no-op rather than a crash', () => {
    expect(withAnchorStamps([], null, CHAIN, TX, [C1])).toEqual([]);
    expect(withAnchorStamps([], OWNER, CHAIN, null, [C1])).toEqual([]);
    expect(isAnchorTx([], null, CHAIN, TX)).toBe(false);
    expect(isAnchorTx([], OWNER, CHAIN, null)).toBe(false);
  });

  test('drops malformed rows instead of letting one poison the table', () => {
    const raw = [
      { owner: OWNER, chainId: CHAIN, txHash: TX, commitment: C1 },
      { owner: OWNER, chainId: 'nope', txHash: TX, commitment: C1 },
      null,
      'garbage',
      { owner: OWNER, chainId: CHAIN },
    ];
    expect(parseAnchorStamps(raw).length).toBe(1);
    expect(parseAnchorStamps('not an array')).toEqual([]);
  });

  test('is bounded, dropping the oldest first', () => {
    let s: AnchorStamp[] = [];
    for (let i = 0; i < MAX_ANCHOR_STAMPS + 5; i += 1) {
      s = withAnchorStamps(s, OWNER, CHAIN, `0x${i.toString(16)}`, [C1]);
    }
    expect(s.length).toBe(MAX_ANCHOR_STAMPS);
    // The five oldest are gone, the newest survived.
    expect(isAnchorTx(s, OWNER, CHAIN, '0x0')).toBe(false);
    expect(isAnchorTx(s, OWNER, CHAIN, `0x${(MAX_ANCHOR_STAMPS + 4).toString(16)}`)).toBe(true);
  });
});
