import { Buffer } from 'buffer';
import { torFetchIfActive } from '@/services/tor-fetch';
import { STELLAR_TESTNET_CONTRACTS, STELLAR_TESTNET_NETWORK, STELLAR_TESTNET_RPC_URL } from '@/config/stellar-deployment';
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
  const server = stellarFeeServer(rpc);
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

function stellarFeeServer(rpc: typeof import('@stellar/stellar-sdk').rpc) {
  const server = new rpc.Server(STELLAR_TESTNET_RPC_URL);
  // Match the EVM gas-price feed's five-second transport deadline. The SDK's
  // rpc.Server ignores its timeout option, so bound both routes here instead.
  const send = torFetchIfActive() ?? fetch;
  (server as unknown as { httpClient: unknown }).httpClient = {
    async post(url: string, data: unknown) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await send(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Soroban RPC HTTP ${res.status}`);
        return { data: await res.json(), status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()) };
      } finally {
        // Keep the deadline active until the response body has also arrived.
        clearTimeout(timer);
      }
    },
  };
  return server;
}

/** Public asset configuration from a fixed neutral source, never the wallet. */
export async function fetchStellarDepositVettingFee(): Promise<number> {
  const { rpc, Account, BASE_FEE, Contract, StrKey, TransactionBuilder, nativeToScVal, scValToNative } = await import('@stellar/stellar-sdk');
  const transaction = new TransactionBuilder(new Account(StrKey.encodeEd25519PublicKey(Buffer.alloc(32)), '0'), {
    fee: BASE_FEE, networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase,
  }).addOperation(new Contract(STELLAR_TESTNET_CONTRACTS.poolContractId).call(
    'get_asset_config', nativeToScVal(STELLAR_TESTNET_CONTRACTS.nativeAssetContractId, { type: 'address' }),
  )).setTimeout(30).build();
  const simulation = await stellarFeeServer(rpc).simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation)) throw new Error('Stellar asset configuration unavailable');
  const config = scValToNative(simulation.result!.retval);
  const bps = Number(config.vetting_fee_bps);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('Invalid Stellar vetting fee');
  return bps;
}
