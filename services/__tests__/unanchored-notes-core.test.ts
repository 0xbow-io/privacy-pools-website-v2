import { describe, expect, test } from 'bun:test';

import {
  parseUnanchoredEntries,
  selectUnanchoredCommitments,
  withUnanchoredNotes,
  withoutUnanchoredNotes,
} from '@/services/unanchored-notes-core';

const OWNER = '0x7742C09a07645f6984F4d06B5A1b7f5b618e763C';
const OTHER = '0xD3581763f41FC0763a49E9ab53F2D3D425870a3D';
const SEPOLIA = 11155111;
const OPTIMISM = 10;
const C1 = '0x1aff8e22f639d4cbc34be37e14cfc9392aba4213d094301d6064a31f2fa041e7';
const C2 = '0x028f461380f05c57f69782c0d44c640271ebf1f3eaef93ead25d32caa0c81d02';

describe('unanchored notes core', () => {
  test('records a device-only note and reads it back for that owner and chain', () => {
    const e = withUnanchoredNotes([], OWNER, SEPOLIA, [C1]);
    expect(selectUnanchoredCommitments(e, OWNER, SEPOLIA).has(C1.toLowerCase())).toBe(true);
  });

  test('scopes by owner and by chain, so one account never sees another', () => {
    const e = withUnanchoredNotes([], OWNER, SEPOLIA, [C1]);
    expect(selectUnanchoredCommitments(e, OTHER, SEPOLIA).size).toBe(0);
    expect(selectUnanchoredCommitments(e, OWNER, OPTIMISM).size).toBe(0);
  });

  test('matches addresses and commitments case-insensitively', () => {
    const e = withUnanchoredNotes([], OWNER.toLowerCase(), SEPOLIA, [C1.toUpperCase()]);
    expect(selectUnanchoredCommitments(e, OWNER.toUpperCase(), SEPOLIA).has(C1.toLowerCase())).toBe(true);
  });

  test('does not duplicate a commitment recorded twice', () => {
    let e = withUnanchoredNotes([], OWNER, SEPOLIA, [C1]);
    e = withUnanchoredNotes(e, OWNER, SEPOLIA, [C1]);
    expect(selectUnanchoredCommitments(e, OWNER, SEPOLIA).size).toBe(1);
  });

  // The flag must survive everything except a CONFIRMED anchor. Clearing it on an
  // unknown outcome would say the funds are safely on-chain when nothing verified
  // that, which is the exact failure this area already produced once.
  test('clears only the commitment that was anchored, leaving the rest flagged', () => {
    const e = withoutUnanchoredNotes(
      withUnanchoredNotes([], OWNER, SEPOLIA, [C1, C2]), OWNER, SEPOLIA, [C1],
    );
    const left = selectUnanchoredCommitments(e, OWNER, SEPOLIA);
    expect(left.has(C1.toLowerCase())).toBe(false);
    expect(left.has(C2.toLowerCase())).toBe(true);
  });

  test('clearing another chain or owner leaves the flag alone', () => {
    let e = withUnanchoredNotes([], OWNER, SEPOLIA, [C1]);
    e = withoutUnanchoredNotes(e, OWNER, OPTIMISM, [C1]);
    e = withoutUnanchoredNotes(e, OTHER, SEPOLIA, [C1]);
    expect(selectUnanchoredCommitments(e, OWNER, SEPOLIA).has(C1.toLowerCase())).toBe(true);
  });

  test('a missing owner is a no-op rather than a crash', () => {
    expect(withUnanchoredNotes([], null, SEPOLIA, [C1])).toEqual([]);
    expect(selectUnanchoredCommitments([], undefined, SEPOLIA).size).toBe(0);
  });

  test('drops malformed rows instead of letting one poison the balance view', () => {
    const parsed = parseUnanchoredEntries([
      { owner: OWNER, chainId: SEPOLIA, commitment: C1 },
      { owner: 42, chainId: SEPOLIA, commitment: C2 },
      null,
      'nonsense',
    ]);
    expect(parsed.length).toBe(1);
    expect(selectUnanchoredCommitments(parsed, OWNER, SEPOLIA).has(C1.toLowerCase())).toBe(true);
  });

  test('parses a non-array as empty rather than throwing', () => {
    expect(parseUnanchoredEntries('{not json}')).toEqual([]);
    expect(parseUnanchoredEntries(null)).toEqual([]);
  });
});
