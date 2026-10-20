import { createContext, useContext } from 'react';
import type { Address } from 'viem';

import type { ImportedAccountSummary, PickerAccount } from '@/services/passkey-eoa/account-picker';

// Public state only: the passkey EOA's ADDRESS and the picker list. No key,
// PRF or signature ever goes through this context (services/passkey-eoa).

export type PasskeyAccountValue = {
  /** Native app with a passkey-capable OS. False on web, where nothing changes. */
  available: boolean;
  /** The signed-in passkey EOA (public), or null before the first sign-in. */
  passkeyAddress: Address | null;
  /** Passkey account first, then imported keys. */
  accounts: PickerAccount[];
  /** 'passkey', an imported key id, or null when nothing is picked yet. */
  activeId: string | null;
  busy: boolean;
  error: string | null;
  /** Prompt the privacypools.com passkey and learn its address. `anyPasskey` skips the remembered one.
   * Resolves true once an account is in use (the caller can close), false on
   * failure or when imported keys mean the picker still has to choose. */
  signIn: (opts?: { anyPasskey?: boolean }) => Promise<boolean>;
  /** Create a privacypools.com passkey, then learn its address. Resolves like `signIn`. */
  create: () => Promise<boolean>;
  /** Use an account from the picker as the privacy account. Resolves true on success. */
  pick: (id: string) => Promise<boolean>;
};

export const PasskeyAccountContext = createContext<PasskeyAccountValue>({
  available: false,
  passkeyAddress: null,
  accounts: [],
  activeId: null,
  busy: false,
  error: null,
  signIn: async () => false,
  create: async () => false,
  pick: async () => false,
});

export function usePasskeyAccount(): PasskeyAccountValue {
  return useContext(PasskeyAccountContext);
}

/**
 * Imported account keys for the picker. Filled by the account-key provider
 * from PR #201 (feat/mobile), which keeps them in SecureStore (list = its
 * StoredAccountKey index, activate = sign that key in). main has no native
 * key store, so until #201 lands the default is an empty list and the picker
 * shows the passkey account alone.
 */
export type ImportedAccountKeysSourceValue = {
  keys: readonly ImportedAccountSummary[];
  activate: (id: string) => Promise<void>;
};

export const ImportedAccountKeysSource = createContext<ImportedAccountKeysSourceValue>({
  keys: [],
  activate: async () => {
    throw new Error('Imported account keys are not available in this build.');
  },
});
