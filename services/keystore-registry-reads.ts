import { readRegistryView } from '@/services/nullifying-key-hash-cache';

// The session's keystore interactor answers the SDK's reads of THIS session's
// own account (nullifyingKeys[account], viewingKeys[account]) from the bulk
// ASP registries first, so no chain request names the user's account while the
// registries have the answer. They used to reach the RPC on every deposit,
// registration and spend precheck.
//
// Three answers, kept distinct:
//   a registry (or own confirmed) hit        -> the value, no request
//   a current registry with no entry         -> zero ("not registered"), no request
//   no current data (not loaded, ASP down)   -> NOT zero: ask the chain, as the
//     session did before the registries existed. Never a wait, never a refusal.
//
// There is no mutable scope here: the rule is the same for every own-account
// read (deposit, registration, payment request, spend, exit), so a read in
// flight cannot change what an unrelated read does. The chain read is the only
// path that names the account, and it is kept for this release until the
// registry feed is proven.
//
// Any other account (a recipient, a payment-request counterparty) goes to the
// chain exactly as before: its answer must stay authoritative for the SDK's
// recipient resolution, and this file does not change recipient behavior.

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
    return chain(account);
  };

  interactor.getNullifyingKeyHash = routed('hash', readChainHash);
  interactor.getViewingKey = routed('viewing', readChainViewingKey);
  return interactor;
}
