import { describe, it, expect } from 'vitest';
import {
  discoveredToStoredNote,
  scanTargeted,
  scanCatchAll,
  verifyDiscoveredCommitment,
  MalformedDiscoveryBatch,
  type TransactEvent,
} from '@/services/sui-witness/note-discovery';
import {
  ecdh,
  encrypt,
  encodeNotePayload,
  deriveViewingPublicKey,
} from '@/services/sui-witness/note-crypto';
import {
  addressToU256,
  calculateNoteAddressHash,
  calculateNoteCommitment,
  poseidonHash2,
} from '@/services/sui-witness/crypto';

/**
 * Note discovery (off-chain recipient channel). Verifies the fail-CLOSED
 * structural validation, a real trial-decrypt SUCCESS + dedup, and the catch-all
 * (ephemeral-pubkey) path. The on-chain NoteEvent stream is mocked: we hand the
 * scanner the exact { outputCommitments, noteHints, noteData } a Transacted +
 * NoteEvent pair would carry.
 */

// Deterministic key material (32-byte hex private keys).
const SENDER_PRIV = '0x' + '11'.repeat(32);
const RECIPIENT_PRIV = '0x' + '22'.repeat(32);
const EPHEMERAL_PRIV = '0x' + '33'.repeat(32);

const RECIPIENT_PUB = deriveViewingPublicKey(RECIPIENT_PRIV);
const SENDER_PUB = deriveViewingPublicKey(SENDER_PRIV);
const EPHEMERAL_PUB = deriveViewingPublicKey(EPHEMERAL_PRIV);

function bytesToBigint(bytes: Uint8Array): bigint {
  let r = 0n;
  for (const b of bytes) r = (r << 8n) | BigInt(b);
  return r;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const PAYLOAD = { noteSecret: 7n, value: 4242n, tokenId: 9999n, label: 314n };

/** Build a TARGETED event: hint = tag(32) = Poseidon(sharedSecret,0). */
async function buildTargetedEvent(): Promise<TransactEvent> {
  const shared = ecdh(SENDER_PRIV, RECIPIENT_PUB);
  const tag = await poseidonHash2(bytesToBigint(shared), 0n);
  const hint = new Uint8Array(32);
  let v = tag;
  for (let i = 31; i >= 0; i--) {
    hint[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  const noteData = encrypt(encodeNotePayload(PAYLOAD), shared);
  return {
    txDigest: 'TX_TARGETED',
    outputCommitments: [12345n],
    noteHints: [hint],
    noteData: [noteData],
  };
}

/** Build a CATCH-ALL event: hint = 33-byte ephemeral compressed pubkey. */
function buildCatchAllEvent(): TransactEvent {
  // Sender encrypts under ecdh(ephemeralPriv, recipientPub); the receiver recovers
  // the same secret via ecdh(recipientPriv, ephemeralPub).
  const shared = ecdh(EPHEMERAL_PRIV, RECIPIENT_PUB);
  const noteData = encrypt(encodeNotePayload(PAYLOAD), shared);
  const hint = hexToBytes(EPHEMERAL_PUB); // 33-byte compressed point
  return {
    txDigest: 'TX_CATCHALL',
    outputCommitments: [67890n],
    noteHints: [hint],
    noteData: [noteData],
  };
}

describe('scanTargeted', () => {
  it('recovers a note addressed to the scanner (real trial-decrypt)', async () => {
    const event = await buildTargetedEvent();
    const found = await scanTargeted([event], [{ name: 'sender', viewingPublicKey: SENDER_PUB }], RECIPIENT_PRIV);
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe(4242n);
    expect(found[0].noteSecret).toBe(7n);
    expect(found[0].label).toBe(314n);
    expect(found[0].commitment).toBe(12345n);
    expect(found[0].contact?.name).toBe('sender');
  });

  it('skips an empty (anonymous) output slot without failing', async () => {
    const event: TransactEvent = {
      txDigest: 'TX',
      outputCommitments: [1n],
      noteHints: [new Uint8Array(0)],
      noteData: [new Uint8Array(0)],
    };
    const found = await scanTargeted([event], [{ name: 's', viewingPublicKey: SENDER_PUB }], RECIPIENT_PRIV);
    expect(found).toHaveLength(0);
  });

  it('skips a tag mismatch (someone else\'s note) without failing', async () => {
    const event = await buildTargetedEvent();
    // Scan with a DIFFERENT contact pubkey -> tag won't match -> no false positive.
    const found = await scanTargeted([event], [{ name: 'other', viewingPublicKey: EPHEMERAL_PUB }], RECIPIENT_PRIV);
    expect(found).toHaveLength(0);
  });
});

describe('scanCatchAll', () => {
  it('recovers a note via the ephemeral-pubkey hint', async () => {
    const event = buildCatchAllEvent();
    const found = await scanCatchAll([event], RECIPIENT_PRIV);
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe(4242n);
    expect(found[0].commitment).toBe(67890n);
    expect(found[0].contact).toBeNull();
  });

  it('dedups across re-scans by commitment when persisted through the note store', async () => {
    // Discovery itself returns one entry per matching output; re-running yields the
    // same commitment, which upsertSuiNote dedups (covered in deposit.test). Here we
    // assert scanning the SAME event twice surfaces the same commitment both times
    // (deterministic) so the store-level dedup is well-defined.
    const event = buildCatchAllEvent();
    const a = await scanCatchAll([event], RECIPIENT_PRIV);
    const b = await scanCatchAll([event], RECIPIENT_PRIV);
    expect(a[0].commitment).toBe(b[0].commitment);
  });
});

describe('discoveredToStoredNote (scan -> store -> spend reconstruction)', () => {
  it('persists the real owner field so the stored note reconstructs its commitment', async () => {
    // Codex round-2 finding 4: discovered notes were stored with ownerAddress
    // '0', so the spend path (which recomputes the commitment from
    // ownerAddress + noteSecret) derived a different leaf and could never
    // spend them. Full flow: sender binds owner = addressToU256(recipient)
    // into the commitment -> recipient discovers via catch-all -> the STORED
    // note's fields must rebuild that exact commitment.
    const recipientSuiAddress = '0x' + 'ab'.repeat(32);
    const ownerField = addressToU256(recipientSuiAddress);
    const noteAddressHash = await calculateNoteAddressHash(ownerField, PAYLOAD.noteSecret);
    const commitment = await calculateNoteCommitment(
      noteAddressHash,
      PAYLOAD.tokenId,
      PAYLOAD.value,
      0n,
      PAYLOAD.label,
    );

    const shared = ecdh(EPHEMERAL_PRIV, RECIPIENT_PUB);
    const event: TransactEvent = {
      txDigest: 'TX_OWNED',
      outputCommitments: [commitment],
      noteHints: [hexToBytes(EPHEMERAL_PUB)],
      noteData: [encrypt(encodeNotePayload(PAYLOAD), shared)],
    };

    const found = await scanCatchAll([event], RECIPIENT_PRIV);
    expect(found).toHaveLength(1);

    const stored = discoveredToStoredNote(recipientSuiAddress, found[0]);
    expect(stored.ownerAddress).toBe(ownerField.toString());
    expect(stored.ownerAddress).not.toBe('0');
    expect(stored.status).toBe('active');

    // Spend-path recomputation over the STORED (string) fields matches the
    // on-chain commitment the note was discovered under.
    const rebuiltNAH = await calculateNoteAddressHash(
      BigInt(stored.ownerAddress),
      BigInt(stored.noteSecret),
    );
    const rebuilt = await calculateNoteCommitment(
      rebuiltNAH,
      BigInt(stored.tokenId),
      BigInt(stored.value),
      0n,
      BigInt(stored.label),
    );
    expect(rebuilt).toBe(BigInt(stored.commitment));
    expect(rebuilt).toBe(commitment);

    // The persistence gate accepts it: fields hash to the event commitment.
    await expect(verifyDiscoveredCommitment(recipientSuiAddress, found[0])).resolves.toBe(true);
  });

  it('rejects a payload that decrypts cleanly but does NOT match the event commitment (round-3 finding 3)', async () => {
    // A sender can encrypt well-formed note data to the victim's viewing key
    // while the Transacted event's output commitment is something else
    // entirely. Discovery decrypts it, but the persistence gate must refuse
    // it — storing it would fake an active balance and later break spends.
    const recipientSuiAddress = '0x' + 'ab'.repeat(32);
    const shared = ecdh(EPHEMERAL_PRIV, RECIPIENT_PUB);
    const event: TransactEvent = {
      txDigest: 'TX_FORGED',
      // NOT the commitment the PAYLOAD's fields hash to for this owner.
      outputCommitments: [999999n],
      noteHints: [hexToBytes(EPHEMERAL_PUB)],
      noteData: [encrypt(encodeNotePayload(PAYLOAD), shared)],
    };

    const found = await scanCatchAll([event], RECIPIENT_PRIV);
    // It DOES decrypt (trial-decrypt succeeds)...
    expect(found).toHaveLength(1);
    expect(found[0].commitment).toBe(999999n);
    // ...but the persistence gate must reject it, so it is never stored.
    await expect(verifyDiscoveredCommitment(recipientSuiAddress, found[0])).resolves.toBe(false);
  });
});

describe('fail-CLOSED structural validation', () => {
  it('throws on a non-array events batch', async () => {
    await expect(scanTargeted(null as never, [], RECIPIENT_PRIV)).rejects.toThrow(MalformedDiscoveryBatch);
    await expect(scanCatchAll(undefined as never, RECIPIENT_PRIV)).rejects.toThrow(MalformedDiscoveryBatch);
  });

  it('throws on a null event element', async () => {
    await expect(scanCatchAll([null as never], RECIPIENT_PRIV)).rejects.toThrow(/null or non-object event/);
  });

  it('throws on a parallel-array length mismatch (truncated/corrupt batch)', async () => {
    const broken: TransactEvent = {
      txDigest: 'TX',
      outputCommitments: [1n, 2n],
      noteHints: [new Uint8Array(0)], // length 1 != 2
      noteData: [new Uint8Array(0), new Uint8Array(0)],
    };
    await expect(scanCatchAll([broken], RECIPIENT_PRIV)).rejects.toThrow(/array length mismatch/);
  });

  it('throws when a noteHints element is not bytes', async () => {
    const broken = {
      txDigest: 'TX',
      outputCommitments: [1n],
      noteHints: [{} as never],
      noteData: [new Uint8Array(0)],
    } as unknown as TransactEvent;
    await expect(scanCatchAll([broken], RECIPIENT_PRIV)).rejects.toThrow(/is not bytes/);
  });

  it('coerces number[] hints/data to Uint8Array (decoder-shape tolerance)', async () => {
    // A well-formed but number[]-encoded empty slot is valid (non-targeted output).
    const event = {
      txDigest: 'TX',
      outputCommitments: [1n],
      noteHints: [[] as number[]],
      noteData: [[] as number[]],
    } as unknown as TransactEvent;
    const found = await scanCatchAll([event], RECIPIENT_PRIV);
    expect(found).toHaveLength(0);
  });
});
