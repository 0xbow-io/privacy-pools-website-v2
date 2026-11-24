// An EVM receipt (partial viewing key) verifies only when its note was minted
// in the transaction the receipt names. The minting tx comes from the same bulk
// events as the presence check; nothing names the receipt's tx or note.
import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const { OnChainNoteIndex } = await import('@/services/onchain-note-index');
const { receiptMintVerdict } = await import('@/services/audit-receipt');
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
    expect(receiptMintVerdict({ present: true, mintTxHash: TX_SEND, receiptTxHash: TX_SEND.toUpperCase().replace('0X', '0x') })).toEqual({ onChain: true });
  });

  test('a real note named under another tx does not verify', () => {
    const v = receiptMintVerdict({ present: true, mintTxHash: TX_SEND, receiptTxHash: TX_OTHER });
    expect(v.onChain).toBe(false);
    expect(v.error).toContain('different transaction');
  });

  test('no bulk tx hash for the note fails closed with a reason, instead of a lookup', () => {
    const v = receiptMintVerdict({ present: true, mintTxHash: null, receiptTxHash: TX_SEND });
    expect(v.onChain).toBe(false);
    expect(v.error).toContain('Could not confirm which transaction');
  });

  test('a note never minted is simply not on chain', () => {
    expect(receiptMintVerdict({ present: false, mintTxHash: null, receiptTxHash: TX_SEND })).toEqual({ onChain: false });
  });
});
