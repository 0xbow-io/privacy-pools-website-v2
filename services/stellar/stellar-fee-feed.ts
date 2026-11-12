import { torFetchIfActive } from '@/services/tor-fetch';
import { STELLAR_TESTNET_RPC_URL } from '@/config/stellar-deployment';
import { stellarRelayFeeFromResourceFee, type StellarFeeEstimates } from '@/services/stellar-fee-estimate';

/**
 * One public configuration read per grid tick, regardless of selected network,
 * wallet, amount or notes. Compute every supported input count locally for
 * both operations; the RPC receives only public configuration keys.
 */
export async function fetchStellarFees(): Promise<StellarFeeEstimates> {
  const [{ rpc }, fees] = await Promise.all([
    import('@stellar/stellar-sdk'),
    import('@/vendor/stellar-fees'),
  ]);
  const server = new rpc.Server(STELLAR_TESTNET_RPC_URL, { timeout: 5 });
  // These fixed configuration keys use the public RPC route on dev and main.
  const send = torFetchIfActive();
  if (send) {
    (server as unknown as { httpClient: unknown }).httpClient = {
      async post(url: string, data: unknown) {
        const res = await send(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`Soroban RPC HTTP ${res.status}`);
        return { data: await res.json(), status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()) };
      },
    };
  }
  const settings = await fees.readStellarFeeSettings(server);
  const resourceFee = (action: 'transfer' | 'relay' | 'register_and_relay', n: number, m: number) => {
    const resources = fees.stellarRelayResources(fees.STELLAR_RELAY_RESOURCE_TABLE, action, { n, m }, {
      keystoreRecord: true,
      // The app accepts G-address withdrawal recipients.
      contractRecipient: false,
    });
    return fees.stellarRelayResourceFee(resources, settings).resourceFee;
  };
  return {
    // prepareTransfer, including request fulfilment and saving a claim.
    transfer: Array.from({ length: 5 }, (_, i) => stellarRelayFeeFromResourceFee(resourceFee('transfer', i + 1, Math.min(2 * (i + 1), 5)))),
    // Withdrawal quotes omit withRegistration, so the relayer prices the
    // costlier action. Both use n inputs and n outputs, including change.
    withdrawal: Array.from({ length: 5 }, (_, i) => {
      const n = i + 1;
      const relay = resourceFee('relay', n, n);
      const register = resourceFee('register_and_relay', n, n);
      return stellarRelayFeeFromResourceFee(relay > register ? relay : register);
    }),
  };
}
