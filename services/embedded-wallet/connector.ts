import { policedHttp } from '@/services/egress-transport';
// A wagmi connector that exposes the embedded wallet as a first-class
// connected account. This is the integration keystone: because the embedded
// account is a wagmi connector, every existing ppv2 flow — useAccount,
// useSignTypedData (privacy-pools secret derivation), useSendTransaction
// (deposits / approvals / keystore registration) — works unchanged, and with
// zero wallet popups (the EOA signs locally).
//
// The connector reads its active key from an in-memory holder set by the
// embedded-wallet React provider after create/unlock. The private key is never
// persisted in plaintext (see store.ts) and is cleared on disconnect.

import {
  type Address,
  type Chain,
  type Hex,
  createWalletClient,
  createPublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createConnector } from 'wagmi';

export const EMBEDDED_CONNECTOR_ID = 'pools-embedded';

interface ActiveWallet {
  privateKey: Hex;
  address: Address;
}

// Module-level holder. Set by the embedded-wallet provider before calling
// wagmi connect({ connector }). Cleared on disconnect.
let activeWallet: ActiveWallet | null = null;
const listeners = new Set<(w: ActiveWallet | null) => void>();

export function setActiveEmbeddedWallet(privateKey: Hex): Address {
  const address = privateKeyToAccount(privateKey).address;
  activeWallet = { privateKey, address };
  for (const l of listeners) l(activeWallet);
  return address;
}

export function clearActiveEmbeddedWallet(): void {
  activeWallet = null;
  for (const l of listeners) l(null);
}

export function getActiveEmbeddedWallet(): ActiveWallet | null {
  return activeWallet;
}

export function onActiveWalletChange(cb: (w: ActiveWallet | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

type RequestArgs = { method: string; params?: unknown };
type Provider = { request: (args: RequestArgs) => Promise<unknown> };

/**
 * Build the embedded wagmi connector. `transports` maps chainId → RPC URL so
 * the local wallet client can broadcast.
 */
export function embeddedConnector(params: { rpcUrls: Record<number, string> }) {
  const { rpcUrls } = params;

  return createConnector<Provider>((config) => {
    function chainById(chainId: number): Chain {
      const chain = config.chains.find((c) => c.id === chainId);
      if (!chain) throw new Error(`Unsupported chainId ${chainId}`);
      return chain;
    }

    function rpcFor(chainId: number): string {
      const url = rpcUrls[chainId];
      if (!url) throw new Error(`No RPC configured for chainId ${chainId}`);
      return url;
    }

    function makeProvider(chainId: number): Provider {
      const request = async ({ method, params }: RequestArgs): Promise<unknown> => {
        if (!activeWallet) throw new Error('Embedded wallet is locked');
        const p = (params ?? []) as any[];
        const account = privateKeyToAccount(activeWallet.privateKey);
        const chain = chainById(chainId);
        const wallet = createWalletClient({ account, chain, transport: policedHttp(rpcFor(chainId)) });
        const pub = createPublicClient({ chain, transport: policedHttp(rpcFor(chainId)) });

        switch (method) {
          case 'eth_accounts':
          case 'eth_requestAccounts':
            return [account.address];
          case 'eth_chainId':
            return `0x${chainId.toString(16)}`;
          case 'personal_sign': {
            const [data] = p as [Hex, Address];
            return account.signMessage({ message: { raw: data } });
          }
          case 'eth_signTypedData_v4': {
            const [, json] = p as [Address, string];
            const typed = typeof json === 'string' ? JSON.parse(json) : json;
            return account.signTypedData(typed);
          }
          case 'eth_sendTransaction': {
            const [tx] = p as [
              { to?: Address; from?: Address; data?: Hex; value?: Hex; gas?: Hex },
            ];
            return wallet.sendTransaction({
              account,
              chain,
              to: tx.to ?? null,
              data: tx.data,
              value: tx.value ? BigInt(tx.value) : undefined,
              gas: tx.gas ? BigInt(tx.gas) : undefined,
            });
          }
          case 'eth_signTransaction': {
            const [tx] = p as [{ to?: Address; data?: Hex; value?: Hex; gas?: Hex }];
            return wallet.signTransaction({
              account,
              chain,
              to: tx.to ?? null,
              data: tx.data,
              value: tx.value ? BigInt(tx.value) : undefined,
              gas: tx.gas ? BigInt(tx.gas) : undefined,
            } as any);
          }
          default:
            // Reads (eth_call, eth_getBalance, …) go straight to the RPC.
            return pub.request({ method, params } as any);
        }
      };
      return { request };
    }

    let currentChainId = config.chains[0].id;
    let unsubscribe: (() => void) | null = null;

    return {
      id: EMBEDDED_CONNECTOR_ID,
      name: 'Privacy Pools Wallet',
      type: 'embedded',

      async setup() {
        // Mirror external key changes into wagmi's account state.
        unsubscribe = onActiveWalletChange((w) => {
          if (w) config.emitter.emit('change', { accounts: [w.address] });
          else config.emitter.emit('disconnect');
        });
      },

      // We never report EIP-5792 capabilities, so connect always returns plain
      // addresses. `accounts` is cast to satisfy wagmi's `withCapabilities`
      // conditional return (which TS can't narrow from a concrete value).
      async connect<withCapabilities extends boolean = false>(
        params?: { chainId?: number; isReconnecting?: boolean; withCapabilities?: withCapabilities | boolean }
      ) {
        if (!activeWallet) throw new Error('Embedded wallet is locked. Create or unlock first');
        currentChainId = params?.chainId ?? currentChainId;
        return {
          accounts: [activeWallet.address] as readonly Address[] as any,
          chainId: currentChainId,
        };
      },

      async disconnect() {
        unsubscribe?.();
        unsubscribe = null;
        // Sign-out must drop the in-memory key. wagmi calls disconnect()
        // directly (not onDisconnect), so clear here too or isAuthorized()
        // stays true and the connector keeps signing with the old key.
        clearActiveEmbeddedWallet();
      },

      async getAccounts() {
        return activeWallet ? [activeWallet.address] : [];
      },

      async getChainId() {
        return currentChainId;
      },

      async getProvider({ chainId } = {}) {
        return makeProvider(chainId ?? currentChainId);
      },

      async isAuthorized() {
        return activeWallet !== null;
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
        clearActiveEmbeddedWallet();
      },
    };
  });
}
