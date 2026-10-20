/**
 * DEV-522: ask for the sign-in signature right after the user connects a
 * wallet, instead of waiting for them to find a Sign in button.
 *
 * The wallet picker ARMS this only after a connect the user started (a tap in
 * the picker). A reconnect from a saved session never goes through the
 * picker, so it never arms. The seed-derivation provider CONSUMES the arm at
 * most once, and only when `shouldAutoSignAfterConnect` says so.
 */

/** An arm older than this is stale: the user wandered off, do not surprise them. */
export const AUTO_SIGN_ARM_TTL_MS = 2 * 60_000;

export type AutoSignArm = {
  /** Lowercased account the connect returned, or null when unknown (quirk path). */
  address: string | null;
  armedAt: number;
};

let current: AutoSignArm | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function armAutoSignAfterConnect(address: string | null | undefined, now = Date.now()): void {
  current = { address: address ? address.toLowerCase() : null, armedAt: now };
  emit();
}

/** Drop the arm without signing (wallet gone, user declined, ...). */
export function disarmAutoSignAfterConnect(): void {
  if (!current) return;
  current = null;
  emit();
}

export function peekAutoSignArm(): AutoSignArm | null {
  return current;
}

/** Take the arm. Returns it once; later calls return null until re-armed. */
export function takeAutoSignArm(): AutoSignArm | null {
  const arm = current;
  current = null;
  return arm;
}

export function subscribeAutoSignArm(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type AutoSignInputs = {
  arm: AutoSignArm | null;
  now: number;
  /** wagmi status; only exactly 'connected' counts. */
  status: string;
  address: string | null | undefined;
  identityMode: 'wallet' | 'key' | null;
  /** Non-EVM chain (Sui/Stellar) has its own unlock. */
  nonEvmChain: boolean;
  keysReady: boolean;
  /** Address the current keys/session belong to (sessionTarget), if known. */
  keysAddress?: string | null;
  isInitializing: boolean;
  /** A passkey unlock needs its own tap (WebAuthn user activation). */
  passkeyActive: boolean;
  /** Smart-wallet probe answered for this address and chain (async getCode). */
  smartWalletProbeSettled: boolean;
  /** A smart-contract wallet unlocks with a passkey, never a wallet signature. */
  isSmartWallet: boolean;
  pageVisible: boolean;
  /**
   * DEV-427: Coinbase Wallet can drop a signature request sent the moment it
   * connects (popup spins, never renders). It gets the dialog, and the
   * signature starts from the user's own tap on Sign in.
   * null while the connected provider's local identity is being read.
   */
  isCoinbaseWallet?: boolean | null;
};

export type AutoSignDecision =
  /** Start the signature now and consume the arm. */
  | 'sign'
  /** Not yet (page hidden, wallet still settling): keep the arm. */
  | 'wait'
  /** Show the Sign in dialog without signing, consume the arm. */
  | 'open'
  /** Nothing to do, consume the arm. */
  | 'drop';

export function shouldAutoSignAfterConnect(i: AutoSignInputs): AutoSignDecision {
  if (!i.arm) return 'drop';
  if (i.now - i.arm.armedAt > AUTO_SIGN_ARM_TTL_MS) return 'drop';
  // Account-key sessions and non-EVM chains never sign with the wallet.
  if (i.identityMode === 'key' || i.nonEvmChain) return 'drop';
  if (i.status !== 'connected' || !i.address) {
    // Connecting/reconnecting settles in a moment; a dead connection drops.
    return i.status === 'connecting' || i.status === 'reconnecting' ? 'wait' : 'drop';
  }
  // A different account than the one the user just approved: not this connect.
  // An arm with no known account (should not happen: the picker reads the
  // live address) is never trusted to sign whatever account is connected.
  if (!i.arm.address || i.arm.address !== i.address.toLowerCase()) return 'drop';
  if (i.keysReady || i.isInitializing) {
    // Readiness still describing the PREVIOUS wallet (the provider has not
    // reset yet after a switch): wait for it to catch up, do not drop.
    if (i.keysAddress && i.keysAddress.toLowerCase() !== i.address.toLowerCase()) return 'wait';
    // Keys already there for this account (cached proved signature): no prompt, ever.
    return 'drop';
  }
  if (i.identityMode !== 'wallet') return 'wait';
  // Back from the wallet app with the tab still hidden: send it once visible.
  if (!i.pageVisible) return 'wait';
  // Until the probe answers we cannot tell a smart wallet from an EOA.
  if (!i.smartWalletProbeSettled) return 'wait';
  if (i.passkeyActive || i.isSmartWallet) return 'open';
  if (i.isCoinbaseWallet === null) return 'wait';
  if (i.isCoinbaseWallet) return 'open';
  return 'sign';
}
