import { useEffect } from 'react';
import { useAccount } from 'wagmi';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useSdkContext } from '@/components/sdk-provider';
import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { setTorAccounts } from '@/services/tor-groups';

/**
 * Keeps anon-rpc's list of the user's accounts current, the session's identity
 * first, so a request that names one goes over that account's worker
 * (services/tor-groups.ts). Renders nothing.
 */
export function TorAccounts() {
  const { sessionTarget } = useSdkContext();
  const { address } = useAccount();
  const sui = useCurrentAccount();
  const stellar = useStellarWallet();
  const session = sessionTarget?.address;
  useEffect(() => {
    setTorAccounts([session, address, sui?.address, stellar.address]);
  }, [session, address, sui?.address, stellar.address]);
  return null;
}
