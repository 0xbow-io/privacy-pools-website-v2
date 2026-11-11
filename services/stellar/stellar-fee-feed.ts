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
  const settings = await fees.readStellarFeeSettings(new rpc.Server(STELLAR_TESTNET_RPC_URL, { timeout: 5 }));
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
