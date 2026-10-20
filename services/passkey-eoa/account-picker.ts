// Account picker for the app: the passkey account first, then account keys
// imported from the web (PR #201's SecureStore list, shape StoredAccountKey).
//
// Whatever is picked as the privacy account, the on-chain signer is always the
// passkey EOA: picking the passkey account makes it the wallet (wallet mode,
// keys derived from its EIP-712 signature like any EOA); picking an imported
// key signs that key in and keeps the passkey EOA connected as the payer, the
// existing "account key + wallet" path (components/sdk-provider.tsx,
// deposit-modal-provider depositFor).

import type { Address } from 'viem';

/** Mirrors StoredAccountKey from PR #197 (services/mobile-account-key-store.ts). */
export type ImportedAccountSummary = { id: string; name: string; address: string };

export type PickerAccount =
  | { kind: 'passkey'; id: 'passkey'; label: string; address: Address }
  | { kind: 'imported'; id: string; label: string; address: string };

export const PASSKEY_ACCOUNT_ID = 'passkey' as const;

export function buildPickerAccounts(
  passkeyAddress: Address | null,
  imported: readonly ImportedAccountSummary[],
): PickerAccount[] {
  const out: PickerAccount[] = [];
  if (passkeyAddress) out.push({ kind: 'passkey', id: PASSKEY_ACCOUNT_ID, label: 'Passkey account', address: passkeyAddress });
  const seen = new Set<string>();
  for (const k of imported) {
    if (!k || typeof k.id !== 'string' || seen.has(k.id) || k.id === PASSKEY_ACCOUNT_ID) continue;
    seen.add(k.id);
    out.push({ kind: 'imported', id: k.id, label: k.name || 'Imported account', address: k.address });
  }
  return out;
}

export type AccountPlan = {
  /** wallet = the passkey EOA is the privacy identity; key = an imported key is. */
  privacyIdentity: { mode: 'wallet'; address: Address } | { mode: 'key'; importedId: string; address: string };
  /** Signs deposits, approvals and registration. Always the passkey EOA. */
  onChainSigner: Address;
};

export class NoPasskeySignerError extends Error {
  constructor() {
    super('Sign in with your passkey first.');
  }
}

/**
 * What a pick means. Throws without a passkey EOA: nothing on-chain can be
 * signed then, and an imported key alone would leave deposits with no sender.
 */
export function planForPick(account: PickerAccount, passkeyAddress: Address | null): AccountPlan {
  if (!passkeyAddress) throw new NoPasskeySignerError();
  if (account.kind === 'passkey') {
    return { privacyIdentity: { mode: 'wallet', address: passkeyAddress }, onChainSigner: passkeyAddress };
  }
  return { privacyIdentity: { mode: 'key', importedId: account.id, address: account.address }, onChainSigner: passkeyAddress };
}

/** The deposit sender for any pick: the passkey EOA, never the imported key's owner. */
export function depositSignerFor(account: PickerAccount, passkeyAddress: Address | null): Address {
  return planForPick(account, passkeyAddress).onChainSigner;
}
