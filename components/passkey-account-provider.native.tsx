import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { useAccount, useConnect } from 'wagmi';
import type { Address } from 'viem';

import { useSdkContext } from '@/components/sdk-provider';
import {
  ImportedAccountKeysSource,
  PasskeyAccountContext,
  type PasskeyAccountValue,
} from '@/components/passkey-account-context';
import { buildPickerAccounts, planForPick, PASSKEY_ACCOUNT_ID } from '@/services/passkey-eoa/account-picker';
import {
  PASSKEY_EOA_CONNECTOR_ID,
  getActivePasskeyEoa,
  setActivePasskeyEoa,
} from '@/services/passkey-eoa/connector';
import { passkeyFailureCopy } from '@/services/passkey-eoa/errors';
import {
  createPasskeyEoaCredential,
  isPasskeyEoaSupported,
  requestPasskeyEoaPrf,
} from '@/services/passkey-eoa/prf-source';
import { passkeyEoaSignIn } from '@/services/passkey-eoa/sign-in';
import {
  loadPasskeyEoaRecord,
  savePasskeyEoaRecord,
  type PasskeyEoaRecord,
  type PublicKV,
} from '@/services/passkey-eoa/store';

// Native passkey sign-in + account picker. Holds PUBLIC state only (address,
// credential id, picker rows). Every key operation lives in services/passkey-eoa
// and runs inside a single call; this file never sees a key or a PRF.

// SecureStore has no synchronous delete; an empty value stands for none.
const kv: PublicKV = {
  get: async (k) => (await SecureStore.getItemAsync(k)) || null,
  set: (k, v) => SecureStore.setItemAsync(k, v),
  remove: (k) => SecureStore.setItemAsync(k, ''),
};

const prompts = { request: requestPasskeyEoaPrf, create: createPasskeyEoaCredential };

export function PasskeyAccountProvider({ children }: { children: ReactNode }) {
  const available = useMemo(() => isPasskeyEoaSupported(), []);
  const { connector, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { identityMode, sessionAddress, signOutAccountKey } = useSdkContext();
  const imported = useContext(ImportedAccountKeysSource);

  const [record, setRecord] = useState<PasskeyEoaRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available) return;
    let live = true;
    loadPasskeyEoaRecord(kv)
      .then((r) => { if (live) setRecord(r); })
      .catch(() => {});
    return () => { live = false; };
  }, [available]);

  const passkeyConnector = useMemo(
    () => connectors.find((c) => c.id === PASSKEY_EOA_CONNECTOR_ID),
    [connectors],
  );
  const passkeyConnected = isConnected && connector?.id === PASSKEY_EOA_CONNECTOR_ID;

  const accounts = useMemo(
    () => buildPickerAccounts(record?.address ?? null, imported.keys),
    [record, imported.keys],
  );

  const activeId = useMemo(() => {
    if (!passkeyConnected) return null;
    if (identityMode === 'wallet') return PASSKEY_ACCOUNT_ID;
    if (identityMode === 'key' && sessionAddress) {
      const hit = accounts.find((a) => a.kind === 'imported' && a.address.toLowerCase() === sessionAddress.toLowerCase());
      return hit?.id ?? null;
    }
    return null;
  }, [passkeyConnected, identityMode, sessionAddress, accounts]);

  /** Make the passkey EOA the connected wallet (no prompt: the address is public). */
  const connectPasskey = useCallback(async (r: PasskeyEoaRecord) => {
    if (!passkeyConnector) throw new Error('Passkey sign-in is not set up in this build.');
    const current = getActivePasskeyEoa();
    if (passkeyConnected && current?.address.toLowerCase() === r.address.toLowerCase()) return;
    // Already connected with another passkey: the connector's change event
    // moves wagmi to the new address, no second connect.
    setActivePasskeyEoa(r);
    if (!passkeyConnected) await connectAsync({ connector: passkeyConnector });
  }, [connectAsync, passkeyConnector, passkeyConnected]);

  const pickWith = useCallback(async (id: string, r: PasskeyEoaRecord) => {
    const account = buildPickerAccounts(r.address, imported.keys).find((a) => a.id === id);
    if (!account) throw new Error('That account is no longer on this device.');
    const plan = planForPick(account, r.address as Address);
    if (plan.privacyIdentity.mode === 'wallet') {
      // The passkey account IS the wallet: drop any imported key identity first.
      if (identityMode === 'key') signOutAccountKey();
      await connectPasskey(r);
      return;
    }
    // Imported key as the privacy account, passkey EOA as the payer/signer.
    await connectPasskey(r);
    await imported.activate(plan.privacyIdentity.importedId);
  }, [imported, identityMode, signOutAccountKey, connectPasskey]);

  const run = useCallback(async (fn: () => Promise<void | boolean>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      return (await fn()) !== false;
    } catch (e) {
      setError(passkeyFailureCopy(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const signInMode = useCallback((mode: 'existing' | 'create', anyPasskey: boolean) => run(async () => {
    const remembered = mode === 'existing' && !anyPasskey ? record?.credentialId ?? null : null;
    const next = await passkeyEoaSignIn(prompts, mode, remembered);
    await savePasskeyEoaRecord(kv, next);
    setRecord(next);
    // Nothing else to choose: go straight in with the passkey account.
    if (imported.keys.length === 0) {
      await pickWith(PASSKEY_ACCOUNT_ID, next);
      return true;
    }
    // Already connected with the old passkey: move the payer to the new one.
    if (passkeyConnected) await connectPasskey(next);
    // The picker stays open to choose an account.
    return false;
  }), [run, record, imported.keys.length, pickWith, passkeyConnected, connectPasskey]);

  const signIn = useCallback(
    (opts?: { anyPasskey?: boolean }) => signInMode('existing', opts?.anyPasskey === true),
    [signInMode],
  );
  const create = useCallback(() => signInMode('create', false), [signInMode]);

  const pick = useCallback((id: string) => run(async () => {
    if (!record) throw new Error('Sign in with your passkey first.');
    await pickWith(id, record);
  }), [run, record, pickWith]);

  const value = useMemo<PasskeyAccountValue>(() => ({
    available,
    passkeyAddress: record?.address ?? null,
    accounts,
    activeId,
    busy,
    error,
    signIn,
    create,
    pick,
  }), [available, record, accounts, activeId, busy, error, signIn, create, pick]);

  return <PasskeyAccountContext.Provider value={value}>{children}</PasskeyAccountContext.Provider>;
}
