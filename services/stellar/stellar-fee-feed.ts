import { STELLAR_TESTNET_RPC_URL } from '@/config/stellar-deployment';
import { stellarTransferFeeFromResourceFee, type StellarTransferFees } from '@/services/stellar-transfer-fee-estimate';

/**
 * One public configuration read per grid tick, regardless of selected network,
 * wallet, amount or notes. Compute ALL input shapes locally: neither shape nor
 * user data goes to the RPC or relayer. No simulation or quote request.
 */
export async function fetchStellarTransferFees(): Promise<StellarTransferFees> {
  const [{ rpc }, fees] = await Promise.all([
    import('@stellar/stellar-sdk'),
    import('@/vendor/stellar-fees'),
  ]);
  const settings = await fees.readStellarFeeSettings(new rpc.Server(STELLAR_TESTNET_RPC_URL, { timeout: 5 }));
  return Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    // prepareTransfer quotes min(2*n,5) outputs, including potential change.
    const resources = fees.stellarRelayResources(fees.STELLAR_RELAY_RESOURCE_TABLE, 'transfer', { n, m: Math.min(2 * n, 5) }, {
      keystoreRecord: true,
      contractRecipient: false,
    });
    return stellarTransferFeeFromResourceFee(fees.stellarRelayResourceFee(resources, settings).resourceFee);
  });
}
