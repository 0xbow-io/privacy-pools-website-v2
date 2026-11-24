// The accounting export over a Stellar account: the rows come from the real
// producer (deriveStellarActivity over the pool's history), go through the same
// item builder and Koinly CSV as EVM, and the proofs they carry verify against
// the Stellar pool.
import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_PAY_URL_BASE = 'https://pay.example.test';
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { buildAccountingItems, buildKoinlyCsv } = await import('@/services/accounting-export');
const { decodeOriginProof, decodePartialViewingKey, decodePartialViewingKeyBatch } = await import('@/services/audit-receipt');
const { buildStellarNoteOrigins, deriveStellarActivity, reconstructStellarSpends, stellarSentRecipientLookup } = await import('@/services/stellar-activity');
const { findBySpelling, stellarSentDisclosures } = await import('@/services/stellar/stellar-audit');
const { mergeMyTransactions } = await import('@/services/transfer-direction');
const { getTokenMetadata } = await import('@/config/tokens');
type Hex = import('@/services/sdk-types').Hex;
type Note = import('@/services/sdk-types').Note;

const ME = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const PAYEE = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const NK = '0x5';
const CTX = { chainId: 202, chainName: 'Stellar Testnet', symbol: 'XLM', decimals: 7, priceUsd: 0, ownAddress: ME };

const fakeHash = { hash: ([k, c]: Hex[]) => `0x${(BigInt(k) * 1_000_000n + BigInt(c)).toString(16)}` as Hex };
const nullifierOf = (c: number) => fakeHash.hash([NK as Hex, `0x${c.toString(16)}` as Hex]);
const pad = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
// Event rows spell the hash without 0x; an SDK receipt (what a send records) with it.
const tx = (n: number) => n.toString(16).padStart(64, 'b');

const note = (c: number, value: bigint, status: string, label = '0xabc') => ({
  commitment: pad(BigInt(c)),
  noteAddressHash: pad(BigInt(100 + c)),
  noteSecret: `0x${(9000 + c).toString(16)}`,
  value: pad(value),
  tokenId: XLM,
  label,
  status,
  ownerAddress: ME,
  isOwned: true,
  txHash: tx(c),
});

/** Deposit 2 XLM, send 0.5, withdraw 0.5 (gross), exit the change, and receive 0.7 from someone else. */
function stellarAccount() {
  const notes = [
    note(1, 20_000_000n, 'SPENT'),
    note(2, 15_000_000n, 'SPENT'),
    note(3, 10_000_000n, 'EXITED'),
    note(5, 7_000_000n, 'ACTIVE', '0xdef'),
  ];
  const transacts = [
    { txHash: tx(2), outputCommitments: ['0x2', '0x777'], nullifierHashes: [nullifierOf(1)], withdrawnValue: '0x0', asset: XLM },
    { txHash: tx(3), outputCommitments: ['0x3'], nullifierHashes: [nullifierOf(2)], withdrawnValue: '0x4c4b40', asset: XLM },
    // Someone else's send to us.
    { txHash: tx(5), outputCommitments: ['0x5', '0x555'], nullifierHashes: ['0x123'], withdrawnValue: '0x0', asset: XLM },
  ];
  const spends = reconstructStellarSpends({ notes, transacts, nullifyingKey: NK, hashService: fakeHash });
  const origins = buildStellarNoteOrigins({
    notes,
    deposits: [{ txHash: tx(1), outputCommitment: '0x1', depositor: ME }],
    transacts,
    logs: [1, 2, 3, 4, 5].map((i) => ({ transactionHash: tx(i), ledger: `0x${(500 + i).toString(16)}`, ledgerClosedAt: `2026-09-30T10:0${i}:00Z` })),
    spends,
    ragequits: [{ txHash: tx(4), commitment: '0x3' }],
  });
  const activity = deriveStellarActivity(notes, origins, {
    ...CTX,
    sentRecipient: stellarSentRecipientLookup([{ txHash: `0x${tx(2)}`, recipient: PAYEE, chainId: 202 }], 202),
  });
  return { notes: notes as unknown as Note[], rows: mergeMyTransactions([], activity.rows) };
}

// What the transfer modal records for the send (the SDK's recipient notes), under the receipt's spelling.
const sentStore = new Map([[`0x${tx(2)}`, stellarSentDisclosures({
  chainId: 202,
  txHash: `0x${tx(2)}`,
  recipient: PAYEE,
  amount: 5_000_000n,
  notes: [{ commitment: '0x777', ownerAddress: PAYEE, noteSecret: '0x42', value: pad(5_000_000n), tokenId: XLM, label: '0xabc' }],
})]]);
const feeStore = new Map([
  [`0x${tx(3)}`, { feeAmount: '0x493e0' }], // 0.03 XLM inside the withdrawal
  [`0x${tx(2)}`, { feeAmount: '0x186a0' }], // 0.01 XLM on top of the send
]);

function items() {
  const { notes, rows } = stellarAccount();
  return buildAccountingItems({
    mineRows: rows,
    notes,
    notesByChain: new Map([[202, notes]]),
    sentTxHashes: new Set(),
    transferTxHashes: new Set(),
    transferClassificationReady: true,
    myDeposits: [],
    myExits: [],
    evmChainId: 11155111,
    findSentAudits: (h) => findBySpelling(h, (s) => sentStore.get(s) ?? [], (l) => l.length === 0) ?? [],
    findSentTransfer: () => null,
    nowMs: 0,
  });
}

describe('Stellar accounting items', () => {
  test('every activity type is booked, keyed for proof where a note exists', () => {
    const byType = Object.fromEntries(items().map((it) => [it.type, it]));
    expect(Object.keys(byType).sort()).toEqual(['deposit', 'exit', 'transfer-in', 'transfer-out', 'withdraw']);
    expect(byType.deposit).toMatchObject({ txHash: tx(1), chainId: 202, tokenId: XLM });
    expect(BigInt(byType.deposit.value)).toBe(20_000_000n);
    expect(byType.deposit.bundles?.[0]).toMatchObject({ kind: 'owned', chainId: 202, ownerAddress: ME, noteSecret: '0x2329' });
    expect(byType['transfer-in'].bundles?.[0]).toMatchObject({ kind: 'owned', chainId: 202, commitment: pad(5n) });
    // The send's disclosure, found although the row spells the hash without 0x.
    expect(byType['transfer-out']).toMatchObject({ counterparty: PAYEE, value: '0x4c4b40' });
    expect(byType['transfer-out'].bundles?.[0]).toMatchObject({ kind: 'sent', ownerAddress: PAYEE, noteSecret: '0x42' });
    // Public: CSV only, the gross that left the pool.
    expect(byType.withdraw).toMatchObject({ bundles: null, value: '5000000' });
    expect(byType.exit).toMatchObject({ bundles: null, value: '10000000', label: '0xabc' });
  });
});

describe('Stellar Koinly CSV', () => {
  test('XLM in its own units, relayer fees split out, every row carrying a Stellar proof link', async () => {
    const { notes } = stellarAccount();
    const csv = await buildKoinlyCsv(items().sort((a, b) => a.timestamp - b.timestamp), {
      notes,
      findFee: (h) => findBySpelling(h, (s) => feeStore.get(s)),
    });
    const lines = csv.split('\n').slice(1);
    const line = (hash: string) => lines.find((l) => l.endsWith(`,${hash}`))!;
    // Date, SentAmt, SentCur, RecvAmt, RecvCur, FeeAmt, FeeCur, ...
    expect(line(tx(1)).split(',').slice(1, 7)).toEqual(['', '', '2', 'XLM', '', '']);
    expect(line(tx(2)).split(',').slice(1, 7)).toEqual(['0.5', 'XLM', '', '', '0.01', 'XLM']);
    expect(line(tx(3)).split(',').slice(1, 7)).toEqual(['0.47', 'XLM', '', '', '0.03', 'XLM']);
    expect(line(tx(4)).split(',').slice(1, 7)).toEqual(['1', 'XLM', '', '', '', '']);
    expect(line(tx(5)).split(',').slice(3, 5)).toEqual(['0.7', 'XLM']);
    expect(csv).not.toContain('CDLZFC,');

    const link = (l: string, label: string) => l.split(` · ${label}: https://pay.example.test/verify#`)[1]?.split(',')[0];
    const deposit = decodePartialViewingKey(link(line(tx(1)), 'verify'));
    expect(deposit).toMatchObject({ chainId: 202, ownerAddress: ME, tokenId: XLM });
    const sent = decodePartialViewingKey(link(line(tx(2)), 'verify')) ?? decodePartialViewingKeyBatch(link(line(tx(2)), 'verify'))?.[0];
    expect(sent).toMatchObject({ kind: 'sent', chainId: 202, ownerAddress: PAYEE });
    // Withdrawal: proven from its change note; exit: from the exited note.
    expect(decodeOriginProof(link(line(tx(3)), 'proof of origin'))).toMatchObject({ chainId: 202, target: { type: 'withdraw', txHash: tx(3) }, note: { ownerAddress: ME, value: pad(10_000_000n) } });
    expect(decodeOriginProof(link(line(tx(4)), 'proof of origin'))).toMatchObject({ chainId: 202, target: { type: 'exit', txHash: tx(4) }, note: { label: '0xabc' } });
  });

  test('a Stellar bundle is recomputed with Stellar field conversions, not the EVM path', async () => {
    const { recomputeCommitment } = await import('@/services/audit-receipt');
    const { recomputeStellarCommitment } = await import('@/services/stellar/stellar-audit-verify');
    const [deposit] = items().filter((it) => it.type === 'deposit');
    const bundle = deposit.bundles![0];
    expect(await recomputeCommitment(bundle)).toBe(await recomputeStellarCommitment(bundle));
  });

  test('native XLM resolves to its symbol and 7 decimals in any casing', () => {
    expect(getTokenMetadata(XLM, 202)).toMatchObject({ symbol: 'XLM', decimals: 7, isNative: true });
    expect(getTokenMetadata(XLM.toLowerCase())).toMatchObject({ symbol: 'XLM', decimals: 7 });
  });
});
