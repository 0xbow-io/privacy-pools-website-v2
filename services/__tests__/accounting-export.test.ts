import { describe, expect, mock, test } from 'bun:test';

// services/accounting-export pulls react-native (via config/pool-profile) and
// config/env at module load; stub the one RN symbol used and pin the env so
// the golden output is deterministic regardless of the local .env.
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_PAY_URL_BASE = 'https://pay.example.test';
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const {
  KOINLY_HEADER,
  buildAccountingItems,
  buildKoinlyCsv,
  csvCell,
  koinlyDate,
  parseDay,
} = await import('@/services/accounting-export');
const { NoteStatus } = await import('@/services/sdk-types');
type AcctItem = import('@/services/accounting-export').AcctItem;
type AccountingSources = import('@/services/accounting-export').AccountingSources;
type Transaction = import('@/components/pools-provider').Transaction;
type Note = import('@/services/sdk-types').Note;
type PartialViewingKeyV1 = import('@/services/audit-receipt').PartialViewingKeyV1;
type OriginProofV1 = import('@/services/audit-receipt').OriginProofV1;

const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const bundle = (over: Partial<PartialViewingKeyV1> = {}): PartialViewingKeyV1 => ({
  v: 1, kind: 'owned', chainId: 11155111,
  txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  commitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
  ownerAddress: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
  noteSecret: '0x3333333333333333333333333333333333333333333333333333333333333333',
  tokenId: ETH as never, value: '0xde0b6b3a7640000', // 1 ETH
  label: '0x4444444444444444444444444444444444444444444444444444444444444444',
  ...over,
} as PartialViewingKeyV1);

// One item per accounting type, plus a fee-split withdrawal — the exact
// shapes the modal hands over after its own filtering/folding.
const items: AcctItem[] = [
  { txHash: '0x1111111111111111111111111111111111111111111111111111111111111111', type: 'deposit',
    bundles: [bundle()], value: '0xde0b6b3a7640000', tokenId: ETH, chainId: 11155111,
    timestamp: Date.UTC(2026, 0, 2, 14, 25), counterparty: '0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd', label: null },
  { txHash: '0x5555555555555555555555555555555555555555555555555555555555555555', type: 'transfer-in',
    bundles: [bundle({ txHash: '0x5555555555555555555555555555555555555555555555555555555555555555' as never, value: '0x6f05b59d3b20000' as never })],
    value: '0x6f05b59d3b20000', tokenId: ETH, chainId: 11155111,
    timestamp: Date.UTC(2026, 0, 3, 9, 5), counterparty: null, label: null },
  { txHash: '0x6666666666666666666666666666666666666666666666666666666666666666', type: 'transfer-out',
    bundles: [bundle({ kind: 'sent', txHash: '0x6666666666666666666666666666666666666666666666666666666666666666' as never, ownerAddress: '0xBbBBbbBBbbbbBBbbBBbbBBbBbBbbBBbbBBbbBBbB' as never, value: '0x2386f26fc10000' as never })],
    value: '0x2386f26fc10000', tokenId: ETH, chainId: 11155111,
    timestamp: Date.UTC(2026, 0, 4, 18, 45), counterparty: '0xBbBBbbBBbbbbBBbbBBbbBBbBbBbbBBbbBBbbBBbB', label: null },
  { txHash: '0x7777777777777777777777777777777777777777777777777777777777777777', type: 'withdraw',
    bundles: null, value: '1000000000000000000', tokenId: ETH, chainId: 11155111,
    timestamp: Date.UTC(2026, 0, 5, 7, 30), counterparty: '0xCcccCCccCCcCccCcCCCcCcccCcccCCccCccCCCCc', label: null },
  { txHash: '0x8888888888888888888888888888888888888888888888888888888888888888', type: 'withdraw',
    bundles: null, value: '500000000000000000', tokenId: ETH, chainId: 11155111,
    timestamp: Date.UTC(2026, 0, 6, 12, 0), counterparty: '0xCcccCCccCCcCccCcCCCcCcccCcccCCccCccCCCCc', label: null },
  { txHash: '0x9999999999999999999999999999999999999999999999999999999999999999', type: 'exit',
    bundles: null, value: '250000000000000000', tokenId: ETH, chainId: 11155111,
    timestamp: Date.UTC(2026, 0, 7, 23, 59), counterparty: '0xCcccCCccCCcCccCcCCCcCcccCcccCCccCccCCCCc',
    label: '0x4444444444444444444444444444444444444444444444444444444444444444' },
];

const proof: OriginProofV1 = {
  v: 1, kind: 'origin', chainId: 11155111,
  note: { ownerAddress: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as never,
    noteSecret: '0x3333333333333333333333333333333333333333333333333333333333333333' as never,
    tokenId: ETH as never, value: '0xde0b6b3a7640000' as never,
    label: '0x4444444444444444444444444444444444444444444444444444444444444444' as never },
  target: { type: 'exit', txHash: '0x9999999999999999999999999999999999999999999999999999999999999999' as never },
};

const deps = {
  notes: [],
  // Fee captured for the first withdrawal only — pins both the fee split and
  // the gross fallback.
  findFee: (txHash: string) => (txHash.startsWith('0x7777') ? { feeAmount: '10000000000000000' } : null),
  // Origin proof resolves for the exit only, like the real builder when only
  // that lineage is locally known.
  buildOriginProof: (async (params: { target: { type: string } }) =>
    params.target.type === 'exit' ? proof : null) as never,
};

describe('buildKoinlyCsv (golden)', () => {
  test('pins the row serializer (builder-producible item shapes)', async () => {
    const golden = (await Bun.file(
      new URL('./__fixtures__/koinly-golden.csv', import.meta.url).pathname,
    ).text()).trimEnd();
    const csv = await buildKoinlyCsv(items, deps);
    expect(csv).toBe(golden);
  });

  test('deposits/receives fill the Received columns; sends fill Sent', async () => {
    const csv = await buildKoinlyCsv(items, deps);
    const [header, dep, tin, tout, wfee] = csv.split('\n');
    expect(header).toBe(KOINLY_HEADER);
    expect(dep.split(',').slice(1, 5)).toEqual(['', '', '1', 'ETH']);
    expect(tin.split(',').slice(1, 5)).toEqual(['', '', '0.5', 'ETH']);
    expect(tout.split(',').slice(1, 5)).toEqual(['0.01', 'ETH', '', '']);
    // Withdrawal with a captured relayer fee: gross 1 ETH → 0.99 sent + 0.01 fee.
    expect(wfee.split(',').slice(1, 7)).toEqual(['0.99', 'ETH', '', '', '0.01', 'ETH']);
  });

  test('a transfer-out with a captured fee adds the Fee columns and keeps the net Sent amount', async () => {
    // The relayer charges a transfer's fee ON TOP of what the recipient got, so
    // the row amount is already net: only the Fee column is added (mirror image
    // of the withdrawal case, which folds the fee out of a gross amount).
    const csv = await buildKoinlyCsv(items, {
      ...deps,
      findFee: (txHash: string) => (txHash.startsWith('0x6666') ? { feeAmount: '493000000000000' } : null),
    });
    const tout = csv.split('\n').find((l) => l.includes('0x6666'))!;
    expect(tout.split(',').slice(1, 7)).toEqual(['0.01', 'ETH', '', '', '0.000493', 'ETH']);
  });

  test('a transfer-out with no fee record on this device takes the fee read from chain', async () => {
    const tout = items.find((it) => it.txHash.startsWith('0x6666'))!;
    const withChainFee: AcctItem = { ...tout, relayFee: '493000000000000' };
    const csv = await buildKoinlyCsv([withChainFee], { ...deps, findFee: () => null });
    expect(csv.split('\n')[1].split(',').slice(1, 7)).toEqual(['0.01', 'ETH', '', '', '0.000493', 'ETH']);
    // This device's record wins where both exist, as in the detail panel.
    const stamped = await buildKoinlyCsv([withChainFee], { ...deps, findFee: () => ({ feeAmount: '500000000000000' }) });
    expect(stamped.split('\n')[1].split(',').slice(5, 7)).toEqual(['0.0005', 'ETH']);
  });

  test('a standalone pool fee uses only the Koinly Fee columns', async () => {
    const feeItem: AcctItem = {
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      type: 'fee',
      bundles: null,
      value: '539379930021000',
      tokenId: ETH,
      chainId: 11155111,
      timestamp: Date.UTC(2026, 0, 6, 12, 0),
      counterparty: null,
      label: null,
    };
    const csv = await buildKoinlyCsv([feeItem], deps);
    const fee = csv.split('\n')[1];
    expect(fee.split(',').slice(1, 7)).toEqual(['', '', '', '', '0.000539379930021', 'ETH']);
    expect(fee).toContain('Privacy Pools fee');
  });

  test('a withdrawal with no captured fee keeps the gross amount and no fee columns', async () => {
    const csv = await buildKoinlyCsv(items, deps);
    const noFee = csv.split('\n')[5];
    expect(noFee.split(',').slice(1, 7)).toEqual(['0.5', 'ETH', '', '', '', '']);
  });

  test('an origin-proof failure omits the link instead of failing the export', async () => {
    const csv = await buildKoinlyCsv(items, {
      ...deps,
      buildOriginProof: (async () => { throw new Error('prover unavailable'); }) as never,
    });
    const exitRow = csv.split('\n')[6];
    expect(exitRow).toContain('Privacy Pools exit to');
    expect(exitRow).not.toContain('proof of origin');
  });
});

describe('csv helpers', () => {
  test('koinlyDate renders the Koinly UTC stamp', () => {
    expect(koinlyDate(Date.UTC(2026, 0, 2, 14, 25))).toBe('2026-01-02 14:25 UTC');
  });

  test('csvCell quotes only when needed and escapes quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  test('parseDay accepts real dates and rejects rolled-over ones', () => {
    expect(parseDay('2026-02-31', false)).toBeNull();
    expect(parseDay('not-a-date', false)).toBeNull();
    const start = parseDay('2026-01-02', false);
    const end = parseDay('2026-01-02', true);
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    expect((end as number) - (start as number)).toBe(24 * 60 * 60 * 1000 - 1);
  });
});

// --- buildAccountingItems (export scoping) ---

const CHAIN = 11155111;
const hx = (c: string): `0x${string}` => `0x${c.repeat(64)}`;
const addr = (c: string): `0x${string}` => `0x${c.repeat(40)}`;

function feedTx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't', address: '', fullAddress: '', type: 'Withdrawal', chain: 'Sepolia',
    chainId: CHAIN, asset: 'ETH', tokenAddress: addr('e'), rawAmount: '1000',
    tokenAmount: 0, usdValue: 0, value: '$0', timestamp: 1000,
    status: 'completed', txHash: hx('1'), reviewStatus: 'approved',
    aspRoot: null, label: null,
    ...over,
  } as Transaction;
}

function ownedNote(over: Partial<Note> = {}): Note {
  return {
    commitment: hx('c'), value: '0x64', tokenId: addr('e'), label: hx('d'),
    status: NoteStatus.ACTIVE, ownerAddress: addr('a'), noteSecret: hx('5'),
    isOwned: true, createdAtBlock: '0x1', spentAtBlock: null,
    txHash: hx('1'), parentCommitmentHash: null,
    ...over,
  } as Note;
}

function sources(over: Partial<AccountingSources> = {}): AccountingSources {
  return {
    mineRows: [],
    notes: [],
    sentTxHashes: new Set<string>(),
    transferTxHashes: new Set<string>(),
    transferClassificationReady: true,
    myDeposits: [],
    myExits: [],
    evmChainId: CHAIN,
    findSentAudits: () => [],
    findSentTransfer: () => null,
    ...over,
  };
}

describe('buildAccountingItems', () => {
  test('only mine-scoped rows are exported: a foreign withdrawal never leaks in', () => {
    // The ownership gate is the mineRows input itself — the caller filters the
    // global feed. Feeding a mine-scoped set containing only our withdrawal
    // must yield exactly that row; the foreign one was never handed over.
    const mine = feedTx({ type: 'Withdrawal', txHash: hx('1'), rawAmount: '5000' });
    const items = buildAccountingItems(sources({ mineRows: [mine] }));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('withdraw');
    expect(items[0].value).toBe('5000');
  });

  test('a mislabeled transfer (ASP says withdrawal) is skipped until proven otherwise', () => {
    const tx = feedTx({ type: 'Withdrawal', txHash: hx('2') });
    // Known transfer hash → skip.
    const known = buildAccountingItems(sources({
      mineRows: [tx], transferTxHashes: new Set([hx('2')]),
    }));
    expect(known).toHaveLength(0);
    // Classification not ready → also skip (can't tell yet).
    const notReady = buildAccountingItems(sources({
      mineRows: [tx], transferClassificationReady: false,
    }));
    expect(notReady).toHaveLength(0);
  });

  test('a stamped send with no disclosure is recorded CSV-only with the stamped amount', () => {
    const tx = feedTx({ type: 'Transfer', txHash: hx('3'), rawAmount: '7' /* fee-only on-chain */ });
    const items = buildAccountingItems(sources({
      mineRows: [tx],
      sentTxHashes: new Set([hx('3')]),
      findSentTransfer: (h) => (h.toLowerCase() === hx('3') ? { rawAmount: '0x2386f26fc10000', recipient: addr('b') } : null),
    }));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('transfer-out');
    expect(items[0].bundles).toBeNull();
    expect(items[0].value).toBe('0x2386f26fc10000'); // the true outflow, not the fee
    expect(items[0].counterparty).toBe(addr('b'));
  });

  test('a reconstructed lineage send row is recorded from its own amount', () => {
    const tx = feedTx({
      type: 'Transfer', txHash: hx('4'), rawAmount: '123456', direction: 'out', isLineageSynthetic: true,
    });
    const items = buildAccountingItems(sources({ mineRows: [tx] }));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('transfer-out');
    expect(items[0].value).toBe('123456');
  });

  test("a reconstructed send carries its on-chain relayer fee into the item", () => {
    const tx = feedTx({
      type: 'Transfer', txHash: hx('4'), rawAmount: '123456', direction: 'out', isLineageSynthetic: true,
      relayFeeRaw: '493000000000000',
    });
    const items = buildAccountingItems(sources({ mineRows: [tx] }));
    expect(items).toHaveLength(1);
    expect(items[0].relayFee).toBe('493000000000000');
    // A direct send has none.
    const direct = buildAccountingItems(sources({ mineRows: [feedTx({ ...tx, relayFeeRaw: undefined })] }));
    expect(direct[0].relayFee).toBeUndefined();
  });

  test('a transfer to myself books only the relayer fee, never the value moved', () => {
    const note = ownedNote({ txHash: hx('4') });
    const tx = feedTx({
      type: 'Transfer',
      direction: 'self',
      txHash: hx('4'),
      rawAmount: '539379930021000',
      movedAmountRaw: '1000000000000000000',
      noteCounts: { spent: 3, created: 1 },
      isLineageSynthetic: true,
    });
    const items = buildAccountingItems(sources({ mineRows: [tx], notes: [note] }));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('fee');
    expect(items[0].bundles).toBeNull();
    expect(items[0].value).toBe('539379930021000');
  });


  test('a received transfer keyed by the owned note, even after it was spent', () => {
    const note = ownedNote({ txHash: hx('5'), status: NoteStatus.SPENT, spentAtBlock: '0x9' });
    const tx = feedTx({ type: 'Transfer', txHash: hx('5') });
    const items = buildAccountingItems(sources({ mineRows: [tx], notes: [note] }));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('transfer-in');
    expect(items[0].bundles).not.toBeNull();
    expect(items[0].value).toBe('0x64');
  });

  test('a claimed transfer is the receipt plus a fee for what the claim cost (DEV-450)', () => {
    // The claim row names the payment (the claimed note's tx) and carries the
    // claim tx + cost. The cost used to be its own Fee row; without it here
    // the ledger would no longer reach the balance.
    const note = ownedNote({ txHash: hx('5'), status: NoteStatus.SPENT, spentAtBlock: '0x9' });
    const tx = feedTx({
      type: 'Transfer', txHash: hx('5'), direction: 'in', isLineageSynthetic: true,
      claimTxHash: hx('8'), claimCostRaw: '65065075042500',
    });
    const items = buildAccountingItems(sources({ mineRows: [tx], notes: [note] }));
    expect(items.map((i) => i.type)).toEqual(['transfer-in', 'fee']);
    expect(items[0].value).toBe('0x64');
    expect(items[1].txHash).toBe(hx('8'));
    expect(items[1].value).toBe('65065075042500');
  });

  test('a claim row keyed by its own claim tx is valued from the row, not the change note', () => {
    // The note under the claim tx is the change (value minus cost); valuing
    // the receipt from it and then booking the cost would count the cost twice.
    const change = ownedNote({ txHash: hx('8'), value: '0x3c' });
    const tx = feedTx({
      type: 'Transfer', txHash: hx('8'), direction: 'in', isLineageSynthetic: true, rawAmount: '100',
      claimTxHash: hx('8'), claimCostRaw: '40',
    });
    const items = buildAccountingItems(sources({ mineRows: [tx], notes: [change] }));
    expect(items.map((i) => [i.type, i.value])).toEqual([['transfer-in', '100'], ['fee', '40']]);
  });

  test('snapshot deposits older than the feed window are folded in and deduped', () => {
    const inWindowNote = ownedNote({ txHash: hx('6'), commitment: hx('7') });
    const inWindowRow = feedTx({ type: 'Deposit', txHash: hx('6'), fullAddress: addr('a') });
    const items = buildAccountingItems(sources({
      mineRows: [inWindowRow],
      notes: [inWindowNote],
      myDeposits: [
        // Same tx as the feed row → deduped, not double-counted.
        { txHash: hx('6'), logIndex: 0, depositAddress: addr('a'), outputCommitment: hx('7'), depositedValue: '100', fee: '0', blockNumber: '1', blockTimestamp: '1700000000', asset: addr('e') },
        // Older-than-window deposit whose note is gone → CSV-only from snapshot.
        { txHash: hx('8'), logIndex: 0, depositAddress: addr('a'), outputCommitment: hx('9'), depositedValue: '250', fee: '0', blockNumber: '1', blockTimestamp: '1700000000', asset: addr('e') },
      ],
    }));
    expect(items).toHaveLength(2);
    const old = items.find((i) => i.txHash === hx('8'));
    expect(old?.type).toBe('deposit');
    expect(old?.bundles).toBeNull();
    expect(old?.value).toBe('250');
    // The in-window one keeps its viewing key.
    const recent = items.find((i) => i.txHash === hx('6'));
    expect(recent?.bundles).not.toBeNull();
  });

  test('a swap deposit is keyed by its output-token note, not the source-token change note', () => {
    const source = addr('b');
    const output = addr('f');
    const change = ownedNote({ txHash: hx('6'), commitment: hx('7'), tokenId: source as never, value: '0x0' as never });
    const received = ownedNote({ txHash: hx('6'), commitment: hx('8'), tokenId: output as never, value: '0xd3a1' as never });
    const row = feedTx({ type: 'Deposit', txHash: hx('6'), tokenAddress: output.toUpperCase().replace('0X', '0x'), fullAddress: addr('a') });

    for (const myDeposits of [[], [{ txHash: hx('6'), logIndex: 0, depositAddress: addr('a'), outputCommitment: hx('8'), depositedValue: '54177', fee: '0', blockNumber: '1', blockTimestamp: '1700000000', asset: output }]]) {
      const items = buildAccountingItems(sources({ mineRows: [row], notes: [change, received], myDeposits }));
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('deposit');
      expect(items[0].value).toBe('0xd3a1');
      expect(items[0].tokenId.toLowerCase()).toBe(output);
      expect(items[0].bundles).toHaveLength(1);
      expect(items[0].bundles?.[0].commitment).toBe(hx('8'));
    }
  });

  test('a decimal snapshot commitment recovers the held hex note viewing key', () => {
    const noteCommitment = `0x${'0'.repeat(62)}ab` as Note['commitment'];
    const note = ownedNote({ txHash: hx('a'), commitment: noteCommitment });
    const items = buildAccountingItems(sources({
      notes: [note],
      myDeposits: [{
        txHash: hx('a'),
        logIndex: 0,
        depositAddress: addr('a'),
        outputCommitment: '171',
        depositedValue: '100',
        fee: '0',
        blockNumber: '1',
        blockTimestamp: '1700000000',
        asset: addr('e'),
      }],
    }));

    expect(items).toHaveLength(1);
    expect(items[0].bundles?.[0].commitment).toBe(noteCommitment);
  });

  test('snapshot exits are folded in and deduped against feed exit rows', () => {
    const feedExit = feedTx({ type: 'Exit', txHash: hx('a'), rawAmount: '900', fullAddress: addr('a') });
    const items = buildAccountingItems(sources({
      mineRows: [feedExit],
      myExits: [
        { txHash: hx('a'), logIndex: 0, ragequitter: addr('a'), withdrawnValue: '900', commitment: hx('c'), nullifierHash: hx('b'), label: hx('d'), blockNumber: '1', blockTimestamp: '1700000000', asset: addr('e') },
        { txHash: hx('b'), logIndex: 0, ragequitter: addr('a'), withdrawnValue: '450', commitment: hx('c'), nullifierHash: hx('b'), label: hx('d'), blockNumber: '1', blockTimestamp: '1700000000', asset: addr('e') },
      ],
    }));
    expect(items.filter((i) => i.type === 'exit')).toHaveLength(2);
    expect(items.find((i) => i.txHash === hx('b'))?.value).toBe('450');
  });

  test('batch same-hash withdrawal rows still fold into one summed item', () => {
    const rowA = feedTx({ type: 'Withdrawal', txHash: hx('f'), rawAmount: '100', timestamp: 2000 });
    const rowB = feedTx({ type: 'Withdrawal', txHash: hx('f'), rawAmount: '250', timestamp: 1000 });
    const items = buildAccountingItems(sources({ mineRows: [rowA, rowB] }));
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe('350');
    expect(items[0].timestamp).toBe(1000); // earliest of the batch
  });
});

describe('buildAccountingItems. Multi-lineage transfers', () => {
  test('a two-note receive exports the SUM with one bundle per note', () => {
    const noteA = ownedNote({ txHash: hx('e'), commitment: hx('1'), value: '0xe' as never });
    const noteB = ownedNote({ txHash: hx('e'), commitment: hx('2'), value: '0xe' as never });
    const tx = feedTx({ type: 'Transfer', txHash: hx('e') });
    const items = buildAccountingItems(sources({ mineRows: [tx], notes: [noteA, noteB] }));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('transfer-in');
    expect(BigInt(items[0].value)).toBe(28n);
    expect(items[0].bundles).toHaveLength(2);
  });

  test('a receive never sums owned notes of another token under the same hash', () => {
    const otherToken = ownedNote({ txHash: hx('e'), commitment: hx('1'), tokenId: addr('b') as never, value: '0x5' as never });
    const sameTokenA = ownedNote({ txHash: hx('e'), commitment: hx('2'), value: '0xe' as never });
    const sameTokenB = ownedNote({ txHash: hx('e'), commitment: hx('3'), value: '0xe' as never });
    const tx = feedTx({ type: 'Transfer', txHash: hx('e'), direction: 'in' });
    const items = buildAccountingItems(sources({ mineRows: [tx], notes: [otherToken, sameTokenA, sameTokenB] }));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('transfer-in');
    expect(BigInt(items[0].value)).toBe(28n);
    expect(items[0].tokenId.toLowerCase()).toBe(addr('e'));
    expect(items[0].bundles).toHaveLength(2);
  });

  test('a multi-disclosure send exports the SUM of the disclosed notes', () => {
    const tx = feedTx({ type: 'Transfer', txHash: hx('d') });
    const disclosure = (commitment: `0x${string}`, value: `0x${string}`) => ({
      chainId: CHAIN, txHash: hx('d'), commitment,
      ownerAddress: addr('b'), noteSecret: hx('5'), tokenId: addr('e'),
      value, label: hx('a'),
    });
    const items = buildAccountingItems(sources({
      mineRows: [tx],
      sentTxHashes: new Set([hx('d')]),
      findSentAudits: (h) => (h.toLowerCase() === hx('d')
        ? [disclosure(hx('1'), '0xe'), disclosure(hx('2'), '0xe')] as never[]
        : []),
    }));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('transfer-out');
    expect(BigInt(items[0].value)).toBe(28n);
    expect(items[0].bundles).toHaveLength(2);
  });
});

// --- isAccountingTxMine (exact ownership evidence) ---

const { isAccountingTxMine } = await import('@/services/accounting-export');
type OwnershipEvidence = import('@/services/accounting-export').OwnershipEvidence;

function evidence(over: Partial<OwnershipEvidence> = {}): OwnershipEvidence {
  return {
    noteTxHashes: new Set<string>(),
    sentTxHashes: new Set<string>(),
    withdrawTxHashes: new Set<string>(),
    exitTxHashes: new Set<string>(),
    walletAddressLc: null,
    ...over,
  };
}

describe('isAccountingTxMine', () => {
  test("a shared label is NOT ownership: Bob's exit never enters Alice's ledger", () => {
    // Alice transferred a label-L note to Bob and retains SPENT/change notes
    // with label L. Bob later exits his note — the exit row carries label L but
    // no evidence Alice owns it. The predicate never looks at labels; with no
    // exit-tx evidence the row is excluded.
    const bobsExit = feedTx({ type: 'Exit', txHash: hx('9'), label: hx('c') /* shared L */ });
    expect(isAccountingTxMine(bobsExit, evidence())).toBe(false);
    // Alice's OWN exit (commitment-proven → in exitTxHashes) is included.
    expect(isAccountingTxMine(bobsExit, evidence({ exitTxHashes: new Set([hx('9')]) }))).toBe(true);
  });

  test("a shared label is NOT ownership for withdrawals either", () => {
    const bobsWithdrawal = feedTx({ type: 'Withdrawal', txHash: hx('8'), label: hx('c') });
    expect(isAccountingTxMine(bobsWithdrawal, evidence())).toBe(false);
    // Own withdrawal via the change note it created…
    expect(isAccountingTxMine(bobsWithdrawal, evidence({ noteTxHashes: new Set([hx('8')]) }))).toBe(true);
    // …or the locally-recorded fee stamp (locked/unhydrated note state).
    expect(isAccountingTxMine(bobsWithdrawal, evidence({ withdrawTxHashes: new Set([hx('8')]) }))).toBe(true);
  });

  test('a transfer to myself is mine only by exact note tx-hash ownership', () => {
    const fee = feedTx({ type: 'Transfer', direction: 'self', txHash: hx('8'), label: hx('c') });
    expect(isAccountingTxMine(fee, evidence())).toBe(false);
    expect(isAccountingTxMine(fee, evidence({ noteTxHashes: new Set([hx('8')]) }))).toBe(true);
  });

  test('a stamped send with unavailable note state is still mine (under-inclusion fix)', () => {
    const stampedSend = feedTx({ type: 'Transfer', txHash: hx('7'), label: null });
    expect(isAccountingTxMine(stampedSend, evidence({ sentTxHashes: new Set([hx('7')]) }))).toBe(true);
    expect(isAccountingTxMine(stampedSend, evidence())).toBe(false);
  });

  test('payer-address deposit ownership applies ONLY in wallet identity mode', () => {
    const payerDeposit = feedTx({ type: 'Deposit', txHash: hx('6'), fullAddress: addr('b') });
    // Wallet mode: the depositing wallet IS the account.
    expect(isAccountingTxMine(payerDeposit, evidence({ walletAddressLc: addr('b') }))).toBe(true);
    // Key mode (walletAddressLc null): payer wallet B's deposit is NOT
    // key-account A's unless A owns the created note.
    expect(isAccountingTxMine(payerDeposit, evidence())).toBe(false);
    expect(isAccountingTxMine(payerDeposit, evidence({ noteTxHashes: new Set([hx('6')]) }))).toBe(true);
  });
});

// --- Full-pipeline golden: evidence gate → merge → buildAccountingItems →
// sort → buildKoinlyCsv. Pins scoping, direction, plural bundles, batch
// folding, and snapshot augmentation end-to-end, not just the serializer.

const { mergeMyTransactions } = await import('@/services/transfer-direction');

describe('accounting pipeline (golden)', () => {
  test('feed → gate → items → CSV matches the pinned pipeline output', async () => {
    // The account's notes: a deposit root, a two-note multi-lineage receive,
    // and a change note from its own withdrawal.
    const depositNote = ownedNote({ txHash: hx('1'), commitment: hx('2'), value: '0xde0b6b3a7640000' as never });
    const recvA = ownedNote({ txHash: hx('3'), commitment: hx('4'), value: '0xc249fdd327780000' as never, label: hx('a') }); // 14 ETH
    const recvB = ownedNote({ txHash: hx('3'), commitment: hx('5'), value: '0xc249fdd327780000' as never, label: hx('b') }); // 14 ETH
    const changeNote = ownedNote({ txHash: hx('6'), commitment: hx('7'), value: '0x64' as never });
    const accountNotes = [depositNote, recvA, recvB, changeNote];

    const feed: Transaction[] = [
      // Own deposit (wallet mode, address match + owned note).
      feedTx({ id: 'dep', type: 'Deposit', txHash: hx('1'), fullAddress: addr('a'), timestamp: Date.UTC(2026, 0, 2) }),
      // Two-lineage receive (28 = 14+14).
      feedTx({ id: 'recv', type: 'Transfer', txHash: hx('3'), timestamp: Date.UTC(2026, 0, 3) }),
      // Own withdrawal: TWO same-hash batch rows that must fold; fee recorded once.
      feedTx({ id: 'w1', type: 'Withdrawal', txHash: hx('6'), rawAmount: '600000000000000000', timestamp: Date.UTC(2026, 0, 4, 10) }),
      feedTx({ id: 'w2', type: 'Withdrawal', txHash: hx('6'), rawAmount: '400000000000000000', timestamp: Date.UTC(2026, 0, 4, 9) }),
      // FOREIGN withdrawal sharing label with recvA — must NOT leak in.
      feedTx({ id: 'foreign', type: 'Withdrawal', txHash: hx('f'), label: hx('a'), rawAmount: '123', timestamp: Date.UTC(2026, 0, 5) }),
      // Own internal spend's leftover ASP row — must be suppressed.
      feedTx({ id: 'internal', type: 'Transfer', txHash: hx('9'), timestamp: Date.UTC(2026, 0, 6) }),
    ];

    // The modal's evidence gate + internal suppression, verbatim semantics.
    const evd = evidence({
      noteTxHashes: new Set(accountNotes.map((n) => String(n.txHash).toLowerCase())),
      withdrawTxHashes: new Set([hx('6')]),
      walletAddressLc: addr('a'),
    });
    const internalTxHashes = new Set<string>([hx('9')]);
    const mineEvents = feed.filter(
      (tx) => isAccountingTxMine(tx, evd) && !internalTxHashes.has(tx.txHash.toLowerCase()),
    );
    const mineRows = mergeMyTransactions(mineEvents, []);

    const items = buildAccountingItems(sources({
      mineRows,
      notes: accountNotes,
      nowMs: Date.UTC(2026, 0, 10),
      myDeposits: [
        // Older-than-window deposit, note consolidated away → CSV-only.
        { txHash: hx('c'), logIndex: 0, depositAddress: addr('a'), outputCommitment: hx('d'), depositedValue: '2000000000000000000', fee: '0', blockNumber: '1', blockTimestamp: String(Date.UTC(2026, 0, 1) / 1000), asset: ETH },
      ],
      myExits: [
        { txHash: hx('b'), logIndex: 0, ragequitter: addr('a'), withdrawnValue: '250000000000000000', commitment: hx('2'), nullifierHash: hx('e'), label: hx('d'), blockNumber: '1', blockTimestamp: String(Date.UTC(2026, 0, 7) / 1000), asset: ETH },
      ],
    }));

    const koinlyItems = [...items].sort((a, b) => a.timestamp - b.timestamp);
    const csv = await buildKoinlyCsv(koinlyItems, {
      notes: accountNotes,
      findFee: (h) => (h.toLowerCase() === hx('6') ? { feeAmount: '10000000000000000' } : null),
      buildOriginProof: (async () => null) as never,
    });

    // Structural assertions (robust to encoding), then the byte-exact golden.
    const lines = csv.split('\n');
    expect(lines).toHaveLength(6); // header + snapshot dep + dep + recv + folded withdrawal + exit
    expect(csv).not.toContain(hx('f')); // foreign withdrawal never leaks
    expect(csv).not.toContain(hx('9')); // internal spend suppressed
    const recvLine = lines.find((l) => l.includes(hx('3')))!;
    expect(recvLine.split(',').slice(3, 5)).toEqual(['28', 'ETH']); // 14+14 summed
    expect(recvLine).toContain('/verify/pvkb1.'); // plural bundles → batch link
    const wLine = lines.find((l) => l.includes(hx('6')))!;
    expect(wLine.split(',').slice(1, 7)).toEqual(['0.99', 'ETH', '', '', '0.01', 'ETH']); // folded once, fee once

    const golden = (await Bun.file(
      new URL('./__fixtures__/koinly-pipeline-golden.csv', import.meta.url).pathname,
    ).text()).trimEnd();
    expect(csv).toBe(golden);
  });
});
