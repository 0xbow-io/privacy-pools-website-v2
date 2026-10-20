/**
 * Browser-safe note discovery (ported from the protocol SDK's
 * `sdk/src/note-discovery.mjs`). Trial-decrypts the per-output encrypted note
 * payloads carried by `NoteEvent { hint, data }` (paired with a `Transacted`
 * event's `output_commitments`) to recover the notes addressed to the scanning
 * user's secp256k1 viewing key.
 *
 * This is the OFF-CHAIN recipient channel (distinct from the in-circuit GVK
 * compliance encryption). Locally-created notes (your own deposits + change
 * outputs) are persisted directly by the session, so discovery is only needed
 * to find notes OTHERS sent you. It fails CLOSED on a structurally malformed
 * batch (a truncated/corrupt parallel array) so a bad batch can never silently
 * hide a note; a tag/AEAD mismatch on a well-formed slot is a legitimate
 * non-match and is skipped.
 */
import { ecdh, decrypt, decodeNotePayload, type NotePayload } from './note-crypto';
import {
  addressToU256,
  calculateNoteAddressHash,
  calculateNoteCommitment,
  poseidonHash2,
} from './crypto';
import { SNARK_SCALAR_FIELD } from './constants';
import type { StoredSuiNote } from './note-store';

/** Thrown when a discovery batch is structurally corrupt (fails CLOSED). */
export class MalformedDiscoveryBatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedDiscoveryBatch';
  }
}

/** One transaction's output set: commitments paired with per-output note blobs. */
export interface TransactEvent {
  txDigest: string;
  outputCommitments: bigint[];
  /** Per-output encrypted hint bytes (parallel to outputCommitments). */
  noteHints: Uint8Array[];
  /** Per-output encrypted note data bytes (parallel to outputCommitments). */
  noteData: Uint8Array[];
}

/** A known sender whose notes we want to find (targeted discovery). */
export interface Contact {
  name: string;
  /** Compressed secp256k1 viewing public key (0x-hex). */
  viewingPublicKey: string;
}

/** A note recovered by trial-decryption. */
export interface DiscoveredNote {
  commitment: bigint;
  noteSecret: bigint;
  value: bigint;
  tokenId: bigint;
  label: bigint;
  contact: Contact | null;
  txDigest: string;
  outputIndex: number;
}

/**
 * Targeted discovery: for each contact, compute the ECDH shared secret + the
 * expected tag (Poseidon(sharedSecret, 0)) and decrypt matching outputs.
 * Ported from `scanTargeted`.
 */
export async function scanTargeted(
  events: TransactEvent[],
  contacts: Contact[],
  viewingPrivKey: string,
): Promise<DiscoveredNote[]> {
  if (!Array.isArray(events)) throw new MalformedDiscoveryBatch('events must be an array');
  const discovered: DiscoveredNote[] = [];

  for (const contact of contacts) {
    const sharedSecret = ecdh(viewingPrivKey, contact.viewingPublicKey);
    const tag = await poseidonHash2(bytesToBigint(sharedSecret), 0n);

    for (let e = 0; e < events.length; e++) {
      const event = validateEvent(events[e], e);

      for (let i = 0; i < event.outputCommitments.length; i++) {
        const hint = validateOutputElement(event.noteHints[i], e, i, 'noteHints');
        const noteData = validateOutputElement(event.noteData[i], e, i, 'noteData');

        // Empty slot: a legitimate non-targeted (anonymous) output, not malformed.
        if (hint.length === 0 || noteData.length === 0) continue;

        const hintValue = hint.length >= 32 ? bytesToBigint(hint.slice(0, 32)) : 0n;
        if (hintValue !== tag) continue;

        let payload: NotePayload;
        try {
          payload = decodeNotePayload(decrypt(noteData, sharedSecret));
        } catch {
          continue; // tag collision / AEAD failure: not our note, skip
        }
        if (!isValidPayload(payload)) continue;
        discovered.push({
          commitment: event.outputCommitments[i],
          noteSecret: payload.noteSecret,
          value: payload.value,
          tokenId: payload.tokenId,
          label: payload.label,
          contact,
          txDigest: event.txDigest,
          outputIndex: i,
        });
      }
    }
  }
  return discovered;
}

/**
 * Catch-all discovery: brute-force trial-decrypt outputs whose hint carries an
 * ephemeral compressed pubkey (33 bytes). Ported from `scanCatchAll`.
 */
export async function scanCatchAll(
  events: TransactEvent[],
  viewingPrivKey: string,
): Promise<DiscoveredNote[]> {
  if (!Array.isArray(events)) throw new MalformedDiscoveryBatch('events must be an array');
  const discovered: DiscoveredNote[] = [];

  for (let e = 0; e < events.length; e++) {
    const event = validateEvent(events[e], e);

    for (let i = 0; i < event.outputCommitments.length; i++) {
      const hint = validateOutputElement(event.noteHints[i], e, i, 'noteHints');
      const noteData = validateOutputElement(event.noteData[i], e, i, 'noteData');

      if (hint.length === 0 || noteData.length === 0) continue;
      // The hint should carry a 33-byte compressed ephemeral pubkey; a shorter
      // (e.g. 32-byte targeted tag) hint is a legitimate non-catch-all output.
      if (hint.length < 33) continue;
      const ephemeralPubKey = '0x' + bytesToHex(hint.slice(0, 33));

      let payload: NotePayload;
      try {
        const sharedSecret = ecdh(viewingPrivKey, ephemeralPubKey);
        payload = decodeNotePayload(decrypt(noteData, sharedSecret));
      } catch {
        continue; // ECDH/AEAD failure: not our note, skip
      }
      if (!isValidPayload(payload)) continue;
      discovered.push({
        commitment: event.outputCommitments[i],
        noteSecret: payload.noteSecret,
        value: payload.value,
        tokenId: payload.tokenId,
        label: payload.label,
        contact: null,
        txDigest: event.txDigest,
        outputIndex: i,
      });
    }
  }
  return discovered;
}

// === Helpers (fail-CLOSED structural validation, F12/MED-1) ===

function validateEvent(event: TransactEvent | null | undefined, index: number): TransactEvent {
  if (event == null || typeof event !== 'object') {
    throw new MalformedDiscoveryBatch(`null or non-object event at index ${index}`);
  }
  const { outputCommitments, noteHints, noteData } = event;
  if (!Array.isArray(outputCommitments)) {
    throw new MalformedDiscoveryBatch(`event[${index}].outputCommitments is not an array`);
  }
  if (!Array.isArray(noteHints) || !Array.isArray(noteData)) {
    throw new MalformedDiscoveryBatch(`event[${index}] missing noteHints/noteData arrays`);
  }
  if (noteHints.length !== outputCommitments.length || noteData.length !== outputCommitments.length) {
    throw new MalformedDiscoveryBatch(
      `event[${index}] array length mismatch: commitments=${outputCommitments.length} ` +
        `hints=${noteHints.length} data=${noteData.length}`,
    );
  }
  return event;
}

function validateOutputElement(
  value: Uint8Array | number[] | null | undefined,
  eventIndex: number,
  outputIndex: number,
  field: string,
): Uint8Array {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new MalformedDiscoveryBatch(
    `event[${eventIndex}].${field}[${outputIndex}] is not bytes (got ${typeof value})`,
  );
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) result = (result << 8n) | BigInt(b);
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function isValidPayload(payload: NotePayload): boolean {
  return (
    payload.noteSecret < SNARK_SCALAR_FIELD &&
    payload.value < SNARK_SCALAR_FIELD &&
    payload.tokenId < SNARK_SCALAR_FIELD &&
    payload.label < SNARK_SCALAR_FIELD
  );
}

/**
 * Map a discovered note into the persisted shape for the scanning account's
 * note store. The note's owner FIELD is `addressToU256(recipient Sui address)`
 * — the exact value the sender bound into the commitment for notes addressed
 * to this account — NOT a placeholder: the spend path recomputes the
 * commitment from `ownerAddress` + `noteSecret` (see reconstruct.ts), so a
 * `'0'` owner made every discovered note unspendable (wrong leaf, no on-chain
 * timestamp/root match).
 */
export function discoveredToStoredNote(
  ownerSuiAddress: string,
  discovered: DiscoveredNote,
): StoredSuiNote {
  return {
    commitment: discovered.commitment.toString(),
    value: discovered.value.toString(),
    tokenId: discovered.tokenId.toString(),
    label: discovered.label.toString(),
    noteSecret: discovered.noteSecret.toString(),
    ownerAddress: addressToU256(ownerSuiAddress).toString(),
    coinType: '0x2::sui::SUI',
    status: 'active',
    txDigest: discovered.txDigest,
  };
}

/**
 * Verify a discovered (trial-decrypted) payload actually reconstructs the
 * event's output commitment for `ownerSuiAddress`. A sender can attach note
 * ciphertext that decrypts cleanly under the victim's viewing key but whose
 * fields do NOT hash to the on-chain commitment — persisting it would create
 * an unspendable "active" note that later breaks spend/proof reconstruction.
 * Callers must skip (and log) discovered notes that fail this check.
 */
export async function verifyDiscoveredCommitment(
  ownerSuiAddress: string,
  discovered: DiscoveredNote,
): Promise<boolean> {
  const ownerField = addressToU256(ownerSuiAddress);
  const noteAddressHash = await calculateNoteAddressHash(ownerField, discovered.noteSecret);
  const rebuilt = await calculateNoteCommitment(
    noteAddressHash,
    discovered.tokenId,
    discovered.value,
    0n,
    discovered.label,
  );
  return rebuilt === discovered.commitment;
}
