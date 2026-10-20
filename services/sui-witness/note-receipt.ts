/**
 * Sui one-time note receipts (`kind: "ppv2-sui-note"`).
 *
 * A Sui private transfer to an unregistered recipient hands the sender a
 * receipt carrying the recipient's full spendable note (value, lineage label,
 * noteSecret, owner field element). The recipient imports it via Actions →
 * Payments → Import Note. This module is the parse/verify half of that flow,
 * kept out of the modal so it is unit-testable:
 *
 *   parseSuiNoteReceipt  — raw JSON or base64(-url) JSON -> the note fields
 *                          (null when the payload isn't a Sui receipt at all,
 *                          throws when it is one but malformed)
 *   verifySuiNoteReceipt — the receipt is addressed to the connected Sui
 *                          account AND its commitment reconstructs from the
 *                          note fields (Poseidon), so a tampered/corrupted
 *                          receipt is refused before it ever hits the store
 *   suiReceiptToStoredNote — the StoredSuiNote to upsert on success
 */
import { addressToU256, calculateNoteAddressHash, calculateNoteCommitment } from './crypto';
import type { StoredSuiNote } from './note-store';

export interface SuiNoteReceiptNote {
  /** All numeric fields are decimal bigint strings. */
  commitment: string;
  value: string;
  tokenId: string;
  label: string;
  noteSecret: string;
  ownerAddress: string;
  coinType?: string;
  txDigest?: string;
}

const REQUIRED_FIELDS = [
  'commitment',
  'value',
  'tokenId',
  'label',
  'noteSecret',
  'ownerAddress',
] as const;

function tryJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Parse a pasted payload as a Sui note receipt. Accepts the raw JSON or a
 * base64/base64url encoding of it. Returns null when the payload is not a Sui
 * receipt (so callers can fall through to other formats); throws when it IS
 * one (`kind: "ppv2-sui-note"`) but the note fields are missing/invalid.
 */
export function parseSuiNoteReceipt(raw: string): SuiNoteReceiptNote | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  if (trimmed.startsWith('{')) {
    parsed = tryJsonParse(trimmed);
  } else if (typeof atob === 'function' && /^[A-Za-z0-9+/\-_=]+$/.test(trimmed)) {
    try {
      const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
      parsed = tryJsonParse(atob(b64));
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as { kind?: unknown; note?: unknown };
  if (obj.kind !== 'ppv2-sui-note') return null;

  const note = (obj.note ?? null) as Record<string, unknown> | null;
  if (!note || typeof note !== 'object') {
    throw new Error('Malformed Sui note receipt: missing note fields.');
  }
  for (const key of REQUIRED_FIELDS) {
    const value = note[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Malformed Sui note receipt: missing ${key}.`);
    }
    try {
      BigInt(value);
    } catch {
      throw new Error(`Malformed Sui note receipt: ${key} is not a number.`);
    }
  }
  return {
    commitment: note.commitment as string,
    value: note.value as string,
    tokenId: note.tokenId as string,
    label: note.label as string,
    noteSecret: note.noteSecret as string,
    ownerAddress: note.ownerAddress as string,
    coinType: typeof note.coinType === 'string' ? note.coinType : undefined,
    txDigest: typeof note.txDigest === 'string' ? note.txDigest : undefined,
  };
}

/**
 * Verify the receipt belongs to `suiAddress` and is internally consistent:
 * the commitment must reconstruct from (ownerAddress, noteSecret, tokenId,
 * value, label). Throws a user-facing message on failure.
 */
export async function verifySuiNoteReceipt(
  note: SuiNoteReceiptNote,
  suiAddress: string,
): Promise<void> {
  if (BigInt(note.ownerAddress) !== addressToU256(suiAddress)) {
    throw new Error('This receipt is addressed to a different Sui account.');
  }
  const noteAddressHash = await calculateNoteAddressHash(
    BigInt(note.ownerAddress),
    BigInt(note.noteSecret),
  );
  const rebuilt = await calculateNoteCommitment(
    noteAddressHash,
    BigInt(note.tokenId),
    BigInt(note.value),
    0n,
    BigInt(note.label),
  );
  if (rebuilt !== BigInt(note.commitment)) {
    throw new Error('Receipt commitment does not reconstruct. Refusing to import.');
  }
}

/** The subset of SuiChainReader the on-chain existence check needs. */
export interface CommitmentReader {
  getCommitmentTimestamp(commitment: bigint): Promise<bigint>;
}

/**
 * Verify the receipt's commitment actually EXISTS in the on-chain pool before
 * persisting it as spendable. A receipt can be perfectly self-consistent
 * (owner matches, commitment reconstructs) without any pool transaction ever
 * having inserted it — importing such a forgery inflates the local active
 * balance and poisons later note selection/proof building.
 *
 * Distinguishes the two failure modes:
 *  - commitment has no on-chain record -> refuse the import outright;
 *  - transient RPC failure -> surface a retryable error; the caller must NOT
 *    store the note either way.
 */
export async function verifySuiNoteOnChain(
  reader: CommitmentReader,
  note: Pick<SuiNoteReceiptNote, 'commitment'>,
): Promise<void> {
  try {
    // Throws "commitment ... not found on-chain (no timestamp)" when the
    // pool has no CommitmentKey dynamic field for this hash.
    await reader.getCommitmentTimestamp(BigInt(note.commitment));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found on-chain/i.test(message)) {
      throw new Error('This note does not exist on-chain. Refusing to import.');
    }
    throw new Error(`Could not verify the note on-chain. Check your connection and try again. (${message})`);
  }
}

/** The StoredSuiNote shape to persist (upsertSuiNote) after verification. */
export function suiReceiptToStoredNote(note: SuiNoteReceiptNote): StoredSuiNote {
  return {
    commitment: note.commitment,
    value: note.value,
    tokenId: note.tokenId,
    label: note.label,
    noteSecret: note.noteSecret,
    ownerAddress: note.ownerAddress,
    coinType: note.coinType ?? '0x2::sui::SUI',
    status: 'active',
    txDigest: note.txDigest,
  };
}
