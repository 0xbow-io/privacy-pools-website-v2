/**
 * A wallet excursion: the WALLET moves to another chain for one transaction and
 * the app stays where it is.
 *
 * Registration is per chain, and a flow on chain A sometimes needs the account
 * registered on chain B first (a cross-chain swap deposits over there). That
 * registration is a wallet transaction on B, so the wallet has to switch. But
 * the app follows the wallet everywhere else: ChainProvider drags the selection
 * to the wallet's chain and the session chain is connector-first. Left alone,
 * the switch moved the whole app to B, which re-initialised the session, reset
 * the form the user was filling in, and left the registration modal building
 * its target session in the gap ("Could not reach Ethereum to register there").
 *
 * While an excursion is open, both followers hold the HOME chain instead. The
 * caller switches the wallet back before ending it, so nothing downstream ever
 * sees the detour.
 *
 * Pure module state, so it is testable without React and shared by every
 * consumer through useWalletChainExcursionHome().
 */

type Listener = () => void;

export type WalletChainExcursion = {
  /** The chain the app stays on while the wallet is away. */
  homeChainId: number;
  /**
   * False once a newer excursion replaced this one or the user picked a chain
   * (cancelWalletChainExcursion). The caller then must not switch the wallet
   * back: home is no longer where the user wants to be.
   */
  isCurrent: () => boolean;
  /** Idempotent. Only the excursion that is still current clears the pin. */
  end: () => void;
};

let current: { token: symbol; homeChainId: number } | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Pin the app to `homeChainId` until `end()` is called. A newer excursion
 * replaces an older one, and the older one's `end()` then does nothing, so an
 * abandoned run can never release a live one's pin.
 */
export function beginWalletChainExcursion(homeChainId: number): WalletChainExcursion {
  const token = Symbol('wallet-chain-excursion');
  current = { token, homeChainId };
  emit();
  let ended = false;
  return {
    homeChainId,
    isCurrent: () => current?.token === token,
    end: () => {
      if (ended) return;
      ended = true;
      if (current?.token !== token) return;
      current = null;
      emit();
    },
  };
}

/**
 * Drop whatever excursion is open, because the user chose a chain. The run
 * that opened it sees isCurrent() go false and leaves the wallet where the
 * user put it instead of dragging it back to the old home.
 */
export function cancelWalletChainExcursion(): void {
  if (!current) return;
  current = null;
  emit();
}

/** The chain the app is pinned to, or null when no excursion is open. */
export function walletChainExcursionHome(): number | null {
  return current?.homeChainId ?? null;
}

export function subscribeWalletChainExcursion(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
