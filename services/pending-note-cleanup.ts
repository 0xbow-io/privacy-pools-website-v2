import type { Hash } from '@/services/sdk-types';

/**
 * Remove ONE pending note from a stored account export, by commitment.
 *
 * A cross-chain swap-deposit persists its destination note PENDING in the
 * destination chain's bucket at prepare time, before anything is bridged. When
 * the bridge delivers but the deposit call fails (LiFi DONE/PARTIAL), the funds
 * are in the wallet and that note never becomes real — left alone it renders
 * as a pending deposit forever. Only a PENDING note with the exact commitment
 * is removed: an ACTIVE note with that commitment means the deposit did land
 * after all, and nothing may touch it.
 *
 * Returns the same object when nothing was removed, so callers can skip the
 * write. Pure.
 */
export function withoutStrandedPendingNote<
  T extends { notes?: Array<{ commitment?: unknown; status?: unknown }> },
>(accountExport: T, commitment: Hash | string): T {
  const target = normalize(commitment);
  if (!target || !Array.isArray(accountExport.notes)) return accountExport;
  const kept = accountExport.notes.filter((note) => {
    if (normalize(note.commitment) !== target) return true;
    return String(note.status ?? '').toUpperCase() !== 'PENDING';
  });
  if (kept.length === accountExport.notes.length) return accountExport;
  return { ...accountExport, notes: kept };
}

function normalize(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
  } catch {
    return value.toLowerCase();
  }
}
