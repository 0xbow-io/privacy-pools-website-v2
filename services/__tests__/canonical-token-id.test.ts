import { describe, expect, test } from 'bun:test';

import { canonicalTokenId, canonicalizeExportTokenIds } from '../canonical-token-id';
import type { AccountExport, Note } from '../sdk-types';

const CHECKSUMMED = '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6';
const LOWER = '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6';
const note = (tokenId: string, value: string, commitment: string) =>
  ({ tokenId, value, commitment } as unknown as Note);

describe('one spelling per token', () => {
  test('an EVM address is lowercased', () => {
    expect(canonicalTokenId(CHECKSUMMED)).toBe(LOWER);
    expect(canonicalTokenId(LOWER)).toBe(LOWER);
  });

  test('a Sui type is left exactly as it is', () => {
    // Its module and struct names are case-sensitive: lowercasing renames the
    // token instead of normalising it.
    for (const id of ['0x2::sui::SUI', '0xaaef2b67::pp_pool::PPUSDC']) {
      expect(canonicalTokenId(id)).toBe(id);
    }
  });

  test('anything that is not a 20-byte hex address is untouched', () => {
    for (const id of ['0x123', '', 'USDC', `${CHECKSUMMED}00`]) {
      expect(canonicalTokenId(id)).toBe(id);
    }
    expect(canonicalTokenId(undefined)).toBeUndefined();
    expect(canonicalTokenId(null)).toBeNull();
  });

  test('two spellings of one token collapse, so both notes can fund one proof', () => {
    const account = {
      notes: [note(CHECKSUMMED, '18827507', '0x01'), note(LOWER, '8552493', '0x02')],
      syncCursor: '0x0',
    } as unknown as AccountExport;
    const out = canonicalizeExportTokenIds(account);
    expect(out.notes.map((n) => n.tokenId)).toEqual([LOWER, LOWER]);
    // The values are the user's, not ours to touch.
    expect(out.notes.map((n) => n.value)).toEqual(['18827507', '8552493']);
  });

  test('an export that is already canonical is returned unchanged, by identity', () => {
    // So a read cannot churn storage on every load.
    const account = { notes: [note(LOWER, '1', '0x01')], syncCursor: '0x0' } as unknown as AccountExport;
    expect(canonicalizeExportTokenIds(account)).toBe(account);
  });

  test('the envelope and cursor survive', () => {
    const account = {
      notes: [note(CHECKSUMMED, '1', '0x01')],
      syncCursor: '0xabc',
      owner: '0x1111111111111111111111111111111111111111',
      chainId: 56,
    } as unknown as AccountExport;
    const out = canonicalizeExportTokenIds(account);
    expect(out.syncCursor).toBe('0xabc');
    expect(out.owner).toBe('0x1111111111111111111111111111111111111111');
    expect(out.chainId).toBe(56);
  });

  test('a malformed export is handed back rather than thrown on', () => {
    for (const bad of [null, undefined, {}, { notes: 'nope' }]) {
      expect(canonicalizeExportTokenIds(bad as unknown as AccountExport)).toBe(bad as unknown as AccountExport);
    }
  });
});
