import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useConfig, useConnect } from 'wagmi';
import {
  EMBEDDED_CONNECTOR_ID,
  canUsePasskey,
  clearActiveEmbeddedWallet,
  createWallet,
  getWalletMeta,
  hasWallet,
  recoverWallet,
  setActiveEmbeddedWallet,
  unlockWallet,
  wipeWallet,
  type EmbeddedWalletMeta,
} from '@/services/embedded-wallet';
import { smartWalletActive } from '@/config/smart-wallet';

// Drives the embedded (passkey smart-account) wallet: create, unlock, wipe, and
// hooking it up to wagmi so the rest of the app (SDK provider, deposit, etc.)
// treats it like any connected account. The headline onboarding path.

interface EmbeddedWalletContextValue {
  // null until we've checked storage.
  exists: boolean | null;
  meta: EmbeddedWalletMeta | null;
  // Whether passkeys are usable here (web + platform authenticator).
  passkeyAvailable: boolean;
  busy: boolean;
  error: string | null;
  // Create a fresh wallet (no seedphrase) and connect it.
  create: () => Promise<void>;
  // Unlock an existing wallet (passkey/biometric prompt) and connect it.
  unlock: () => Promise<void>;
  // Recover from the passkey alone (no local state) and connect it.
  recover: () => Promise<void>;
  // Forget the wallet entirely (after disconnect).
  wipe: () => Promise<void>;
}

const EmbeddedWalletContext = createContext<EmbeddedWalletContextValue | null>(null);

function humanizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  switch (msg) {
    case 'PASSKEY_PRF_UNSUPPORTED':
      return "This device's passkey can't secure the wallet key. Try a device with a built-in authenticator.";
    case 'NO_EMBEDDED_WALLET':
      return 'No wallet found on this device yet.';
    case 'MISSING_ENCRYPTED_KEY':
    case 'MISSING_SECURE_KEY':
      return 'Wallet data is missing or was cleared. You may need to recover from a backup.';
    case 'PASSKEY_DECRYPT_MISMATCH':
      return 'Could not unlock. The passkey did not match this wallet.';
    case 'PASSKEY_UNAVAILABLE':
      return 'This browser/device has no passkey support. Open on a device with a built-in authenticator (or connect an existing wallet).';
    default:
      if (/cancel/i.test(msg)) return 'Cancelled.';
      return msg;
  }
}

export function EmbeddedWalletProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const { connectAsync, connectors } = useConnect();

  const [exists, setExists] = useState<boolean | null>(null);
  const [meta, setMeta] = useState<EmbeddedWalletMeta | null>(null);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Flag OFF (web without the flag): stay fully inert — no storage reads, no
    // WebAuthn capability probes — so ppv2's normal flow is untouched.
    if (!smartWalletActive()) {
      setExists(false);
      return;
    }
    const [has, m, canPk] = await Promise.all([hasWallet(), getWalletMeta(), canUsePasskey()]);
    setExists(has);
    setMeta(m);
    setPasskeyAvailable(canPk);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const embeddedConn = useMemo(
    () => connectors.find((c) => c.id === EMBEDDED_CONNECTOR_ID),
    [connectors]
  );

  const connectEmbedded = useCallback(async () => {
    if (!embeddedConn) throw new Error('Embedded connector not configured');
    await connectAsync({ connector: embeddedConn });
  }, [connectAsync, embeddedConn]);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const wallet = await createWallet();
      setActiveEmbeddedWallet(wallet.privateKey);
      await connectEmbedded();
      await refresh();
    } catch (e) {
      clearActiveEmbeddedWallet();
      setError(humanizeError(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [connectEmbedded, refresh]);

  const unlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const wallet = await unlockWallet();
      setActiveEmbeddedWallet(wallet.privateKey);
      await connectEmbedded();
      await refresh();
    } catch (e) {
      clearActiveEmbeddedWallet();
      setError(humanizeError(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [connectEmbedded, refresh]);

  const recover = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const wallet = await recoverWallet();
      setActiveEmbeddedWallet(wallet.privateKey);
      await connectEmbedded();
      await refresh();
    } catch (e) {
      clearActiveEmbeddedWallet();
      setError(humanizeError(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [connectEmbedded, refresh]);

  const wipe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      clearActiveEmbeddedWallet();
      await wipeWallet();
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const value = useMemo<EmbeddedWalletContextValue>(
    () => ({ exists, meta, passkeyAvailable, busy, error, create, unlock, recover, wipe }),
    [exists, meta, passkeyAvailable, busy, error, create, unlock, recover, wipe]
  );

  return <EmbeddedWalletContext.Provider value={value}>{children}</EmbeddedWalletContext.Provider>;
}

export function useEmbeddedWallet(): EmbeddedWalletContextValue {
  const ctx = useContext(EmbeddedWalletContext);
  if (!ctx) throw new Error('useEmbeddedWallet must be used within EmbeddedWalletProvider');
  return ctx;
}
