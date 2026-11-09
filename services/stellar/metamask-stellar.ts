/**
 * MetaMask as a Stellar signer, behind the same bare-value contract the
 * Stellar SDK signs through (getAddress / getNetworkPassphrase / signTransaction,
 * errors thrown, not returned), so nothing downstream knows which wallet it has.
 *
 * `@metamask/connect-stellar` (0.3.0) only speaks Stellar MAINNET (stellar:pubnet):
 * its adapter throws "Unknown network passphrase" for any other passphrase, and the
 * extension refuses a testnet session. The app is on Testnet, so a connected MetaMask
 * reads as a network mismatch and signing says so up front, in words, instead of
 * surfacing the SDK's throw. When the app or MetaMask gains a matching network the
 * passphrases agree and nothing here changes.
 *
 * Follows the wallet through the adapter's own events (no polling).
 *
 * Pure module (the adapter is injected, only its type is imported) so it is bun-testable.
 */
import type { MetaMaskStellarAdapter } from '@metamask/connect-stellar';

export type MetaMaskStellarApi = Pick<
  MetaMaskStellarAdapter,
  'requestAccess' | 'getAddress' | 'getNetwork' | 'signTransaction' | 'isAllowed' | 'disconnect' | 'on' | 'off'
>;

export interface MetaMaskSigner {
  getAddress(): Promise<string>;
  getNetworkPassphrase(): Promise<string>;
  signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
}

/** The sentence the UI shows when MetaMask's network is not the app's. */
export function metaMaskNetworkMismatchMessage(appNetworkName: string = 'Stellar Testnet'): string {
  return `MetaMask supports Stellar mainnet only, this app is on ${appNetworkName}.`;
}

export function isMetaMaskNetworkMismatch(message: string): boolean {
  return /MetaMask supports Stellar mainnet only|Unknown network passphrase/i.test(message);
}

function failure(error: { message?: string } | undefined, fallback: string): Error {
  return new Error(error?.message || fallback);
}

export function metaMaskSigner(adapter: MetaMaskStellarApi, appNetworkName?: string): MetaMaskSigner {
  return {
    async getAddress() {
      const result = await adapter.getAddress();
      if (result.error) throw failure(result.error, 'MetaMask is locked or not connected');
      if (!result.address) throw new Error('MetaMask is locked or not connected');
      return result.address;
    },
    async getNetworkPassphrase() {
      const result = await adapter.getNetwork();
      if (result.error) throw failure(result.error, 'MetaMask is locked or not connected');
      return result.networkPassphrase;
    },
    async signTransaction(xdr, opts) {
      const network = await adapter.getNetwork();
      if (!network.error && network.networkPassphrase !== opts.networkPassphrase) {
        throw new Error(metaMaskNetworkMismatchMessage(appNetworkName));
      }
      let result: Awaited<ReturnType<MetaMaskStellarApi['signTransaction']>>;
      try {
        result = await adapter.signTransaction(xdr, { networkPassphrase: opts.networkPassphrase });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        throw isMetaMaskNetworkMismatch(message) ? new Error(metaMaskNetworkMismatchMessage(appNetworkName)) : caught;
      }
      if (result.error) throw failure(result.error, 'MetaMask could not sign this transaction');
      return result.signedTxXdr;
    },
  };
}

export interface MetaMaskAccount {
  address: string | null;
  passphrase: string | null;
}

/**
 * Reports account and network switches from the adapter's events. A cleared account
 * or a disconnect is `revoked`; a later account event reconnects.
 */
export function watchMetaMask(
  adapter: Pick<MetaMaskStellarApi, 'on' | 'off'>,
  current: MetaMaskAccount,
  on: { change: (account: { address: string; passphrase: string | null }) => void; revoked: () => void },
): { stop: () => void } {
  let { address, passphrase } = current;

  const onAccount = (data: unknown) => {
    if (typeof data === 'string' && data) {
      if (data === address) return;
      address = data;
      on.change({ address, passphrase });
    } else if (address !== null) {
      address = null;
      on.revoked();
    }
  };
  const onNetwork = (data: unknown) => {
    const next = (data as { networkPassphrase?: unknown } | null)?.networkPassphrase;
    if (typeof next !== 'string' || !next || next === passphrase) return;
    passphrase = next;
    if (address !== null) on.change({ address, passphrase });
  };
  const onDisconnect = () => {
    if (address === null) return;
    address = null;
    on.revoked();
  };

  adapter.on('accountsChanged', onAccount);
  adapter.on('networkChanged', onNetwork);
  adapter.on('disconnect', onDisconnect);
  return {
    stop: () => {
      adapter.off('accountsChanged', onAccount);
      adapter.off('networkChanged', onNetwork);
      adapter.off('disconnect', onDisconnect);
    },
  };
}
