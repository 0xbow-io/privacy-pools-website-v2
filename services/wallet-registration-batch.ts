import type { Address, Hex } from 'viem';
import { getCapabilities, getCallsStatus, sendCalls } from 'viem/actions';
import type { Config } from 'wagmi';
import { getConnectorClient } from 'wagmi/actions';

import { submitRegistrationBatch } from '@/services/registration-batch';

type RegistrationCall = { to: string; data: string; value: string | number | bigint };

export function submitWalletRegistrationBatch(config: Config, args: {
  owner: Address;
  chainId: number;
  keystoreCalldata?: RegistrationCall | null;
  viewingKeyCalldata?: RegistrationCall | null;
  beforeSend: () => void;
  onAwaitingWallet?: (waiting: boolean) => void;
}) {
  const { owner, chainId, keystoreCalldata, viewingKeyCalldata } = args;
  let client: Awaited<ReturnType<typeof getConnectorClient>> | undefined;
  const getClient = async () => client ??= await getConnectorClient(config, { account: owner, chainId });
  return submitRegistrationBatch({
    getCapabilities: async () => getCapabilities(await getClient(), { account: owner, chainId }),
    sendCalls: async ({ calls, id }) => {
      const wallet = await getClient();
      return sendCalls(wallet, {
        account: owner, chain: wallet.chain, forceAtomic: true, id,
        calls: calls.map(call => ({ to: call.to as Address, data: call.data as Hex, value: BigInt(call.value ?? 0) })),
      });
    },
    getCallsStatus: async (id) => getCallsStatus(await getClient(), { id }),
  }, {
    owner, chainId,
    calls: [keystoreCalldata, viewingKeyCalldata].filter(call => call != null).map(call => ({ ...call, value: String(call.value) })),
    beforeSend: args.beforeSend,
    onAwaitingWallet: args.onAwaitingWallet,
  });
}
