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

import { keccak256, toBytes } from 'viem';

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

// --- Owner binding for a discoverable pick ----------------------------------
//
// The keys come from the passkey's PRF alone, not the wallet. A discoverable
// prompt lists every privacypools.com passkey, so a user with wallets A and B
// could pick A's passkey while unlocking B: B would then hold A's keys, and
// registering B would put A's key hash on chain for both, linking them
// (review on PR #63). So a discoverable pick is only kept when it provably
// belongs to this wallet:
// - passkeys created from now on carry an owner tag in their user handle,
//   checked on assertion;
// - older passkeys have a random handle, so they are kept only when this
//   wallet is already registered on this network with exactly these keys.

// The handle holds a HASH of the owner, not the address (the WebAuthn spec says
// user.id must not carry identifying information, and it syncs with the
// passkey into the user's passkey manager and its exports; review on PR #63).
// The check recomputes the hash and compares.
//
// Layout, 36 bytes: "pp2:" | 16-byte owner tag | 16 random bytes.
// - WebAuthn caps user.id at 64 bytes. The first version put 64 hex chars
//   after the prefix (68 bytes) and every create threw "User handle exceeds
//   64 bytes" before the prompt (QA on PR #63).
// - The random half is deliberate: an authenticator OVERWRITES a discoverable
//   credential with the same RP ID and user.id, so a fully deterministic id
//   would let a second create for the same wallet destroy the first passkey
//   and the PRF its account comes from.
// - Older handles are 16 random bytes, so the length and prefix tell them apart.
const OWNER_HANDLE_PREFIX = new TextEncoder().encode('pp2:');
export const OWNER_TAG_BYTES = 16;
export const OWNER_HANDLE_RANDOM_BYTES = 16;
export const OWNER_HANDLE_BYTES = OWNER_HANDLE_PREFIX.length + OWNER_TAG_BYTES + OWNER_HANDLE_RANDOM_BYTES;
/** WebAuthn's limit on user.id. */
export const WEBAUTHN_USER_ID_MAX_BYTES = 64;

function ownerTag(ownerAddress: string): Uint8Array {
  return keccak256(toBytes(`privacy-pools passkey owner:${ownerAddress.toLowerCase()}`), 'bytes').slice(0, OWNER_TAG_BYTES);
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** user.id for a new passkey: binds it to the wallet that created it. */
export function passkeyOwnerHandle(
  ownerAddress: string,
  random: Uint8Array = defaultRandom(OWNER_HANDLE_RANDOM_BYTES),
): Uint8Array {
  if (random.length !== OWNER_HANDLE_RANDOM_BYTES) {
    throw new Error(`passkeyOwnerHandle expects ${OWNER_HANDLE_RANDOM_BYTES} random bytes`);
  }
  const out = new Uint8Array(OWNER_HANDLE_BYTES);
  out.set(OWNER_HANDLE_PREFIX, 0);
  out.set(ownerTag(ownerAddress), OWNER_HANDLE_PREFIX.length);
  out.set(random, OWNER_HANDLE_PREFIX.length + OWNER_TAG_BYTES);
  return out;
}

/** The owner tag a handle carries, or null for an older passkey with a random handle. */
function tagFromPasskeyHandle(handle: Uint8Array | null | undefined): Uint8Array | null {
  if (!handle || handle.length !== OWNER_HANDLE_BYTES) return null;
  for (let i = 0; i < OWNER_HANDLE_PREFIX.length; i++) {
    if (handle[i] !== OWNER_HANDLE_PREFIX[i]) return null;
  }
  return handle.slice(OWNER_HANDLE_PREFIX.length, OWNER_HANDLE_PREFIX.length + OWNER_TAG_BYTES);
}

/** Whether a handle names an owner at all (a passkey created by this version). */
export function passkeyHandleNamesOwner(handle: Uint8Array | null | undefined): boolean {
  return tagFromPasskeyHandle(handle) !== null;
}

/** Whether a handle names exactly this owner. */
export function passkeyHandleIsOwner(handle: Uint8Array | null | undefined, ownerAddress: string): boolean {
  const tag = tagFromPasskeyHandle(handle);
  if (!tag) return false;
  const want = ownerTag(ownerAddress);
  return tag.every((b, i) => b === want[i]);
}

/** The name the OS sheet shows for a new passkey, so two wallets' passkeys can be told apart. */
export function passkeyDisplayName(ownerAddress: string): string {
  const a = ownerAddress.toLowerCase();
  return `Privacy Pools ${a.slice(0, 6)}…${a.slice(-4)}`;
}

export type DiscoverablePickVerdict = 'accept' | 'wrong-wallet' | 'unproven';

export function discoverablePickVerdict(input: {
  ownerAddress: string;
  userHandle: Uint8Array | null | undefined;
  identityStatus: string;
}): DiscoverablePickVerdict {
  if (passkeyHandleNamesOwner(input.userHandle)) {
    return passkeyHandleIsOwner(input.userHandle, input.ownerAddress) ? 'accept' : 'wrong-wallet';
  }
  return input.identityStatus === 'compatible' || input.identityStatus === 'partial' ? 'accept' : 'unproven';
}

export const PASSKEY_WRONG_WALLET_MESSAGE =
  'That passkey belongs to another wallet. Tap Use another passkey and pick the one for this wallet.';
export const PASSKEY_UNPROVEN_MESSAGE =
  'That passkey is not registered for this wallet on this network. Pick another passkey, or switch to a network where this wallet is registered.';

export const PASSKEY_CREATED_FOR_REGISTERED_MESSAGE =
  'This wallet is already set up with another passkey, so the new one cannot use it. Tap Sign in and pick the passkey you set it up with.';

/** A passkey just created is kept as this wallet's passkey only when the wallet is not already set up with another one. */
export function keepCreatedPasskey(identityStatus: string): boolean {
  return identityStatus !== 'incompatible';
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
