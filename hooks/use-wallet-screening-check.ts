import { useCallback, useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';

import { useToast } from '@/components/toast-provider';
import apiClient from '@/services/api-client';
import { checkWalletScreening } from '@/services/wallet-screening';

/**
 * The account menu's "Check wallet status": asks the ASP whether 0xbow
 * services refuse the connected EVM wallet. Runs only on the user's press
 * (services/wallet-screening.ts says why).
 */
export function useWalletScreeningCheck(): { run: () => void; running: boolean } {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { toast } = useToast();
  const [running, setRunning] = useState(false);

  const run = useCallback(() => {
    if (!address || running) return;
    setRunning(true);
    void checkWalletScreening(address, {
      getNonce: (a) => apiClient.getScreeningNonce(a),
      check: (body) => apiClient.checkWalletScreening(body),
      signMessage: (message) => signMessageAsync({ message }),
    })
      .then(({ denied }) => {
        if (denied) {
          toast({
            title: '0xbow services refuse this wallet',
            description: 'You can still exit with ragequit or a self-relayed withdrawal.',
            variant: 'warning',
          });
        } else {
          toast({ title: 'This wallet can use Privacy Pools services.' });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Closing the wallet prompt is the user's answer, not a failure. Same
        // pattern as isUserRejected in services/error-reports-cause.ts.
        if (/\buser (?:rejected|denied|cancell?ed)\b|transaction was rejected/i.test(message)) return;
        toast({ title: 'Wallet check failed', description: 'Try again in a moment.', variant: 'destructive' });
      })
      .finally(() => setRunning(false));
  }, [address, running, signMessageAsync, toast]);

  return { run, running };
}
