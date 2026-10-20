import type { Address, Hex } from 'viem';

// Persisted, non-secret metadata about an embedded wallet. Web wallets store no
// key at rest (the EOA is re-derived from the passkey PRF); native stores the
// key in expo-secure-store. This record holds only the credential id + address.
export interface EmbeddedWalletMeta {
  version: 1;
  // The embedded EOA address (the smart-account owner key).
  address: Address;
  // How the EOA is protected: 'passkey' (web, PRF-derived) or 'secure-store'.
  protection: 'passkey' | 'secure-store';
  // Passkey (web) details, when protection === 'passkey'.
  passkey?: {
    credentialId: string; // base64url
    // RP ID the credential was created under. Absent on metadata written before
    // the apex RP ID (2026-09-05): those credentials answer only for the page hostname.
    rpId?: string;
    // How the EOA relates to the passkey.
    //  'prf'  → deterministically derived from the passkey PRF (recoverable from
    //           the passkey alone; nothing stored).
    //  'test' → e2e-only: a fixed key injected via window.__POOLS_TEST_PK__.
    derivation: 'prf' | 'test';
  };
  // Chains on which the smart account has been deployed/activated. Keyed by
  // chainId. (Reserved for the ERC-7579 smart-account integration.)
  delegatedChains?: number[];
  createdAt: number;
}

// The unlocked, in-memory wallet: the EOA private key plus its metadata.
// Never persisted in this form.
export interface UnlockedEmbeddedWallet {
  privateKey: Hex;
  meta: EmbeddedWalletMeta;
}
