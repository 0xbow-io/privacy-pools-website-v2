import { useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useSdkContext } from '@/components/sdk-provider';
import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { beginTorOperationScope } from '@/services/tor-fetch';

/**
 * While `active`, the flow is one operation for anon-rpc: its relayer, LI.FI
 * and targeted ASP requests share a worker no other operation uses, which
 * closes when the flow does (services/tor-groups.ts).
 *
 * A flow left open while the session or any wallet (EVM, Sui or Stellar)
 * changes starts a new operation, since its next quotes are another
 * identity's. The previous one is left to finish what it already sent, such
 * as a relay a submitted swap still awaits, and ends with the flow.
 */
export function useTorOperation(active: boolean): void {
  const { sessionAddress } = useSdkContext();
  const { address } = useAccount();
  const sui = useCurrentAccount()?.address;
  // Stellar account ids are case-sensitive, so they are compared as given.
  const stellar = useStellarWallet().address;
  const session = sessionAddress?.toLowerCase();
  const wallet = address?.toLowerCase();
  const ends = useRef<(() => void)[]>([]);
  useEffect(() => {
    if (active) ends.current.push(beginTorOperationScope());
  }, [active, session, wallet, sui, stellar]);
  useEffect(() => {
    if (!active) return undefined;
    const open = ends.current;
    return () => {
      for (const end of open.splice(0)) end();
    };
  }, [active]);
}
