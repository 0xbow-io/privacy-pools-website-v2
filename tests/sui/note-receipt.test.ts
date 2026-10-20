import { describe, it, expect } from 'vitest';
import {
  parseSuiNoteReceipt,
  suiReceiptToStoredNote,
  verifySuiNoteOnChain,
  verifySuiNoteReceipt,
  type CommitmentReader,
} from '@/services/sui-witness/note-receipt';
import {
  addressToU256,
  calculateNoteAddressHash,
  calculateNoteCommitment,
} from '@/services/sui-witness/crypto';

/**
 * Sui one-time note receipt parsing + verification (codex round-1 finding 4).
 *
 * The transfer success screen hands the sender a `kind: "ppv2-sui-note"` JSON
 * and points the recipient at Actions -> Payments -> Import Note; these tests
 * pin that the importer's parse/verify layer accepts exactly that payload
 * (raw or base64), refuses tampered/mis-addressed receipts, and produces the
 * StoredSuiNote shape the note store expects.
 */

const OWNER_SUI_ADDRESS = '0x' + 'ab'.repeat(32);
const OTHER_SUI_ADDRESS = '0x' + 'cd'.repeat(32);

async function buildValidReceipt() {
  const ownerAddress = addressToU256(OWNER_SUI_ADDRESS);
  const noteSecret = 12345678901234567890n;
  const tokenId = 987654321n;
  const value = 5_000_000_000n; // 5 SUI
  const label = 42424242n;
  const noteAddressHash = await calculateNoteAddressHash(ownerAddress, noteSecret);
  const commitment = await calculateNoteCommitment(noteAddressHash, tokenId, value, 0n, label);
  return {
    kind: 'ppv2-sui-note' as const,
    note: {
      commitment: commitment.toString(),
      value: value.toString(),
      tokenId: tokenId.toString(),
      label: label.toString(),
      noteSecret: noteSecret.toString(),
      ownerAddress: ownerAddress.toString(),
      coinType: '0x2::sui::SUI',
      status: 'active',
      txDigest: 'DigestAbc123',
    },
  };
}

describe('parseSuiNoteReceipt', () => {
  it('parses the raw JSON the transfer success screen emits', async () => {
    const receipt = await buildValidReceipt();
    const parsed = parseSuiNoteReceipt(JSON.stringify(receipt, null, 2));
    expect(parsed).not.toBeNull();
    expect(parsed!.commitment).toBe(receipt.note.commitment);
    expect(parsed!.noteSecret).toBe(receipt.note.noteSecret);
    expect(parsed!.coinType).toBe('0x2::sui::SUI');
    expect(parsed!.txDigest).toBe('DigestAbc123');
  });

  it('parses base64 and base64url encodings of the JSON', async () => {
    const receipt = await buildValidReceipt();
    const json = JSON.stringify(receipt);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    const b64url = Buffer.from(json, 'utf8').toString('base64url');
    expect(parseSuiNoteReceipt(b64)?.commitment).toBe(receipt.note.commitment);
    expect(parseSuiNoteReceipt(b64url)?.commitment).toBe(receipt.note.commitment);
  });

  it('returns null for payloads that are not Sui receipts', () => {
    expect(parseSuiNoteReceipt('')).toBeNull();
    expect(parseSuiNoteReceipt('not json at all')).toBeNull();
    // EVM AccountExport-ish JSON -> not ours, let the EVM importer handle it.
    expect(parseSuiNoteReceipt(JSON.stringify({ notes: [], syncCursor: '0x0' }))).toBeNull();
    expect(parseSuiNoteReceipt(JSON.stringify({ kind: 'ppv2-sui-payment-receipt', note: {} }))).toBeNull();
  });

  it('throws on a Sui receipt with missing or non-numeric note fields', async () => {
    const receipt = await buildValidReceipt();
    const missing = { kind: 'ppv2-sui-note', note: { ...receipt.note, noteSecret: undefined } };
    expect(() => parseSuiNoteReceipt(JSON.stringify(missing))).toThrow(/missing noteSecret/);
    const nonNumeric = { kind: 'ppv2-sui-note', note: { ...receipt.note, value: '5 SUI' } };
    expect(() => parseSuiNoteReceipt(JSON.stringify(nonNumeric))).toThrow(/value is not a number/);
    expect(() => parseSuiNoteReceipt(JSON.stringify({ kind: 'ppv2-sui-note' }))).toThrow(/missing note fields/);
  });
});

describe('verifySuiNoteReceipt', () => {
  it('accepts a receipt whose commitment reconstructs for the connected account', async () => {
    const receipt = await buildValidReceipt();
    await expect(verifySuiNoteReceipt(receipt.note, OWNER_SUI_ADDRESS)).resolves.toBeUndefined();
  });

  it('rejects a receipt addressed to a different Sui account', async () => {
    const receipt = await buildValidReceipt();
    await expect(verifySuiNoteReceipt(receipt.note, OTHER_SUI_ADDRESS)).rejects.toThrow(
      /different Sui account/,
    );
  });

  it('rejects a tampered receipt (commitment does not reconstruct)', async () => {
    const receipt = await buildValidReceipt();
    const tampered = { ...receipt.note, value: (BigInt(receipt.note.value) + 1n).toString() };
    await expect(verifySuiNoteReceipt(tampered, OWNER_SUI_ADDRESS)).rejects.toThrow(
      /does not reconstruct/,
    );
  });
});

describe('suiReceiptToStoredNote', () => {
  it('produces an ACTIVE StoredSuiNote with a defaulted coinType', async () => {
    const receipt = await buildValidReceipt();
    const stored = suiReceiptToStoredNote({ ...receipt.note, coinType: undefined });
    expect(stored.status).toBe('active');
    expect(stored.coinType).toBe('0x2::sui::SUI');
    expect(stored.commitment).toBe(receipt.note.commitment);
    expect(stored.noteSecret).toBe(receipt.note.noteSecret);
    expect(stored.txDigest).toBe('DigestAbc123');
  });
});

describe('verifySuiNoteOnChain (existence gate, round-3 finding 2)', () => {
  it('passes when the pool has a timestamp for the commitment', async () => {
    const reader: CommitmentReader = {
      getCommitmentTimestamp: async () => 1_700_000_000n,
    };
    await expect(verifySuiNoteOnChain(reader, { commitment: '123' })).resolves.toBeUndefined();
  });

  it('refuses a commitment with no on-chain record (self-consistent forgery)', async () => {
    const reader: CommitmentReader = {
      getCommitmentTimestamp: async (c) => {
        throw new Error(`commitment ${c} not found on-chain (no timestamp)`);
      },
    };
    await expect(verifySuiNoteOnChain(reader, { commitment: '123' })).rejects.toThrow(
      /does not exist on-chain/,
    );
  });

  it('surfaces a retryable error on a transient RPC failure (never stores)', async () => {
    const reader: CommitmentReader = {
      getCommitmentTimestamp: async () => {
        throw new Error('RPC timeout (10000ms) during getCommitmentTimestamp');
      },
    };
    await expect(verifySuiNoteOnChain(reader, { commitment: '123' })).rejects.toThrow(
      /try again/,
    );
  });
});
