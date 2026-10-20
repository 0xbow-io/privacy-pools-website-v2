import { describe, expect, test } from 'bun:test';

import { mergeClaimsByPayment, reconstructUserSpends, snapshotTimestampToMs } from '@/services/outgoing-transfers';
import type { SnapshotTransact } from '@/services/api-types';
import type { Hex, Secret } from '@/services/sdk-types';

// Deterministic stand-in for the Poseidon hash service: nullifier of a
// commitment 0x..N under key K becomes a unique, stable hex value.
const fakeHashService = {
  hash: (inputs: Hex[]): Hex => `0x${(BigInt(inputs[0]) * 1_000_003n + BigInt(inputs[1])).toString(16)}` as Hex,
};

const KEY = '0x0abc' as Secret;
const nullifierOf = (commitment: string): string =>
  `0x${BigInt(fakeHashService.hash([KEY, commitment as Hex])).toString(16).padStart(64, '0')}`;

const TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Hex;

function note(commitment: string, value: bigint) {
  return {
    commitment: commitment as Hex,
    value: `0x${value.toString(16)}` as Hex,
    tokenId: TOKEN,
  };
}

function transact(overrides: Partial<SnapshotTransact>): SnapshotTransact {
  return {
    txHash: '0xtx',
    logIndex: 0,
    outputCommitments: [],
    nullifierHashes: [],
    caller: '0xcaller',
    withdrawnValue: '0',
    encryptedPayload: null,
    blockNumber: '1',
    blockTimestamp: '1750000000',
    asset: TOKEN,
    ...overrides,
  };
}

// User owns a 1.0 input and the 0.9 change; the second output belongs to the
// recipient. withdrawnValue is the public relay fee.
const oneEth = 10n ** 18n;

describe('reconstructUserSpends', () => {
  test('a reshield (spend + re-deposit in one tx) is a swap of the gross, not internal', () => {
    // 1.0 in, 0.9 change (owned, the only Transacted output), and a NEW note
    // of mine created in the same tx by the embedded deposit: a different
    // label, not among the outputs. No withdrawnValue was recorded.
    const notes = [
      { ...note('0x01', oneEth), label: '0xaa' as Hex, txHash: '0xdeposit' as Hex },
      { ...note('0x02', (oneEth * 9n) / 10n), label: '0xaa' as Hex, txHash: '0xreshield' as Hex },
      { ...note('0x77', (oneEth * 95n) / 1000n), label: '0xbb' as Hex, txHash: '0xreshield' as Hex },
    ];
    const spends = reconstructUserSpends(
      notes,
      [transact({ txHash: '0xreshield', nullifierHashes: [nullifierOf('0x01')], outputCommitments: ['0x02'], withdrawnValue: '0' })],
      KEY,
      fakeHashService,
    );
    expect(spends).toHaveLength(1);
    expect(spends[0].kind).toBe('swap');
    expect(spends[0].amount).toBe(oneEth / 10n);
    expect(spends[0].swapOutputs?.map((o) => [o.commitment, o.label, o.value])).toEqual([['0x77', '0xbb', (oneEth * 95n) / 1000n]]);
  });

  test('a plain self merge/split with no new lineage stays internal', () => {
    const notes = [
      { ...note('0x01', oneEth), label: '0xaa' as Hex, txHash: '0xdeposit' as Hex },
      { ...note('0x02', oneEth), label: '0xaa' as Hex, txHash: '0xmerge' as Hex },
    ];
    const spends = reconstructUserSpends(
      notes,
      [transact({ txHash: '0xmerge', nullifierHashes: [nullifierOf('0x01')], outputCommitments: ['0x02'], withdrawnValue: '0' })],
      KEY,
      fakeHashService,
    );
    expect(spends[0].kind).toBe('internal');
  });

  test('a consolidation on the transfer route is a fee row, not a withdrawal of the fee', () => {
    // BSC 0x20a869c4: three notes of one deposit folded into one, the relayer's
    // 0.0000425 BNB fee the only value out. One output per label, so arity
    // alone reads it as the withdrawal builder's shape.
    const SIGNER = '0x9e2f1b234953f46c6091636290e9035618ea3c07';
    const fee = 42500000021000n;
    const notes = [
      { ...note('0x01', oneEth), label: '0xaa' as Hex, txHash: '0xd1' as Hex },
      { ...note('0x02', oneEth), label: '0xaa' as Hex, txHash: '0xd2' as Hex },
      { ...note('0x03', oneEth), label: '0xaa' as Hex, txHash: '0xd3' as Hex },
      { ...note('0x04', 3n * oneEth - fee), label: '0xaa' as Hex, txHash: '0xconsolidate' as Hex },
    ];
    const log = (caller: string) => ({
      ...transact({
        txHash: '0xconsolidate',
        caller,
        nullifierHashes: [nullifierOf('0x01'), nullifierOf('0x02'), nullifierOf('0x03')],
        outputCommitments: ['0x04'],
        withdrawnValue: `${fee}`,
      }),
      chainId: 56,
    });
    const isTransferRouteCaller = (caller: string | null | undefined, chainId: number | undefined) =>
      chainId === 56 && caller?.toLowerCase() === SIGNER;

    const consolidation = reconstructUserSpends(notes, [log(SIGNER)], KEY, fakeHashService, { isTransferRouteCaller });
    expect(consolidation[0].kind).toBe('fee');
    expect(consolidation[0].amount).toBe(0n);
    expect(consolidation[0].fee).toBe(fee);
    // What the row names it from: three notes in, one out, and the value that
    // stayed mine.
    expect(consolidation[0].inputCount).toBe(3);
    expect(consolidation[0].outputCount).toBe(1);
    expect(consolidation[0].consolidation).toEqual({ spent: 3, created: 1 });
    expect(consolidation[0].ownOutputValue).toBe(3n * oneEth - fee);

    // The same arity through the relay contract is a real withdrawal.
    const withdrawal = reconstructUserSpends(notes, [log('0x01a8fa4dbb60187ad8d3c3d08e7fb8c14198a461')], KEY, fakeHashService, { isTransferRouteCaller });
    expect(withdrawal[0].kind).toBe('withdrawal');
    expect(withdrawal[0].amount).toBe(fee);
  });

  test('classifies a relayed transfer with exact recipient-facing amount', () => {
    const notes = [note('0x01', oneEth), note('0x02', (oneEth * 9n) / 10n)];
    const spends = reconstructUserSpends(
      notes,
      [transact({
        txHash: '0xaaa',
        nullifierHashes: [nullifierOf('0x01')],
        outputCommitments: ['0x02', '0x99'],
        withdrawnValue: `${oneEth / 100n}`,
      })],
      KEY,
      fakeHashService,
    );
    expect(spends.length).toBe(1);
    expect(spends[0].kind).toBe('transfer');
    // gross = 1.0 - 0.9 = 0.1; amount = 0.1 - 0.01 fee = 0.09
    expect(spends[0].grossOutflow).toBe(oneEth / 10n);
    expect(spends[0].fee).toBe(oneEth / 100n);
    expect(spends[0].amount).toBe(oneEth / 10n - oneEth / 100n);
  });

  test('classifies a withdrawal (all outputs owned, value left the pool)', () => {
    const notes = [note('0x01', oneEth), note('0x02', (oneEth * 9n) / 10n)];
    const spends = reconstructUserSpends(
      notes,
      [transact({
        txHash: '0xbbb',
        nullifierHashes: [nullifierOf('0x01')],
        outputCommitments: ['0x02'],
        withdrawnValue: `${oneEth / 10n}`,
      })],
      KEY,
      fakeHashService,
    );
    expect(spends.length).toBe(1);
    expect(spends[0].kind).toBe('withdrawal');
    expect(spends[0].amount).toBe(oneEth / 10n);
  });

  test('classifies a self merge/split as internal (no user-facing amount)', () => {
    const notes = [note('0x01', oneEth), note('0x02', oneEth / 2n), note('0x03', oneEth / 2n)];
    const spends = reconstructUserSpends(
      notes,
      [transact({
        txHash: '0xccc',
        nullifierHashes: [nullifierOf('0x01')],
        outputCommitments: ['0x02', '0x03'],
        withdrawnValue: '0',
      })],
      KEY,
      fakeHashService,
    );
    expect(spends.length).toBe(1);
    expect(spends[0].kind).toBe('internal');
    expect(spends[0].amount).toBe(0n);
  });

  test("skips transacts that spend someone else's notes", () => {
    const notes = [note('0x01', oneEth)];
    const spends = reconstructUserSpends(
      notes,
      [transact({
        txHash: '0xddd',
        nullifierHashes: ['0x77'],
        outputCommitments: ['0x88', '0x89'],
        withdrawnValue: '0',
      })],
      KEY,
      fakeHashService,
    );
    expect(spends.length).toBe(0);
  });

  test('folds a batch (N Transacted logs, one txHash) into one aggregate withdrawal', () => {
    // A 2-item batch: item A spends 0.6 (full withdrawal, 0-value change 0x91),
    // item B spends 0.5 (full withdrawal, 0-value change 0x92). Both logs carry
    // the SAME txHash and each reports its own withdrawnValue.
    const notes = [
      note('0x01', (oneEth * 6n) / 10n),
      note('0x02', (oneEth * 5n) / 10n),
      note('0x91', 0n),
      note('0x92', 0n),
    ];
    const spends = reconstructUserSpends(
      notes,
      [
        transact({
          txHash: '0xbatch',
          logIndex: 0,
          nullifierHashes: [nullifierOf('0x01')],
          outputCommitments: ['0x91'],
          withdrawnValue: `${(oneEth * 6n) / 10n}`,
        }),
        transact({
          txHash: '0xbatch',
          logIndex: 1,
          nullifierHashes: [nullifierOf('0x02')],
          outputCommitments: ['0x92'],
          withdrawnValue: `${(oneEth * 5n) / 10n}`,
        }),
      ],
      KEY,
      fakeHashService,
    );
    // ONE spend row for the batch tx, not two.
    expect(spends.length).toBe(1);
    expect(spends[0].txHash).toBe('0xbatch');
    expect(spends[0].kind).toBe('withdrawal');
    // Aggregate value that left the pool = 0.6 + 0.5 = 1.1 ETH.
    expect(spends[0].amount).toBe((oneEth * 11n) / 10n);
    expect(spends[0].grossOutflow).toBe((oneEth * 11n) / 10n);
  });

  // The label-aware discriminator (services/transact-shape.ts). The fixtures
  // above deliberately carry no `label`, which exercises the unknown-labels
  // fallback; these two carry labels, which is what real notes always do, and
  // they are the pair that actually pins the fix. Same all-owned-outputs,
  // same withdrawnValue > 0 - only the label-to-output arity differs, and that
  // alone must flip the verdict.
  test('an ANCHOR (self-transfer: 1 input label, 2 owned outputs) reports a FEE, not a withdrawal', () => {
    // Pat's transaction, 2026-09-01: he anchored a link-received note. One
    // input, two owned outputs (zero-value change + the self-recipient note),
    // and withdrawnValue is entirely the relayer's fee. This used to render as
    // "Withdrawal 0.0005 ETH" with fee 0, and reached the Koinly CSV as a
    // phantom disposal.
    const feeWei = 539379930021000n;
    const notes = [
      { ...note('0x01', oneEth), label: '0xaa' as Hex },
      { ...note('0x91', 0n), label: '0xaa' as Hex },
      { ...note('0x92', oneEth - feeWei), label: '0xaa' as Hex },
    ];
    const spends = reconstructUserSpends(
      notes,
      [transact({
        txHash: '0xanchor',
        nullifierHashes: [nullifierOf('0x01')],
        outputCommitments: ['0x91', '0x92'],
        withdrawnValue: `${feeWei}`,
      })],
      KEY,
      fakeHashService,
    );
    expect(spends.length).toBe(1);
    expect(spends[0].kind).toBe('fee');
    // The whole point: no amount is claimed, and the outflow is named a fee.
    expect(spends[0].amount).toBe(0n);
    expect(spends[0].fee).toBe(feeWei);
    expect(spends[0].inputCount).toBe(1);
    expect(spends[0].outputCount).toBe(2);
    // A recipient output on top of the change: not the Consolidate action.
    expect(spends[0].consolidation).toBeUndefined();
  });

  test('a stamped GASLESS claim is the receipt of the claimed note, not a withdrawal or a fee', () => {
    // The gasless claim path cannot use relayTransfer because it also bundles
    // keystore registration; it submits relayWithdraw/registerAndWithdraw with
    // one change note per input label. Shape alone is therefore M === labels,
    // indistinguishable from a plain withdrawal. The confirmed local stamp is
    // the only positive intent signal for this SDK path.
    //
    // withdrawnValue from the DEV-450 claim: payout 32532542500000 (gas top-up
    // to the claimer's wallet) + relayer fee 32532532542500. That sum used to
    // render as a lone "Relayer fee" row while the payment itself had none.
    const feeWei = 65065075042500n;
    const notes = [
      // The claimed note keeps the SENDER's tx: that is the payment.
      { ...note('0x01', oneEth), label: '0xaa' as Hex, txHash: '0xSenderTx' as Hex },
      { ...note('0x91', oneEth - feeWei), label: '0xaa' as Hex, txHash: '0xgasless' as Hex },
    ];
    const spends = reconstructUserSpends(
      notes,
      [transact({
        txHash: '0xgasless',
        nullifierHashes: [nullifierOf('0x01')],
        outputCommitments: ['0x91'],
        withdrawnValue: `${feeWei}`,
      })],
      KEY,
      fakeHashService,
      { anchorTxHashes: new Set(['0xgasless']) },
    );
    expect(spends.length).toBe(1);
    expect(spends[0].kind).toBe('claim');
    // What arrived, not what is left after the claim cost.
    expect(spends[0].amount).toBe(oneEth);
    expect(spends[0].fee).toBe(feeWei);
    // The row is keyed by the payment, so a feed or lineage row for the same
    // payment dedupes against it instead of rendering twice.
    expect(spends[0].receivedTxHash).toBe('0xsendertx');
  });

  test('a stamped SELF-FUNDED claim (relayTransfer, all outputs owned) is also the receipt', () => {
    // Without the stamp this shape is the anchor-FEE case above. With it, the
    // inputs are known to be received notes, so the row is the payment.
    const feeWei = 539379930021000n;
    const notes = [
      { ...note('0x01', oneEth), label: '0xaa' as Hex },
      { ...note('0x91', 0n), label: '0xaa' as Hex },
      { ...note('0x92', oneEth - feeWei), label: '0xaa' as Hex },
    ];
    const spends = reconstructUserSpends(
      notes,
      [transact({
        txHash: '0xselfclaim',
        nullifierHashes: [nullifierOf('0x01')],
        outputCommitments: ['0x91', '0x92'],
        withdrawnValue: `${feeWei}`,
      })],
      KEY,
      fakeHashService,
      { anchorTxHashes: new Set(['0xselfclaim']) },
    );
    expect(spends.length).toBe(1);
    expect(spends[0].kind).toBe('claim');
    expect(spends[0].amount).toBe(oneEth);
    expect(spends[0].fee).toBe(feeWei);
    // The input names no creating tx: the row falls back to the claim tx.
    expect(spends[0].receivedTxHash).toBeUndefined();
  });

  test('a MIXED-LABEL withdrawal keeps its amount, though it also has 2 owned outputs', () => {
    // The regression guard for the same change. Two distinct input labels means
    // the SDK emits two change notes, so output count alone looks identical to
    // the anchor above. Only labels-vs-outputs separates them, and a real
    // withdrawal must keep reporting the value that left the pool.
    const out = (oneEth * 11n) / 10n;
    const notes = [
      { ...note('0x01', (oneEth * 6n) / 10n), label: '0xaa' as Hex },
      { ...note('0x02', (oneEth * 5n) / 10n), label: '0xbb' as Hex },
      { ...note('0x91', 0n), label: '0xaa' as Hex },
      { ...note('0x92', 0n), label: '0xbb' as Hex },
    ];
    const spends = reconstructUserSpends(
      notes,
      [transact({
        txHash: '0xmixed',
        nullifierHashes: [nullifierOf('0x01'), nullifierOf('0x02')],
        outputCommitments: ['0x91', '0x92'],
        withdrawnValue: `${out}`,
      })],
      KEY,
      fakeHashService,
    );
    expect(spends.length).toBe(1);
    expect(spends[0].kind).toBe('withdrawal');
    expect(spends[0].amount).toBe(out);
  });

  test('a batch of withdrawals SHARING an input label is still a withdrawal, not a fee', () => {
    // The regression codex caught in the first cut of the shape change. A batch
    // relays several transacts under one tx hash, and the first version compared
    // the bucket's TOTAL outputs (2) against its TOTAL distinct labels (1), which
    // looks exactly like a self-transfer - so a real batch withdrawal rendered as
    // a fee row with amount 0. Shape is now decided per LOG: each item here is
    // one label and one output, so each is a withdrawal.
    const out = (oneEth * 11n) / 10n;
    const notes = [
      { ...note('0x01', (oneEth * 6n) / 10n), label: '0xaa' as Hex },
      { ...note('0x02', (oneEth * 5n) / 10n), label: '0xaa' as Hex },
      { ...note('0x91', 0n), label: '0xaa' as Hex },
      { ...note('0x92', 0n), label: '0xaa' as Hex },
    ];
    const spends = reconstructUserSpends(
      notes,
      [
        transact({
          txHash: '0xsharedlabel',
          logIndex: 0,
          nullifierHashes: [nullifierOf('0x01')],
          outputCommitments: ['0x91'],
          withdrawnValue: `${(oneEth * 6n) / 10n}`,
        }),
        transact({
          txHash: '0xsharedlabel',
          logIndex: 1,
          nullifierHashes: [nullifierOf('0x02')],
          outputCommitments: ['0x92'],
          withdrawnValue: `${(oneEth * 5n) / 10n}`,
        }),
      ],
      KEY,
      fakeHashService,
    );
    expect(spends.length).toBe(1);
    expect(spends[0].kind).toBe('withdrawal');
    // The money must still be reported, in full.
    expect(spends[0].amount).toBe(out);
  });

  test('sums multi-input spends via nullifier matching (#215)', () => {
    // 0.6 + 0.5 spent, 0.2 change back, recipient got 0.9.
    const notes = [
      note('0x01', (oneEth * 6n) / 10n),
      note('0x02', (oneEth * 5n) / 10n),
      note('0x03', (oneEth * 2n) / 10n),
    ];
    const spends = reconstructUserSpends(
      notes,
      [transact({
        txHash: '0xeee',
        nullifierHashes: [nullifierOf('0x01'), nullifierOf('0x02')],
        outputCommitments: ['0x03', '0x99'],
        withdrawnValue: '0',
      })],
      KEY,
      fakeHashService,
    );
    expect(spends.length).toBe(1);
    expect(spends[0].kind).toBe('transfer');
    expect(spends[0].amount).toBe((oneEth * 9n) / 10n);
  });
});

describe('snapshotTimestampToMs (#215 codex)', () => {
  test('parses ISO datetime strings (previously collapsed to 1970)', () => {
    const iso = '2026-04-29T21:41:12.000Z';
    expect(snapshotTimestampToMs(iso)).toBe(Date.parse(iso));
    // Not epoch 0, and lands in 2026, not 1970.
    expect(snapshotTimestampToMs(iso) === 0).toBe(false);
    expect(new Date(snapshotTimestampToMs(iso)).getUTCFullYear()).toBe(2026);
  });

  test('parses unix seconds and milliseconds', () => {
    expect(snapshotTimestampToMs('1750000000')).toBe(1750000000000); // seconds -> ms
    expect(snapshotTimestampToMs('1750000000000')).toBe(1750000000000); // already ms
    expect(snapshotTimestampToMs(1750000000)).toBe(1750000000000);
  });

  test('returns 0 for empty / unparseable / nullish input', () => {
    expect(snapshotTimestampToMs('')).toBe(0);
    expect(snapshotTimestampToMs('   ')).toBe(0);
    expect(snapshotTimestampToMs('not-a-date')).toBe(0);
    expect(snapshotTimestampToMs(null)).toBe(0);
    expect(snapshotTimestampToMs(undefined)).toBe(0);
  });
});

describe('a spend knows its chain (Mike, 2026-09-24)', () => {
  test('the transact row names the chain, and the spend carries it', () => {
    const notes = [note('0x01', oneEth), note('0x02', (oneEth * 9n) / 10n)];
    const spends = reconstructUserSpends(
      notes,
      [{ ...transact({ txHash: '0xbbb', nullifierHashes: [nullifierOf('0x01')], outputCommitments: ['0x02', '0x99'], withdrawnValue: `${oneEth / 100n}` }), chainId: 56 }],
      KEY,
      fakeHashService,
    );
    expect(spends[0].kind).toBe('transfer');
    expect(spends[0].chainId).toBe(56);
    expect(spends[0].amount).toBe(oneEth / 10n - oneEth / 100n);
  });
});

describe('own transfers are explained from every chain\'s notes', () => {
  const read = (rel: string) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', rel), 'utf8') as string;

  test('the spend reconstruction reads every chain, and the row uses the spend\'s chain', () => {
    const src = read('components/pools-provider.tsx');
    expect(src).toContain('reconstructUserSpends(spendNotes, transacts');
    expect(src).toContain('tagNotesByChain(');
  });

  test('the row decodes direction from the session chain only, so another chain\'s change never reads as Transfer In', () => {
    const src = read('components/pools/transactions.tsx');
    expect(src).not.toContain('classifyTransfer(tx, allOwnedNotes');
    expect(src).not.toContain('computeUserTransferAmount(tx, allOwnedNotes');
    expect(read('components/pools-provider.tsx')).toContain('[notes, sessionAddress, myAddress, syncedHoldings]');
  });
});

describe('claim payment key (DEV-450)', () => {
  test('a placeholder 0x0 note hash is not a payment', () => {
    const notes = [
      { ...note('0x01', oneEth), label: '0xaa' as Hex, txHash: '0x0' as Hex },
      { ...note('0x91', oneEth - 5n), label: '0xaa' as Hex, txHash: '0xclaim' as Hex },
    ];
    const spends = reconstructUserSpends(
      notes,
      [transact({ txHash: '0xclaim', nullifierHashes: [nullifierOf('0x01')], outputCommitments: ['0x91'], withdrawnValue: '5' })],
      KEY,
      fakeHashService,
      { anchorTxHashes: new Set(['0xclaim']) },
    );
    expect(spends[0].kind).toBe('claim');
    expect(spends[0].receivedTxHash).toBeUndefined();
  });
});

describe('mergeClaimsByPayment (DEV-450)', () => {
  test('a self-funded claim of a 14 + 14 payment is ONE spend of 28', () => {
    // Two lineage notes delivered by one sender tx, anchored one tx each.
    const notes = [
      { ...note('0x01', 14n * oneEth), label: '0xaa' as Hex, txHash: '0xpay' as Hex },
      { ...note('0x02', 14n * oneEth), label: '0xbb' as Hex, txHash: '0xpay' as Hex },
      { ...note('0x91', 14n * oneEth - 5n), label: '0xaa' as Hex, txHash: '0xclaim1' as Hex },
      { ...note('0x92', 14n * oneEth - 7n), label: '0xbb' as Hex, txHash: '0xclaim2' as Hex },
    ];
    const spends = reconstructUserSpends(
      notes,
      [
        transact({ txHash: '0xclaim1', nullifierHashes: [nullifierOf('0x01')], outputCommitments: ['0x91'], withdrawnValue: '5' }),
        transact({ txHash: '0xclaim2', nullifierHashes: [nullifierOf('0x02')], outputCommitments: ['0x92'], withdrawnValue: '7' }),
      ],
      KEY,
      fakeHashService,
      { anchorTxHashes: new Set(['0xclaim1', '0xclaim2']) },
    );
    expect(spends.map((s) => s.receivedTxHash)).toEqual(['0xpay', '0xpay']);
    const merged = mergeClaimsByPayment(spends);
    expect(merged.length).toBe(1);
    expect(merged[0].amount).toBe(28n * oneEth);
    expect(merged[0].fee).toBe(12n);
    expect(merged[0].txHash).toBe('0xclaim1');
    // The input list is not mutated.
    expect(spends[0].amount).toBe(14n * oneEth);
  });
});
