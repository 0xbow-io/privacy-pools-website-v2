/**
 * Client for the v2 relayer's Stellar routes (v2-monorepo packages/relayer/relayer), a copy of
 * v2.0's StellarRelayerInteractor (packages/stellar-sdk, 8abfc67f). Temporary: the vendored SDK
 * (c81ba9d5) still speaks the old reference relayer's /api/v1/relayer/* protocol. Delete once the
 * SDK is re-vendored with v2.0's interactor.
 *
 * Withdrawals and private transfers. A withdrawal quote's
 * routing (`feeCommitment.data`) is checked against the user's recipient and fee by the SDK's
 * withdraw builder before proving. A relayed transfer's only public outflow is the fee
 * (`amountOut == feeAmount`, paid to the relayer as the pool's gated processor).
 */
import type {
  Hex,
  IRelayerInteractor,
  RelayerInfo,
  StellarAddress,
  TransferQuoteParams,
  TransferRelayerQuote,
  TransferRelayParams,
  WithdrawalQuoteParams,
  WithdrawalRelayerQuote,
  WithdrawalRelayParams,
} from '@privacy-pools-v2/stellar-sdk';

import { STELLAR_RELAYER_CHAIN_ID, STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import type { StellarRpcInteractor, StellarSdk } from '@/services/stellar/stellar-runtime';

const TIMEOUT_MS = 90_000;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
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

/**
 * Confirms a relayed transfer from bulk pool events instead of asking the RPC about the
 * relayer's tx hash (which would link this client to it). `mark` runs right before the proof is
 * handed over; `relayed` gets the hash with the proof's spent nullifiers and that cursor.
 */
export interface StellarRelayedSpendHooks {
  mark(): Promise<Hex>;
  relayed(txHash: Hex, spentNullifiers: Hex[], fromCursor: Hex): void;
}

/** What the SDK gets instead of a pool `transact` built from the user's account while relaying. */
export const RELAYED_TRANSACT_PLACEHOLDER = '';

type Receipt = Awaited<ReturnType<StellarRpcInteractor['waitForTransactionReceipt']>>;

/**
 * The session's RPC for relayed flows (`relaying()` is true while a relayer is handed to the session):
 * - A simulated pool `transact` from the user's account would show the RPC that account with the
 *   nullifiers the relayer then spends. The SDK builds a proof's transact locally (unsimulated); any
 *   simulated transact build while relaying is still skipped, since the relayer builds its own tx.
 * - A relayed tx's receipt comes from `confirmRelayed` (pool events by spent nullifiers), never from
 *   `getTransaction(hash)`; while relaying, a hash it does not know is refused.
 */
export function relayAwareRpc<T extends Pick<StellarRpcInteractor, 'buildTransaction' | 'waitForTransactionReceipt'>>(
  rpc: T,
  poolContractId: string,
  hooks: { relaying(): boolean; confirmRelayed(hash: Hex): Promise<Receipt> | null },
): T {
  return new Proxy(rpc, {
    get: (target, prop) => {
      if (prop === 'buildTransaction') {
        const build: StellarRpcInteractor['buildTransaction'] = target.buildTransaction.bind(target);
        return async (...args: Parameters<StellarRpcInteractor['buildTransaction']>) => {
          const [contractId, method] = args;
          if (hooks.relaying() && contractId === poolContractId && method === 'transact') return RELAYED_TRANSACT_PLACEHOLDER;
          return build(...args);
        };
      }
      if (prop === 'waitForTransactionReceipt') {
        return async (hash: Hex) => {
          const confirmed = hooks.confirmRelayed(hash);
          if (confirmed) return confirmed;
          if (hooks.relaying()) throw new Error('Refusing to look up a relayed transaction by its hash.');
          return target.waitForTransactionReceipt(hash);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The proof's leading `inputs` public signals are the spent nullifiers, as 32-byte hex. */
export function spentNullifiersOf(publicSignals: readonly (string | bigint)[], inputs: number): Hex[] {
  return publicSignals.slice(0, inputs).map((s) => `0x${BigInt(s).toString(16).padStart(64, '0')}` as Hex);
}

export function createStellarRelayer(
  sdk: StellarSdk,
  config: { url: string; relayerAddress: string; relayedSpends?: StellarRelayedSpendHooks },
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
        { amount: BigInt(params.amount).toString(), asset: params.asset, recipient: params.recipient, commit: true, ...(params.shape && { shape: params.shape }) },
      );
      if (!quote.feeCommitment) throw new sdk.RelayerRequestFailed('The relayer returned no fee commitment');
      return { ...quote, txCost: '0', gasPrice: '0', feeCommitment: { ...quote.feeCommitment, extraGas: false } };
    },

    async getTransferQuote(relayer, params: TransferQuoteParams<StellarAddress>): Promise<TransferRelayerQuote<StellarAddress>> {
      const quote = await postJson<{
        feeAmount: string;
        txCost: string;
        gasPrice: string;
        feeCommitment?: TransferRelayerQuote<StellarAddress>['feeCommitment'];
      }>(`${base}/quote/${path}/transfer`, { asset: params.asset, commit: true, ...(params.shape && { shape: params.shape }) }).catch((error: unknown) => {
        throw new sdk.RelayerRequestFailed(error instanceof Error ? error.message : String(error));
      });
      if (!quote.feeCommitment) throw new sdk.RelayerRequestFailed('The relayer returned no fee commitment');
      return { txCost: quote.txCost, gasPrice: quote.gasPrice, feeAmount: quote.feeAmount, feeCommitment: quote.feeCommitment };
    },

    async relayTransfer(relayer, params: TransferRelayParams<StellarAddress>): Promise<Hex> {
      sdk.assertFeeCommitmentLive(params.signedFeeCommitment.expiration);
      const n = params.inputNullifierNumber;
      const m = params.outputCommitmentNumber;
      const hooks = config.relayedSpends;
      const fromCursor = hooks ? await hooks.mark() : undefined;
      const res = await postJson<{ txHash?: string; error?: string }>(`${base}/relay/${path}/transfer`, {
        proof: { ...formatProof(params.proof.proof), publicSignals: params.proof.publicSignals.slice(0, n + m + 6) },
        inputNullifierNumber: n,
        outputCommitmentNumber: m,
        noteData: params.noteData,
        signedFeeCommitment: params.signedFeeCommitment,
      }).catch((error: unknown) => {
        throw new sdk.RelayerRejected(error instanceof Error ? error.message : String(error));
      });
      if (res.error || !res.txHash) throw new sdk.RelayerRejected(res.error ?? 'The relayer rejected the transfer');
      if (hooks && fromCursor !== undefined) hooks.relayed(res.txHash as Hex, spentNullifiersOf(params.proof.publicSignals, n), fromCursor);
      return res.txHash as Hex;
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
