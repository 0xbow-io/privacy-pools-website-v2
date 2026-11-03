// Which WebAuthn ceremony a wallet + passkey unlock runs (smart-contract wallet
// path in components/sdk-provider.tsx). Pure, so the choice is testable.
//
// Before this, a remembered credential id meant a GET restricted to that one
// id, and no remembered id meant CREATE. A user whose remembered passkey was
// the wrong one could never reach the right one (the prompt offered only the
// remembered id, and nothing at all once it was deleted), and a new browser or
// a cleared storage minted a new passkey, which is a new account, every time.
//
// Now:
// - remembered id, no explicit pick: targeted GET (unchanged).
// - 'any' ("Use another passkey"): discoverable GET, the OS lists every
//   passkey for the RP ID, and the one chosen becomes the remembered id.
// - no remembered id, no explicit pick: discoverable GET. Never a silent create.
// - 'create' ("Create a passkey"): CREATE, only when nothing is remembered. With
//   a remembered id it stays a targeted GET, the same rule the create lock
//   applies when another tab won the race: never a second credential while one
//   is on record.
//
// Key derivation is untouched: whichever passkey answers, its PRF goes through
// the same salts and the same derivation as before.

export type PasskeyPick = 'any' | 'create';

export type PasskeyUnlockPlan =
  | { kind: 'targeted'; credentialId: string }
  | { kind: 'discoverable' }
  | { kind: 'create' };

/** Only the two literal picks count; anything else (an event object, a typo) is no pick. */
export function normalizePasskeyPick(pick: unknown): PasskeyPick | undefined {
  return pick === 'any' || pick === 'create' ? pick : undefined;
}

export function resolvePasskeyUnlockPlan(input: {
  rememberedCredentialId?: string | null;
  pick?: unknown;
}): PasskeyUnlockPlan {
  const pick = normalizePasskeyPick(input.pick);
  const remembered = input.rememberedCredentialId || undefined;
  if (pick === 'any') return { kind: 'discoverable' };
  if (remembered) return { kind: 'targeted', credentialId: remembered };
  if (pick === 'create') return { kind: 'create' };
  return { kind: 'discoverable' };
}

export const PASSKEY_USE_ANOTHER_LABEL = 'Use another passkey';
export const PASSKEY_CREATE_LABEL = 'Create a passkey';

export const PASSKEY_TARGETED_NOT_USED_MESSAGE =
  'Your saved passkey was not used. If it is not offered or was deleted, tap Use another passkey.';
export const PASSKEY_ANOTHER_NOT_USED_MESSAGE =
  'No passkey was chosen. Tap Use another passkey to try again.';
export const PASSKEY_DISCOVERABLE_NOT_USED_MESSAGE =
  'No passkey was chosen. If you do not have one for this wallet yet, tap Create a passkey.';

/**
 * The dialog line for a dismissed or empty passkey prompt (WebAuthn reports a
 * cancel and "no matching credential" the same way, NotAllowedError). Points
 * at the way out the dialog actually offers.
 */
export function passkeyNotUsedMessage(plan: PasskeyUnlockPlan, remembered: boolean): string {
  if (plan.kind === 'targeted') return PASSKEY_TARGETED_NOT_USED_MESSAGE;
  return remembered ? PASSKEY_ANOTHER_NOT_USED_MESSAGE : PASSKEY_DISCOVERABLE_NOT_USED_MESSAGE;
}

/**
 * The secondary choice under the passkey Sign in button: switch passkeys when
 * one is remembered, set one up when none is.
 */
export function passkeySecondaryChoice(remembered: boolean): { pick: PasskeyPick; label: string } {
  return remembered
    ? { pick: 'any', label: PASSKEY_USE_ANOTHER_LABEL }
    : { pick: 'create', label: PASSKEY_CREATE_LABEL };
}
