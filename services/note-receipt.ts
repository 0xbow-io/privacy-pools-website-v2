// One-time receipt for transfers to recipients who never registered
// a viewing key on the Keystore. The SDK's discoverable path falls
// through to out-of-band semantics (no on-chain Note event), and the
// recipient has no way to claim the funds without the noteSecret.
//
// Encode a single-note AccountExport as a base64url URL fragment so
// the sender can share a link instead of asking the recipient to
// paste JSON. The recipient opens the URL on the privacy-pools site,
// the /import-note route decodes it, and we merge the note into
// their NoteManager via SDK importAccount.

import { NoteStatus, type AccountExport, type Note } from '@/services/sdk-types';
import { importableNoteShape, isRecoveredClaimNote, recoveredClaimReceiptPayload } from '@/services/note-receipt-shape';
import type { SentNoteDisclosure } from '@/services/audit-receipt';
import { PAY_URL_BASE } from '@/config/env';

export type NoteReceipt = AccountExport;

function toBase64Url(value: string): string {
  if (typeof btoa === 'function') {
    return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  if (typeof Buffer !== 'undefined') {
    // The RN/web `buffer` polyfill doesn't support 'base64url' — use
    // 'base64' and url-safe it manually.
    return Buffer.from(value, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  throw new Error('Base64 encoding is unavailable in this environment.');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  if (typeof atob === 'function') {
    return atob(padded);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8');
  }
  throw new Error('Base64 decoding is unavailable in this environment.');
}

export function encodeNoteReceiptForUrl(receipt: NoteReceipt): string {
  return toBase64Url(JSON.stringify(receipt));
}

/**
 * Pull the encoded receipt payload out of whatever the user pasted —
 * a full share URL (`https://…/import-note#<encoded>`, older links
 * `https://…/import-note/<encoded>?x=y`), a bare
 * `/import-note/<encoded>` path, or just the `<encoded>` fragment on
 * its own. Returns null for empty input. The result still has to pass
 * `decodeNoteReceiptFromUrl` to be considered valid.
 */
export function extractNoteReceiptEncoded(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const route = /\/import-note[/#]/.exec(trimmed);
  const tail = route ? trimmed.slice(route.index + route[0].length) : trimmed;
  // A pasted URL may carry a trailing query, hash, slash, or whitespace;
  // the base64url payload itself contains none of those characters.
  const candidate = tail.split(/[?#/\s]/)[0];
  return candidate || null;
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

// The receipt is attacker-controllable input (anyone can craft a link).
// `decodeNoteReceiptFromUrl` only proves the JSON parsed; this checks the
// fields the import + render paths dereference (`BigInt(note.value)`,
// `note.commitment.slice`, `note.ownerAddress.toLowerCase`, `tokenId`) so
// malformed-but-valid JSON falls into the handled "invalid receipt" UI
// instead of throwing during render.
// Two shapes are importable - FULL (send-time receipt: owner + commitment) and
// RECOVERED (rebuilt from the sender's on-chain backup: the SDK's four fields,
// no owner, no commitment; the import path fills the owner in from the
// signed-in session and recomputes the commitment). The rules live in
// services/note-receipt-shape.ts, import-free so they can be tested; this
// module cannot load under bun (it pulls React Native through config/env).
function isImportableNote(note: unknown): note is Note {
  return importableNoteShape(note) !== null;
}

export { isRecoveredClaimNote };

export function decodeNoteReceiptFromUrl(encoded: string): NoteReceipt | null {
  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as { notes?: Note[]; syncCursor?: string; owner?: string; chainId?: number };
    if (!Array.isArray(candidate.notes) || candidate.notes.length === 0) return null;
    if (!candidate.notes.every(isImportableNote)) return null;
    // Preserve the envelope: chainId names the chain the notes live on (the
    // native-token sentinel is ambiguous across chains — a Citrea cBTC receipt
    // must not display as ETH), owner names the intended recipient. Both are
    // attacker-controllable, so type-check before trusting; legacy receipts
    // carry neither and fall back to the caller's default.
    const chainId = typeof candidate.chainId === 'number' && Number.isInteger(candidate.chainId) && candidate.chainId > 0
      ? candidate.chainId
      : undefined;
    const owner = typeof candidate.owner === 'string' && HEX_RE.test(candidate.owner)
      ? (candidate.owner as NoteReceipt['owner'])
      : undefined;
    return {
      notes: candidate.notes,
      syncCursor: (candidate.syncCursor ?? '0x0') as AccountExport['syncCursor'],
      ...(chainId !== undefined ? { chainId } : {}),
      ...(owner !== undefined ? { owner } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Rebuild the one-time receipt link for a transfer the user already sent,
 * from the send-time recipient disclosures the audit store keeps (same
 * preimage the success screen encoded). Works even after the recipient
 * claimed: importing is idempotent (merge dedupes by commitment) and the
 * import path's full-range reconcile re-derives the real note status, so
 * the ACTIVE stub here is fine. noteAddressHash is intentionally absent —
 * the import path backfills it from (ownerAddress, noteSecret).
 *
 * `createdAtBlock` should be the tx's BLOCK TIMESTAMP when the caller can
 * resolve it: the transact witness's state leaf is Poseidon(commitment,
 * createdAtBlock), so a '0x0' stub makes the on-chain anchor fail with
 * "Leaf … not found in tree". The import path heals stubs from the txHash
 * (use-note-import resolveCreatedAtBlocks), so a stub is recoverable — but
 * a stamped receipt spares the recipient the extra RPC round trip.
 */
export function buildSentReceiptUrl(
  disclosures: readonly SentNoteDisclosure[],
  opts?: { createdAtBlock?: `0x${string}` },
): string | null {
  if (disclosures.length === 0) return null;
  const payload = {
    notes: disclosures.map((d) => ({
      commitment: d.commitment,
      value: d.value,
      tokenId: d.tokenId,
      label: d.label,
      status: NoteStatus.ACTIVE,
      ownerAddress: d.ownerAddress,
      noteSecret: d.noteSecret,
      isOwned: true,
      createdAtBlock: opts?.createdAtBlock ?? '0x0',
      spentAtBlock: null,
      txHash: d.txHash,
    })),
    syncCursor: '0x0',
    owner: disclosures[0].ownerAddress,
    chainId: disclosures[0].chainId,
  };
  return buildNoteReceiptUrl(encodeNoteReceiptForUrl(payload as unknown as NoteReceipt));
}

/**
 * Build the absolute URL the sender should share. Falls back to the
 * relative path on native (no `window.location`); the consumer can
 * prefix it with their own deep-link scheme if needed.
 */
/**
 * A claim link rebuilt from the sender's ON-CHAIN backup, on any browser.
 *
 * Unlike `buildSentReceiptUrl`, the notes here name NO owner and carry NO
 * commitment: the backup deliberately holds only the four fields the SDK
 * itself announces (services/blind-deposit-backup.ts), so the sender's
 * decryptable record discloses nothing about who was paid. The import path
 * supplies the owner from the signed-in session and recomputes the commitment
 * (hooks/use-note-import.ts); `isImportableNote` accepts the shape via
 * `isRecoveredClaimNote`. Correctness is the chain's: a wrong claimant's
 * address reproduces a wrong noteAddressHash, hence a wrong commitment, hence
 * a note that is not in the tree and cannot be spent. Nobody else's money
 * moves; the link simply does nothing for them.
 *
 * `createdAtBlock` is the `0x0` stub; the import path heals it from the
 * snapshot AFTER the commitment exists (deposits are indexed there too since
 * services/note-timestamp-heal.ts).
 */
export function buildRecoveredClaimUrl(
  claims: readonly {
    chainId: number;
    txHash: string;
    noteSecret: string;
    value: string;
    tokenId: string;
    label: string;
  }[],
): string | null {
  const payload = recoveredClaimReceiptPayload(claims, NoteStatus.ACTIVE);
  if (!payload) return null;
  return buildNoteReceiptUrl(encodeNoteReceiptForUrl(payload as unknown as NoteReceipt));
}

// The showable form of a receipt URL lives in its own import-free module so
// it stays node-testable (this one transitively pulls in React Native).
export { previewNoteReceiptUrl } from '@/services/note-receipt-preview';

export function buildNoteReceiptUrl(encoded: string): string {
  // PAY_URL_BASE pins the brand domain in production; falls back to
  // the running origin on previews / native (where the consumer is
  // expected to deep-link relative paths anyway).
  if (PAY_URL_BASE) return `${PAY_URL_BASE}/import-note#${encoded}`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/import-note#${encoded}`;
  }
  return `/import-note#${encoded}`;
}
