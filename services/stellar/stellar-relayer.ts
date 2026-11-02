/**
 * Client for the v2 relayer's Stellar routes (v2-monorepo packages/relayer/relayer), a copy of
 * v2.0's StellarRelayerInteractor. Temporary: the vendored SDK (c81ba9d5) still speaks the old
 * reference relayer's /api/v1/relayer/* protocol. Delete once the SDK is re-vendored with v2.0's.
 *
 * Only relayed withdrawals exist on Stellar. The quote's routing (`feeCommitment.data`) is
 * checked against the user's recipient and fee by the SDK's withdraw builder before proving.
 */
import type {
  Hex,
  IRelayerInteractor,
  RelayerInfo,
  StellarAddress,
  WithdrawalQuoteParams,
  WithdrawalRelayerQuote,
  WithdrawalRelayParams,
} from '@privacy-pools-v2/stellar-sdk';

import { STELLAR_RELAYER_CHAIN_ID, STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import type { StellarSdk } from '@/services/stellar/stellar-runtime';
import { routedFetch } from '@/services/tor-fetch';

const TIMEOUT_MS = 90_000;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await routedFetch('relayer')(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: string | string[]; error?: string };
    if (!res.ok) throw new Error([json.message ?? json.error ?? `relayer ${res.status}`].flat().join('; '));
    return json;
  } finally {
    clearTimeout(timer);
  }
}

const bytes32 = (v: bigint) => v.toString(16).padStart(64, '0');

/** Same packing as the SDK's StellarProofService.formatForChain. */
function formatProof(proof: { pi_a: Hex[]; pi_b: Hex[][]; pi_c: Hex[] }) {
  const g1 = (p: Hex[]) => `0x${bytes32(BigInt(p[0]))}${bytes32(BigInt(p[1]))}` as Hex;
  const b = proof.pi_b;
  return {
    a: g1(proof.pi_a),
    b: `0x${bytes32(BigInt(b[0][1]))}${bytes32(BigInt(b[0][0]))}${bytes32(BigInt(b[1][1]))}${bytes32(BigInt(b[1][0]))}` as Hex,
    c: g1(proof.pi_c),
  };
}

export function createStellarRelayer(
  sdk: StellarSdk,
  config: { url: string; relayerAddress: string },
): IRelayerInteractor<StellarAddress> {
  const base = `${config.url}/v1`;
  const path = `stellar/${STELLAR_RELAYER_CHAIN_ID}`;
  const info: RelayerInfo<StellarAddress> = {
    url: config.url,
    name: 'Stellar testnet relayer',
    chainId: STELLAR_RELAYER_CHAIN_ID,
    chainType: 'stellar',
    status: 'active',
    address: config.relayerAddress,
    // The relay contract is the transact processor.
    processorAddress: STELLAR_TESTNET_CONTRACTS.relayContractId,
  };

  const impl: Partial<IRelayerInteractor<StellarAddress>> = {
    async getRelayers() {
      return [info];
    },

    async getWithdrawalQuote(relayer, params: WithdrawalQuoteParams<StellarAddress>): Promise<WithdrawalRelayerQuote<StellarAddress>> {
      if (params.extraGas) throw new sdk.RelayerRequestFailed('extraGas is not supported on Stellar');
      const quote = await postJson<Omit<WithdrawalRelayerQuote<StellarAddress>, 'txCost' | 'gasPrice'>>(
        `${base}/quote/${path}/receive`,
        { amount: BigInt(params.amount).toString(), asset: params.asset, recipient: params.recipient, commit: true },
      );
      if (!quote.feeCommitment) throw new sdk.RelayerRequestFailed('The relayer returned no fee commitment');
      return { ...quote, txCost: '0', gasPrice: '0', feeCommitment: { ...quote.feeCommitment, extraGas: false } };
    },

    async relayWithdrawal(relayer, params: WithdrawalRelayParams<StellarAddress>): Promise<Hex> {
      sdk.assertFeeCommitmentLive(params.signedFeeCommitment.expiration);
      const n = params.inputNullifierNumber;
      const m = params.outputCommitmentNumber;
      const res = await postJson<{ txHash?: string; error?: string }>(`${base}/relay/${path}/withdrawal`, {
        proof: { ...formatProof(params.proof.proof), publicSignals: params.proof.publicSignals.slice(0, n + m + 6) },
        inputNullifierNumber: n,
        outputCommitmentNumber: m,
        noteData: params.noteData,
        signedFeeCommitment: params.signedFeeCommitment,
      }).catch((error: unknown) => {
        throw new sdk.RelayerRejected(error instanceof Error ? error.message : String(error));
      });
      if (res.error || !res.txHash) throw new sdk.RelayerRejected(res.error ?? 'The relayer rejected the withdrawal');
      return res.txHash as Hex;
    },
  };

  return new Proxy(impl as IRelayerInteractor<StellarAddress>, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (prop === 'then') return undefined;
      return () => {
        throw new sdk.RelayerRequestFailed(`Not supported by the Stellar relayer (${String(prop)})`);
      };
    },
  });
}
