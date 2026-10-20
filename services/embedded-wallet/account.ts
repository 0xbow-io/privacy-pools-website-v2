// Embedded smart-wallet lifecycle: create (seedphrase-free), unlock, recover,
// wipe. Built ON TOP of ppv2's own passkey stack (services/passkey.ts) — there
// is no second passkey implementation here.
//
// Key model (web, passkey):
//  - The secp256k1 signing EOA is DERIVED DETERMINISTICALLY from the passkey's
//    WebAuthn PRF (prf.first), domain-separated by EOA_DERIVATION_TAG so it is
//    cryptographically independent of the privacy-pools keys ppv2 derives from
//    the same PRF. The passkey is the seed: same passkey → same EOA → same
//    account, recoverable from the passkey alone (no stored key).
//  - Native: there's no platform WebAuthn, so the EOA lives in
//    expo-secure-store (hardware keystore).
//
// The privacy-pools spending/viewing keys are derived elsewhere (ppv2's
// SdkProvider) from the same passkey/signature — unchanged by this module.

import { Platform } from 'react-native';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, concat, stringToBytes, hexToBytes, type Address, type Hex } from 'viem';
import { createPasskey, getPasskeyPrf, isPasskeyPrfLikelySupported } from '@/services/passkey';
import { passkeyRpIdFor } from '@/services/passkey-rp-id';
import {
  clearEmbeddedWallet,
  loadMeta,
  loadSecureKey,
  saveMeta,
  saveSecureKey,
} from './store';
import { EOA_DERIVATION_TAG } from './constants';
import type { EmbeddedWalletMeta, UnlockedEmbeddedWallet } from './types';

// secp256k1 group order.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const RP_NAME = 'Privacy Pools';
const USER_NAME = 'Privacy Pools Wallet';

function legacyHostnameRpId(): string {
  if (typeof window !== 'undefined' && window.location?.hostname) return window.location.hostname;
  return 'localhost';
}
function rpId(): string {
  // Apex RP ID for every *.privacypools.com page (services/passkey-rp-id.ts).
  return passkeyRpIdFor(typeof window !== 'undefined' ? window.location?.hostname : undefined);
}
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
  return b;
}

// Deterministically turn the passkey PRF output (prf.first, 0x-hex) into a valid
// secp256k1 private key. Domain-separated keccak, re-hashed in the
// cosmically-unlikely event the scalar is out of range — so the same PRF always
// yields the same key.
function deriveEoaFromPrf(prfFirst: Hex): Hex {
  let material = concat([hexToBytes(prfFirst), stringToBytes(EOA_DERIVATION_TAG)]);
  for (let i = 0; i < 1000; i++) {
    const candidate = keccak256(material);
    const scalar = BigInt(candidate);
    if (scalar > 0n && scalar < SECP256K1_N) return candidate;
    material = hexToBytes(candidate);
  }
  throw new Error('EOA_DERIVATION_FAILED');
}

function getTestPk(): Hex | undefined {
  return typeof __DEV__ !== 'undefined' && __DEV__ && typeof window !== 'undefined'
    ? (window as unknown as { __POOLS_TEST_PK__?: Hex }).__POOLS_TEST_PK__
    : undefined;
}

export async function hasWallet(): Promise<boolean> {
  return (await loadMeta()) !== null;
}

export async function getWalletMeta(): Promise<EmbeddedWalletMeta | null> {
  return loadMeta();
}

/** Whether the passkey-backed embedded wallet is usable here (web + platform PRF). */
export async function canUsePasskey(): Promise<boolean> {
  if (Platform.OS !== 'web') return false;
  return isPasskeyPrfLikelySupported();
}

/**
 * Create a brand-new embedded wallet. No seedphrase, no key shown.
 *  - web + passkey: enroll a passkey (ppv2 createPasskey), derive the EOA from
 *    its PRF — nothing secret is stored, the passkey reconstructs it.
 *  - native: store a generated EOA in expo-secure-store.
 */
export async function createWallet(displayName?: string): Promise<UnlockedEmbeddedWallet> {
  const testPk = getTestPk();
  const usePasskey = await canUsePasskey();

  if (usePasskey) {
    const created = await createPasskey({
      rpId: rpId(),
      rpName: RP_NAME,
      userId: randomBytes(16),
      userName: displayName ?? USER_NAME,
      userDisplayName: displayName ?? USER_NAME,
      challenge: randomBytes(32),
    });

    // e2e injects a fixed key so testnet funds stay recoverable across runs;
    // honor it but mark the wallet 'test' (re-injected each load, not stored).
    const derivation: 'prf' | 'test' = testPk ? 'test' : 'prf';

    let privateKey: Hex;
    if (testPk) {
      privateKey = testPk;
    } else {
      // Some platforms acknowledge PRF at create() but only return the PRF bytes
      // on a subsequent assertion — same fallback ppv2's SdkProvider uses. So if
      // create() didn't surface prf.first, immediately assert for it.
      let prfFirst = created.prf?.first;
      if (!prfFirst) {
        const res = await getPasskeyPrf({ rpId: rpId(), challenge: randomBytes(32), credentialId: created.credentialId });
        prfFirst = res.prf?.first;
      }
      if (!prfFirst) throw new Error('PASSKEY_PRF_UNSUPPORTED');
      privateKey = deriveEoaFromPrf(prfFirst);
    }

    const address = privateKeyToAccount(privateKey).address;

    const meta: EmbeddedWalletMeta = {
      version: 1,
      address,
      protection: 'passkey',
      passkey: { credentialId: created.credentialId, derivation, rpId: rpId() },
      delegatedChains: [],
      createdAt: Date.now(),
    };
    await saveMeta(meta);
    return { privateKey, meta };
  }

  if (Platform.OS === 'web') {
    // Web requires a platform passkey (no hardware keystore fallback).
    throw new Error('PASSKEY_UNAVAILABLE');
  }

  const privateKey = testPk ?? generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  await saveSecureKey(privateKey);
  const meta: EmbeddedWalletMeta = {
    version: 1,
    address,
    protection: 'secure-store',
    delegatedChains: [],
    createdAt: Date.now(),
  };
  await saveMeta(meta);
  return { privateKey, meta };
}

/** Unlock an existing embedded wallet (passkey / biometric prompt). */
export async function unlockWallet(): Promise<UnlockedEmbeddedWallet> {
  const meta = await loadMeta();
  if (!meta) throw new Error('NO_EMBEDDED_WALLET');

  if (meta.protection === 'passkey') {
    if (!meta.passkey) throw new Error('CORRUPT_WALLET_META');

    let privateKey: Hex;
    if (meta.passkey.derivation === 'test') {
      const testPk = getTestPk();
      if (!testPk) throw new Error('MISSING_SECURE_KEY');
      privateKey = testPk;
    } else {
      // Metadata written before the apex RP ID names no rpId: its credential only
      // answers for the page hostname it was created on (codex on f0419b5).
      const res = await getPasskeyPrf({ rpId: meta.passkey.rpId ?? legacyHostnameRpId(), challenge: randomBytes(32), credentialId: meta.passkey.credentialId });
      if (!res.prf?.first) throw new Error('PASSKEY_PRF_UNSUPPORTED');
      privateKey = deriveEoaFromPrf(res.prf.first);
    }

    if (privateKeyToAccount(privateKey).address !== meta.address) {
      throw new Error('PASSKEY_DECRYPT_MISMATCH');
    }
    return { privateKey, meta };
  }

  const secureKey = await loadSecureKey();
  if (!secureKey) throw new Error('MISSING_SECURE_KEY');
  return { privateKey: secureKey, meta };
}

/**
 * Recover the embedded wallet from the passkey ALONE — no local state needed.
 * A discoverable passkey assertion (no credentialId) re-derives the same EOA and
 * rebuilds the metadata, restoring the same account after a storage wipe or on a
 * new device where the passkey is synced. Web + passkey only.
 */
export async function recoverWallet(): Promise<UnlockedEmbeddedWallet> {
  if (!(await canUsePasskey())) throw new Error('PASSKEY_UNAVAILABLE');

  // Still require a fresh user-verified passkey gesture (and bind to the actual
  // credential), but in dev/e2e the injected fixed key is the source of truth.
  const res = await getPasskeyPrf({ rpId: rpId(), challenge: randomBytes(32) });
  const testPk = getTestPk();
  const derivation: 'prf' | 'test' = testPk ? 'test' : 'prf';
  let privateKey: Hex;
  if (testPk) {
    privateKey = testPk;
  } else {
    if (!res.prf?.first) throw new Error('PASSKEY_PRF_UNSUPPORTED');
    privateKey = deriveEoaFromPrf(res.prf.first);
  }

  const address = privateKeyToAccount(privateKey).address;
  const meta: EmbeddedWalletMeta = {
    version: 1,
    address,
    protection: 'passkey',
    passkey: { credentialId: res.credentialId, derivation, rpId: rpId() },
    delegatedChains: [],
    createdAt: Date.now(),
  };
  await saveMeta(meta);
  return { privateKey, meta };
}

export async function wipeWallet(): Promise<void> {
  await clearEmbeddedWallet();
}

export function getAddress(meta: EmbeddedWalletMeta): Address {
  return meta.address;
}
