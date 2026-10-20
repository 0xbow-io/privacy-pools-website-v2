// v2.0 migration: the SDK's NoteSchema now REQUIRES `noteAddressHash` on
// every note, and NoteManager.importState validates the whole blob — one
// legacy note (written by the pre-v2.0 SDK, which had no such field) makes
// the entire import throw InvalidNoteError. That would drop the local note
// cache on session init and, worse, make old account backups unimportable —
// including out-of-band (one-time receipt) notes that can never be
// rediscovered by an on-chain scan.
//
// The field is fully derivable — noteAddressHash = Poseidon(ownerAddress,
// noteSecret) (see the SDK's NoteComputationService.computeNoteAddressHash)
// — so we backfill it before handing the blob to the SDK.

/**
 * Backfill `noteAddressHash` on any note missing it. Returns the input
 * untouched (same reference) when nothing needs upgrading. Notes without
 * `ownerAddress`/`noteSecret` are left as-is (the SDK schema rejects them
 * either way, matching pre-migration behavior for malformed blobs).
 */
export async function backfillNoteAddressHashes<T extends object>(data: T): Promise<T> {
  const notes = (data as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) return data;

  const needsUpgrade = notes.some((n) => {
    if (!n || typeof n !== 'object') return false;
    const note = n as Record<string, unknown>;
    return !note.noteAddressHash
      && typeof note.ownerAddress === 'string'
      && typeof note.noteSecret === 'string';
  });
  if (!needsUpgrade) return data;

  // Lazy import: keeps this module load-light (the Poseidon hash service
  // pulls in circomlibjs).
  const { createHashService } = await import('@/services/sdk-runtime');
  const hashService = await createHashService();

  const upgraded = notes.map((n) => {
    if (!n || typeof n !== 'object') return n;
    const note = n as Record<string, unknown>;
    if (note.noteAddressHash || typeof note.ownerAddress !== 'string' || typeof note.noteSecret !== 'string') {
      return n;
    }
    return {
      ...note,
      noteAddressHash: hashService.hash([note.ownerAddress as `0x${string}`, note.noteSecret as `0x${string}`]),
    };
  });

  return { ...data, notes: upgraded };
}
