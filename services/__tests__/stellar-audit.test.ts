import { describe, expect, mock, test } from 'bun:test';

import {
  findBySpelling,
  stellarClaimDisclosures,
  stellarSentDisclosures,
  stellarTxHashSpellings,
  withStellarHistoryPending,
} from '@/services/stellar/stellar-audit';
import type { StellarSentClaim } from '@/services/stellar/stellar-sent-claims';

const ME = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const BOB = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const TX = `0x${'ab'.repeat(32)}`;

// Shaped like the SDK's finalizeTransfer recipient notes: padded hex, the
// recipient stamped as owner, the secret from the send's own secrets map.
const recipientNote = (i: number, value: bigint, over: Record<string, unknown> = {}) => ({
  commitment: `0x${i.toString(16).padStart(64, '0')}`,
  ownerAddress: BOB,
  noteSecret: `0x${(1000 + i).toString(16)}`,
  value: `0x${value.toString(16).padStart(64, '0')}`,
  tokenId: XLM,
  label: `0x${(77 + i).toString(16)}`,
  txHash: TX,
  ...over,
});

describe('stellarSentDisclosures', () => {
  test('one disclosure per recipient note when the notes add up to the amount sent', () => {
    const out = stellarSentDisclosures({
      chainId: 202, txHash: TX, recipient: BOB, amount: 30_000_000n,
      notes: [recipientNote(1, 20_000_000n), recipientNote(2, 10_000_000n)],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      chainId: 202,
      txHash: TX,
      commitment: recipientNote(1, 0n).commitment,
      ownerAddress: BOB,
      noteSecret: '0x3e9',
      tokenId: XLM,
      value: '0x1312d00',
      label: '0x4e',
    });
  });

  test('a partial set is never kept: it would undercount the payment while reading as proven', () => {
    expect(stellarSentDisclosures({
      chainId: 202, txHash: TX, recipient: BOB, amount: 30_000_000n,
      notes: [recipientNote(1, 20_000_000n)],
    })).toEqual([]);
  });

  test('a note without its secret, or owned by someone else, keeps nothing', () => {
    expect(stellarSentDisclosures({
      chainId: 202, txHash: TX, recipient: BOB, amount: 10_000_000n,
      notes: [recipientNote(1, 10_000_000n, { noteSecret: undefined })],
    })).toEqual([]);
    expect(stellarSentDisclosures({
      chainId: 202, txHash: TX, recipient: BOB, amount: 10_000_000n,
      notes: [recipientNote(1, 10_000_000n, { ownerAddress: ME })],
    })).toEqual([]);
  });

  test('an owner the SDK left unstamped is the recipient the sender named', () => {
    const [d] = stellarSentDisclosures({
      chainId: 202, txHash: TX, recipient: BOB, amount: 10_000_000n,
      notes: [recipientNote(1, 10_000_000n, { ownerAddress: undefined })],
    });
    expect(d.ownerAddress).toBe(BOB);
  });

  test('no notes (a blind send) or no hash keeps nothing', () => {
    expect(stellarSentDisclosures({ chainId: 202, txHash: TX, recipient: BOB, amount: 1n, notes: undefined })).toEqual([]);
    expect(stellarSentDisclosures({ chainId: 202, txHash: '', recipient: BOB, amount: 1n, notes: [recipientNote(1, 1n)] })).toEqual([]);
  });
});

describe('stellarClaimDisclosures', () => {
  const claim = (over: Partial<StellarSentClaim> = {}): StellarSentClaim => ({
    id: 'c1',
    sender: ME,
    recipient: BOB,
    amount: '30000000',
    notes: [
      { ...recipientNote(1, 20_000_000n), noteAddressHash: '0x1', txHash: '0x0' } as never,
      { ...recipientNote(2, 10_000_000n), noteAddressHash: '0x2', txHash: '0x0' } as never,
    ],
    txHash: TX,
    createdAt: 1,
    ...over,
  });

  test('a confirmed one-time send discloses its claim notes under the send hash', () => {
    const out = stellarClaimDisclosures(202, claim());
    expect(out.map((d) => d.txHash)).toEqual([TX, TX]);
    expect(out.map((d) => d.ownerAddress)).toEqual([BOB, BOB]);
  });

  test('the notes are the whole set, so a fee that made the asked amount differ still discloses', () => {
    expect(stellarClaimDisclosures(202, claim({ amount: '30500000', kind: 'deposit' }))).toHaveLength(2);
  });

  test('a send never seen to confirm discloses nothing', () => {
    expect(stellarClaimDisclosures(202, claim({ txHash: null }))).toEqual([]);
    expect(stellarClaimDisclosures(202, null)).toEqual([]);
  });
});

describe('Stellar tx hash spellings', () => {
  test('both spellings, the given one first', () => {
    expect(stellarTxHashSpellings('abc')).toEqual(['abc', '0xabc']);
    expect(stellarTxHashSpellings('0xabc')).toEqual(['0xabc', 'abc']);
    expect(stellarTxHashSpellings('')).toEqual([]);
  });

  test('a record kept under the 0x spelling is found from an unprefixed row hash', () => {
    const store = new Map([['0xabc', ['kept']]]);
    expect(findBySpelling('abc', (h) => store.get(h) ?? [], (l) => l.length === 0)).toEqual(['kept']);
    expect(findBySpelling('def', (h) => store.get(h) ?? [], (l) => l.length === 0)).toBeNull();
  });
});

describe('withStellarHistoryPending', () => {
  test('a connected Stellar wallet waits for its first history read', () => {
    expect(withStellarHistoryPending([], { selected: true, connected: true, noteOrigins: null })).toEqual([202]);
    expect(withStellarHistoryPending([11155111], { selected: true, connected: true, noteOrigins: null })).toEqual([11155111, 202]);
  });

  test('an index a failed refresh left incomplete still blocks the export: received transfers would be missing', () => {
    expect(withStellarHistoryPending([], { selected: true, connected: true, noteOrigins: { complete: false } })).toEqual([202]);
  });

  test('nothing to wait for once completely indexed, with no wallet, or with another chain selected', () => {
    expect(withStellarHistoryPending([], { selected: true, connected: true, noteOrigins: { complete: true } })).toEqual([]);
    expect(withStellarHistoryPending([], { selected: true, connected: false, noteOrigins: null })).toEqual([]);
    expect(withStellarHistoryPending([1], { selected: false, connected: true, noteOrigins: null })).toEqual([1]);
  });
});

describe('Stellar export after a page reload', () => {
  test('a connected wallet still locked shows cached notes only, so the export stays blocked until unlocked and indexed', async () => {
    mock.module('react-native', () => ({
      Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
    }));
    const { stellarAccount } = await import('@/services/stellar/stellar-account');
    const internals = stellarAccount as unknown as { buildSession: () => Promise<unknown>; set: (p: Record<string, unknown>) => void };
    const signer = { getAddress: async () => '', getNetworkPassphrase: async () => '', signTransaction: async (x: string) => x } as never;
    stellarAccount.bind(null, null);
    // What a reload leaves: the wallet reconnects, the account binds, nothing unlocks.
    stellarAccount.bind(ME, signer);
    const locked = stellarAccount.getSnapshot();
    expect(locked.unlocked).toBe(false);
    expect(withStellarHistoryPending([], { selected: true, connected: true, noteOrigins: locked.noteOrigins })).toEqual([202]);
    // Unlocking alone is not enough: the export waits for a complete index.
    internals.buildSession = async () => ({});
    await stellarAccount.ensureSession();
    expect(withStellarHistoryPending([], { selected: true, connected: true, noteOrigins: stellarAccount.getSnapshot().noteOrigins })).toEqual([202]);
    internals.set({ noteOrigins: { byCommitment: {}, complete: true } });
    expect(withStellarHistoryPending([], { selected: true, connected: true, noteOrigins: stellarAccount.getSnapshot().noteOrigins })).toEqual([]);
    stellarAccount.bind(null, null);
  });
});
