import { chainFallbackAllowed } from '@/services/keystore-read-policy';
import {
  awaitKeystoreRegistries,
  readRegistryView,
  REGISTRY_SYNCING_MESSAGE,
  REGISTRY_WAIT_MS,
} from '@/services/nullifying-key-hash-cache';

// The session's keystore interactor answers the SDK's reads of THIS session's
// own account (nullifyingKeys[account], viewingKeys[account]) from the bulk
// ASP registries, so no chain request names the user's account. They used to
// reach the RPC on every deposit, registration and spend precheck.
//
// Three answers, kept distinct:
//   a registry (or own confirmed) hit        -> the value
//   a current registry with no entry         -> zero ("not registered")
//   no current data (not loaded, ASP down)   -> NOT zero: wait (bounded) and
//     refuse with "still syncing", or, in the spend/exit scope, ask the chain.
//
// Any other account (a recipient, a payment-request counterparty) goes to the
// chain exactly as before: its answer must stay authoritative for the SDK's
// recipient resolution, and this file does not change recipient behavior.

const ZERO_WORD = `0x${'0'.repeat(64)}`;

/** Thrown for an own-account read when the registries have no current answer. Not "unregistered". */
export class KeystoreRegistryUnavailableError extends Error {
  constructor() {
    super(REGISTRY_SYNCING_MESSAGE);
    this.name = 'KeystoreRegistryUnavailableError';
  }
}

interface KeystoreReads {
  getNullifyingKeyHash: (account: any) => Promise<any>;
  getViewingKey: (account: any) => Promise<any>;
}

export function routeOwnKeystoreReads<T extends KeystoreReads>(
  interactor: T,
  scope: { chainId: number; keystoreAddress?: string; ownerAddress: string; /** Test seam. */ waitMs?: number },
): T {
  const { chainId, keystoreAddress } = scope;
  const waitMs = scope.waitMs ?? REGISTRY_WAIT_MS;
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
    // Spend and exit never wait on the registry.
    if (chainFallbackAllowed()) return chain(account);
    await awaitKeystoreRegistries(chainId, keystoreAddress, waitMs);
    const later = answer(account, read);
    if (later !== null) return later;
    throw new KeystoreRegistryUnavailableError();
  };

  interactor.getNullifyingKeyHash = routed('hash', readChainHash);
  interactor.getViewingKey = routed('viewing', readChainViewingKey);
  return interactor;
}
