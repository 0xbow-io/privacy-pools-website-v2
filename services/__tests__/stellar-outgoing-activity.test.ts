// Stellar Sent / Withdrawal / Exit rows, rebuilt from the pool's own events
// (nullifiers, outputs, withdrawn value, ragequits) and the account's notes.
import { describe, expect, test } from 'bun:test';

import {
  buildStellarNoteOrigins,
  deriveStellarActivity,
  reconstructStellarSpends,
  stellarReceivedNotes,
  stellarSentRecipientLookup,
} from '@/services/stellar-activity';
import type { Hex } from '@/services/sdk-types';

const ME = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const PAYEE = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const NK = '0x5';
const CTX = { chainId: 202, chainName: 'Stellar Testnet', symbol: 'XLM', decimals: 7, priceUsd: 0, ownAddress: ME };

// Stand-in for Poseidon: deterministic and distinct per (key, commitment).
const fakeHash = { hash: ([k, c]: Hex[]) => `0x${(BigInt(k) * 1_000_000n + BigInt(c)).toString(16)}` as Hex };
const nullifierOf = (c: number) => fakeHash.hash([NK as Hex, `0x${c.toString(16)}` as Hex]);
const pad = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const tx = (n: number) => n.toString(16).padStart(64, 'b');

const note = (c: number, value: bigint, status: string, label = '0xabc') => ({
  commitment: pad(BigInt(c)),
  value: pad(value),
  tokenId: XLM,
  label,
  status,
  ownerAddress: ME,
  isOwned: true,
  txHash: tx(c),
});

function account() {
  const notes = [
    note(1, 20_000_000n, 'SPENT'), // deposit, 2 XLM
    note(2, 15_000_000n, 'SPENT'), // change of the send
    note(3, 10_000_000n, 'EXITED'), // change of the withdrawal, then exited
  ];
  const transacts = [
    // Send 0.5 XLM: spends note 1, change 1.5 to us, one output to the payee.
    { txHash: tx(2), outputCommitments: ['0x2', '0x777'], nullifierHashes: [nullifierOf(1)], withdrawnValue: '0x0', asset: XLM },
    // Withdraw 0.5 XLM through the relayer: spends note 2, change 1.0 to us.
    { txHash: tx(3), outputCommitments: ['0x3'], nullifierHashes: [nullifierOf(2)], withdrawnValue: '0x4c4b40', asset: XLM },
    // Somebody else's transact: nothing of ours.
    { txHash: tx(9), outputCommitments: ['0x999'], nullifierHashes: ['0x123'], withdrawnValue: '0x10', asset: XLM },
  ];
  const spends = reconstructStellarSpends({ notes, transacts, nullifyingKey: NK, hashService: fakeHash });
  const origins = buildStellarNoteOrigins({
    notes,
    deposits: [{ txHash: tx(1), outputCommitment: '0x1', depositor: ME }],
    transacts,
    logs: [1, 2, 3, 4].map((i) => ({ transactionHash: tx(i), ledger: `0x${(500 + i).toString(16)}`, ledgerClosedAt: `2026-09-30T10:0${i}:00Z` })),
    spends,
    ragequits: [
      { txHash: tx(4), commitment: '0x3' },
      { txHash: tx(8), commitment: '0x888' }, // not ours
    ],
  });
  return { notes, spends, origins };
}

describe('reconstructStellarSpends', () => {
  test('finds our send and withdrawal by nullifier, with exact amounts', () => {
    const { spends } = account();
    expect(spends).toEqual([
      { txHash: tx(2), kind: 'transfer', amount: '5000000', tokenId: XLM },
      { txHash: tx(3), kind: 'withdrawal', amount: '5000000', tokenId: XLM },
    ]);
  });

  test('without our nullifying key nothing matches', () => {
    const { notes } = account();
    const spends = reconstructStellarSpends({
      notes,
      transacts: [{ txHash: tx(2), outputCommitments: ['0x2', '0x777'], nullifierHashes: [nullifierOf(1)], withdrawnValue: '0x0' }],
      nullifyingKey: '0x6',
      hashService: fakeHash,
    });
    expect(spends).toEqual([]);
  });
});

describe('Stellar Sent / Withdrawal / Exit rows', () => {
  test('one row each, with chain time, and the exit only for our note', () => {
    const { notes, origins } = account();
    expect(origins.exits).toEqual([{ txHash: tx(4), commitment: '0x3', ledger: 504, time: Date.parse('2026-09-30T10:04:00Z') / 1000 }]);
    const activity = deriveStellarActivity(notes, origins, {
      ...CTX,
      sentRecipient: stellarSentRecipientLookup([{ txHash: `0x${tx(2).toUpperCase()}`, recipient: PAYEE, chainId: 202 }], 202),
    });
    const byType = (t: string) => activity.rows.filter((r) => r.type === t);
    const [sent] = byType('Transfer').filter((r) => r.direction === 'out');
    expect(sent).toMatchObject({ txHash: tx(2), rawAmount: '5000000', tokenAmount: 0.5, fullAddress: PAYEE, status: 'completed' });
    const [withdrawal] = byType('Withdrawal');
    expect(withdrawal).toMatchObject({ txHash: tx(3), rawAmount: '5000000', fullAddress: '' });
    const [exit] = byType('Exit');
    expect(exit).toMatchObject({ txHash: tx(4), rawAmount: '10000000', noteStatus: 'EXITED' });
    expect(activity.sentCount).toBe(1);
    expect(activity.withdrawalCount).toBe(2);
    expect(activity.depositCount).toBe(1);
    // Newest first.
    expect(activity.rows.map((r) => r.type)).toEqual(['Exit', 'Withdrawal', 'Transfer', 'Deposit']);
  });

  test('an index read without keys keeps the old rows only', () => {
    const { notes } = account();
    const origins = buildStellarNoteOrigins({
      notes,
      deposits: [{ txHash: tx(1), outputCommitment: '0x1', depositor: ME }],
      transacts: [],
      logs: [],
    });
    expect(origins.spends).toBeUndefined();
    const activity = deriveStellarActivity(notes, origins, CTX);
    expect(activity.rows.map((r) => r.type)).toEqual(['Deposit']);
  });
});

describe('stellarReceivedNotes (payment-request matching)', () => {
  test('own deposits and the change of own spends are not payments; a received note is, with its chain time', () => {
    const { notes } = account();
    const received = note(4, 7_000_000n, 'ACTIVE', '0xdef');
    const all = [...notes, received];
    const transacts = [
      { txHash: tx(2), outputCommitments: ['0x2', '0x777'], nullifierHashes: [nullifierOf(1)], withdrawnValue: '0x0' },
      { txHash: tx(3), outputCommitments: ['0x3'], nullifierHashes: [nullifierOf(2)], withdrawnValue: '0x4c4b40' },
      { txHash: tx(7), outputCommitments: ['0x4'], nullifierHashes: ['0x999'], withdrawnValue: '0x0' },
    ];
    const origins = buildStellarNoteOrigins({
      notes: all,
      deposits: [{ txHash: tx(1), outputCommitment: '0x1', depositor: ME }],
      transacts,
      logs: [1, 2, 3, 7].map((i) => ({ transactionHash: tx(i), ledger: `0x${(500 + i).toString(16)}`, ledgerClosedAt: `2026-09-30T10:0${i}:00Z` })),
      spends: reconstructStellarSpends({ notes: all, transacts, nullifyingKey: NK, hashService: fakeHash }),
    });
    const out = stellarReceivedNotes(all, origins, ME);
    expect(out.map((n) => n.commitment)).toEqual([received.commitment]);
    expect(Number(BigInt(out[0].createdAtBlock))).toBe(Date.parse('2026-09-30T10:07:00Z') / 1000);
  });
});

describe('Stellar self-transfer (Save to my account)', () => {
  test('its outputs are own, not a received payment, and it makes no row', () => {
    const claimed = note(5, 9_000_000n, 'SPENT', '0x555');
    const kept = note(6, 9_000_000n, 'ACTIVE', '0x555');
    const all = [claimed, kept];
    const transacts = [
      { txHash: tx(5), outputCommitments: ['0x5'], nullifierHashes: ['0x9'], withdrawnValue: '0x0' },
      { txHash: tx(6), outputCommitments: ['0x6'], nullifierHashes: [nullifierOf(5)], withdrawnValue: '0x0' },
    ];
    const spends = reconstructStellarSpends({ notes: all, transacts, nullifyingKey: NK, hashService: fakeHash });
    expect(spends.map((s) => s.kind)).toEqual(['internal']);
    const origins = buildStellarNoteOrigins({
      notes: all, deposits: [], transacts,
      logs: [5, 6].map((i) => ({ transactionHash: tx(i), ledger: `0x${(500 + i).toString(16)}`, ledgerClosedAt: `2026-09-30T10:0${i}:00Z` })),
      spends,
    });
    expect(stellarReceivedNotes(all, origins, ME).map((n) => n.commitment)).toEqual([claimed.commitment]);
    expect(deriveStellarActivity(all, origins, CTX).rows.filter((r) => r.direction === 'out' || r.type === 'Withdrawal')).toEqual([]);
  });

  test('no payment matching from an incomplete index', () => {
    const { notes, origins } = account();
    expect(stellarReceivedNotes(notes, { ...origins, complete: false }, ME)).toEqual([]);
  });
});
