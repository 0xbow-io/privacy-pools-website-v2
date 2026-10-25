/**
 * Which notes a swap may spend, as far as the ASP has said (DEV-590).
 *
 * A swap needs an association-set proof for every input, so it fails closed:
 * nothing is spendable until the set is known. What it must NOT do is say the
 * notes are "not approved yet" while that is merely unknown. The swap used to
 * resolve approval itself, once per open, with one association-set download
 * per note, and read every failure (an ASP backoff window, a pacing refusal, a
 * notes sync that landed after the open) as "not in the set". The first swap of
 * a fresh session therefore reported long-approved notes as waiting, and a
 * retry, after the session had settled, worked.
 *
 * The answer now comes from the one shared gate (hooks/use-leaf-gate.ts), which
 * reads the session's bulk association set. No request is added for it, and
 * none is keyed on a note. Pure, so the states can be tested.
 */
import type { LeafGate } from '@/services/leaf-gate';

export const SWAP_APPROVAL_CHECKING = 'Checking approval…';
export const SWAP_APPROVAL_UNAVAILABLE = 'Could not check approval right now. Try again in a moment.';

export type SwapApproval =
  /** The association set has not answered for these notes yet. */
  | { status: 'checking' }
  /** The set could not be read or verified. Retryable, and not a verdict. */
  | { status: 'unavailable'; error: string }
  /**
   * A verified answer. `approved` is authoritative only for the commitments in
   * `checked`: a note outside it arrived after the answer and is unknown.
   */
  | { status: 'ready'; approved: ReadonlySet<string>; checked: ReadonlySet<string> };

export function swapApprovalFromGate(gate: LeafGate, checkedNotes: readonly { commitment: string }[]): SwapApproval {
  if (gate.status === 'loading') return { status: 'checking' };
  if (gate.status === 'error') return { status: 'unavailable', error: gate.error };
  return {
    status: 'ready',
    approved: gate.confirmed,
    checked: new Set(checkedNotes.map((n) => n.commitment)),
  };
}

/**
 * Why the swap cannot judge approval for these held notes yet, or null when the
 * answer covers all of them and the note selection can decide. Only a null here
 * may lead to the shortfall copy that names value as waiting for approval.
 */
export function swapApprovalBlock(
  approval: SwapApproval,
  heldCommitments: readonly string[],
): { reason: 'unresolved'; error: string } | null {
  if (approval.status === 'checking') return { reason: 'unresolved', error: SWAP_APPROVAL_CHECKING };
  if (approval.status === 'unavailable') return { reason: 'unresolved', error: SWAP_APPROVAL_UNAVAILABLE };
  if (heldCommitments.some((c) => !approval.checked.has(c))) {
    return { reason: 'unresolved', error: SWAP_APPROVAL_CHECKING };
  }
  return null;
}
