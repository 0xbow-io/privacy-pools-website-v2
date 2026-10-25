export type UnlockStatus = 'unknown' | 'unregistered' | 'compatible' | 'partial' | 'incompatible';

/**
 * What a session on one chain is about to do there. Only a write that mints a
 * note under this unlock on THAT chain needs a positive answer; a failed read
 * for any other purpose is "unknown for that chain", never a block.
 *
 * - `deposit` / `swap-destination`: a deposit, or the far side of a cross-chain
 *   swap, lands a note here. Unknown blocks: a wrong unlock would mint a note
 *   nobody can spend. Only a deposit says "Nothing was deposited".
 * - `register`: registration, or the lookup that decides whether to offer it.
 *   The keystore's own registration read decides; unknown passes.
 * - `spend`: the source of a cross-chain swap. The proof decides; unknown passes.
 *
 * A confirmed mismatch blocks every purpose.
 */
export type UnlockPurpose = 'deposit' | 'swap-destination' | 'register' | 'spend';

export function assertUnlockFor(status: UnlockStatus, purpose: UnlockPurpose, network?: string): void {
  if (status === 'incompatible') {
    throw new Error('This account is registered with a different unlock. Use your original wallet or passkey.');
  }
  if (status !== 'unknown') return;
  if (purpose === 'deposit') {
    throw new Error('Could not verify this unlock. Nothing was deposited. Try again.');
  }
  if (purpose === 'swap-destination') {
    throw new Error(`Could not verify this unlock on ${network ?? 'that network'}. Try again.`);
  }
}

/** Unknown registration is safe for discovery, never for authorizing a deposit. */
export function assertDepositUnlock(status: UnlockStatus): void {
  assertUnlockFor(status, 'deposit');
}
