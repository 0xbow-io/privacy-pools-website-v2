import { describe, expect, test } from 'bun:test';

import {
  buildStellarNoteOrigins,
  canonicalCommitment,
  countStellarDeposits,
  deriveStellarActivity,
  stellarDepositReview,
  type StellarActivityNote,
  type StellarNoteOrigins,
} from '@/services/stellar-activity';

// Shaped like a real rediscovered export (fresh-tab sign-in): no depositSecret,
// createdAtBlock "0x0000000000" on every note, the deposit note's value
// unpadded and later values 64-hex padded, commitments padded.
const ME = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const OTHER = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const LABEL = '0x08fd29f0';
const CTX = { chainId: 202, chainName: 'Stellar Testnet', symbol: 'XLM', decimals: 7, priceUsd: 0.5, ownAddress: ME };

const pad = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const hash = (n: number) => n.toString(16).padStart(64, 'a');

function note(i: number, overrides: Partial<StellarActivityNote & { createdAtBlock: string; spentAtBlock: string | null }> = {}) {
  return {
    noteAddressHash: pad(BigInt(1000 + i)),
    commitment: pad(BigInt(i)),
    value: pad(5_000_000n),
    tokenId: XLM,
    label: LABEL,
    status: 'SPENT',
    ownerAddress: ME,
    noteSecret: '0x[redacted]',
    isOwned: true,
    createdAtBlock: '0x0000000000',
    spentAtBlock: null,
    txHash: hash(i),
    ...overrides,
  };
}

/** The sender account from the browser test: one 2 XLM deposit, then spends. */
function senderAccount() {
  const notes = [
    note(1, { value: '0x01312d00' }), // the deposit note, 2 XLM
    note(2, { value: pad(15_000_000n) }),
    note(3, { value: pad(10_000_000n) }),
    note(4, { value: pad(4_000_000n) }),
    note(5, { value: pad(3_000_000n), status: 'ACTIVE' }),
  ];
  const origins = buildStellarNoteOrigins({
    notes,
    deposits: [
      { txHash: hash(1), outputCommitment: '0x1', depositor: ME },
      { txHash: hash(99), outputCommitment: '0x63', depositor: OTHER },
    ],
    transacts: [2, 3, 4, 5].map((i) => ({ txHash: hash(i), outputCommitments: [`0x${i.toString(16)}`, '0x777'] })),
    logs: [1, 2, 3, 4, 5, 99].map((i) => ({
      transactionHash: hash(i),
      ledger: `0x${(1000 + i).toString(16)}`,
      ledgerClosedAt: `2026-09-26T10:0${i % 10}:00Z`,
    })),
  });
  return { notes, origins };
}

describe('buildStellarNoteOrigins', () => {
  test('matches padded note commitments to unpadded event outputs, keeps only held notes', () => {
    const { origins } = senderAccount();
    expect(origins.complete).toBe(true);
    expect(Object.keys(origins.byCommitment).sort()).toEqual(['0x1', '0x2', '0x3', '0x4', '0x5']);
    expect(origins.byCommitment['0x1']).toMatchObject({ kind: 'deposit', depositor: ME, ledger: 1001 });
    expect(origins.byCommitment['0x3']).toMatchObject({ kind: 'transact', ledger: 1003 });
    expect(origins.byCommitment['0x1'].time).toBe(Date.parse('2026-09-26T10:01:00Z') / 1000);
  });

  test('a held note missing from the history makes the index incomplete', () => {
    const origins = buildStellarNoteOrigins({ notes: [note(1)], deposits: [], transacts: [], logs: [] });
    expect(origins).toEqual({ byCommitment: {}, complete: false });
  });
});

describe('deriveStellarActivity', () => {
  test('the real sender account: one 2 XLM Deposit, no Transfer in', () => {
    const { notes, origins } = senderAccount();
    const { rows, depositCount, receivedCount } = deriveStellarActivity(notes, origins, CTX);
    expect(depositCount).toBe(1);
    expect(receivedCount).toBe(0);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe('Deposit');
    expect(row.rawAmount).toBe('20000000');
    expect(row.tokenAmount).toBe(2);
    expect(row.usdValue).toBeCloseTo(1);
    // What the ragequit modal and the row menu match on, verbatim from the note.
    expect(row.label).toBe(LABEL);
    expect(row.txHash).toBe(hash(1));
    expect(row.reviewStatus).toBe('approved');
    expect(row.status).toBe('completed');
    expect(row.timestamp).toBe(Date.parse('2026-09-26T10:01:00Z'));
  });

  test('deposit review and outcome follow the note status', () => {
    const cases: Array<[string, string, string, string | undefined]> = [
      ['PENDING', 'pending', 'pending', undefined],
      ['ACTIVE', 'approved', 'completed', 'ready'],
      ['SPENT', 'approved', 'completed', undefined],
      // REJECTED can follow an approval: the deposit landed, its review is unknown.
      ['REJECTED', '', 'completed', 'at_risk'],
      ['EXIT_PENDING', '', 'completed', undefined],
      ['EXITED', '', 'completed', undefined],
    ];
    for (const [status, review, outcome, funds] of cases) {
      const n = note(1, { value: '0x01312d00', status });
      const origins = buildStellarNoteOrigins({ notes: [n], deposits: [{ txHash: hash(1), outputCommitment: '0x1', depositor: ME }], transacts: [], logs: [] });
      const [row] = deriveStellarActivity([n], origins, CTX).rows;
      expect(row.reviewStatus).toBe(review);
      expect(row.status).toBe(outcome);
      expect(row.fundsState).toBe(funds as never);
      expect(row.noteStatus).toBe(status);
    }
  });

  test('no event history, no rows (never a guess)', () => {
    const { notes } = senderAccount();
    expect(deriveStellarActivity(notes, null, CTX)).toEqual({ rows: [], depositCount: 0, receivedCount: 0, sentCount: 0, withdrawalCount: 0 });
  });

  test('an incomplete index still proves deposits but produces no Transfer in', () => {
    const own = note(1, { value: '0x01312d00' });
    const other = note(7, { label: '0xbeef' });
    const origins: StellarNoteOrigins = {
      byCommitment: { '0x1': { kind: 'deposit', depositor: ME, txHash: hash(1), ledger: 1, time: 0 } },
      complete: false,
    };
    const { rows } = deriveStellarActivity([own, other], origins, CTX);
    expect(rows.map((r) => r.type)).toEqual(['Deposit']);
    // Time unknown: kept, with no time for the row to show.
    expect(rows[0].timestamp).toBe(0);
  });

  test('a lineage started by someone else: its earliest transact output(s) are one Transfer in', () => {
    const received = [
      note(10, { label: '0xbeef', value: pad(20_000_000n) }),
      note(11, { label: '0xbeef', value: pad(5_000_000n), status: 'ACTIVE' }), // our later change
    ];
    const origins = buildStellarNoteOrigins({
      notes: received,
      deposits: [],
      transacts: [
        { txHash: hash(10), outputCommitments: ['0xa'] },
        { txHash: hash(11), outputCommitments: ['0xb'] },
      ],
      logs: [
        { transactionHash: hash(10), ledger: '0x10', ledgerClosedAt: '2026-09-26T09:00:00Z' },
        { transactionHash: hash(11), ledger: '0x20', ledgerClosedAt: '2026-09-26T09:30:00Z' },
      ],
    });
    const { rows, receivedCount, depositCount } = deriveStellarActivity(received, origins, CTX);
    expect(depositCount).toBe(0);
    expect(receivedCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'Transfer', direction: 'in', rawAmount: '20000000', tokenAmount: 2, txHash: hash(10) });
  });

  test('one transfer delivering notes of two lineages is one summed row', () => {
    const a = note(20, { label: '0xe2', value: pad(10_000_000n) });
    const b = note(21, { label: '0xe3', value: pad(20_000_000n), txHash: hash(20) });
    const origins = buildStellarNoteOrigins({
      notes: [a, b],
      deposits: [],
      transacts: [{ txHash: hash(20), outputCommitments: [a.commitment, b.commitment] }],
      logs: [],
    });
    const { rows, receivedCount } = deriveStellarActivity([a, b], origins, CTX);
    expect(receivedCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawAmount).toBe('30000000');
  });

  test('a deposit someone else made to this account reads as a Transfer in', () => {
    const n = note(30, { label: '0xd0', value: pad(10_000_000n), status: 'ACTIVE' });
    const origins = buildStellarNoteOrigins({
      notes: [n],
      deposits: [{ txHash: hash(30), outputCommitment: n.commitment, depositor: OTHER }],
      transacts: [],
      logs: [],
    });
    const { rows, depositCount } = deriveStellarActivity([n], origins, CTX);
    expect(depositCount).toBe(0);
    expect(rows.map((r) => [r.type, r.direction])).toEqual([['Transfer', 'in']]);
  });

  test('a note made after the index was read never turns our change into a receipt', () => {
    const { notes, origins } = senderAccount();
    const fresh = note(6, { value: pad(1_000_000n), status: 'ACTIVE' }); // not in the index yet
    const { rows } = deriveStellarActivity([...notes, fresh], origins, CTX);
    expect(rows.map((r) => r.type)).toEqual(['Deposit']);
  });

  test('two txs in a received lineage\'s first ledger cannot be ordered: no row', () => {
    const a = note(50, { label: '0xe5', value: pad(10_000_000n) });
    const b = note(51, { label: '0xe5', value: pad(4_000_000n), status: 'ACTIVE' });
    const origins = buildStellarNoteOrigins({
      notes: [a, b],
      deposits: [],
      transacts: [
        { txHash: hash(50), outputCommitments: [a.commitment] },
        { txHash: hash(51), outputCommitments: [b.commitment] },
      ],
      logs: [
        { transactionHash: hash(50), ledger: '0x30' },
        { transactionHash: hash(51), ledger: '0x30' },
      ],
    });
    const { rows, receivedCount } = deriveStellarActivity([a, b], origins, CTX);
    expect(rows).toHaveLength(0);
    expect(receivedCount).toBe(0);
  });

  test('countStellarDeposits matches the rows without an active chain', () => {
    const { notes, origins } = senderAccount();
    expect(countStellarDeposits(notes, origins, ME)).toBe(deriveStellarActivity(notes, origins, CTX).depositCount);
    expect(countStellarDeposits(notes, origins, OTHER)).toBe(0);
    expect(countStellarDeposits(notes, null, ME)).toBe(0);
  });

  test('foreign and duplicate notes are ignored', () => {
    const { notes, origins } = senderAccount();
    const foreign = note(40, { label: '0xf3', isOwned: false });
    expect(deriveStellarActivity([...notes, notes[0], foreign], origins, CTX).rows).toHaveLength(1);
  });
});

describe('helpers', () => {
  test('canonicalCommitment joins padded and unpadded spellings', () => {
    expect(canonicalCommitment(pad(1n))).toBe('0x1');
    expect(canonicalCommitment('0x01')).toBe('0x1');
  });

  test('stellarDepositReview keeps unknown statuses pending', () => {
    expect(stellarDepositReview('INACTIVE')).toBe('pending');
  });
});
