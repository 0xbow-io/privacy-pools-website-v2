/**
 * Stellar wallet provider — Freighter connection state for the Stellar chain.
 *
 * The Stellar counterpart of components/sui-provider.tsx (dapp-kit's
 * `WalletProvider autoConnect`): holds the connected account, reconnects
 * silently only when this browser connected before, and follows Freighter's
 * own account and network switches (services/stellar/freighter-watch.ts). It exposes the account as a
 * `StellarWalletProvider`, the bare-value signer contract the Stellar SDK's
 * `FreighterWalletInteractor` signs through (network check included).
 *
 * Local development only: `EXPO_PUBLIC_STELLAR_DEV_SECRET` swaps Freighter for
 * a testnet burner keypair, so flows can be driven in a browser without the
 * extension. It is refused on any non-local host and must never hold a key
 * with real value (a public env var is inlined into the bundle).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import type { StellarWalletProvider as StellarSigner } from '@privacy-pools-v2/stellar-sdk';

import { STELLAR_TESTNET_NETWORK } from '@/config/stellar-deployment';
import { useToast } from '@/components/toast-provider';
import { watchFreighter, type FreighterAccount } from '@/services/stellar/freighter-watch';

type FreighterApi = typeof import('@stellar/freighter-api');

const CONNECTED_FLAG_KEY = 'ppv2_stellar_connected';
/**
 * Freighter is a browser extension, and freighter-api talks to it through
 * `window.postMessage`, which React Native lacks: only the web build can reach it.
 */
const FREIGHTER_REACHABLE = Platform.OS === 'web';
const WATCH_INTERVAL_MS = 3000;

export type StellarWalletStatus = 'disconnected' | 'connecting' | 'connected';

export interface StellarWalletContextValue {
  address: string | null;
  status: StellarWalletStatus;
  isConnected: boolean;
  /** Freighter's active network passphrase, when known. */
  networkPassphrase: string | null;
  /** Connected, but Freighter is on a different network than the app's. */
  networkMismatch: boolean;
  /** Whether a Stellar wallet (Freighter, or the dev burner) is available at all. */
  isAvailable: boolean;
  /**
   * The availability probe has finished. Until then `isAvailable: false`
   * means "not known yet", not "not installed".
   */
  availabilityChecked: boolean;
  /** Dev burner keypair in use instead of Freighter. */
  isDevBurner: boolean;
  error: string | null;
  connect: () => Promise<string | null>;
  /** Interactive connect that also says why it failed (for a toast). */
  connectDetailed: () => Promise<{ address: string | null; error: string | null }>;
  disconnect: () => void;
  /** Signer for the SDK; null until connected. */
  signer: StellarSigner | null;
}

const StellarWalletContext = createContext<StellarWalletContextValue | null>(null);

let freighterPromise: Promise<FreighterApi> | null = null;
function loadFreighter(): Promise<FreighterApi> {
  freighterPromise ??= import('@stellar/freighter-api');
  return freighterPromise;
}

/**
 * freighter-api also answers "not connected" when Freighter does not reply within 2 s (a cold
 * extension), so ask once more before calling it not installed.
 */
async function isFreighterInstalled(api: FreighterApi): Promise<boolean> {
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

/** The Freighter signer, adapted to the SDK contract (errors thrown, not returned). */
function freighterSigner(api: FreighterApi): StellarSigner {
  return {
    async getAddress() {
      const result = await api.getAddress();
      if (result.error) throw new Error(result.error.message);
      if (!result.address) throw new Error('Freighter is locked or not connected');
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
  const [isAvailable, setIsAvailable] = useState(isDevBurner);
  const [availabilityChecked, setAvailabilityChecked] = useState(isDevBurner || !FREIGHTER_REACHABLE);
  const lastErrorRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signer, setSigner] = useState<StellarSigner | null>(null);
  const watcherRef = useRef<{ stop: () => void } | null>(null);

  const stopWatching = useCallback(() => {
    watcherRef.current?.stop();
    watcherRef.current = null;
  }, []);

  const adopt = useCallback((next: { address: string; passphrase: string | null; signer: StellarSigner }) => {
    setAddress(next.address);
    setNetworkPassphrase(next.passphrase);
    setSigner(next.signer);
    setStatus('connected');
    setError(null);
  }, []);

  const drop = useCallback(() => {
    setAddress(null);
    setNetworkPassphrase(null);
    setSigner(null);
    setStatus('disconnected');
  }, []);

  const reset = useCallback(() => {
    stopWatching();
    drop();
  }, [drop, stopWatching]);

  // Follows Freighter's account and network until an explicit disconnect. An empty or slow read
  // is not a disconnect (see services/stellar/freighter-watch.ts); a revoked site is, and watching
  // continues so an unlock or re-allow reconnects.
  const watch = useCallback(async (current: FreighterAccount) => {
    if (isDevBurner) return;
    stopWatching();
    const api = await loadFreighter();
    const freighter = freighterSigner(api);
    watcherRef.current = watchFreighter(api, current, {
      change: (next) => adopt({ ...next, signer: freighter }),
      revoked: drop,
    }, WATCH_INTERVAL_MS);
  }, [adopt, drop, isDevBurner, stopWatching]);

  const connectedAddressRef = useRef<string | null>(null);
  connectedAddressRef.current = status === 'connected' ? address : null;

  const connectWith = useCallback(async (interactive: boolean): Promise<string | null> => {
    // Already connected: nothing to do, and no state churn for callers that
    // (re)connect from effects.
    if (connectedAddressRef.current) return connectedAddressRef.current;
    setStatus('connecting');
    setError(null);
    lastErrorRef.current = null;
    try {
      if (isDevBurner) {
        const burner = await devBurnerSigner(DEV_SECRET);
        adopt({ address: burner.address, passphrase: STELLAR_TESTNET_NETWORK.networkPassphrase, signer: burner.signer });
        writeFlag(true);
        return burner.address;
      }
      if (!FREIGHTER_REACHABLE) throw new Error('Freighter is not installed');
      const api = await loadFreighter();
      const installed = await isFreighterInstalled(api);
      setAvailabilityChecked(true);
      if (!installed) {
        setIsAvailable(false);
        throw new Error('Freighter is not installed');
      }
      setIsAvailable(true);
      const access = interactive ? await api.requestAccess() : await api.getAddress();
      if (access.error && interactive) throw new Error(access.error.message);
      if (access.error || !access.address) {
        reset();
        // Silent reconnect: a locked Freighter, or one that did not answer in time, so keep
        // watching and adopt the account once it reads.
        if (!interactive) await watch({ address: null, passphrase: null });
        return null;
      }
      const details = await api.getNetworkDetails();
      // Unknown (null) rather than '', which would read as a network mismatch.
      const passphrase = details.error ? null : details.networkPassphrase;
      adopt({ address: access.address, passphrase, signer: freighterSigner(api) });
      writeFlag(true);
      await watch({ address: access.address, passphrase });
      return access.address;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      reset();
      lastErrorRef.current = message;
      if (interactive) setError(message);
      return null;
    }
  }, [adopt, isDevBurner, reset, watch]);

  // Availability probe + silent reconnect, once. Only reconnects when this
  // browser connected before, so a bare page load never prompts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isDevBurner) {
        if (!FREIGHTER_REACHABLE) return;
        try {
          const api = await loadFreighter();
          const installed = await isFreighterInstalled(api);
          if (!cancelled) {
            setIsAvailable(installed);
            setAvailabilityChecked(true);
          }
          if (!installed) return;
          const allowed = await api.isAllowed();
          if (!allowed.isAllowed) return;
        } catch {
          // A failed probe proves nothing: availability stays unknown, so the
          // next click retries the connect instead of opening freighter.app.
          return;
        }
      }
      if (!cancelled && readFlag()) await connectWith(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [connectWith, isDevBurner]);

  useEffect(() => stopWatching, [stopWatching]);

  const connect = useCallback(() => connectWith(true), [connectWith]);
  const connectDetailed = useCallback(async () => {
    const address = await connectWith(true);
    return { address, error: address ? null : lastErrorRef.current };
  }, [connectWith]);
  const disconnect = useCallback(() => {
    writeFlag(false);
    reset();
  }, [reset]);

  const value = useMemo<StellarWalletContextValue>(() => ({
    address,
    status,
    isConnected: status === 'connected' && address !== null,
    networkPassphrase,
    networkMismatch: status === 'connected'
      && networkPassphrase !== null
      && networkPassphrase !== STELLAR_TESTNET_NETWORK.networkPassphrase,
    isAvailable,
    availabilityChecked,
    isDevBurner,
    error,
    connect,
    connectDetailed,
    disconnect,
    signer,
  }), [address, status, networkPassphrase, isAvailable, availabilityChecked, isDevBurner, error, connect, connectDetailed, disconnect, signer]);

  return <StellarWalletContext.Provider value={value}>{children}</StellarWalletContext.Provider>;
}

const DISCONNECTED: StellarWalletContextValue = {
  address: null,
  status: 'disconnected',
  isConnected: false,
  networkPassphrase: null,
  networkMismatch: false,
  isAvailable: false,
  availabilityChecked: true,
  isDevBurner: false,
  error: null,
  connect: async () => null,
  connectDetailed: async () => ({ address: null, error: null }),
  disconnect: () => {},
  signer: null,
};

/** Stellar wallet state; a disconnected stub when no provider is mounted. */
export function useStellarWallet(): StellarWalletContextValue {
  return useContext(StellarWalletContext) ?? DISCONNECTED;
}

const FREIGHTER_URL = 'https://www.freighter.app';

/**
 * "Connect Wallet" on Stellar: Freighter when it is (or may still turn out to
 * be) installed, the Freighter site when the probe found none. A failed
 * connect is always shown, never swallowed. Needs the toast provider above it.
 */
export function useConnectFreighter(): () => Promise<string | null> {
  const wallet = useStellarWallet();
  const { toast } = useToast();
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  return useCallback(async () => {
    const current = walletRef.current;
    if (current.isConnected) return current.address;
    if (current.availabilityChecked && !current.isAvailable) {
      if (Platform.OS === 'web') window.open(FREIGHTER_URL, '_blank', 'noopener');
      else Linking.openURL(FREIGHTER_URL).catch(() => {});
      return null;
    }
    const { address, error } = await current.connectDetailed();
    if (!address && error) {
      toast({
        title: /not installed/i.test(error) ? 'Freighter is not installed. Get it at freighter.app.' : error,
        variant: 'destructive',
      });
    }
    return address;
  }, [toast]);
}
