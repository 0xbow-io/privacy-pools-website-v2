/**
 * One spelling per token, across every note a session holds.
 *
 * A note's `tokenId` is stored as whatever string produced it: the checksummed
 * address from a config table on one path, the lowercased one a log decode
 * yields on another. Both name the same token and every comparison in this app
 * is case-insensitive, so the mixture is invisible until a transact.
 *
 * It is not invisible there. The SDK reduces the input notes with a strict
 * `!==` (`getNotesTokenId`, "All input notes must have the same tokenId"), so
 * two spellings in one proof throw, and `selectSwapInputNotes` groups by the
 * raw string to avoid exactly that. The cost is that a user with one note in
 * each spelling can only ever spend the larger group: two approved notes,
 * neither near the five-input cap, and the swap still refused half the balance
 * (Mike, 2026-09-23).
 *
 * The SDK's own next line compares `notesTokenId.toLowerCase()` against the
 * transact's, so the strict reduce is an inconsistency rather than an
 * invariant, and it is being fixed upstream. This collapses the spellings that
 * already exist, which no upstream change can do.
 *
 * ONLY a 20-byte hex address is lowercased. A Sui type (`0x2::sui::SUI`) is
 * case-sensitive in its module and struct names, and lowercasing one would
 * rename the token rather than normalise it.
 */
import type { AccountExport, Note } from '@/services/sdk-types';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function canonicalTokenId<T>(tokenId: T): T {
  return typeof tokenId === 'string' && EVM_ADDRESS.test(tokenId)
    ? (tokenId.toLowerCase() as unknown as T)
    : tokenId;
}

/**
 * The same export with every note's `tokenId` canonical.
 *
 * Returns the ORIGINAL object when nothing changed, so a caller can skip a
 * write, and so this cannot churn storage on every read.
 */
export function canonicalizeExportTokenIds<T extends AccountExport>(account: T): T {
  if (!account || !Array.isArray(account.notes)) return account;
  let changed = false;
  const notes = account.notes.map((note: Note) => {
    const canonical = canonicalTokenId(note.tokenId);
    if (canonical === note.tokenId) return note;
    changed = true;
    return { ...note, tokenId: canonical };
  });
  return changed ? { ...account, notes } : account;
}
