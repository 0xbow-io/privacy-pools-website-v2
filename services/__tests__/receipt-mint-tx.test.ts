// An EVM receipt (partial viewing key) verifies only when its note was minted
// in the transaction the receipt names. The minting tx comes from the same bulk
// events as the presence check; nothing names the receipt's tx or note.
import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const { OnChainNoteIndex } = await import('@/services/onchain-note-index');
const { buildSentPaymentKey, receiptMintVerdict } = await import('@/services/audit-receipt');
const { disclosureMatchesTx, rekeyBridgedAudits } = await import('@/services/audit-store-core');
type Hex = import('@/services/sdk-types').Hex;

const pad = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const DEPOSIT = pad(0xaaan);
const OUTPUT = pad(0xbbbn);
const BARE = pad(0xcccn);
const TX_DEPOSIT = pad(0xd1n);
const TX_SEND = pad(0x5en);
const TX_OTHER = pad(0x77n);

function index(opts: { snapshot?: unknown; tailTx?: boolean }) {
  const calls: string[] = [];
  const vault = {
    getStateLeaves: async () => { calls.push('leaves'); return []; },
    getDepositedEvents: async () => { calls.push('deposits'); return [{ blockNumber: '0x64', outputCommitment: DEPOSIT, ...(opts.tailTx ? { txHash: TX_DEPOSIT } : {}) }]; },
    getTransactedEvents: async () => {
      calls.push('transacts');
      return [
        { blockNumber: '0x65', outputCommitments: [OUTPUT], nullifierHashes: [pad(1n)], ...(opts.tailTx ? { txHash: TX_SEND } : {}) },
        { blockNumber: '0x66', outputCommitments: [BARE], nullifierHashes: [pad(2n)] },
      ];
    },
    getRagequitEvents: async () => { calls.push('ragequits'); return []; },
  };
  const idx = new OnChainNoteIndex({
    chainId: 11155111,
    poolVaultInteractor: vault as never,
    hashService: { hash: () => pad(0n) } as never,
    loadEventSnapshot: opts.snapshot === undefined ? undefined : async () => opts.snapshot,
  });
  (idx as unknown as { fetchBlockTimestamps: () => Promise<Map<string, Hex>> }).fetchBlockTimestamps = async () => new Map();
  return { idx, calls };
}

describe('minting tx from the bulk note index', () => {
  test('chain tail events carry their tx hash per minted commitment', async () => {
    const { idx, calls } = index({ tailTx: true });
    await idx.refresh();
    expect(idx.mintingTxHash(DEPOSIT)).toBe(TX_DEPOSIT);
    expect(idx.mintingTxHash(OUTPUT)).toBe(TX_SEND);
    // Present, but the event carried no hash: unknown, never looked up.
    expect(idx.hasCommitment(BARE)).toBe(true);
    expect(idx.mintingTxHash(BARE)).toBeNull();
    // Only the bulk reads the index always makes.
    expect(new Set(calls)).toEqual(new Set(['deposits', 'transacts', 'ragequits', 'leaves']));
  });

  test('ASP snapshot rows carry it too, deposits included', async () => {
    const { idx } = index({
      snapshot: {
        snapshotBlockNumber: '200',
        deposits: [{ outputCommitment: BigInt(pad(0xeen)).toString(), blockTimestamp: '2026-09-30T10:00:00Z', blockNumber: '10', txHash: TX_OTHER }],
        transacts: [],
        ragequits: [],
      },
    });
    await idx.refresh();
    expect(idx.mintingTxHash(pad(0xeen))).toBe(TX_OTHER);
  });
});

describe('receiptMintVerdict', () => {
  test('the receipt names the minting tx: verified, whatever the spelling', () => {
    expect(receiptMintVerdict({ present: true, mintTxHash: TX_SEND, receiptTxHash: TX_SEND.toUpperCase().replace('0X', '0x'), namedTxMintsInPool: true })).toEqual({ onChain: true });
  });

  test('a real note named under another tx does not verify', () => {
    const v = receiptMintVerdict({ present: true, mintTxHash: TX_SEND, receiptTxHash: TX_OTHER, namedTxMintsInPool: true });
    expect(v.onChain).toBe(false);
    expect(v.error).toContain('different transaction');
  });

  test('no bulk tx hash for the note fails closed with a reason, instead of a lookup', () => {
    const v = receiptMintVerdict({ present: true, mintTxHash: null, receiptTxHash: TX_SEND, namedTxMintsInPool: true });
    expect(v.onChain).toBe(false);
    expect(v.error).toContain('Could not confirm which transaction');
  });

  test('a note never minted is simply not on chain', () => {
    expect(receiptMintVerdict({ present: false, mintTxHash: null, receiptTxHash: TX_SEND, namedTxMintsInPool: false })).toEqual({ onChain: false });
  });
});

// A cross-chain shield for someone else (DEV-489): the claim disclosure was
// recorded under the SOURCE-chain swap; the bridge minted the note in its own
// tx on the pool's chain (here TX_DEPOSIT, the deposit of DEPOSIT).
describe('bridged deposits', () => {
  const SOURCE_SWAP = pad(0xb41d6en);
  const disclosure = {
    chainId: 11155111, txHash: SOURCE_SWAP, commitment: DEPOSIT, ownerAddress: `0x${'ab'.repeat(20)}`,
    noteSecret: '0x1234', tokenId: `0x${'ee'.repeat(20)}`, value: '0x1', label: '0xabc',
  } as never;

  test('once delivered, the disclosure moves to the minting tx, keeps the source, and still answers for the source row', () => {
    const rekeyed = rekeyBridgedAudits([disclosure], SOURCE_SWAP, TX_DEPOSIT, 11155111);
    expect(rekeyed).toHaveLength(1);
    expect(rekeyed[0]).toMatchObject({ txHash: TX_DEPOSIT.toLowerCase(), sourceTxHash: SOURCE_SWAP.toLowerCase() });
    expect(disclosureMatchesTx(rekeyed[0], SOURCE_SWAP)).toBe(true);
    expect(disclosureMatchesTx(rekeyed[0], TX_DEPOSIT)).toBe(true);
    // Another chain's record is never moved.
    expect(rekeyBridgedAudits([disclosure], SOURCE_SWAP, TX_DEPOSIT, 1)).toEqual([]);
    // The receipt built from it names the minting tx, so it verifies outright.
    const bundle = buildSentPaymentKey(rekeyed[0]);
    expect(bundle).toMatchObject({ txHash: TX_DEPOSIT.toLowerCase(), sourceTxHash: SOURCE_SWAP.toLowerCase() });
  });

  test('a new receipt keyed to the destination tx verifies against the bulk index', async () => {
    const { idx } = index({ tailTx: true });
    await idx.refresh();
    const receiptTx = TX_DEPOSIT;
    expect(receiptMintVerdict({
      present: idx.hasCommitment(DEPOSIT), mintTxHash: idx.mintingTxHash(DEPOSIT),
      receiptTxHash: receiptTx, namedTxMintsInPool: idx.isPoolMintTx(receiptTx),
    })).toEqual({ onChain: true });
  });

  test('a receipt already issued with the source swap hash is not called a mismatch', async () => {
    const { idx } = index({ tailTx: true });
    await idx.refresh();
    expect(idx.isPoolMintTx(SOURCE_SWAP)).toBe(false);
    const v = receiptMintVerdict({
      present: idx.hasCommitment(DEPOSIT), mintTxHash: idx.mintingTxHash(DEPOSIT),
      receiptTxHash: SOURCE_SWAP, namedTxMintsInPool: idx.isPoolMintTx(SOURCE_SWAP),
    });
    expect(v).toEqual({ onChain: true, sourceTxUnchecked: true });
    expect(v.error).toBeUndefined();
  });

  test('naming a tx that minted something else in this pool is still a mismatch', async () => {
    const { idx } = index({ tailTx: true });
    await idx.refresh();
    const v = receiptMintVerdict({
      present: idx.hasCommitment(DEPOSIT), mintTxHash: idx.mintingTxHash(DEPOSIT),
      receiptTxHash: TX_SEND, namedTxMintsInPool: idx.isPoolMintTx(TX_SEND),
    });
    expect(v.onChain).toBe(false);
    expect(v.error).toContain('different transaction');
  });
});
