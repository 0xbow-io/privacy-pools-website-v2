/**
 * The SHAPE rules for a claim link's notes, with no imports at all.
 *
 * services/note-receipt.ts owns the encoding and the URL, but it transitively
 * pulls in React Native (config/env for PAY_URL_BASE, the SDK types), so it
 * only loads under bun behind a react-native stub, and its rules could not be
 * unit-tested in isolation. Same
 * split as services/note-receipt-preview.ts, for the same reason. Everything
 * here is a pure function of its arguments.
 *
 * Two note shapes may appear in a link:
 *
 * FULL - built at send time; names its owner and carries its commitment.
 *
 * RECOVERED - rebuilt from the sender's on-chain backup
 * (services/blind-deposit-backup.ts), which deliberately carries only the four
 * fields the SDK itself announces: noteSecret, value, tokenId, label. It names
 * NO recipient and has NO commitment. The import path fills the owner in from
 * the signed-in session and recomputes the commitment; the chain enforces that
 * only the true recipient's address reproduces the committed noteAddressHash,
 * so a wrong claimant gets a note that is not in the tree and cannot be spent.
 *
 * A link is attacker-controllable input (anyone can craft one), so both shapes
 * must be fully hex-typed before the import and render paths dereference them
 * (`BigInt(note.value)`, `.toLowerCase()`, `.slice`).
 */

const HEX_RE = /^0x[0-9a-fA-F]*$/;

/**
 * The BN254 scalar field the note hash lives in. Poseidon reduces every input
 * modulo this, so a value of `v + r` hashes to the SAME commitment as `v`: a
 * link could carry a genuine claim with its amount inflated by r, pass a
 * commitment-presence check, and import a note whose displayed and stored
 * amount is wrong (codex third pass, 2026-09-16). An amount must be a
 * canonical field element: strictly below r, and positive.
 */
const BN254_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export type ImportableNoteShape = 'full' | 'recovered';

// Exact widths as the SDK emits them (padded hex): 32-byte hashes and secrets,
// 20-byte addresses. `value` is the one variable-width field; it is bounded
// by range instead.
const FIELD_WIDTH: Readonly<Record<string, number>> = {
  commitment: 66,
  noteSecret: 66,
  label: 66,
  tokenId: 42,
  ownerAddress: 42,
};

const FULL_FIELDS = ['commitment', 'value', 'tokenId', 'ownerAddress'] as const;
const RECOVERED_FIELDS = ['noteSecret', 'label', 'value', 'tokenId'] as const;

/** A note that names no owner and carries no commitment, but does carry a secret and label. */
export function isRecoveredClaimNote(n: Record<string, unknown>): boolean {
  return n.ownerAddress === undefined && n.commitment === undefined
    && typeof n.noteSecret === 'string' && typeof n.label === 'string';
}

function allHex(n: Record<string, unknown>, fields: readonly string[]): boolean {
  for (const field of fields) {
    const v = n[field];
    if (typeof v !== 'string' || !HEX_RE.test(v)) return false;
    const width = FIELD_WIDTH[field];
    if (width !== undefined && v.length !== width) return false;
  }
  return true;
}

/** A positive canonical field element: `BigInt(note.value)` is what render and hashing consume. */
function valueOk(value: unknown): boolean {
  try {
    const v = BigInt(value as string);
    return v > 0n && v < BN254_SCALAR_FIELD;
  } catch {
    return false;
  }
}

/**
 * Which shape this note is, or null if it is neither - in which case the
 * whole link is refused and the UI shows "invalid receipt" rather than
 * throwing during render.
 */
export function importableNoteShape(note: unknown): ImportableNoteShape | null {
  if (!note || typeof note !== 'object') return null;
  const n = note as Record<string, unknown>;
  if (isRecoveredClaimNote(n)) {
    return allHex(n, RECOVERED_FIELDS) && valueOk(n.value) ? 'recovered' : null;
  }
  return allHex(n, FULL_FIELDS) && valueOk(n.value) ? 'full' : null;
}

export type RecoveredClaimInput = {
  chainId: number;
  txHash: string;
  noteSecret: string;
  value: string;
  tokenId: string;
  label: string;
};

/**
 * The receipt payload for recovered claims. `activeStatus` is the SDK's
 * NoteStatus.ACTIVE value, passed in so this module imports nothing.
 * `createdAtBlock` is the `0x0` stub: the import path heals it from the
 * snapshot AFTER the commitment exists (deposits are indexed there too, see
 * services/note-timestamp-heal.ts). Note what is absent: ownerAddress and
 * commitment, by design.
 */
export function recoveredClaimReceiptPayload(
  claims: readonly RecoveredClaimInput[],
  activeStatus: string,
): {
  notes: Record<string, unknown>[];
  syncCursor: string;
  chainId: number;
} | null {
  if (claims.length === 0) return null;
  return {
    notes: claims.map((c) => ({
      value: c.value,
      tokenId: c.tokenId,
      label: c.label,
      status: activeStatus,
      noteSecret: c.noteSecret,
      isOwned: true,
      createdAtBlock: '0x0',
      spentAtBlock: null,
      txHash: c.txHash,
    })),
    syncCursor: '0x0',
    chainId: claims[0].chainId,
  };
}

/** A link note as the import paths see it once the healer has run. */
export type LinkNoteAnchor = {
  commitment?: unknown;
  createdAtBlock?: unknown;
  /** Rebuilt from the sender's on-chain backup rather than named by the link. */
  recovered?: boolean;
};

function isStubBlock(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return true;
  try {
    return BigInt(raw) === 0n;
  } catch {
    return true;
  }
}

/**
 * Link notes the chain has not shown us.
 *
 * A link is attacker-controllable: anyone can encode a note that names the
 * victim's address, an invented amount and a status of ACTIVE. What they
 * cannot do is put its commitment on chain, so the healer's lookup is the
 * evidence, and a note whose `createdAtBlock` is still a stub after it did not
 * happen. Import must refuse those BEFORE writing anything: a note merged and
 * then rejected is still on the device, reading as balance (audit F-01, and
 * the anchor path did exactly that until 2026-09-18).
 */
export function unanchoredLinkNotes<T extends LinkNoteAnchor>(notes: readonly T[]): T[] {
  return notes.filter((note) => isStubBlock(note.createdAtBlock));
}

/**
 * Why the import stopped, or null when every note is anchored. `verifiedAbsent`
 * separates "the chain says no" from "we could not finish asking", because only
 * the first is the user's problem to act on.
 */
export function linkImportRefusal(
  unanchored: readonly LinkNoteAnchor[],
  verifiedAbsent: boolean,
): string | null {
  if (unanchored.length === 0) return null;
  if (!verifiedAbsent) return 'Could not verify this claim on-chain yet. Nothing was imported. Retry in a moment.';
  if (unanchored.some((note) => note.recovered === true)) {
    return 'This claim does not match the signed-in account, or its deposit is not on-chain yet. Sign in as the recipient it was sent to and retry. Nothing was imported.';
  }
  return 'This claim is not on-chain, so there is nothing to import. Nothing was imported.';
}
