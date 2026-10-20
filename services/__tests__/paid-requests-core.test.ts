import { describe, expect, test } from 'bun:test';

import {
  findPaidRequestIn,
  normalizePaidRequest,
  parsePaidRequests,
  toPaidRequestTxHashSet,
  upsertPaidRequest,
  type PaidRequest,
} from '@/services/paid-requests-core';

const entry = (over: Partial<PaidRequest> = {}): PaidRequest => ({
  txHash: '0xAABB',
  recipient: '0xD3581763f41FC0763a49E9ab53F2D3D425870a3D',
  rawAmount: '0x2386f26fc10000',
  tokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  chainId: 11155111,
  requestId: 'req-1',
  timestamp: 1_800_000_000_000,
  ...over,
});

describe('normalizePaidRequest', () => {
  test('lowercases the COMPARED fields only', () => {
    const n = normalizePaidRequest(entry());
    expect(n.txHash).toBe('0xaabb');
    expect(n.tokenAddress).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    // The recipient is displayed — checksum case is how users recognise it.
    expect(n.recipient).toBe('0xD3581763f41FC0763a49E9ab53F2D3D425870a3D');
  });
});

describe('upsertPaidRequest', () => {
  // A retry, a re-render or a double-submit must not leave two records.
  test('is idempotent on txHash, last write wins', () => {
    let all = upsertPaidRequest([], entry());
    all = upsertPaidRequest(all, entry({ requestId: 'retry' }));
    expect(all).toHaveLength(1);
    expect(all[0].requestId).toBe('retry');
  });

  test('dedupes across case differences in the hash', () => {
    let all = upsertPaidRequest([], entry({ txHash: '0xAABB' }));
    all = upsertPaidRequest(all, entry({ txHash: '0xaabb', requestId: 'same-tx' }));
    expect(all).toHaveLength(1);
    expect(all[0].requestId).toBe('same-tx');
  });

  test('keeps distinct payments', () => {
    let all = upsertPaidRequest([], entry());
    all = upsertPaidRequest(all, entry({ txHash: '0xccdd', requestId: 'req-2' }));
    expect(all).toHaveLength(2);
  });

  test('does not mutate the input array', () => {
    const original: PaidRequest[] = [];
    upsertPaidRequest(original, entry());
    expect(original).toHaveLength(0);
  });
});

describe('parsePaidRequests', () => {
  test('tolerates absent, empty, corrupt and wrong-shaped storage', () => {
    expect(parsePaidRequests(null)).toEqual([]);
    expect(parsePaidRequests('')).toEqual([]);
    expect(parsePaidRequests('not json')).toEqual([]);
    expect(parsePaidRequests('{"not":"an array"}')).toEqual([]);
    expect(parsePaidRequests('"a string"')).toEqual([]);
  });

  test('round-trips a real record', () => {
    const all = upsertPaidRequest([], entry());
    expect(parsePaidRequests(JSON.stringify(all))).toEqual(all);
  });

  // codex finding: '[{}]' passed the Array.isArray check and then blew up in
  // toPaidRequestTxHashSet (undefined.toLowerCase()) — inside pools-provider's
  // balance memo, so one corrupt localStorage value crashed rendering. Each
  // entry must be validated, and the whole downstream pipeline must survive
  // whatever parse admits.
  test('drops malformed ENTRIES inside a well-formed array', () => {
    expect(parsePaidRequests('[{}]')).toEqual([]);
    expect(parsePaidRequests('[null, 42, "x", {"txHash":123}, {"txHash":""}]')).toEqual([]);
    const good = upsertPaidRequest([], entry())[0];
    const mixed = JSON.stringify([{}, good, null]);
    expect(parsePaidRequests(mixed)).toEqual([good]);
  });

  test('everything parse admits survives the set builder and the finder', () => {
    // '[{"txHash":"0xabc"}]' is the codex round-2 case: it passed the
    // txHash-only validation and then crashed the VIEWER-aware builder on
    // recipient.toLowerCase(). The viewer variant must be exercised too.
    for (const raw of ['[{}]', '[null]', '[{"txHash":123}]', '[{"txHash":"0xabc"}]', JSON.stringify([entry()])]) {
      const all = parsePaidRequests(raw);
      expect(() => toPaidRequestTxHashSet(all)).not.toThrow();
      expect(() => toPaidRequestTxHashSet(all, '0xd3581763f41fc0763a49e9ab53f2d3d425870a3d')).not.toThrow();
      expect(() => findPaidRequestIn(all, '0xaabb')).not.toThrow();
    }
  });

  test('a recipient-less record handed straight to the builder is excluded, not fatal', () => {
    // The builder is exported; records can bypass parse entirely. No usable
    // recipient means it cannot be proven a self-payment — it stays excluded
    // (the pre-viewer behaviour) rather than throwing or being kept.
    const raw = [{ txHash: '0xABC' } as unknown as PaidRequest];
    const set = toPaidRequestTxHashSet(raw, '0xd3581763f41fc0763a49e9ab53f2d3d425870a3d');
    expect(set.has('0xabc')).toBe(true);
  });
});

describe('findPaidRequestIn', () => {
  const all = upsertPaidRequest([], entry());

  test('matches whatever case the feed supplies', () => {
    expect(findPaidRequestIn(all, '0xaabb')?.requestId).toBe('req-1');
    expect(findPaidRequestIn(all, '0xAABB')?.requestId).toBe('req-1');
  });

  test('returns null for null/undefined/unknown', () => {
    expect(findPaidRequestIn(all, null)).toBeNull();
    expect(findPaidRequestIn(all, undefined)).toBeNull();
    expect(findPaidRequestIn(all, '0xnope')).toBeNull();
  });
});

describe('toPaidRequestTxHashSet', () => {
  // THE POINT: this set is what stops a payment made to someone else from
  // being counted back into the payer's own balance in pools-provider.
  test('is lowercase, so it matches feed hashes lowercased at the call site', () => {
    const all = upsertPaidRequest([], entry({ txHash: '0xAaBbCc' }));
    const set = toPaidRequestTxHashSet(all);
    expect(set.has('0xaabbcc')).toBe(true);
    expect(set.size).toBe(1);
  });

  test('empty in, empty out', () => {
    expect(toPaidRequestTxHashSet([]).size).toBe(0);
  });

  // codex: paying a request whose recipient is YOUR OWN account is a deposit
  // you do own — excluding it hid the payer's own pending balance. The viewer
  // address keeps self-payments out of the exclusion set.
  test('a self-payment is not excluded for its own recipient', () => {
    const me = '0xD3581763f41FC0763a49E9ab53F2D3D425870a3D';
    const all = upsertPaidRequest(
      upsertPaidRequest([], entry({ txHash: '0xself', recipient: me })),
      entry({ txHash: '0xother', recipient: '0x1111111111111111111111111111111111111111', requestId: 'r2' }),
    );
    const forMe = toPaidRequestTxHashSet(all, me.toLowerCase());
    expect(forMe.has('0xself')).toBe(false);   // mine. Stays counted
    expect(forMe.has('0xother')).toBe(true);   // foreign. Excluded
    // Address matching is case-insensitive.
    expect(toPaidRequestTxHashSet(all, me.toUpperCase()).has('0xself')).toBe(false);
    // No viewer => the old payer-only behaviour: everything excluded.
    expect(toPaidRequestTxHashSet(all).has('0xself')).toBe(true);
  });

  // kimi's surviving mutation: every path into the store normalizes, so
  // dropping toPaidRequestTxHashSet's OWN .toLowerCase() changed nothing and the
  // suite stayed green. It matters anyway — the function is exported and a
  // caller can hand it records from anywhere (a migration, a hand-written
  // fixture, a future non-store source). Pin it against a record that skipped
  // normalizePaidRequest entirely.
  test('lowercases defensively, even for records that never went through the store', () => {
    const raw: PaidRequest = { ...entry(), txHash: '0xDEADBEEF' };
    const set = toPaidRequestTxHashSet([raw]);
    expect(set.has('0xdeadbeef')).toBe(true);
    expect(set.has('0xDEADBEEF')).toBe(false);
  });
});
