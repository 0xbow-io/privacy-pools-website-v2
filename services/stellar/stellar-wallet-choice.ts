/**
 * Which Stellar wallet this browser used last, stored next to the connected flag
 * (`ppv2_stellar_connected`, owned by components/stellar-wallet-provider.tsx).
 * A silent reconnect only ever goes to this wallet; a browser that connected
 * before this key existed was using Freighter.
 *
 * Pure module (storage is injectable) so it is bun-testable.
 */
export type StellarWalletKind = 'freighter' | 'metamask';

export const STELLAR_WALLET_KIND_KEY = 'ppv2_stellar_wallet';

export const STELLAR_WALLET_NAMES: Record<StellarWalletKind, string> = {
  freighter: 'Varial',
  metamask: 'MetaMask',
};

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readStellarWalletKind(store: KeyValueStore | undefined = defaultStore()): StellarWalletKind {
  try {
    return store?.getItem(STELLAR_WALLET_KIND_KEY) === 'metamask' ? 'metamask' : 'freighter';
  } catch {
    return 'freighter';
  }
}

export function writeStellarWalletKind(kind: StellarWalletKind, store: KeyValueStore | undefined = defaultStore()): void {
  try {
    if (kind === 'metamask') store?.setItem(STELLAR_WALLET_KIND_KEY, 'metamask');
    else store?.removeItem(STELLAR_WALLET_KIND_KEY);
  } catch {
    // storage unavailable: the next silent reconnect falls back to Freighter
  }
}
