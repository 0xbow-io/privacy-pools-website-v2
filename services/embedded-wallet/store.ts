// Persistence for the embedded wallet. Web wallets store ONLY the non-secret
// metadata (the EOA is re-derived from the passkey PRF — no key at rest). Native
// stores the generated EOA in expo-secure-store (hardware keystore).

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { Hex } from 'viem';
import type { EmbeddedWalletMeta } from './types';

// v2: the EOA is PRF-derived (no key at rest). v1 metadata from the earlier
// ported layer used a different PRF salt + an encrypted-blob path, so it would
// mis-derive under the unified scheme — bumping the key makes those wallets
// "not found" (→ recreate) instead of deriving a wrong/failing EOA.
const META_KEY = 'pools_embedded_wallet_meta_v2';
const SECURE_KEY = 'pools_embedded_wallet_key_v1'; // native: raw EOA key in keystore
// Legacy keys, removed on wipe so old private-key material doesn't linger.
const LEGACY_META_KEY = 'pools_embedded_wallet_meta_v1';
const LEGACY_ENC_KEY = 'pools_embedded_wallet_enckey_v1';

function isWebWithStorage(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

// ---------- metadata ----------

export async function loadMeta(): Promise<EmbeddedWalletMeta | null> {
  try {
    if (isWebWithStorage()) {
      const raw = window.localStorage.getItem(META_KEY);
      return raw ? (JSON.parse(raw) as EmbeddedWalletMeta) : null;
    }
    const raw = await SecureStore.getItemAsync(META_KEY);
    return raw ? (JSON.parse(raw) as EmbeddedWalletMeta) : null;
  } catch {
    return null;
  }
}

export async function saveMeta(meta: EmbeddedWalletMeta): Promise<void> {
  const raw = JSON.stringify(meta);
  if (isWebWithStorage()) {
    window.localStorage.setItem(META_KEY, raw);
    return;
  }
  await SecureStore.setItemAsync(META_KEY, raw);
}

// ---------- native: secure-store key ----------

export async function loadSecureKey(): Promise<Hex | null> {
  if (Platform.OS === 'web') return null;
  const raw = await SecureStore.getItemAsync(SECURE_KEY, {
    // Gate read behind device auth where available.
    requireAuthentication: false,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return raw ? (raw as Hex) : null;
}

export async function saveSecureKey(privateKey: Hex): Promise<void> {
  if (Platform.OS === 'web') throw new Error('secure-store key is native-only');
  await SecureStore.setItemAsync(SECURE_KEY, privateKey, {
    requireAuthentication: false,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

// ---------- wipe ----------

export async function clearEmbeddedWallet(): Promise<void> {
  if (isWebWithStorage()) {
    window.localStorage.removeItem(META_KEY);
    // Best-effort cleanup of any pre-unification material.
    window.localStorage.removeItem(LEGACY_META_KEY);
    window.localStorage.removeItem(LEGACY_ENC_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(META_KEY);
  await SecureStore.deleteItemAsync(SECURE_KEY);
}

export async function hasEmbeddedWallet(): Promise<boolean> {
  const meta = await loadMeta();
  return meta !== null;
}
