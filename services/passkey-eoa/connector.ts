// wagmi connector for the passkey EOA (native app only). Rules: see ./derivation.ts.
//
// Being a wagmi connector is what lets every existing flow use it unchanged:
// the SDK provider's EIP-712 derivation (useSignTypedData), deposits,
// approvals and keystore registration (useSendTransaction), and, with an
// imported account key as the identity, the payer side of a depositFor.
//
// The connector holds only the PUBLIC record (address + credential id). Every
// signing method prompts the passkey and derives, signs and zeroes inside the
// call (./signer.ts). Reads and the final broadcast go out through the app's
// own policed RPC transport, the same one the embedded wallet uses: the RPC
// sees this address as a sender, which is what a wallet's provider sees.

import {
  createPublicClient,
  hexToBigInt,
  hexToNumber,
  type Address,
  type Chain,
  type Hex,
  type TransactionSerializable,
  type Transport,
  type TypedDataDefinition,
} from 'viem';
import { createConnector } from 'wagmi';

import { createPasskeyEoaSigner } from './signer';
import type { PasskeyEoaRecord } from './store';
import type { PrfGrant } from './prf-source';

import { PASSKEY_EOA_CONNECTOR_ID } from './constants';

export { PASSKEY_EOA_CONNECTOR_ID };

// Public record of the signed-in passkey EOA (address + credential id only).
let activeRecord: PasskeyEoaRecord | null = null;
const listeners = new Set<(r: PasskeyEoaRecord | null) => void>();

export function setActivePasskeyEoa(record: PasskeyEoaRecord | null): void {
  activeRecord = record ? { address: record.address, credentialId: record.credentialId } : null;
  for (const l of listeners) l(activeRecord);
}

export function getActivePasskeyEoa(): PasskeyEoaRecord | null {
  return activeRecord;
}

function onActivePasskeyEoaChange(cb: (r: PasskeyEoaRecord | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

type RequestArgs = { method: string; params?: unknown };
type Provider = { request: (args: RequestArgs) => Promise<unknown> };

type RpcTx = {
  to?: Address | null;
  data?: Hex;
  value?: Hex;
  gas?: Hex;
  nonce?: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
};

class ProviderRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const big = (v?: Hex) => (v ? hexToBigInt(v) : undefined);

export function passkeyEoaConnector(params: {
  transportFor: (chainId: number) => Transport;
  requestPrf: (credentialId: string | null) => Promise<PrfGrant>;
}) {
  const { transportFor, requestPrf } = params;

  return createConnector<Provider>((config) => {
    function chainById(chainId: number): Chain {
      const chain = config.chains.find((c) => c.id === chainId);
      if (!chain) throw new Error('Unsupported network.');
      return chain;
    }

    function signerFor(record: PasskeyEoaRecord) {
      return createPasskeyEoaSigner(async () => (await requestPrf(record.credentialId)).prf, record.address);
    }

    async function prepareTx(chainId: number, from: Address, tx: RpcTx): Promise<TransactionSerializable> {
      const chain = chainById(chainId);
      const pub = createPublicClient({ chain, transport: transportFor(chainId) });
      const prepared = await pub.prepareTransactionRequest({
        account: from,
        chain,
        to: tx.to ?? undefined,
        data: tx.data,
        value: big(tx.value),
        gas: big(tx.gas),
        nonce: tx.nonce ? hexToNumber(tx.nonce) : undefined,
        ...(tx.gasPrice
          ? { gasPrice: big(tx.gasPrice) }
          : { maxFeePerGas: big(tx.maxFeePerGas), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas) }),
        parameters: ['fees', 'gas', 'nonce', 'type', 'chainId'],
      } as never) as unknown as Record<string, unknown>;
      const common = {
        chainId,
        to: (prepared.to as Address | undefined) ?? null,
        data: prepared.data as Hex | undefined,
        value: prepared.value as bigint | undefined,
        gas: prepared.gas as bigint,
        nonce: prepared.nonce as number,
      };
      if (prepared.type === 'legacy' || prepared.gasPrice !== undefined && prepared.maxFeePerGas === undefined) {
        return { ...common, type: 'legacy', gasPrice: prepared.gasPrice as bigint };
      }
      return {
        ...common,
        type: 'eip1559',
        maxFeePerGas: prepared.maxFeePerGas as bigint,
        maxPriorityFeePerGas: prepared.maxPriorityFeePerGas as bigint,
      };
    }

    function makeProvider(initialChainId: number): Provider {
      // The chain this provider reads, signs and broadcasts on; a switch moves it.
      let chainId = initialChainId;
      const request = async ({ method, params: rawParams }: RequestArgs): Promise<unknown> => {
        const p = (Array.isArray(rawParams) ? rawParams : []) as unknown[];
        const record = activeRecord;
        switch (method) {
          case 'eth_accounts':
          case 'eth_requestAccounts':
            return record ? [record.address] : [];
          case 'eth_chainId':
            return `0x${chainId.toString(16)}`;
          case 'wallet_switchEthereumChain': {
            const target = Number((p[0] as { chainId?: string })?.chainId);
            chainById(target);
            chainId = target;
            currentChainId = target;
            config.emitter.emit('change', { chainId: target });
            return null;
          }
          case 'eth_sign':
          case 'wallet_sendCalls':
          case 'wallet_getCapabilities':
            throw new ProviderRpcError(4200, 'Method not supported.');
          default:
            break;
        }
        const isSigning = method === 'personal_sign' || method === 'eth_signTypedData_v4'
          || method === 'eth_sendTransaction' || method === 'eth_signTransaction';
        if (isSigning) {
          if (!record) throw new ProviderRpcError(4100, 'Sign in with your passkey first.');
          const signer = signerFor(record);
          if (method === 'personal_sign') {
            const [data, addr] = p as [Hex, Address];
            if (addr && addr.toLowerCase() !== record.address.toLowerCase()) throw new ProviderRpcError(4100, 'Unknown account.');
            return signer.signMessage(data);
          }
          if (method === 'eth_signTypedData_v4') {
            const [addr, json] = p as [Address, string | TypedDataDefinition];
            if (addr && addr.toLowerCase() !== record.address.toLowerCase()) throw new ProviderRpcError(4100, 'Unknown account.');
            const typed = (typeof json === 'string' ? JSON.parse(json) : json) as TypedDataDefinition;
            return signer.signTypedData(typed);
          }
          const [tx] = p as [RpcTx & { from?: Address }];
          if (tx?.from && tx.from.toLowerCase() !== record.address.toLowerCase()) throw new ProviderRpcError(4100, 'Unknown account.');
          // Prepare first so the passkey prompt is the last step before broadcast.
          // One chain for the whole request: a switch mid-prompt must not reroute it.
          const txChainId = chainId;
          const serializable = await prepareTx(txChainId, record.address, tx ?? {});
          const signed = await signer.signTransaction(serializable);
          if (method === 'eth_signTransaction') return signed;
          const pub = createPublicClient({ chain: chainById(txChainId), transport: transportFor(txChainId) });
          return pub.sendRawTransaction({ serializedTransaction: signed });
        }
        // Reads (eth_call, eth_getBalance, ...) go to the app's policed RPC.
        const pub = createPublicClient({ chain: chainById(chainId), transport: transportFor(chainId) });
        return pub.request({ method, params: rawParams } as never);
      };
      return { request };
    }

    let currentChainId = config.chains[0].id;
    let subscribed = false;

    return {
      id: PASSKEY_EOA_CONNECTOR_ID,
      name: 'Passkey',
      type: 'passkey-eoa',

      async setup() {
        if (subscribed) return;
        subscribed = true;
        onActivePasskeyEoaChange((r) => {
          if (r) config.emitter.emit('change', { accounts: [r.address] });
          else config.emitter.emit('disconnect');
        });
      },

      async connect<withCapabilities extends boolean = false>(
        connectParams?: { chainId?: number; isReconnecting?: boolean; withCapabilities?: withCapabilities | boolean },
      ) {
        if (!activeRecord) throw new Error('Sign in with your passkey first.');
        currentChainId = connectParams?.chainId ?? currentChainId;
        return {
          accounts: [activeRecord.address] as readonly Address[] as never,
          chainId: currentChainId,
        };
      },

      async disconnect() {
        // The listener from setup() stays: wagmi runs setup once per config,
        // and a later sign-in must still reach it. The address stays
        // stored (public), so the next sign-in needs no extra prompt.
        activeRecord = null;
      },

      async getAccounts() {
        return activeRecord ? [activeRecord.address] : [];
      },

      async getChainId() {
        return currentChainId;
      },

      async getProvider({ chainId } = {}) {
        return makeProvider(chainId ?? currentChainId);
      },

      async isAuthorized() {
        return activeRecord !== null;
      },

      async switchChain({ chainId }) {
        const chain = chainById(chainId);
        currentChainId = chainId;
        config.emitter.emit('change', { chainId });
        return chain;
      },

      onAccountsChanged() {},
      onChainChanged(chainId) {
        currentChainId = Number(chainId);
      },
      onDisconnect() {
        activeRecord = null;
      },
    };
  });
}
