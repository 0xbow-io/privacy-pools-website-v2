import { describe, expect, test } from 'bun:test';

import {
  buildStellarNoteOrigins,
  canonicalCommitment,
  countStellarDeposits,
  dedupeRowsById,
  deriveStellarActivity,
  stellarDepositReview,
  stellarIncomingActions,
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

describe('DEV-501: deposit for another account, claimed links', () => {
  test('a recorded deposit-for is an outgoing Deposit, amount and time from its event, no recipient', () => {
    const { notes } = senderAccount();
    const origins = buildStellarNoteOrigins({
      notes,
      deposits: [
        { txHash: hash(1), outputCommitment: '0x1', depositor: ME, value: '0x01312d00' },
        { txHash: hash(42), outputCommitment: '0x2a', depositor: ME, value: '0x1312d00' },
      ],
      transacts: [2, 3, 4, 5].map((i) => ({ txHash: hash(i), outputCommitments: [`0x${i.toString(16)}`] })),
      logs: [{ transactionHash: hash(42), ledger: '0x10', ledgerClosedAt: '2026-10-02T10:00:00Z' }],
      authoredDepositTxHashes: [hash(42)],
    });
    expect(origins.authored).toEqual([{ txHash: hash(42), amount: '20000000', ledger: 16, time: Date.parse('2026-10-02T10:00:00Z') / 1000 }]);
    const { rows, depositCount, receivedCount } = deriveStellarActivity(notes, origins, { ...CTX, depositsFor: [{ txHash: hash(42) }] });
    const row = rows.find((r) => r.id === `stellar-deposit-for-${hash(42)}`);
    expect(row).toMatchObject({ type: 'Deposit', depositFor: true, fullAddress: ME, rawAmount: '20000000', status: 'completed', reviewStatus: '' });
    expect(row?.timestamp).toBe(Date.parse('2026-10-02T10:00:00Z'));
    expect(JSON.stringify(rows)).not.toContain(OTHER);
    expect(depositCount).toBe(1);
    expect(receivedCount).toBe(0);
  });

  test('a recorded deposit-for not in the index yet makes no row', () => {
    const { notes, origins } = senderAccount();
    const { rows } = deriveStellarActivity(notes, origins, { ...CTX, depositsFor: [{ txHash: hash(42) }] });
    expect(rows.some((r) => r.type === 'Deposit' && r.depositFor)).toBe(false);
  });

  test("the recipient's note, held by the depositor's browser, stays out of the depositor's view", () => {
    const recipientNote = note(9, { ownerAddress: OTHER, status: 'ACTIVE', label: '0x99' });
    const origins = buildStellarNoteOrigins({
      notes: [recipientNote],
      deposits: [{ txHash: hash(9), outputCommitment: '0x9', depositor: ME }],
      transacts: [],
      logs: [{ transactionHash: hash(9), ledger: '0x10', ledgerClosedAt: '2026-10-02T10:00:00Z' }],
    });
    const { rows } = deriveStellarActivity([recipientNote], origins, CTX);
    expect(rows).toEqual([]);
  });

  test('a note of a recorded deposit-for is not counted as our own deposit', () => {
    const n = note(9, { ownerAddress: undefined, status: 'ACTIVE', label: '0x99' });
    const origins = buildStellarNoteOrigins({
      notes: [n],
      deposits: [{ txHash: hash(9), outputCommitment: '0x9', depositor: ME }],
      transacts: [],
      logs: [],
    });
    const { rows, depositCount } = deriveStellarActivity([n], origins, { ...CTX, depositsFor: [{ txHash: hash(9) }] });
    expect(depositCount).toBe(0);
    expect(rows).toEqual([]);
  });

  test('the recipient session still sees a deposit made for it as received', () => {
    const n = note(9, { status: 'ACTIVE', label: '0x99' });
    const origins = buildStellarNoteOrigins({
      notes: [n],
      deposits: [{ txHash: hash(9), outputCommitment: '0x9', depositor: OTHER }],
      transacts: [],
      logs: [],
    });
    const [row] = deriveStellarActivity([n], origins, CTX).rows;
    expect(row).toMatchObject({ type: 'Transfer', direction: 'in' });
  });

  test('a claimed note not indexed yet is a Pending Transfer In, not counted', () => {
    const { notes, origins } = senderAccount();
    const claimedNote = note(20, { status: 'PENDING', label: '0x20', value: pad(7_000_000n) });
    const claimed = [{ commitment: claimedNote.commitment, txHash: hash(20), claimedAt: 1_700_000_000_000 }];
    const { rows, receivedCount } = deriveStellarActivity([...notes, claimedNote], origins, { ...CTX, claimed });
    const row = rows.find((r) => r.id === `stellar-in-${claimedNote.commitment}`);
    expect(row).toMatchObject({ type: 'Transfer', direction: 'in', status: 'pending', rawAmount: '7000000', timestamp: 1_700_000_000_000 });
    expect(receivedCount).toBe(0);
  });

  test("a claim whose transfer never landed stays Pending and is never counted", () => {
    // Link built with txHash 0x0 before the send; the send reverted, so no
    // index read ever gives the note an origin.
    const claimedNote = note(21, { status: 'PENDING', label: '0x21', txHash: '0x0' });
    const origins = buildStellarNoteOrigins({ notes: [], deposits: [], transacts: [], logs: [] });
    const claimed = [{ commitment: claimedNote.commitment, txHash: '0x0', claimedAt: 5_000 }];
    const { rows, receivedCount } = deriveStellarActivity([claimedNote], origins, { ...CTX, claimed });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', direction: 'in' });
    expect(rows.some((r) => r.status === 'completed')).toBe(false);
    expect(receivedCount).toBe(0);
  });

  test('once indexed, the claimed note keeps exactly one row', () => {
    const claimedNote = note(20, { status: 'ACTIVE', label: '0x20' });
    const origins = buildStellarNoteOrigins({
      notes: [claimedNote],
      deposits: [],
      transacts: [{ txHash: hash(20), outputCommitments: ['0x14'] }],
      logs: [],
    });
    const claimed = [{ commitment: claimedNote.commitment, txHash: hash(20), claimedAt: 1 }];
    const { rows } = deriveStellarActivity([claimedNote], origins, { ...CTX, claimed });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'Transfer', direction: 'in', status: 'completed' });
  });
});

describe('DEV-501: before the first index read', () => {
  test('a claimed note shows as Pending, nothing else and nothing completed', () => {
    const { notes } = senderAccount();
    const claimedNote = note(30, { status: 'PENDING', label: '0x30' });
    const claimed = [{ commitment: claimedNote.commitment, txHash: hash(30), claimedAt: 9_000 }];
    const a = deriveStellarActivity([...notes, claimedNote], null, { ...CTX, claimed, depositsFor: [{ txHash: hash(42) }] });
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ type: 'Transfer', direction: 'in', status: 'pending' });
    expect(a).toMatchObject({ depositCount: 0, receivedCount: 0, sentCount: 0, withdrawalCount: 0 });
  });
});

describe('dedupeRowsById: one row per id whichever source lands first', () => {
  const row = (extra: Record<string, unknown>) => ({ id: 'stellar-deposit-for-0x2a', type: 'Deposit', timestamp: 1, ...extra }) as unknown as Parameters<typeof dedupeRowsById>[0][number];

  test('a deposit-for described twice (device record and saved claim) is one row', () => {
    const out = dedupeRowsById([row({ fullAddress: 'GRECIPIENT', direction: 'out' }), row({ fullAddress: 'GME', depositFor: true })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fullAddress: 'GRECIPIENT', depositFor: true });
  });

  test('the depositFor flag survives in the other order too', () => {
    const out = dedupeRowsById([row({ fullAddress: 'GME', depositFor: true }), row({ fullAddress: 'GRECIPIENT', direction: 'out' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fullAddress: 'GME', depositFor: true });
  });

  test('distinct ids are all kept, in order', () => {
    const out = dedupeRowsById([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'a' })]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('Stellar incoming row fund actions', () => {
  const row = { chainId: 202, type: 'Transfer', direction: 'in' as const, label: LABEL, tokenAddress: XLM };
  test('a received deposit uses owned note status, not the completed receipt status', () => {
    for (const [status, canWithdraw, canExit] of [
      ['ACTIVE', true, true], ['PENDING', false, true], ['REJECTED', false, true],
      ['SPENT', false, false], ['EXITED', false, false], ['EXIT_PENDING', false, false], ['INACTIVE', false, false],
    ] as const) {
      const n = note(1, { status });
      const origins = buildStellarNoteOrigins({ notes: [n], deposits: [{ txHash: n.txHash, outputCommitment: n.commitment, depositor: OTHER }], transacts: [], logs: [] });
      const { rows } = deriveStellarActivity([n], origins, CTX);
      expect(rows[0].type).toBe('Transfer');
      expect(stellarIncomingActions(rows[0], [n], ME)).toEqual({ canWithdraw, canExit });
    }
  });
  test('partial spending keeps actions through live change, but zero-value change does not', () => {
    const spent = note(1);
    const change = note(2, { status: 'ACTIVE', label: pad(BigInt(LABEL)) });
    expect(stellarIncomingActions(row, [spent, change], ME)).toEqual({ canWithdraw: true, canExit: true });
    expect(stellarIncomingActions(row, [spent, { ...change, value: '0x0' }], ME)).toEqual({ canWithdraw: false, canExit: false });
  });
  test('other owners, assets, lineages and unowned notes cannot enable actions', () => {
    for (const n of [note(1, { status: 'ACTIVE', ownerAddress: OTHER }), note(1, { status: 'ACTIVE', isOwned: false }),
      note(1, { status: 'ACTIVE', label: '0x99' }), note(1, { status: 'ACTIVE', tokenId: 'another-asset' })]) {
      expect(stellarIncomingActions(row, [n], ME)).toEqual({ canWithdraw: false, canExit: false });
    }
    expect(stellarIncomingActions({ ...row, label: '0x0' }, [note(1, { status: 'ACTIVE', label: '0x0' })], ME)).toEqual({ canWithdraw: false, canExit: false });
    expect(stellarIncomingActions(row, [note(1, { status: 'ACTIVE' })], null)).toEqual({ canWithdraw: false, canExit: false });
  });
  test('sender deposit-for, outgoing transfers and other chains retain their existing rules', () => {
    for (const otherRow of [{ ...row, type: 'Deposit' }, { ...row, direction: 'out' as const }, { ...row, chainId: 1 }]) {
      expect(stellarIncomingActions(otherRow, [note(1, { status: 'ACTIVE' })], ME)).toEqual({ canWithdraw: false, canExit: false });
    }
  });
});

describe('indexed Stellar incoming status', () => {
  test('registered and claimed receipts stay pending until the local note is active', () => {
    for (const claimed of [false, true]) {
      for (const [status, outcome, review, funds] of [
        ['PENDING', 'pending', 'pending', undefined],
        ['INACTIVE', 'pending', 'pending', undefined],
        ['ACTIVE', 'completed', 'approved', 'ready'],
        ['SPENT', 'completed', 'approved', undefined],
        ['REJECTED', 'completed', '', 'at_risk'],
        ['EXIT_PENDING', 'completed', '', undefined],
        ['EXITED', 'completed', '', undefined],
      ] as const) {
        const n = note(1, { status, value: '1000000000' });
        const origins = buildStellarNoteOrigins({ notes: [n], deposits: [{ txHash: n.txHash, outputCommitment: n.commitment, depositor: OTHER }], transacts: [], logs: [] });
        const ctx = { ...CTX, claimed: claimed ? [{ commitment: n.commitment, txHash: n.txHash, claimedAt: 1 }] : [] };
        const { rows, receivedCount, depositCount } = deriveStellarActivity([n], origins, ctx);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ type: 'Transfer', direction: 'in', rawAmount: '1000000000', noteStatus: status, status: outcome, reviewStatus: review });
        expect(rows[0].fundsState).toBe(funds);
        expect(receivedCount).toBe(1);
        expect(depositCount).toBe(0);
      }
    }
  });
});
