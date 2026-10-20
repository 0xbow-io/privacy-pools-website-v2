/**
 * The sender's own on-chain backup of a blind deposit's claim material.
 *
 * WHAT PROBLEM. A deposit for someone who never registered a viewing key
 * ("blind cold-start", prepareDepositFor path A) announces nothing usable on
 * chain: the SDK publishes EMPTY_NOTE_DATA and the only route to the money is a
 * one-time claim link the sender holds locally. Lose the browser, lose the link,
 * lose the recipient's money. Pat asked whether a registered sender could
 * regenerate the link from a new browser (2026-09-16). With random secrets held
 * only in localStorage, no.
 *
 * WHAT THIS DOES. It rides the same path-A escape hatch that
 * services/payment-request-deposit.ts already uses in production: the caller
 * may supply `noteData: {hint, data}` and a `depositSecret`, and the deposit's
 * proof context is bound to that noteData. We build noteData that encrypts the
 * four fields a claim needs - noteSecret, value, tokenId, label - to the
 * SENDER'S OWN viewing key. Any browser the sender signs into can then trial-
 * decrypt Note events with that key and rebuild the link.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: the recipient's address. Verified
 * against the vendored SDK (seven-agent review, 2026-09-16): the owner address
 * is structurally the CLAIMANT's input - `scanCatchAll(events, viewPriv,
 * ownerAddress)`, `computeNoteCommitment(ownerAddress, payload)` - never the
 * payload's. The SDK's own NotePayload is exactly these four fields and its
 * codec hard-rejects a fifth. So this record discloses precisely what an
 * ordinary transfer already publishes about its sender (their change-note
 * announcement, built unconditionally) and nothing about who was paid. The
 * chain enforces correctness for free: only the true recipient's address
 * reproduces the committed Poseidon(recipient, noteSecret), so a leaked link
 * names nobody and pays nobody else.
 *
 * WHY THE SENDER'S OWN DISCOVERY MUST SKIP THIS. The shipped `scanCatchAll`
 * does not filter on hint at all (its doc comment said it did; the code trial-
 * decrypts every event), and `tryDecryptEvent` returns a CANDIDATE for anything
 * that decodes as a full note, with a commitment computed from the SCANNER's
 * address - for a recipient's note that commitment is wrong. Discovery does not
 * store such a candidate (it resolves the commitment's on-chain timestamp first
 * and skips one that never resolves), but the cost is real: repeated unresolved
 * scans and a held discovery cursor, on every sync, forever (codex, 2026-09-16).
 * Isolation therefore cannot come from the hint. It comes from the payload:
 * `decodeNotePayload` does `fromRlp` -> requires a non-empty list -> reads the
 * version from `items[0]` -> accepts only versions the codec defines (1, the
 * legacy 5-item list, and 2, the current `[0x02, kind, ...4 fields]`; both in
 * the ab0d93bc build ppv2 vendors) and throws `unsupported NotePayload
 * version N` on anything else; `decryptNotePayload` rethrows and the scan
 * skips the event silently. The blind-kind decoder the payment-request scan
 * uses (`decodePaymentRequestNotePayload`) rejects at the version too. Our
 * first RLP item is the single byte 0x7e (126), a version the SDK does not
 * define. Deterministic rejection today, and it stays rejected until the SDK
 * defines version 126, which is far from the 3, 4, 5 it would add next. That
 * guarantees exactly one thing - these decoders skip it - and nothing broader.
 * services/__tests__/blind-deposit-backup.test.ts pins this against the SDK's
 * real NoteDiscoveryService, with a real SDK note as the control.
 *
 * WHY ONE BYTE AND NOT A SELF-DESCRIBING MAGIC, AND WHY SIX ITEMS. A first
 * draft used the 9-byte string "ppv2claim". RLP encodes that as 10 bytes where
 * the SDK's version is a single byte, so every backup's `data` was a fixed 9
 * bytes longer than a real note's - a small, constant, public fingerprint
 * reading "this deposit carries a sender backup", i.e. "this was a blind
 * deposit to someone unregistered", which is the very tell this file exists
 * to remove. A second draft matched the LEGACY 5-item v1 list and came out one
 * byte SHORT of the v2 notes the vendored SDK actually emits (caught when the
 * tests first ran against the pinned build rather than a stale install). So
 * the list mirrors v2 exactly: a one-byte version, a one-byte kind, then the
 * four fields encoded as the SDK encodes them (passed through as given, no
 * re-canonicalisation), so for the same inputs our plaintext, our ciphertext
 * and our on-chain `data` are byte-for-byte the same LENGTH as a real note's.
 * The test pins that too.
 *
 * WHY THE HINT IS RANDOM, NOT A CONSTANT. The observer-view pass found that a
 * blind deposit already emits a Note log whose hint is the ONLY constant-zero
 * value in a topic space of otherwise-random 32-byte hints, with a zero-length
 * body - 2 of 118 sampled deposits on the staging pool, i.e. an anonymity set of
 * two, correlated exactly to the deposit. A real announcement removes that tell.
 * A fixed hint of our own would have recreated it. So the hint is 32 random
 * bytes per event, exactly like the SDK's own default, and our scanner does what
 * scanCatchAll does: trial-decrypt everything.
 *
 * PURE module: no React, no SDK import, no network. Services are injected, the
 * same shape as services/payment-request-deposit.ts, so this runs under bun.
 */
import { bytesToHex, fromRlp, hexToBytes, toRlp } from 'viem';

export type HexString = `0x${string}`;

/**
 * RLP list head: a one-byte version the SDK does not define. `Number(this)` is
 * 126, so the SDK's version switch (which accepts 1 and 2) rejects it, and the
 * single byte keeps our plaintext the same length as an SDK note's.
 */
export const CLAIM_BACKUP_MAGIC = '0x7e' as HexString;

/**
 * Second list item, mirroring the SDK's v2 `kind` byte so the list has the
 * SAME item count and widths as a v2 full note (`RLP([0x02, 0x01, ...4])`).
 * One kind exists: a recipient-claim backup. The SDK never reads it - it has
 * already rejected the version - it is here for the length identity only.
 */
export const CLAIM_BACKUP_KIND = '0x01' as HexString;

/** Exactly the SDK's NotePayload fields. Nothing more, by design (see header). */
export type BackupPayload = {
  noteSecret: HexString;
  value: HexString;
  tokenId: HexString;
  label: HexString;
};

/** The slice of the SDK's note-computation service this module needs. */
export interface BackupNoteComputationLike {
  computeNoteAddressHash(ownerAddress: string, noteSecret: string): string;
  computePrecommitment(noteAddressHash: string, tokenId: string, value: string): string;
  computeLabel(precommitment: string, depositSecret: string): string;
  computeFullCommitment(params: { noteAddressHash: string; tokenId: string; value: string; label: string }): string;
}

/** The slice of the SDK's crypto service this module needs. */
export interface BackupCryptoLike {
  generateEphemeralKeyPair(): { privateKey: string; publicKey: string };
  ecdh(privateKey: string, publicKey: string): string;
  encrypt(data: Uint8Array, secret: string): string;
  decrypt(ciphertext: string, secret: string): Uint8Array;
}

export type BlindDepositBackupResult = {
  noteAddressHash: HexString;
  precommitment: HexString;
  label: HexString;
  commitment: HexString;
  /** Pass straight through as prepareDepositFor path-A `noteData`. */
  noteData: { hint: HexString; data: HexString };
  /** Pass straight through as prepareDepositFor path-A `depositSecret`. */
  depositSecret: HexString;
  noteSecret: HexString;
};

export class BlindDepositBackupError extends Error {}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

/** Lowercase, even-length. RLP round-trips bytes, so odd nibbles must not exist. */
function canonHex(value: string, name: string): HexString {
  // `0x` plus at least one nibble: "0x0" is a legitimate zero.
  if (typeof value !== 'string' || !HEX_RE.test(value) || value.length < 3) {
    throw new BlindDepositBackupError(`${name} is not a hex string`);
  }
  const body = value.slice(2).toLowerCase();
  return (`0x${body.length % 2 === 1 ? `0${body}` : body}`) as HexString;
}

/**
 * A quantity, encoded EXACTLY as the SDK's `serializeV1` would encode the same
 * input: passed through as given (lowercased, even-length), never minimised.
 * Re-canonicalising would change the RLP length relative to a real note built
 * from the same amount string, and length is the one thing an observer can
 * measure. Callers compare values with BigInt, never by string.
 */
function canonValue(value: string): HexString {
  const h = canonHex(value, 'value');
  if (BigInt(h) < 0n) throw new BlindDepositBackupError('value is negative');
  return h;
}

function expectBytes(value: string, bytes: number, name: string): HexString {
  const h = canonHex(value, name);
  if (h.length !== 2 + bytes * 2) {
    throw new BlindDepositBackupError(`${name} must be ${bytes} bytes`);
  }
  return h;
}

/**
 * Plaintext for the announcement:
 * RLP([MAGIC, KIND, noteSecret, value, tokenId, label]).
 *
 * Same list shape as the SDK's own v2 `RLP([0x02, kind, ...4 fields])`, so it
 * fails the SDK decoder at exactly one place - the version switch - and
 * nowhere ambiguous before it, and encodes to exactly a v2 note's length.
 */
export function encodeBackupPayload(payload: BackupPayload): Uint8Array {
  const items: HexString[] = [
    CLAIM_BACKUP_MAGIC,
    CLAIM_BACKUP_KIND,
    expectBytes(payload.noteSecret, 32, 'noteSecret'),
    canonValue(payload.value),
    expectBytes(payload.tokenId, 20, 'tokenId'),
    expectBytes(payload.label, 32, 'label'),
  ];
  return hexToBytes(toRlp(items));
}

/**
 * Parse a decrypted plaintext. Returns null for ANYTHING that is not exactly
 * our shape - the SDK's own notes included - which is what makes trial-
 * decryption over every event safe: "not ours" is a value, not an exception.
 */
export function decodeBackupPayload(bytes: Uint8Array): BackupPayload | null {
  let decoded: unknown;
  try {
    decoded = fromRlp(bytesToHex(bytes), 'hex');
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== 6) return null;
  const [magic, kind, noteSecret, value, tokenId, label] = decoded as unknown[];
  if (typeof magic !== 'string' || magic.toLowerCase() !== CLAIM_BACKUP_MAGIC) return null;
  if (typeof kind !== 'string' || kind.toLowerCase() !== CLAIM_BACKUP_KIND) return null;
  try {
    return {
      noteSecret: expectBytes(String(noteSecret), 32, 'noteSecret'),
      value: canonValue(String(value)),
      tokenId: expectBytes(String(tokenId), 20, 'tokenId'),
      label: expectBytes(String(label), 32, 'label'),
    };
  } catch {
    return null;
  }
}

/**
 * The Note event `data` layout the SDK emits and the indexer splits:
 * `ephemeralPubKey (32 bytes) || ciphertext`. Kept here so the emit side and
 * the tests speak one truth about the layout.
 */
export function joinNoteData(ephemeralPubKey: string, ciphertext: string): HexString {
  const pub = expectBytes(ephemeralPubKey, 32, 'ephemeralPubKey');
  const ct = canonHex(ciphertext, 'ciphertext');
  return (`0x${pub.slice(2)}${ct.slice(2)}`) as HexString;
}

export function splitNoteData(data: string): { ephemeralPubKey: HexString; encryptedPayload: HexString } | null {
  if (typeof data !== 'string' || !HEX_RE.test(data) || data.length <= 2 + 64) return null;
  return {
    ephemeralPubKey: (`0x${data.slice(2, 66)}`) as HexString,
    encryptedPayload: (`0x${data.slice(66)}`) as HexString,
  };
}

/** 32 random bytes as hex, from an injected byte source (testable). */
export function randomHint32(fill: (out: Uint8Array) => void): HexString {
  const out = new Uint8Array(32);
  fill(out);
  return bytesToHex(out) as HexString;
}

/** The browser/RN source for `randomHint32`. Throws rather than degrade. */
export function webRandomFill(out: Uint8Array): void {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new BlindDepositBackupError('No secure randomness available on this device.');
  c.getRandomValues(out);
}

/**
 * Build the path-A arguments for a blind deposit that the SENDER can recover.
 *
 * `depositSecret` and `noteSecret` are injected rather than generated here so
 * the caller owns randomness (and so this is deterministic under test) - the
 * same reason services/payment-request-deposit.ts injects its secret. The
 * label needs the deposit secret fixed BEFORE the payload is built, because
 * the payload names the lineage; letting the SDK generate the secret later
 * would commit the proof to a label the announcement did not carry.
 */
export function buildBlindDepositBackup(input: {
  recipient: string;
  tokenId: string;
  value: string;
  noteSecret: string;
  depositSecret: string;
  senderViewingPubKey: string;
  noteComputation: BackupNoteComputationLike;
  crypto: BackupCryptoLike;
  randomFill: (out: Uint8Array) => void;
}): BlindDepositBackupResult {
  const recipient = expectBytes(input.recipient, 20, 'recipient');
  const tokenId = expectBytes(input.tokenId, 20, 'tokenId');
  const value = canonValue(input.value);
  const noteSecret = expectBytes(input.noteSecret, 32, 'noteSecret');
  const depositSecret = expectBytes(input.depositSecret, 32, 'depositSecret');
  const senderViewingPubKey = expectBytes(input.senderViewingPubKey, 32, 'senderViewingPubKey');
  if (BigInt(value) === 0n) throw new BlindDepositBackupError('value must be positive');

  const { noteComputation, crypto } = input;
  const noteAddressHash = canonHex(noteComputation.computeNoteAddressHash(recipient, noteSecret), 'noteAddressHash');
  const precommitment = canonHex(noteComputation.computePrecommitment(noteAddressHash, tokenId, value), 'precommitment');
  const label = expectBytes(noteComputation.computeLabel(precommitment, depositSecret), 32, 'label');
  const commitment = canonHex(
    noteComputation.computeFullCommitment({ noteAddressHash, tokenId, value, label }),
    'commitment',
  );

  const plaintext = encodeBackupPayload({ noteSecret, value, tokenId, label });
  const ephemeral = crypto.generateEphemeralKeyPair();
  const shared = crypto.ecdh(ephemeral.privateKey, senderViewingPubKey);
  const ciphertext = crypto.encrypt(plaintext, shared);

  return {
    noteAddressHash,
    precommitment,
    label,
    commitment,
    noteData: {
      hint: randomHint32(input.randomFill),
      data: joinNoteData(ephemeral.publicKey, ciphertext),
    },
    depositSecret,
    noteSecret,
  };
}

/**
 * Try to read one Note event as our backup. Null means "not ours" - a wrong
 * key, an SDK note, garbage - and is the normal result for almost every event.
 */
export function decryptBlindDepositBackup(input: {
  ephemeralPubKey: string;
  encryptedPayload: string;
  viewingPrivateKey: string;
  crypto: BackupCryptoLike;
}): BackupPayload | null {
  try {
    const shared = input.crypto.ecdh(input.viewingPrivateKey, input.ephemeralPubKey);
    const bytes = input.crypto.decrypt(input.encryptedPayload, shared);
    return decodeBackupPayload(bytes);
  } catch {
    return null;
  }
}
