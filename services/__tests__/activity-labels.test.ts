import { describe, expect, mock, test } from 'bun:test';

// DEV-574 / DEV-575 / DEV-517: one row per user action, labelled by what
// happened to the user's balance, with the relayer fee in View details.
//
// The row builder reads token and chain metadata (config/tokens pulls
// react-native at load); stub the one RN symbol and pin the env.
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { reconstructUserSpends, mergeClaimsByPayment } = await import('@/services/outgoing-transfers');
const { buildSpendRows, buildUserSpendRow } = await import('@/services/activity-rows');
const { rowTypeLabel } = await import('@/services/row-type-label');
const { classifyTransfer } = await import('@/services/transfer-direction');
const { normalizeClaimCommitment, parseClaimRecords, toClaimedInputMap, upsertClaimRecords, MAX_CLAIM_RECORDS } = await import('@/services/claim-records-core');
const { parseOwnActions } = await import('@/services/own-actions-core');
const { parseWithdrawFees, toWithdrawalTxHashSet } = await import('@/services/withdraw-fees-core');
const { relayerFeeFor, relayerFeeUsdNote } = await import('@/services/relayer-fee-row');
const { buildAccountingItems, buildKoinlyRow } = await import('@/services/accounting-export');
const { transactionBaseType, transactionTypeGlyph } = await import('@/services/transaction-visuals');

type Hex = import('@/services/sdk-types').Hex;
type Secret = import('@/services/sdk-types').Secret;
type Note = import('@/services/sdk-types').Note;
type SnapshotTransact = import('@/services/api-types').SnapshotTransact;
type Transaction = import('@/components/pools-provider').Transaction;
type UserSpend = import('@/services/outgoing-transfers').UserSpend;

const fakeHashService = {
  hash: (inputs: Hex[]): Hex => `0x${(BigInt(inputs[0]) * 1_000_003n + BigInt(inputs[1])).toString(16)}` as Hex,
};
const KEY = '0x0abc' as Secret;
const nullifierOf = (commitment: string): string =>
  `0x${BigInt(fakeHashService.hash([KEY, commitment as Hex])).toString(16).padStart(64, '0')}`;
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const oneEth = 10n ** 18n;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function note(commitment: string, value: bigint, extra: Record<string, unknown> = {}) {
  return { commitment: commitment as Hex, value: `0x${value.toString(16)}` as Hex, tokenId: ETH as Hex, ...extra };
}

function transact(overrides: Partial<SnapshotTransact>): SnapshotTransact {
  return {
    txHash: H(0xc1a1),
    logIndex: 0,
    outputCommitments: [],
    nullifierHashes: [],
    caller: '0xcaller',
    withdrawnValue: '0',
    encryptedPayload: null,
    blockNumber: '1',
    blockTimestamp: '1750000000',
    asset: ETH,
    ...overrides,
  };
}

// The claim from the report (Mike, 2026-10-14): a new user claims a 0.005 ETH
// payment link from their own device, registration riding along. Before the
// viewing key is set, the claim's own output does not read as theirs, so the
// shape rule sees a recipient that is "someone else".
const PAYMENT_TX = H(0x5e4d);
const CLAIM_TX = H(0xc1a1);
const claimFee = 360_000_000_000_000n;
const received = 5_000_000_000_000_000n;
const claimNotes = [note('0x01', received, { label: '0xaa', txHash: PAYMENT_TX })];
const claimLog = transact({
  txHash: CLAIM_TX,
  nullifierHashes: [nullifierOf('0x01')],
  outputCommitments: ['0x91'], // not decodable as mine yet
  withdrawnValue: `${claimFee}`,
});

describe('DEV-574: a claimed payment is a Transfer In', () => {
  test('without a record, the pre-viewing-key claim read as a transfer OUT (the reported bug)', () => {
    const [spend] = reconstructUserSpends(claimNotes, [claimLog], KEY, fakeHashService);
    expect(spend.kind).toBe('transfer');
  });

  test('the recorded claim inputs make it the claim, with the registration', () => {
    const claimedInputs = toClaimedInputMap(upsertClaimRecords([], { chainId: 1, commitments: ['0x01'], withRegistration: true, now: 1 }));
    const spends = reconstructUserSpends(claimNotes, [claimLog], KEY, fakeHashService, { claimedInputs });
    expect(spends).toHaveLength(1);
    expect(spends[0].kind).toBe('claim');
    expect(spends[0].amount).toBe(received);
    expect(spends[0].fee).toBe(claimFee);
    expect(spends[0].receivedTxHash).toBe(PAYMENT_TX);
    expect(spends[0].withRegistration).toBe(true);

    const row = buildUserSpendRow(mergeClaimsByPayment(spends)[0], 1, {});
    expect(row.type).toBe('Transfer');
    expect(row.direction).toBe('in');
    expect(row.withRegistration).toBe(true);
    expect(row.claimTxHash).toBe(CLAIM_TX);
    expect(rowTypeLabel(row)).toBe('Transfer In & registration');
  });

  test('a claim without registration is a plain Transfer In', () => {
    const claimedInputs = toClaimedInputMap(upsertClaimRecords([], { chainId: 1, commitments: ['0x01'], withRegistration: false, now: 1 }));
    const [spend] = reconstructUserSpends(claimNotes, [claimLog], KEY, fakeHashService, { claimedInputs });
    const row = buildUserSpendRow(spend, 1, {});
    expect(row.withRegistration).toBeUndefined();
    expect(rowTypeLabel(row)).toBe('Transfer In');
  });

  test('a spend mixing a claimed note with my own note is not a claim', () => {
    const notes = [...claimNotes, note('0x02', oneEth, { label: '0xbb', txHash: H(0xdead) })];
    const claimedInputs = toClaimedInputMap(upsertClaimRecords([], { chainId: 1, commitments: ['0x01'], withRegistration: false, now: 1 }));
    const [spend] = reconstructUserSpends(notes, [transact({
      txHash: CLAIM_TX,
      nullifierHashes: [nullifierOf('0x01'), nullifierOf('0x02')],
      outputCommitments: ['0x91', '0x92'],
      withdrawnValue: '1',
    })], KEY, fakeHashService, { claimedInputs });
    expect(spend.kind).not.toBe('claim');
  });

  test('two notes of one payment claimed in separate txs fold into one row, keeping the registration', () => {
    const merged = mergeClaimsByPayment([
      { kind: 'claim', receivedTxHash: PAYMENT_TX, txHash: H(1), amount: 1n, grossOutflow: 1n, fee: 1n, inputCount: 1, outputCount: 1, ownOutputValue: 0n, tokenId: ETH, blockTimestamp: '1' },
      { kind: 'claim', receivedTxHash: PAYMENT_TX, txHash: H(2), amount: 2n, grossOutflow: 2n, fee: 1n, inputCount: 1, outputCount: 1, ownOutputValue: 0n, tokenId: ETH, blockTimestamp: '1', withRegistration: true },
    ] as UserSpend[]);
    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe(3n);
    expect(merged[0].withRegistration).toBe(true);
  });

  test('net incoming wins over the sent stamp in classifyTransfer', () => {
    const base = { id: 'x', type: 'Transfer', txHash: CLAIM_TX, label: null, rawAmount: '1', tokenAddress: ETH, chainId: 1 } as unknown as Transaction;
    const sent = new Set([CLAIM_TX]);
    // A claim receipt row.
    expect(classifyTransfer({ ...base, claimTxHash: CLAIM_TX }, [], sent)).toBe('in');
    // A feed row of my own confirmed claim.
    expect(classifyTransfer(base, [], sent, new Set([CLAIM_TX]))).toBe('in');
    // An ordinary send is still out.
    expect(classifyTransfer(base, [], sent)).toBe('out');
  });

  test('claim records: normalised, bounded, malformed rows dropped', () => {
    expect(normalizeClaimCommitment('0x01')).toBe(H(1));
    expect(normalizeClaimCommitment('1')).toBe(H(1));
    expect(normalizeClaimCommitment(H(0xab).toUpperCase().replace('0X', '0x'))).toBe(H(0xab));
    expect(parseClaimRecords([{}, { commitment: H(1), chainId: 1, withRegistration: true, timestamp: 1 }, null])).toHaveLength(1);
    let list = upsertClaimRecords([], { chainId: 1, commitments: ['0x01'], withRegistration: false, now: 1 });
    list = upsertClaimRecords(list, { chainId: 1, commitments: ['0x01'], withRegistration: true, now: 2 });
    expect(list).toHaveLength(1);
    expect(list[0].withRegistration).toBe(true);
    const many = upsertClaimRecords([], { chainId: 1, commitments: Array.from({ length: MAX_CLAIM_RECORDS + 5 }, (_, i) => `0x${(i + 1).toString(16)}`), withRegistration: false, now: 1 });
    expect(many).toHaveLength(MAX_CLAIM_RECORDS);
  });
});

describe('DEV-574: account setup spends are named for what they were', () => {
  const setupTx = H(0x5e7);
  const setupNotes = [note('0x01', oneEth, { label: '0xaa', txHash: H(0xd0) }), note('0x02', oneEth - 360_000_000_000_000n, { label: '0xaa', txHash: setupTx })];
  const setupSpends = reconstructUserSpends(setupNotes, [transact({
    txHash: setupTx,
    nullifierHashes: [nullifierOf('0x01')],
    outputCommitments: ['0x02'],
    withdrawnValue: '360000000000000',
  })], KEY, fakeHashService);

  const build = (kind: 'gas-top-up' | 'registration' | null) => buildSpendRows({
    spends: setupSpends,
    seenTxHashes: new Set(),
    defaultChainId: 1,
    feedRows: [],
    priceMap: {},
    projectLocalOutputs: () => null,
    setupKindOf: (_chainId, txHash) => (txHash === setupTx ? kind : null),
  });

  test('the viewing-key gas top-up is "Gas for viewing key", not a bare Withdrawal', () => {
    expect(setupSpends[0].kind).toBe('withdrawal');
    const rows = build('gas-top-up');
    expect(rows).toHaveLength(1);
    expect(rows[0].setupKind).toBe('gas-top-up');
    expect(rowTypeLabel(rows[0])).toBe('Gas for viewing key');
  });

  test('the gasless registration is "Account setup"', () => {
    expect(rowTypeLabel(build('registration')[0])).toBe('Account setup');
  });

  test('without the device record it stays a Withdrawal', () => {
    expect(rowTypeLabel(build(null)[0])).toBe('Withdrawal');
  });

  test('the setup actions survive the own-action store', () => {
    const parsed = parseOwnActions([
      { txHash: setupTx, chainId: 1, kind: 'setup-gas', timestamp: 1 },
      { txHash: setupTx, chainId: 2, kind: 'setup-register', timestamp: 1 },
      { txHash: setupTx, chainId: 3, kind: 'bogus', timestamp: 1 },
    ]);
    expect(parsed.map((a) => a.kind)).toEqual(['setup-gas', 'setup-register']);
  });
});

describe('DEV-575: the label table, one row shape each', () => {
  // [row fields, label, visual base type]. docs/activity-labels.md is the
  // human copy of this table.
  const table: Array<[Record<string, unknown>, string, string]> = [
    [{ type: 'Deposit' }, 'Deposit', 'Deposit'],
    [{ type: 'Deposit', authored: true }, 'Deposit to recipient', 'Withdrawal'],
    [{ type: 'Deposit', swappedFrom: {} }, 'Deposit via swap', 'Deposit'],
    [{ type: 'Withdrawal' }, 'Withdrawal', 'Withdrawal'],
    [{ type: 'Withdrawal', viaSwap: true }, 'Withdrawal via swap', 'Withdrawal'],
    [{ type: 'Withdrawal', receivedAs: {} }, 'Withdrawal via swap', 'Withdrawal'],
    [{ type: 'Withdrawal', viaSwap: true, sentToOther: true }, 'Sent to another account', 'Withdrawal'],
    [{ type: 'Transfer', direction: 'in' }, 'Transfer In', 'Transfer'],
    [{ type: 'Transfer', direction: 'in', withRegistration: true }, 'Transfer In & registration', 'Transfer'],
    [{ type: 'Transfer', direction: 'out' }, 'Transfer Out', 'Transfer'],
    [{ type: 'Swap' }, 'Swap', 'Swap'],
    [{ type: 'Exit' }, 'Exit', 'Exit'],
    [{ type: 'Withdrawal', setupKind: 'gas-top-up' }, 'Gas for viewing key', 'Gas for viewing key'],
    [{ type: 'Transfer', direction: 'self', setupKind: 'registration' }, 'Account setup', 'Account setup'],
    [{ type: 'Transfer', direction: 'self' }, 'Self-transfer', 'Self-transfer'],
    [{ type: 'Transfer', direction: 'self', noteCounts: { spent: 3, created: 1 } }, 'Consolidation', 'Consolidation'],
  ];
  for (const [row, label, base] of table) {
    test(`${JSON.stringify(row)} reads "${label}"`, () => {
      expect(rowTypeLabel(row as Parameters<typeof rowTypeLabel>[0])).toBe(label);
      expect(transactionBaseType(label)).toBe(base);
    });
  }

  test('every new label has its own glyph', () => {
    for (const label of ['Transfer In & registration', 'Gas for viewing key', 'Account setup', 'Sent to another account']) {
      expect(transactionTypeGlyph(label, transactionBaseType(label))).not.toBe('ellipse-outline');
    }
  });

  test('the doc carries every label of the table', () => {
    const doc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'docs', 'activity-labels.md'), 'utf8') as string;
    for (const [, label] of table) expect(doc).toContain(`| ${label} |`);
  });
});

describe('DEV-575: the CSV export uses the same labels', () => {
  const claimRow = buildUserSpendRow(
    reconstructUserSpends(claimNotes, [claimLog], KEY, fakeHashService, {
      claimedInputs: toClaimedInputMap(upsertClaimRecords([], { chainId: 11155111, commitments: ['0x01'], withRegistration: true, now: 1 })),
    })[0],
    11155111,
    {},
  );
  const items = buildAccountingItems({
    mineRows: [claimRow],
    notes: [] as Note[],
    sentTxHashes: new Set(),
    transferTxHashes: new Set(),
    transferClassificationReady: true,
    findSentAudits: () => [],
    findSentTransfer: () => null,
    myDeposits: [],
    myExits: [],
    evmChainId: 11155111,
  });

  test('a claim with registration exports as a transfer in, described as the list names it', async () => {
    const transferIn = items.find((i) => i.type === 'transfer-in');
    expect(transferIn?.activity).toBe('Transfer In & registration');
    const row = await buildKoinlyRow(transferIn!, { findFee: () => null, notes: [] } as unknown as Parameters<typeof buildKoinlyRow>[1]);
    expect(row).toContain('Privacy Pools transfer in & registration');
  });

  test('its cost is a separate fee line, never a disposal', () => {
    expect(items.some((i) => i.type === 'transfer-out')).toBe(false);
    expect(items.find((i) => i.type === 'fee')?.value).toBe(claimFee.toString());
  });

  test('shield swaps, self-transfers and consolidations retain the UI label in CSV', async () => {
    const base = { ...claimRow, claimTxHash: undefined, claimCostRaw: undefined, withRegistration: undefined };
    const depositNote = { ...claimNotes[0], txHash: PAYMENT_TX } as Note;
    const rows = [
      { ...base, type: 'Deposit', direction: undefined, swappedFrom: { chainId: 1 } },
      { ...base, txHash: H(0x100), direction: 'self' },
      { ...base, txHash: H(0x101), direction: 'self', noteCounts: { spent: 3, created: 1 } },
    ] as Transaction[];
    const exported = buildAccountingItems({
      mineRows: rows, notes: [depositNote], sentTxHashes: new Set(), transferTxHashes: new Set(),
      transferClassificationReady: true, findSentAudits: () => [], findSentTransfer: () => null,
      myDeposits: [], myExits: [], evmChainId: 11155111,
    });
    expect(exported.map((i) => i.activity)).toEqual(['Deposit via swap', 'Self-transfer', 'Consolidation']);
    expect(exported.map((i) => i.type)).toEqual(['deposit', 'fee', 'fee']);
    for (const item of exported) {
      const csv = await buildKoinlyRow({ ...item, bundles: null }, { findFee: () => null, notes: [] } as unknown as Parameters<typeof buildKoinlyRow>[1]);
      expect(csv).toContain(`Privacy Pools ${item.activity!.toLowerCase()}`);
    }
  });
});

describe('DEV-517: the Relayer fee row in View details', () => {
  const fees = new Map<string, { feeAmount: string; priceUsd?: number }>([
    [H(0x5e), { feeAmount: '155523' }],
    [H(0xa1), { feeAmount: '0x1f4', priceUsd: 2000 }],
    [CLAIM_TX, { feeAmount: '300000000000000' }],
    [H(0xbad), { feeAmount: 'not-a-number' }],
  ]);
  const findFee = (txHash: string) => fees.get(txHash) ?? null;
  const base = { txHash: H(0x5e), feeAmountRow: false, isBatchItemRow: false, findFee };

  test('relayed operations show their recorded fee', () => {
    expect(relayerFeeFor({ ...base, type: 'Transfer', direction: 'out' })?.wei).toBe(155523n);
    expect(relayerFeeFor({ ...base, type: 'Withdrawal', direction: null, txHash: H(0xa1) })).toEqual({ wei: 500n, priceUsd: 2000, stored: true });
    expect(relayerFeeFor({ ...base, type: 'Swap', direction: null })?.wei).toBe(155523n);
    // A claim's fee is the claim tx's, not the payment's.
    expect(relayerFeeFor({ ...base, type: 'Transfer', direction: 'in', txHash: PAYMENT_TX, claimTxHash: CLAIM_TX })?.wei).toBe(300000000000000n);
    // An outgoing transfer from another device: the chain's figure.
    expect(relayerFeeFor({ ...base, type: 'Transfer', direction: 'out', txHash: H(0x99), relayFeeRaw: '42' })).toEqual({ wei: 42n, stored: false });
  });

  test('no relayer, no row', () => {
    expect(relayerFeeFor({ ...base, type: 'Deposit', direction: null })).toBeNull();
    // A self-paid ragequit.
    expect(relayerFeeFor({ ...base, type: 'Exit', direction: null })).toBeNull();
    // A received transfer that was not a claim.
    expect(relayerFeeFor({ ...base, type: 'Transfer', direction: 'in' })).toBeNull();
  });

  test('old rows without a stored fee, zero and malformed fees show no row', () => {
    expect(relayerFeeFor({ ...base, type: 'Withdrawal', direction: null, txHash: H(0x1234) })).toBeNull();
    expect(relayerFeeFor({ ...base, type: 'Transfer', direction: 'in', claimTxHash: H(0x1234) })).toBeNull();
    expect(relayerFeeFor({ ...base, type: 'Withdrawal', direction: null, txHash: H(0xbad) })).toBeNull();
    expect(relayerFeeFor({ ...base, type: 'Transfer', direction: 'out', txHash: H(0x1234), relayFeeRaw: '0' })).toBeNull();
    // One row of a batch: the aggregate fee is not its own.
    expect(relayerFeeFor({ ...base, type: 'Withdrawal', direction: null, txHash: H(0xa1), isBatchItemRow: true })).toBeNull();
  });

  test('the dollar value is formatted like the review step', () => {
    expect(relayerFeeUsdNote(0.155523, { stablecoin: true })).toBe(' (~$0.16)');
    expect(relayerFeeUsdNote(0.0005, { stamped: 2000, stablecoin: false })).toBe(' (~$1.00)');
    expect(relayerFeeUsdNote(0.0005, { now: 2000, stablecoin: false })).toBe(' (~$1.00 now)');
    expect(relayerFeeUsdNote(0.000001, { now: 2000, stablecoin: false })).toBe(' (~<$0.01 now)');
    expect(relayerFeeUsdNote(1, { now: null, stablecoin: false })).toBe('');
  });

  test('claim fees are stored, and never count as withdrawals', () => {
    const list = parseWithdrawFees(JSON.stringify([
      { txHash: CLAIM_TX, feeAmount: '1', tokenAddress: ETH, chainId: 1, timestamp: 1, kind: 'claim' },
      { txHash: H(0xa1), feeAmount: '1', tokenAddress: ETH, chainId: 1, timestamp: 1, kind: 'withdrawal' },
    ]));
    expect(list).toHaveLength(2);
    expect([...toWithdrawalTxHashSet(list)]).toEqual([H(0xa1)]);
  });

  test('the fee is stored at submit time on the claim and setup paths', () => {
    const read = (rel: string) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', rel), 'utf8') as string;
    const importHook = read('hooks/use-note-import.ts');
    expect(importHook).toContain("kind: 'claim'");
    expect(importHook).toContain('recordClaimInputs(');
    const setupHook = read('hooks/use-gasless-registration.ts');
    expect(setupHook).toContain("topUpOnly ? 'setup-gas' : 'setup-register'");
    expect(setupHook).toContain('recordWithdrawFee(');
    expect(read('components/pools/transactions.tsx')).toContain('relayerFeeFor(');
  });
});

describe('review of #288', () => {
  const read = (rel: string) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', rel), 'utf8') as string;

  test('a claim records its inputs only after its relay succeeded, so a failed claim leaves no record', () => {
    const src = read('hooks/use-note-import.ts');
    const calls = src.split('\n').filter((l) => l.includes('recordClaimInputs(') && !l.includes('import'));
    expect(calls).toHaveLength(2);
    expect(calls[0].trim().startsWith('recordClaimInputs(')).toBe(true);
    expect(calls[1]).toContain('if (legConfirmed && sdkVerdict === true) recordClaimInputs(');
    // Both after the success verdict they are gated on.
    // The relayed claim records inside the nullifier-confirmed branch.
    const relayedAt = src.indexOf('recordClaimInputs(sessionChainId, inputCommitments');
    expect(src.lastIndexOf('if (anchorStampTxHash) {', relayedAt)).toBeGreaterThan(src.lastIndexOf('anchorStampTxHash = observedTxHash;', relayedAt));
    expect(src.indexOf('if (legConfirmed && sdkVerdict === true) recordClaimInputs(')).toBeGreaterThan(src.indexOf('const legConfirmed = receiptIsOurs'));
  });

  test('without a record, a later withdrawal of an unclaimed link note stays a withdrawal', () => {
    const notes = [note('0x01', oneEth, { label: '0xaa', txHash: PAYMENT_TX })];
    const [spend] = reconstructUserSpends(notes, [transact({ nullifierHashes: [nullifierOf('0x01')], outputCommitments: [], withdrawnValue: `${oneEth}` })], KEY, fakeHashService, { claimedInputs: new Map() });
    expect(spend.kind).toBe('withdrawal');
  });

  test('a payment claimed over two txs shows the sum of both legs\' fees, or no row', () => {
    const merged = mergeClaimsByPayment([
      { kind: 'claim', receivedTxHash: PAYMENT_TX, txHash: H(1), amount: 1n, grossOutflow: 1n, fee: 10n, inputCount: 1, outputCount: 1, ownOutputValue: 0n, tokenId: ETH, blockTimestamp: '1' },
      { kind: 'claim', receivedTxHash: PAYMENT_TX, txHash: H(2), amount: 2n, grossOutflow: 2n, fee: 20n, inputCount: 1, outputCount: 1, ownOutputValue: 0n, tokenId: ETH, blockTimestamp: '1' },
    ] as UserSpend[]);
    const row = buildUserSpendRow(merged[0], 1, {});
    expect(row.claimTxHashes).toEqual([H(1), H(2)]);
    const both = new Map([[H(1), { feeAmount: '10' }], [H(2), { feeAmount: '20' }]]);
    const input = { type: 'Transfer', direction: 'in' as const, txHash: PAYMENT_TX, claimTxHash: row.claimTxHash, claimTxHashes: row.claimTxHashes, feeAmountRow: false, isBatchItemRow: false };
    expect(relayerFeeFor({ ...input, findFee: (h) => both.get(h) ?? null })?.wei).toBe(30n);
    expect(relayerFeeFor({ ...input, findFee: (h) => (h === H(1) ? { feeAmount: '10' } : null) })).toBeNull();
  });
});

describe('cubic review of #288', () => {
  test('a multi-tx claim values its fee at the legs\' stamped prices', () => {
    const fees = new Map([[H(1), { feeAmount: '10', priceUsd: 1000 }], [H(2), { feeAmount: '30', priceUsd: 2000 }]]);
    const fee = relayerFeeFor({ type: 'Transfer', direction: 'in', txHash: PAYMENT_TX, claimTxHashes: [H(1), H(2)], feeAmountRow: false, isBatchItemRow: false, findFee: (h) => fees.get(h) ?? null });
    expect(fee?.wei).toBe(40n);
    expect(fee?.priceUsd).toBe(1750);
    // One unpriced leg: no historical price for the sum.
    const partial = new Map([[H(1), { feeAmount: '10', priceUsd: 1000 }], [H(2), { feeAmount: '30' }]]);
    expect(relayerFeeFor({ type: 'Transfer', direction: 'in', txHash: PAYMENT_TX, claimTxHashes: [H(1), H(2)], feeAmountRow: false, isBatchItemRow: false, findFee: (h) => partial.get(h) ?? null })?.priceUsd).toBeUndefined();
  });

  test('the CSV names swap-sends and routed withdrawals as the list does', () => {
    const row = (over: Partial<Transaction>) => ({ id: 'w', type: 'Withdrawal', txHash: H(0x77), rawAmount: '1000', tokenAddress: ETH, chainId: 11155111, timestamp: 1, fullAddress: '', label: null, isLineageSynthetic: true, ...over }) as unknown as Transaction;
    const items = buildAccountingItems({
      mineRows: [row({ viaSwap: true, sentToOther: true }), row({ txHash: H(0x78), viaSwap: true })],
      notes: [] as Note[], sentTxHashes: new Set(), transferTxHashes: new Set(), transferClassificationReady: true,
      findSentAudits: () => [], findSentTransfer: () => null, myDeposits: [], myExits: [], evmChainId: 11155111,
    });
    expect(items.map((i) => i.activity)).toEqual(['Sent to another account', 'Withdrawal via swap']);
  });

  test('a phone keeps the claim record small enough for SecureStore', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'claim-records-store.ts'), 'utf8') as string;
    expect(src).toContain('next.slice(-NATIVE_MAX_RECORDS)');
    const twelve = upsertClaimRecords([], { chainId: 11155111, commitments: Array.from({ length: 12 }, (_, i) => H(i + 1)), withRegistration: false, now: 1_760_000_000_000 });
    expect(JSON.stringify(twelve).length).toBeLessThan(2048);
  });
});
