/** Stellar connection state. Varial reconnects silently after an explicit connection.
 * Follows account/network changes. No wallet signatures are requested
 * until an explicit unlock or transaction. Localhost may use a test-only burner.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { StellarWalletProvider as StellarSigner } from '@privacy-pools-v2/stellar-sdk';

import { STELLAR_TESTNET_NETWORK } from '@/config/stellar-deployment';
import { Platform } from 'react-native';
import { watchVarial, type VarialAccount } from '@/services/stellar/varial-watch';

type VarialApi = typeof import('@stellar/varial-sdk');

const CONNECTED_FLAG_KEY = 'ppv2_stellar_connected';
const WATCH_INTERVAL_MS = 3000;

export type StellarWalletStatus = 'disconnected' | 'connecting' | 'connected';

export interface StellarWalletContextValue {
  address: string | null;
  status: StellarWalletStatus;
  isConnected: boolean;
  /** Observed Varial network. */
  networkPassphrase: string | null;
  /** Connected, but the wallet is on a different network than the app's. */
  networkMismatch: boolean;
  /** Whether Varial (or the dev burner) was found by the passive probe. */
  isAvailable: boolean;
  /**
   * The availability probe has finished. Until then `isAvailable: false`
   * means "not known yet", not "not installed".
   */
  availabilityChecked: boolean;
  /** Dev burner keypair in use instead of a wallet. */
  isDevBurner: boolean;
  error: string | null;
  connect: () => Promise<string | null>;
  /** Interactive connect that also says why it failed (for a toast). */
  connectDetailed: () => Promise<{ address: string | null; error: string | null }>;
  /** Cancel an in-flight connection without forgetting the reconnect preference. */
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
  const [isAvailable, setIsAvailable] = useState(isDevBurner);
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
  const connectWith = useCallback(async (interactive: boolean): Promise<string | null> => {
    if (connectedAddressRef.current) return connectedAddressRef.current;
    if (busyRef.current) return null;
    busyRef.current = true;
    stopWatching();
    const generation = ++generationRef.current;
    const active = () => generation === generationRef.current;
    setStatus('connecting');
    setError(null);
    lastErrorRef.current = null;
    try {
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
      setIsAvailable(installed);
      if (!installed) throw new Error('Varial is not installed');
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
      adopt({ address: access.address, passphrase, signer: varialSigner(api) });
      writeFlag(true);
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
  }, [adopt, drop, isDevBurner, reset, stopWatching, watch]);

  // Availability probe + silent reconnect, once. Only reconnects when this
  // browser connected before, so a bare page load never prompts.
  useEffect(() => {
    let cancelled = false;
    const generation = generationRef.current;
    (async () => {
      if (!isDevBurner) {
        if (Platform.OS !== 'web') return;
        try {
          const api = await loadVarial();
          const installed = await isVarialInstalled(api);
          if (!cancelled) {
            setIsAvailable(installed);
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

  const connect = useCallback(() => connectWith(true), [connectWith]);
  const connectDetailed = useCallback(async () => {
    const address = await connectWith(true);
    return { address, error: address ? null : lastErrorRef.current };
  }, [connectWith]);
  const disconnect = useCallback(() => {
    writeFlag(false);
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
    isAvailable,
    availabilityChecked,
    isDevBurner,
    error,
    connect,
    connectDetailed,
    cancelConnect,
    disconnect,
    signer,
  }), [address, status, networkPassphrase, isAvailable, availabilityChecked, isDevBurner, error, connect, connectDetailed, cancelConnect, disconnect, signer]);

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
  cancelConnect: () => {},
  disconnect: () => {},
  signer: null,
};

/** Stellar wallet state; a disconnected stub when no provider is mounted. */
export function useStellarWallet(): StellarWalletContextValue {
  return useContext(StellarWalletContext) ?? DISCONNECTED;
}
