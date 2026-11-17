/**
 * How the Stellar wallet state drives the shared account store, and when the header must offer
 * Sign Out on its own. Pure, so the rules are tested against the real store.
 */
import type { StellarWalletProvider } from '@privacy-pools-v2/stellar-sdk';

export interface StellarWalletBindingState {
  address: string | null;
  signer: StellarWalletProvider | null;
  isConnected: boolean;
  signedOut: boolean;
}

/**
 * Losing the active account without a Disconnect keeps the unlocked sessions (see the wallet
 * provider's watch). Disconnect forgets them.
 */
export function bindStellarWallet(
  account: { bind(address: string | null, signer: StellarWalletProvider | null, opts?: { keepSessions?: boolean }): void },
  wallet: StellarWalletBindingState,
) {
  account.bind(wallet.isConnected ? wallet.address : null, wallet.isConnected ? wallet.signer : null, { keepSessions: !wallet.signedOut });
}

/**
 * The account menu, and its Sign Out, needs a connected wallet. When the wallet lost its active
 * account (a revoked site, or an account the site is not allowed for yet) the unlocked sessions
 * stay in memory, so Sign Out stays on screen until it is used.
 */
export function showStellarSignOut(state: {
  activeIsStellar: boolean;
  walletConnected: boolean;
  signedOut: boolean;
  keptSessions: boolean;
}): boolean {
  return state.activeIsStellar && !state.walletConnected && !state.signedOut && state.keptSessions;
}
