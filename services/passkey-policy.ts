// Who gets the passkey unlock. Passkeys exist for wallets that cannot produce
// the single deterministic ECDSA signature the wallet path derives the account
// from, so a WebAuthn PRF is their one way in. Smart-contract wallets (Safe,
// Ambire, ...) are that case by construction. Everyone else keeps the
// wallet-signature sign-in and never sees a passkey option, so nobody has to
// remember which of two unlocks they used (Pat, 2026-09-05).
//
// The second case is found rather than detected: some hardware wallets and
// signers return a different signature every time for the same payload. The
// derivation refuses those (services/signer-determinism.ts) because each
// signature would derive a different, empty account. Before, that was a dead
// end. Now, once a wallet has actually proved itself non-deterministic, the
// passkey is offered to it too — the same reason a contract wallet gets one.

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
   * THIS wallet returned two different signatures for the same payload, so it
   * cannot derive a stable account and the user asked for the passkey instead.
   * Observed, never assumed: it is set only after the determinism proof failed
   * for the connected address.
   */
  signerRefusedDerivation?: boolean;
}): boolean {
  const needsPasskey = input.isSmartWallet || input.signerRefusedDerivation === true;
  return input.enabled && input.hasAddress && !input.hasKeyIdentity && needsPasskey && input.supportedChain;
}
