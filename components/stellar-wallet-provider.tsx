/**
 * Stellar wallet provider: Varial or MetaMask connection state for the Stellar chain.
 *
 * The Stellar counterpart of components/sui-provider.tsx (dapp-kit's
 * `WalletProvider autoConnect`): holds the connected account, reconnects
 * silently only when this browser connected before (to the wallet it used, remembered in
 * ppv2_stellar_wallet), and follows the wallet's
 * own account and network switches (services/stellar/varial-watch.ts, metamask-stellar.ts). It exposes the account as a
 * `StellarWalletProvider`, the bare-value signer contract the Stellar SDK's
 * `FreighterWalletInteractor` signs through (network check included).
 *
 * Local development only: `EXPO_PUBLIC_STELLAR_DEV_SECRET` swaps Freighter for
 * a testnet burner keypair, so flows can be driven in a browser without the
 * extension. It is refused on any non-local host and must never hold a key
 * with real value (a public env var is inlined into the bundle).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { StellarWalletProvider as StellarSigner } from '@privacy-pools-v2/stellar-sdk';

import { STELLAR_TESTNET_NETWORK } from '@/config/stellar-deployment';
import { Platform } from 'react-native';
import { watchVarial, type VarialAccount } from '@/services/stellar/varial-watch';
import { metaMaskNetworkMismatchMessage, metaMaskSigner, watchMetaMask, type MetaMaskStellarApi } from '@/services/stellar/metamask-stellar';
import {
  readStellarWalletKind,
  STELLAR_WALLET_NAMES,
  writeStellarWalletKind,
  type StellarWalletKind,
} from '@/services/stellar/stellar-wallet-choice';
import { setStellarCopyWallet } from '@/services/stellar/stellar-copy';

type VarialApi = typeof import('@stellar/varial-sdk');

const CONNECTED_FLAG_KEY = 'ppv2_stellar_connected';
const WATCH_INTERVAL_MS = 3000;

export type StellarWalletStatus = 'disconnected' | 'connecting' | 'connected';

export interface StellarWalletContextValue {
  address: string | null;
  status: StellarWalletStatus;
  isConnected: boolean;
  /** The wallet's active network passphrase, when known. */
  networkPassphrase: string | null;
  /** Connected, but the wallet is on a different network than the app's. */
  networkMismatch: boolean;
  /** What to tell the user about a network mismatch; null when there is none. */
  networkMismatchMessage: string | null;
  /** Whether a Stellar wallet (Freighter, MetaMask, or the dev burner) is available at all. */
  isAvailable: boolean;
  /** Per wallet: the extension was found. Freighter's is also true for the dev burner. */
  walletAvailable: Record<StellarWalletKind, boolean>;
  /** The connected wallet, else the one used last (Freighter when none). */
  walletKind: StellarWalletKind;
  /**
   * The availability probe has finished. Until then `isAvailable: false`
   * means "not known yet", not "not installed".
   */
  availabilityChecked: boolean;
  /** Dev burner keypair in use instead of a wallet. */
  isDevBurner: boolean;
  error: string | null;
  /** `kind` defaults to the wallet used last, else the one that is installed. */
  connect: (kind?: StellarWalletKind) => Promise<string | null>;
  /**
   * Interactive connect that also says why it failed (for a toast), and
   * `notice` when it connected but cannot sign for this app (network mismatch).
   */
  connectDetailed: (kind?: StellarWalletKind) => Promise<{ address: string | null; error: string | null; notice: string | null }>;
  cancelConnect: () => void;
  disconnect: () => void;
  /** Signer for the SDK; null until connected. */
  signer: StellarSigner | null;
}

const StellarWalletContext = createContext<StellarWalletContextValue | null>(null);

let varialPromise: Promise<VarialApi> | null = null;
function loadVarial(): Promise<VarialApi> {
  varialPromise ??= import('@stellar/varial-sdk');
  return varialPromise;
}

type MetaMaskModule = typeof import('@metamask/connect-stellar');
let metaMaskPromise: Promise<MetaMaskModule> | null = null;
function loadMetaMask(): Promise<MetaMaskModule> {
  metaMaskPromise ??= import('@metamask/connect-stellar');
  return metaMaskPromise;
}

/**
 * The adapter restores a MetaMask session in its constructor, so make it only for a
 * browser that chose MetaMask (silent reconnect) or on an explicit connect.
 */
let metaMaskAdapter: MetaMaskStellarApi | null = null;
async function getMetaMaskAdapter(): Promise<MetaMaskStellarApi> {
  const mod = await loadMetaMask();
  metaMaskAdapter ??= new mod.MetaMaskStellarAdapter();
  return metaMaskAdapter;
}

async function isMetaMaskInstalled(): Promise<boolean> {
  try {
    return await (await loadMetaMask()).MetaMaskStellarAdapter.isMetaMaskAvailable();
  } catch {
    return false;
  }
}

/**
 * The SDK also answers "not connected" when Varial does not reply within 2 s (a cold
 * extension), so ask once more before calling it not installed.
 */
async function isVarialInstalled(api: VarialApi): Promise<boolean> {
  if ((await api.isConnected()).isConnected) return true;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return (await api.isConnected()).isConnected;
}

function readFlag(): boolean {
  try {
    return globalThis.localStorage?.getItem(CONNECTED_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function writeFlag(on: boolean) {
  try {
    if (on) globalThis.localStorage?.setItem(CONNECTED_FLAG_KEY, '1');
    else globalThis.localStorage?.removeItem(CONNECTED_FLAG_KEY);
  } catch {
    // storage unavailable: autoconnect simply won't happen
  }
}

function isLocalHost(): boolean {
  const host = globalThis.location?.hostname ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
}

const DEV_SECRET = (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_STELLAR_DEV_SECRET) || '';

/** Adapt Varial's returned errors to the Stellar SDK's throwing signer contract. */
function varialSigner(api: VarialApi): StellarSigner {
  return {
    async getAddress() {
      const result = await api.getAddress();
      if (result.error) throw new Error(result.error.message);
      if (!result.address) throw new Error('Varial is locked or not connected');
      return result.address;
    },
    async getNetworkPassphrase() {
      const result = await api.getNetworkDetails();
      if (result.error) throw new Error(result.error.message);
      return result.networkPassphrase;
    },
    async signTransaction(xdr, opts) {
      const result = await api.signTransaction(xdr, { networkPassphrase: opts.networkPassphrase });
      if (result.error) throw new Error(result.error.message);
      return result.signedTxXdr;
    },
  };
}

async function devBurnerSigner(secret: string): Promise<{ address: string; signer: StellarSigner }> {
  const { Keypair, TransactionBuilder } = await import('@stellar/stellar-sdk');
  const keypair = Keypair.fromSecret(secret);
  const passphrase = STELLAR_TESTNET_NETWORK.networkPassphrase;
  return {
    address: keypair.publicKey(),
    signer: {
      async getAddress() {
        return keypair.publicKey();
      },
      async getNetworkPassphrase() {
        return passphrase;
      },
      async signTransaction(xdr, opts) {
        const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
        tx.sign(keypair);
        return tx.toXDR();
      },
    },
  };
}

export function StellarWalletProvider({ children }: { children: React.ReactNode }) {
  const isDevBurner = DEV_SECRET !== '' && isLocalHost();
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<StellarWalletStatus>('disconnected');
  const [networkPassphrase, setNetworkPassphrase] = useState<string | null>(null);
  const [freighterAvailable, setFreighterAvailable] = useState(isDevBurner);
  const [metaMaskAvailable, setMetaMaskAvailable] = useState(false);
  const [walletKind, setWalletKind] = useState<StellarWalletKind>('freighter');
  const [availabilityChecked, setAvailabilityChecked] = useState(isDevBurner);
  const lastErrorRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signer, setSigner] = useState<StellarSigner | null>(null);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const connectedAddressRef = useRef<string | null>(null);
  const watcherRef = useRef<{ stop: () => void } | null>(null);

  const stopWatching = useCallback(() => {
    watcherRef.current?.stop();
    watcherRef.current = null;
  }, []);

  const adopt = useCallback((next: { address: string; passphrase: string | null; signer: StellarSigner }) => {
    connectedAddressRef.current = next.address;
    setAddress(next.address);
    setNetworkPassphrase(next.passphrase);
    setSigner(next.signer);
    setStatus('connected');
    setError(null);
  }, []);

  const drop = useCallback(() => {
    connectedAddressRef.current = null;
    setAddress(null);
    setNetworkPassphrase(null);
    setSigner(null);
    setStatus('disconnected');
  }, []);

  const reset = useCallback(() => {
    generationRef.current++;
    busyRef.current = false;
    stopWatching();
    drop();
  }, [drop, stopWatching]);

  // Preserve passive recovery from a locked wallet and account/network changes.
  const watch = useCallback(async (current: VarialAccount, generation: number) => {
    if (isDevBurner) return;
    stopWatching();
    const api = await loadVarial();
    if (generation !== generationRef.current) return;
    const signer = varialSigner(api);
    watcherRef.current = watchVarial(api, current, {
      change: (next) => {
        if (generation !== generationRef.current) return;
        adopt({ ...next, signer });
      },
      revoked: () => { if (generation === generationRef.current) drop(); },
    }, WATCH_INTERVAL_MS);
  }, [adopt, drop, isDevBurner, stopWatching]);

  // Follows MetaMask's account and network through the adapter's events (no polling).
  const watchMetaMaskWallet = useCallback((adapter: MetaMaskStellarApi, current: { address: string | null; passphrase: string | null }, generation: number) => {
    stopWatching();
    const signer = metaMaskSigner(adapter);
    watcherRef.current = watchMetaMask(adapter, current, {
      change: (next) => { if (generation === generationRef.current) adopt({ ...next, signer }); },
      revoked: () => { if (generation === generationRef.current) drop(); },
    });
  }, [adopt, drop, stopWatching]);

  const connectedKindRef = useRef<StellarWalletKind>('freighter');
  const noticeRef = useRef<string | null>(null);

  const connectMetaMask = useCallback(async (interactive: boolean, generation: number): Promise<string | null> => {
    const active = () => generation === generationRef.current;
    const installed = await isMetaMaskInstalled();
    if (!active()) return null;
    setMetaMaskAvailable(installed);
    if (!installed) throw new Error('MetaMask is not installed');
    const adapter = await getMetaMaskAdapter();
    if (!active()) return null;
    let connectedAddress: string | null = null;
    if (interactive) {
      const access = await adapter.requestAccess();
      if (!active()) return null;
      if (access.error) throw new Error(access.error.message);
      connectedAddress = access.address || null;
    } else {
      const allowed = await adapter.isAllowed();
      if (!active()) return null;
      if (!allowed.error && allowed.isAllowed) {
        const read = await adapter.getAddress();
        if (!active()) return null;
        connectedAddress = !read.error && read.address ? read.address : null;
      }
    }
    if (!connectedAddress) {
      drop();
      // Silent reconnect: the adapter is still restoring its session, so watch and adopt
      // the account once it reports. Only when MetaMask still allows this site.
      if (!interactive) {
        const allowed = await adapter.isAllowed();
        if (!active()) return null;
        if (!allowed.error && allowed.isAllowed) watchMetaMaskWallet(adapter, { address: null, passphrase: null }, generation);
      }
      return null;
    }
    const net = await adapter.getNetwork();
    if (!active()) return null;
    // Unknown (null) rather than '', which would read as a network mismatch.
    const passphrase = net.error ? null : net.networkPassphrase;
    setWalletKind('metamask');
    connectedKindRef.current = 'metamask';
    setStellarCopyWallet('metamask');
    adopt({ address: connectedAddress, passphrase, signer: metaMaskSigner(adapter) });
    if (passphrase !== null && passphrase !== STELLAR_TESTNET_NETWORK.networkPassphrase) {
      noticeRef.current = metaMaskNetworkMismatchMessage();
    }
    writeFlag(true);
    writeStellarWalletKind('metamask');
    watchMetaMaskWallet(adapter, { address: connectedAddress, passphrase }, generation);
    return connectedAddress;
  }, [adopt, drop, watchMetaMaskWallet]);

  const connectWith = useCallback(async (interactive: boolean, wanted?: StellarWalletKind): Promise<string | null> => {
    const kind = wanted ?? readStellarWalletKind();
    // Already connected: nothing to do, and no state churn for callers that
    // (re)connect from effects. Asking for the other wallet switches to it.
    if (connectedAddressRef.current) {
      if (!wanted || wanted === connectedKindRef.current) return connectedAddressRef.current;
      reset();
    }
    if (busyRef.current) return null;
    busyRef.current = true;
    stopWatching();
    const generation = ++generationRef.current;
    const active = () => generation === generationRef.current;
    setStatus('connecting');
    setError(null);
    lastErrorRef.current = null;
    noticeRef.current = null;
    try {
      if (kind === 'metamask' && !isDevBurner) return await connectMetaMask(interactive, generation);
      if (isDevBurner) {
        const burner = await devBurnerSigner(DEV_SECRET);
        if (!active()) return null;
        adopt({ address: burner.address, passphrase: STELLAR_TESTNET_NETWORK.networkPassphrase, signer: burner.signer });
        writeFlag(true);
        return burner.address;
      }
      if (Platform.OS !== 'web') throw new Error('Use a browser extension to connect a Stellar wallet.');
      const api = await loadVarial();
      const installed = await isVarialInstalled(api);
      if (!active()) return null;
      setAvailabilityChecked(true);
      if (!installed) {
        setFreighterAvailable(false);
        throw new Error('Varial is not installed');
      }
      setFreighterAvailable(true);
      const access = interactive ? await api.requestAccess() : await api.getAddress();
      if (!active()) return null;
      if (access.error && interactive) throw new Error(access.error.message);
      if (access.error || !access.address) {
        drop();
        if (!interactive) await watch({ address: null, passphrase: null }, generation);
        return null;
      }
      const details = await api.getNetworkDetails();
      if (!active()) return null;
      const passphrase = details.error ? null : details.networkPassphrase;
      await watch({ address: access.address, passphrase }, generation);
      if (!active()) return null;
      setWalletKind('freighter');
      connectedKindRef.current = 'freighter';
      setStellarCopyWallet('freighter');
      adopt({ address: access.address, passphrase, signer: varialSigner(api) });
      writeFlag(true);
      writeStellarWalletKind('freighter');
      return active() ? access.address : null;
    } catch (caught) {
      if (!active()) return null;
      const message = caught instanceof Error ? caught.message : String(caught);
      reset();
      lastErrorRef.current = message;
      if (interactive) setError(message);
      return null;
    } finally {
      if (active()) busyRef.current = false;
    }
  }, [adopt, connectMetaMask, drop, isDevBurner, reset, stopWatching, watch]);

  // Availability probe + silent reconnect, once. Only reconnects when this
  // browser connected before, so a bare page load never prompts.
  useEffect(() => {
    let cancelled = false;
    const generation = generationRef.current;
    (async () => {
      // The wallet used before is the only one a silent reconnect may go to.
      const remembered = isDevBurner ? 'freighter' : readStellarWalletKind();
      if (!isDevBurner) {
        // Local extension probe, so the picker can offer a MetaMask row. Never prompts.
        const metaMask = await isMetaMaskInstalled();
        if (!cancelled) setMetaMaskAvailable(metaMask);
        if (remembered === 'metamask') {
          if (!cancelled && generation === generationRef.current && metaMask && readFlag()) await connectWith(false, 'metamask');
          // Freighter is still offered in the picker: probe it, but never connect it.
          try {
            const installed = await isVarialInstalled(await loadVarial());
            if (!cancelled) setFreighterAvailable(installed);
          } catch {
            // a failed probe proves nothing
          }
          if (!cancelled) setAvailabilityChecked(true);
          return;
        }
      }
      if (!isDevBurner) {
        if (Platform.OS !== 'web') return;
        try {
          const api = await loadVarial();
          const installed = await isVarialInstalled(api);
          if (!cancelled) {
            setFreighterAvailable(installed);
            setAvailabilityChecked(true);
          }
          if (!installed) return;
          const allowed = await api.isAllowed();
          if (!allowed.isAllowed) return;
        } catch {
          // A failed probe proves nothing: availability stays unknown, so the
          // next click retries the connect instead of opening varialwallet.com.
          return;
        }
      }
      if (!cancelled && generation === generationRef.current && readFlag()) await connectWith(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [connectWith, isDevBurner]);

  useEffect(() => () => { generationRef.current++; stopWatching(); }, [stopWatching]);

  // No explicit choice: the wallet used last; a browser with only MetaMask installed gets MetaMask.
  const defaultKind = useCallback((): StellarWalletKind => {
    const last = readStellarWalletKind();
    return last === 'freighter' && availabilityChecked && !freighterAvailable && metaMaskAvailable
      ? 'metamask'
      : last;
  }, [availabilityChecked, freighterAvailable, metaMaskAvailable]);
  const connect = useCallback((kind?: StellarWalletKind) => connectWith(true, kind ?? defaultKind()), [connectWith, defaultKind]);
  const connectDetailed = useCallback(async (kind?: StellarWalletKind) => {
    const address = await connectWith(true, kind ?? defaultKind());
    return { address, error: address ? null : lastErrorRef.current, notice: address ? noticeRef.current : null };
  }, [connectWith, defaultKind]);
  const disconnect = useCallback(() => {
    writeFlag(false);
    if (connectedKindRef.current === 'metamask') {
      // Keep the extension's permission for the site (it may be shared with other chains).
      void metaMaskAdapter?.disconnect({ revokeSession: false }).catch(() => {});
    }
    reset();
  }, [reset]);
  const cancelConnect = useCallback(() => {
    if (busyRef.current) reset();
  }, [reset]);

  const value = useMemo<StellarWalletContextValue>(() => ({
    address,
    status,
    isConnected: status === 'connected' && address !== null,
    networkPassphrase,
    networkMismatch: status === 'connected'
      && networkPassphrase !== null
      && networkPassphrase !== STELLAR_TESTNET_NETWORK.networkPassphrase,
    networkMismatchMessage: status === 'connected'
      && networkPassphrase !== null
      && networkPassphrase !== STELLAR_TESTNET_NETWORK.networkPassphrase
      ? (walletKind === 'metamask'
        ? metaMaskNetworkMismatchMessage()
        : `${STELLAR_WALLET_NAMES[walletKind]} is on another network. Switch it to Testnet.`)
      : null,
    isAvailable: freighterAvailable || metaMaskAvailable,
    walletAvailable: { freighter: freighterAvailable, metamask: metaMaskAvailable },
    walletKind,
    availabilityChecked,
    isDevBurner,
    error,
    connect,
    connectDetailed,
    cancelConnect,
    disconnect,
    signer,
  }), [address, status, networkPassphrase, freighterAvailable, metaMaskAvailable, walletKind, availabilityChecked, isDevBurner, error, connect, connectDetailed, cancelConnect, disconnect, signer]);

  return <StellarWalletContext.Provider value={value}>{children}</StellarWalletContext.Provider>;
}

const DISCONNECTED: StellarWalletContextValue = {
  address: null,
  status: 'disconnected',
  isConnected: false,
  networkPassphrase: null,
  networkMismatch: false,
  networkMismatchMessage: null,
  isAvailable: false,
  walletAvailable: { freighter: false, metamask: false },
  walletKind: 'freighter',
  availabilityChecked: true,
  isDevBurner: false,
  error: null,
  connect: async () => null,
  connectDetailed: async () => ({ address: null, error: null, notice: null }),
  cancelConnect: () => {},
  disconnect: () => {},
  signer: null,
};

/** Stellar wallet state; a disconnected stub when no provider is mounted. */
export function useStellarWallet(): StellarWalletContextValue {
  return useContext(StellarWalletContext) ?? DISCONNECTED;
}
