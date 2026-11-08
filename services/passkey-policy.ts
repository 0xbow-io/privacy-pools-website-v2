// Who gets the passkey unlock. Passkeys exist for wallets that cannot produce
// the single deterministic ECDSA signature the wallet path derives the account
// from, so a WebAuthn PRF is their one way in. Smart-contract wallets (Safe,
// Ambire, ...) are that case by construction. Everyone else keeps the
// wallet-signature sign-in and never sees a passkey option, so nobody has to
// remember which of two unlocks they used (Pat, 2026-09-05).
//
// The second case is chosen rather than detected. Some hardware wallets and
// signers return a different signature every time for the same payload. The
// derivation refuses those (services/signer-determinism.ts) because each
// signature would derive a different, empty account. Once a wallet has proved
// itself non-deterministic, or this browser already unlocked it with a
// passkey, the user may pick a passkey or a security key for it (one gate for
// both, services/passkey-choice.ts). This policy only sees the result: the pick.

export function passkeyUnlockDefault(input: {
  /** The build ships the passkey unlock at all (EXPO_PUBLIC_PASSKEY_PREVIEW !== '0'). */
  enabled: boolean;
  /** Code at the connected address, and not an EIP-7702 delegation. */
  isSmartWallet: boolean;
  /** An imported account key is the identity: it carries its own signature. */
  hasKeyIdentity: boolean;
  /** The active chain is a supported EVM chain. */
  supportedChain: boolean;
  /** A wallet is connected. */
  hasAddress: boolean;
  /**
   * The user picked a passkey or security key for THIS wallet, through a
   * choice that services/passkey-choice.ts allowed. Never assumed.
   */
  passkeyChosen?: boolean;
  /** Older name of passkeyChosen, kept for callers and tests that still pass it. */
  signerRefusedDerivation?: boolean;
}): boolean {
  const chosen = input.passkeyChosen === true || input.signerRefusedDerivation === true;
  const needsPasskey = input.isSmartWallet || chosen;
  return input.enabled && input.hasAddress && !input.hasKeyIdentity && needsPasskey && input.supportedChain;
}
