import { beforeAll, describe, expect, test } from 'bun:test';
import {
  CATCH_ALL_TAG,
  CryptoService,
  NoteComputationService,
  EvmAddressFieldConverter,
  EvmNoteDiscoveryService,
  PoseidonHashService,
} from '@privacy-pools-v2/sdk';

import {
  CLAIM_BACKUP_MAGIC,
  buildBlindDepositBackup,
  decodeBackupPayload,
  decryptBlindDepositBackup,
  encodeBackupPayload,
  joinNoteData,
  splitNoteData,
  type BackupCryptoLike,
  type BackupNoteComputationLike,
} from '../blind-deposit-backup';

/**
 * REAL SDK services, not fakes. The property this file exists to pin is a
 * claim about the SDK's behaviour - "your own catch-all discovery will skip
 * our backup rather than return it as a candidate with a wrong commitment" -
 * and a fake could only ever confirm what we assumed. The control case (an
 * SDK-generated note IS found by the same scanner in the same call) is what
 * makes the isolation result meaningful. Note the vendored build's codec
 * defines payload version 1 only; v2.0 source defines 1 and 2. Our version
 * byte is 126, so the result holds against both.
 *
 * Poseidon, the crypto service and the discovery service all construct under
 * bun (probed 2026-09-16).
 */

type Hex = `0x${string}`;

let hashService: Awaited<ReturnType<typeof PoseidonHashService.create>>;
let crypto: CryptoService;
let ncs: NoteComputationService;
let discovery: EvmNoteDiscoveryService;

// A registered sender: an X25519 pair, which is exactly what a viewing key is.
let senderViewPriv: Hex;
let senderViewPub: Hex;
const SENDER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x42bacd8d0c811a2ba95e5d44f9c71d984299e308';
const OTHER = '0x2222222222222222222222222222222222222222';
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const VALUE = '0xb5e620f48000'; // 0.0002 ETH

// Deterministic randomness so a failure reproduces.
const fixedFill = (byte: number) => (out: Uint8Array) => { out.fill(byte); };
// The cast is a TS lib-typing nit (Uint8Array<ArrayBufferLike> vs ArrayBufferView<ArrayBuffer>),
// not a behaviour change: the buffer is a plain 32-byte Uint8Array either way.
const realFill = (out: Uint8Array) => { globalThis.crypto.getRandomValues(out as unknown as Uint8Array<ArrayBuffer>); };

beforeAll(async () => {
  hashService = await PoseidonHashService.create();
  crypto = new CryptoService();
  ncs = new NoteComputationService({ hashService, cryptoService: crypto });
  discovery = new EvmNoteDiscoveryService({ cryptoService: crypto, hashService, noteComputationService: ncs, addressFieldConverter: new EvmAddressFieldConverter() });
  const pair = crypto.generateEphemeralKeyPair();
  senderViewPriv = pair.privateKey as Hex;
  senderViewPub = pair.publicKey as Hex;
});

const build = (over: Partial<Parameters<typeof buildBlindDepositBackup>[0]> = {}) =>
  buildBlindDepositBackup({
    recipient: RECIPIENT,
    tokenId: ETH,
    value: VALUE,
    noteSecret: crypto.generateSecret(),
    depositSecret: crypto.generateSecret(),
    senderViewingPubKey: senderViewPub,
    noteComputation: ncs as unknown as BackupNoteComputationLike,
    crypto: crypto as unknown as BackupCryptoLike,
    randomFill: realFill,
    ...over,
  });

/** Shape the ASP/indexer hands back for one Note log. */
const asEvent = (noteData: { hint: string; data: string }, txHash = '0xdead') => {
  const split = splitNoteData(noteData.data);
  if (!split) throw new Error('unsplittable data');
  return {
    blockNumber: '0x1' as Hex,
    txHash: txHash as Hex,
    hint: noteData.hint as Hex,
    ephemeralPubKey: split.ephemeralPubKey,
    encryptedPayload: split.encryptedPayload,
  };
};

describe("the sender's own discovery ignores the backup", () => {
  test("REAL scanCatchAll finds a real SDK note and NOT ours, in the same call", () => {
    const ours = build();
    // Control: what the SDK itself would announce for the sender's own note.
    const control = ncs.generateNoteData(
      { noteSecret: crypto.generateSecret(), value: VALUE as Hex, tokenId: ETH as Hex, label: ours.label } as never,
      senderViewPub,
    );
    const found = discovery.scanCatchAll(
      [asEvent(ours.noteData, '0x0a'), asEvent(control, '0x0b')] as never,
      senderViewPriv as never,
      SENDER as never,
    );
    // Exactly the control. Not zero (the harness works), not two (no phantom).
    expect(found.length).toBe(1);
    expect(String((found[0] as { txHash: string }).txHash)).toBe('0x0b');
  });

  test('the SDK decoder rejects our plaintext at the version switch, deterministically', () => {
    const ours = build();
    const shared = crypto.ecdh(senderViewPriv, splitNoteData(ours.noteData.data)!.ephemeralPubKey);
    const plaintext = crypto.decrypt(splitNoteData(ours.noteData.data)!.encryptedPayload, shared);
    // Public on the class; tryDecryptEvent calls it. Cast because the typedef
    // may not advertise it.
    const codec = ncs as unknown as {
      decodeNotePayload: (b: Uint8Array) => unknown;
      decodePaymentRequestNotePayload: (b: Uint8Array) => unknown;
    };
    expect(() => codec.decodeNotePayload(plaintext)).toThrow(/unsupported NotePayload version 126/);
    // The blind-kind decoder the payment-request scan uses rejects it at the
    // version as well, so no SDK scan of any kind ingests it.
    expect(() => codec.decodePaymentRequestNotePayload(plaintext)).toThrow(/version 2/);
    // And it is OUR decoder that reads it.
    expect(decodeBackupPayload(plaintext)).not.toBeNull();
  });

  test('our decoder refuses a real SDK note - "not ours" is a value, not a throw', () => {
    const control = ncs.generateNoteData(
      { noteSecret: crypto.generateSecret(), value: VALUE as Hex, tokenId: ETH as Hex, label: build().label } as never,
      senderViewPub,
    );
    const split = splitNoteData(control.data)!;
    expect(decryptBlindDepositBackup({
      ephemeralPubKey: split.ephemeralPubKey,
      encryptedPayload: split.encryptedPayload,
      viewingPrivateKey: senderViewPriv,
      crypto: crypto as unknown as BackupCryptoLike,
    })).toBeNull();
  });
});

describe('the sender can recover exactly what they announced', () => {
  test('round trip through the real crypto service', () => {
    const noteSecret = crypto.generateSecret();
    const ours = build({ noteSecret });
    const split = splitNoteData(ours.noteData.data)!;
    const back = decryptBlindDepositBackup({
      ephemeralPubKey: split.ephemeralPubKey,
      encryptedPayload: split.encryptedPayload,
      viewingPrivateKey: senderViewPriv,
      crypto: crypto as unknown as BackupCryptoLike,
    });
    expect(back).not.toBeNull();
    expect(back!.noteSecret).toBe(noteSecret.toLowerCase());
    expect(BigInt(back!.value)).toBe(BigInt(VALUE));
    expect(back!.tokenId).toBe(ETH);
    expect(back!.label).toBe(ours.label);
  });

  test('a different viewing key recovers nothing', () => {
    const ours = build();
    const stranger = crypto.generateEphemeralKeyPair();
    const split = splitNoteData(ours.noteData.data)!;
    expect(decryptBlindDepositBackup({
      ephemeralPubKey: split.ephemeralPubKey,
      encryptedPayload: split.encryptedPayload,
      viewingPrivateKey: stranger.privateKey,
      crypto: crypto as unknown as BackupCryptoLike,
    })).toBeNull();
  });

  test('the recovered fields rebuild the SAME commitment the deposit committed to', () => {
    const ours = build();
    const split = splitNoteData(ours.noteData.data)!;
    const back = decryptBlindDepositBackup({
      ephemeralPubKey: split.ephemeralPubKey, encryptedPayload: split.encryptedPayload,
      viewingPrivateKey: senderViewPriv, crypto: crypto as unknown as BackupCryptoLike,
    })!;
    // The recipient supplies their own address at claim time; with it, the
    // four recovered fields reproduce the on-chain commitment exactly.
    const nah = ncs.computeNoteAddressHash(RECIPIENT as never, back.noteSecret as never);
    const commitment = ncs.computeFullCommitment({ noteAddressHash: nah, tokenId: back.tokenId, value: back.value, label: back.label } as never);
    expect(String(commitment).toLowerCase()).toBe(ours.commitment);
  });

  test('with the WRONG address the commitment is wrong - the chain, not us, protects the money', () => {
    const ours = build();
    const nah = ncs.computeNoteAddressHash(OTHER as never, ours.noteSecret as never);
    const commitment = ncs.computeFullCommitment({ noteAddressHash: nah, tokenId: ETH, value: ours.noteData && VALUE, label: ours.label } as never);
    expect(String(commitment).toLowerCase()).not.toBe(ours.commitment);
  });
});

describe('what goes on chain looks like every other note', () => {
  test('the hint is 32 random bytes, never the catch-all zero, and differs per event', () => {
    const a = build();
    const b = build();
    expect(a.noteData.hint).toHaveLength(66);
    expect(a.noteData.hint).not.toBe(CATCH_ALL_TAG);
    expect(a.noteData.hint).not.toBe(b.noteData.hint);
    // Deterministic fill is honoured (so a failing case can be replayed).
    expect(build({ randomFill: fixedFill(0xab) }).noteData.hint).toBe(`0x${'ab'.repeat(32)}`);
  });

  test('data has the SDK layout: 32-byte ephemeral key || ciphertext, same as a real note', () => {
    const ours = build();
    const control = ncs.generateNoteData(
      { noteSecret: crypto.generateSecret(), value: VALUE as Hex, tokenId: ETH as Hex, label: ours.label } as never,
      senderViewPub,
    );
    // Same plaintext shape (RLP list of six items of the same widths, as the
    // SDK's v2 note) -> same ciphertext length -> same data length as a real
    // note. Must run against the PINNED SDK: a stale install once emitted the
    // 5-item v1 list and let a one-byte-short layout pass.
    expect(ours.noteData.data.length).toBe(control.data.length);
    const s = splitNoteData(ours.noteData.data)!;
    expect(s.ephemeralPubKey).toHaveLength(66);
    expect(joinNoteData(s.ephemeralPubKey, s.encryptedPayload)).toBe(ours.noteData.data);
  });

  test('the label is bound to OUR deposit secret, so the announced lineage is the proven one', () => {
    const depositSecret = crypto.generateSecret();
    const noteSecret = crypto.generateSecret();
    const ours = build({ depositSecret, noteSecret });
    const nah = ncs.computeNoteAddressHash(RECIPIENT as never, noteSecret as never);
    const pre = ncs.computePrecommitment(nah, ETH as never, ours.noteData && (VALUE as never));
    expect(String(ncs.computeLabel(pre, depositSecret as never)).toLowerCase()).toBe(ours.label);
    expect(ours.depositSecret).toBe(depositSecret.toLowerCase());
  });
});

describe('the codec is strict', () => {
  const ok = () => ({
    noteSecret: `0x${'11'.repeat(32)}` as Hex,
    value: VALUE as Hex,
    tokenId: ETH as Hex,
    label: `0x${'22'.repeat(32)}` as Hex,
  });

  test('round trip; value is passed through as given, exactly like serializeV1', () => {
    const back = decodeBackupPayload(encodeBackupPayload(ok()));
    expect(back).toEqual(ok());
    // Leading zero bytes are KEPT, not stripped: minimising would change the
    // RLP length relative to a real note built from the same amount string.
    const padded = decodeBackupPayload(encodeBackupPayload({ ...ok(), value: '0x0000b5e620f48000' as Hex }))!;
    expect(padded.value).toBe('0x0000b5e620f48000');
    expect(BigInt(padded.value)).toBe(BigInt(VALUE));
    // Odd-nibble input is accepted and made even, and case is normalised.
    expect(decodeBackupPayload(encodeBackupPayload({ ...ok(), value: '0xB5E620F48000' as Hex }))!.value).toBe('0xb5e620f48000');
  });

  test('anything that is not exactly our six-item list is null', () => {
    expect(decodeBackupPayload(new Uint8Array([]))).toBeNull();
    expect(decodeBackupPayload(new Uint8Array([0x01, 0x02, 0x03]))).toBeNull();
    // An SDK-shaped list (version 2, kind full) is byte-for-byte our layout
    // with a different version byte - and is not ours. Byte 0 is the RLP list
    // prefix, byte 1 the version, byte 2 the kind.
    expect(decodeBackupPayload(encodeBackupPayload(ok()).map((b, i) => (i === 1 ? 0x02 : b)))).toBeNull();
    // Our version with a kind we do not define is not ours either.
    expect(decodeBackupPayload(encodeBackupPayload(ok()).map((b, i) => (i === 2 ? 0x02 : b)))).toBeNull();
    // Wrong widths.
    expect(() => encodeBackupPayload({ ...ok(), noteSecret: '0x1234' as Hex })).toThrow(/32 bytes/);
    expect(() => encodeBackupPayload({ ...ok(), tokenId: `0x${'aa'.repeat(32)}` as Hex })).toThrow(/20 bytes/);
    expect(() => encodeBackupPayload({ ...ok(), value: 'nope' as Hex })).toThrow(/hex/);
  });

  test('the version byte is what the header says it is', () => {
    // One byte, so our RLP head is the same length as the SDK's version 1.
    expect(CLAIM_BACKUP_MAGIC).toBe('0x7e');
    expect(Number(CLAIM_BACKUP_MAGIC)).toBe(126);
    expect(Number(CLAIM_BACKUP_MAGIC)).not.toBe(1);
  });

  test('build refuses a zero value and malformed keys before touching crypto', () => {
    expect(() => build({ value: '0x0' })).toThrow(/positive/);
    expect(() => build({ senderViewingPubKey: '0x1234' })).toThrow(/32 bytes/);
    expect(() => build({ recipient: '0xabc' })).toThrow(/20 bytes/);
  });
});
