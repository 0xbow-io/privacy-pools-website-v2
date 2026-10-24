// Is the signing address an EOA or a contract wallet? Asked right before the
// unlock signature, because a contract wallet (Safe, Ambire, ...) answers with
// EIP-1271 data that the SDK refuses with "must be 65 bytes", so it unlocks with
// the passkey instead.
//
// The answer is ADVICE. The SDK's 65-byte check is the enforcement
// (services/signer-determinism.ts). So a failed read must not lock anyone out:
// on 2026-10-24 one failed eth_getCode on mainnet left a MetaMask user on
// "Could not verify the wallet type" with no way in.
//
// Order:
//   1. the app's public client for the chain (its transport already falls back
//      across our endpoints), tried twice;
//   2. the connected wallet's own provider, only when it is on the same chain.
//      Same question, about the user's own connected address, over the RPC the
//      wallet already uses, so it names nothing new;
//   3. the verdict the ahead-of-click probe settled for this address:chain;
//   4. nothing answered: a wallet that has no contract accounts goes on to the
//      signature, anything else gets a retry message.
//
// Pure: no react, no wagmi, so bun tests drive it directly.

import { contractWalletVerdict, type ContractWalletVerdict } from '@/services/signer-determinism';

export type CodeReader = {
  /** Short label for the log line. Never an endpoint. */
  source: 'app-rpc' | 'wallet-rpc';
  read: () => Promise<string | null | undefined>;
  /** Tries before the next reader. Default 1. */
  attempts?: number;
};

export type CodeRead = { verdict: ContractWalletVerdict; code: string | undefined; source: CodeReader['source'] };

export type CodeReadFailure = { source: CodeReader['source']; error: unknown };

/**
 * First reader that answers wins. A reader with `attempts` is retried first, so
 * a transient failure of the app RPC does not reach the wallet at all.
 */
export async function readWalletCode(
  readers: readonly CodeReader[],
  opts: { onFailure?: (failure: CodeReadFailure) => void } = {},
): Promise<CodeRead | null> {
  for (const reader of readers) {
    const attempts = Math.max(1, reader.attempts ?? 1);
    for (let i = 0; i < attempts; i += 1) {
      try {
        const raw = await reader.read();
        const code = typeof raw === 'string' ? raw : undefined;
        return { verdict: contractWalletVerdict(code), code, source: reader.source };
      } catch (error) {
        opts.onFailure?.({ source: reader.source, error });
      }
    }
  }
  return null;
}

type Eip1193Like = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

function isEip1193(p: unknown): p is Eip1193Like {
  return !!p && typeof p === 'object' && typeof (p as { request?: unknown }).request === 'function';
}

/**
 * eth_getCode through the connected wallet's provider. Refuses (throws) when the
 * wallet is on another chain, so its answer is never taken for the wrong chain.
 */
export function walletProviderCodeReader(
  getProvider: () => Promise<unknown>,
  address: string,
  chainId: number,
): CodeReader {
  return {
    source: 'wallet-rpc',
    read: async () => {
      const provider = await getProvider();
      if (!isEip1193(provider)) throw new Error('wallet provider unavailable');
      const walletChain = await provider.request({ method: 'eth_chainId' });
      const walletChainId = typeof walletChain === 'string' ? Number.parseInt(walletChain, 16)
        : typeof walletChain === 'number' ? walletChain : NaN;
      if (walletChainId !== chainId) throw new Error('wallet is on another chain');
      const code = await provider.request({ method: 'eth_getCode', params: [address, 'latest'] });
      if (code !== null && code !== undefined && typeof code !== 'string') throw new Error('wallet returned a non-string code');
      return code as string | null | undefined;
    },
  };
}

type CodeClient = { getCode: (args: { address: `0x${string}` }) => Promise<string | undefined> };

/** The app's public client first, then the wallet's own provider. */
export function unlockCodeReaders(
  publicClient: CodeClient | null | undefined,
  getWalletProvider: (() => Promise<unknown>) | null,
  address: string,
  chainId: number,
): CodeReader[] {
  const readers: CodeReader[] = [];
  if (publicClient) {
    readers.push({ source: 'app-rpc', attempts: 2, read: () => publicClient.getCode({ address: address as `0x${string}` }) });
  }
  if (getWalletProvider) readers.push(walletProviderCodeReader(getWalletProvider, address, chainId));
  return readers;
}

/**
 * Wallets whose accounts are always EOAs (an EIP-7702 delegation still signs
 * with the EOA key). MetaMask only, by its EIP-6963 id or its exact name: the
 * isMetaMask provider flag is set by many other wallets. Rabby is left out on
 * purpose, it can hold Safe accounts.
 */
export function isEoaOnlyWallet(connector: { id?: string | null; name?: string | null } | null | undefined): boolean {
  if (!connector) return false;
  const id = (connector.id ?? '').toLowerCase();
  const name = (connector.name ?? '').toLowerCase().trim();
  return id === 'io.metamask' || name === 'metamask';
}

export const WALLET_TYPE_UNVERIFIED_MESSAGE =
  'Could not check this wallet because a network request failed. Please try again.';

export type UnlockWalletKind =
  /** A read answered on this attempt. */
  | { kind: 'read'; smart: boolean; read: CodeRead }
  /** No read answered; the ahead probe's verdict for this address:chain. */
  | { kind: 'ahead'; smart: boolean }
  /** No verdict at all; go to the signature, the SDK's 65-byte check enforces. */
  | { kind: 'assume-eoa'; reason: 'feature-off' | 'eoa-only-wallet' }
  /** No verdict and a wallet that may be a contract: ask for a retry. */
  | { kind: 'refuse'; message: string };

export function decideUnlockWalletKind(input: {
  read: CodeRead | null;
  passkeyUnlockEnabled: boolean;
  /** `${address.toLowerCase()}:${chainId}` of this unlock. */
  key: string;
  ahead: { key: string; smart: boolean } | null | undefined;
  eoaOnlyWallet: boolean;
}): UnlockWalletKind {
  if (input.read) return { kind: 'read', smart: input.read.verdict === 'contract', read: input.read };
  // Feature off: no passkey to route a contract wallet to, so the probe is advice
  // only (the smart-wallet message needs a positive verdict anyway).
  if (!input.passkeyUnlockEnabled) return { kind: 'assume-eoa', reason: 'feature-off' };
  if (input.ahead && input.ahead.key === input.key) return { kind: 'ahead', smart: input.ahead.smart };
  if (input.eoaOnlyWallet) return { kind: 'assume-eoa', reason: 'eoa-only-wallet' };
  // Guessing "EOA" here could send a Safe to the signature prompt and a bare
  // 65-byte failure (codex on PR #36), so this one case still asks for a retry.
  return { kind: 'refuse', message: WALLET_TYPE_UNVERIFIED_MESSAGE };
}
