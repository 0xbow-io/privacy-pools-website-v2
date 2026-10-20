import { useAccount } from 'wagmi';

import { usePoolSession } from '@/hooks/use-pool-session';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useStellarWallet } from '@/components/stellar-wallet-provider';

/**
 * The one canonical, SETTLED identity that owns payment requests — shared by
 * the list card, the backup modal, backup filenames, and storage-adapter
 * calls so they can never disagree:
 *
 *  - On Stellar, the connected Freighter account: Stellar requests name it
 *    and are listed under it (services/session-payment-requests.ts).
 *  - An active account-key session IS the owner. A connected wallet is then
 *    only the payer and must never replace the key identity (exporting the
 *    payer's empty request namespace while displaying the key account was
 *    exactly that bug).
 *  - Otherwise the wallet address counts only once wagmi's status is EXACTLY
 *    'connected' — a cached 'reconnecting' address is an unknown outcome and
 *    must not load/flash another identity's data.
 */
export function useRequestOwner(): { owner: string | null; ownerMode: 'key' | 'wallet' | null } {
  const { sessionAddress, identityMode } = usePoolSession();
  const { address, status } = useAccount();
  const { isStellar } = useChainRouter();
  const stellarWallet = useStellarWallet();
  if (isStellar) {
    return stellarWallet.isConnected && stellarWallet.address
      ? { owner: stellarWallet.address, ownerMode: 'wallet' }
      : { owner: null, ownerMode: null };
  }
  if (identityMode === 'key' && sessionAddress) return { owner: sessionAddress, ownerMode: 'key' };
  if (status === 'connected' && address) return { owner: address, ownerMode: 'wallet' };
  return { owner: null, ownerMode: null };
}
