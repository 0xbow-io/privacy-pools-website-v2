import { readRegistryView, REGISTRY_SYNCING_MESSAGE } from '@/services/nullifying-key-hash-cache';

// SDK reads of the session account use only the bulk ASP registries and
// confirmed registration records. A current miss means unregistered; missing
// or stale data throws instead of naming the account to RPC. The background
// feed owns refreshes, so these reads cannot disclose operation timing.
// Recipient and counterparty reads retain their existing chain behavior.

const ZERO_WORD = `0x${'0'.repeat(64)}`;

interface KeystoreReads {
  getNullifyingKeyHash: (account: any) => Promise<any>;
  getViewingKey: (account: any) => Promise<any>;
}

export function routeOwnKeystoreReads<T extends KeystoreReads>(
  interactor: T,
  scope: { chainId: number; keystoreAddress?: string; ownerAddress: string },
): T {
  const { chainId, keystoreAddress } = scope;
  const owner = scope.ownerAddress.toLowerCase();
  const isOwn = (account: unknown) => typeof account === 'string' && account.toLowerCase() === owner;
  const readChainHash = interactor.getNullifyingKeyHash.bind(interactor);
  const readChainViewingKey = interactor.getViewingKey.bind(interactor);

  const answer = (account: string, read: 'hash' | 'viewing'): string | null => {
    const view = readRegistryView(chainId, account, keystoreAddress);
    if (read === 'hash') {
      if (view.nullifyingKeyHash) return view.nullifyingKeyHash;
      return view.nullifyingFresh ? ZERO_WORD : null;
    }
    // A viewing key can be rotated, so even a hit needs a current registry.
    return view.viewingFresh ? (view.viewingKey ?? ZERO_WORD) : null;
  };

  const routed = (read: 'hash' | 'viewing', chain: (account: string) => Promise<unknown>) => async (account: string) => {
    if (!isOwn(account)) return chain(account);
    const now = answer(account, read);
    if (now !== null) return now;
    throw new Error(REGISTRY_SYNCING_MESSAGE);
  };

  interactor.getNullifyingKeyHash = routed('hash', readChainHash);
  interactor.getViewingKey = routed('viewing', readChainViewingKey);
  return interactor;
}
