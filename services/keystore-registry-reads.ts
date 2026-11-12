import { readRegistryView, REGISTRY_SYNCING_MESSAGE } from '@/services/nullifying-key-hash-cache';

// SDK account reads, including recipients, stay local. A complete background
// bulk source authorizes absence, while missing data refuses the operation.

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

  const answer = (account: string, read: 'hash' | 'viewing'): string | null => {
    const view = readRegistryView(chainId, account, keystoreAddress);
    if (read === 'hash') {
      if (view.nullifyingKeyHash) return view.nullifyingKeyHash;
      return view.nullifyingFresh ? ZERO_WORD : null;
    }
    // A viewing key can be rotated, so even a hit needs a current registry.
    return view.viewingFresh ? (view.viewingKey ?? ZERO_WORD) : null;
  };

  const routed = (read: 'hash' | 'viewing') => async (account: string) => {
    const now = answer(account, read);
    if (now !== null) return now;
    throw new Error(REGISTRY_SYNCING_MESSAGE);
  };

  interactor.getNullifyingKeyHash = routed('hash');
  interactor.getViewingKey = routed('viewing');
  return interactor;
}
