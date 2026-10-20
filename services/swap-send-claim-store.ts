// Storage half of services/swap-send-claim.ts: sealed claim records for private
// swap-sends to unregistered recipients (DEV-511). Only ciphertext encrypted to
// the sender's viewing key is stored; the note secret never lands in plaintext.
// Web: localStorage; native: SecureStore, like the other per-device stores.
//
// ONE KEY PER CLAIM, never a shared list: two tabs sending at once would each
// read the list, add their own claim and write it back, and the second write
// would drop the first claim (cubic, #274). A claim is written under
// `<prefix>:c:<id>` and found by its relayed hash through `<prefix>:t:<hash>`,
// so every write touches a key nothing else writes. The first release's list
// key is still read.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { envScopedStorageKey } from '@/config/app-environment';
import {
  parseSealedClaim,
  parseSealedClaims,
  sealedClaimsForTx,
  type SealedSwapSendClaim,
} from '@/services/swap-send-claim';

const LEGACY_LIST_KEY = envScopedStorageKey('ppv2_swap_send_claims_v1');
const PREFIX = envScopedStorageKey('ppv2_swap_send_claim_v2');
// SecureStore keys allow only [A-Za-z0-9._-].
const claimKey = (id: string) => `${PREFIX}.c.${id}`;
const txKey = (txHash: string) => `${PREFIX}.t.${txHash.toLowerCase()}`;

function getOrThrow(key: string): string | null {
  if (Platform.OS === 'web') {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  }
  return SecureStore.getItem(key);
}

function setOrThrow(key: string, value: string): void {
  if (Platform.OS === 'web') {
    if (typeof localStorage === 'undefined') throw new Error('no storage');
    localStorage.setItem(key, value);
    return;
  }
  SecureStore.setItem(key, value);
}

function read(key: string): string | null {
  try {
    return getOrThrow(key);
  } catch {
    return null;
  }
}

function readClaim(id: string): SealedSwapSendClaim | null {
  return parseSealedClaim(read(claimKey(id)));
}

/** Store a sealed claim under its own key. True only when it reads back. */
export function storeSealedClaim(record: SealedSwapSendClaim): boolean {
  try {
    setOrThrow(claimKey(record.id), JSON.stringify(record));
  } catch {
    return false;
  }
  return readClaim(record.id)?.ciphertext === record.ciphertext;
}

/** Attach the relayed hash: the record itself, plus the hash -> id pointer. */
export function rekeyStoredClaim(id: string, txHash: string): boolean {
  const record = readClaim(id);
  if (!record) return false;
  const hash = txHash.toLowerCase();
  // Each write is tried on its own (and the pointer twice): a failed pointer
  // still leaves the hash on the record, which the claim-key scan below finds
  // on web; a failed record update still leaves the pointer, which alone
  // identifies the claim.
  const attempt = (fn: () => void) => { try { fn(); return true; } catch { return false; } };
  attempt(() => setOrThrow(claimKey(id), JSON.stringify({ ...record, txHash: hash })));
  if (!attempt(() => setOrThrow(txKey(hash), id))) attempt(() => setOrThrow(txKey(hash), id));
  return read(txKey(hash)) === id || readClaim(id)?.txHash === hash;
}

/** Web only: every per-claim key (native SecureStore cannot enumerate). */
function scanClaimKeys(): SealedSwapSendClaim[] {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return [];
  const out: SealedSwapSendClaim[] = [];
  try {
    const head = `${PREFIX}.c.`;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(head)) continue;
      const r = parseSealedClaim(localStorage.getItem(key));
      if (r) out.push(r);
    }
  } catch { /* unreadable storage finds nothing */ }
  return out;
}

export function findSealedClaimsForTx(txHash: string | null | undefined): SealedSwapSendClaim[] {
  if (!txHash) return [];
  const hash = txHash.toLowerCase();
  const out: SealedSwapSendClaim[] = [];
  // The pointer names the claim even when the record's own hash write failed.
  const id = read(txKey(hash));
  const own = id ? readClaim(id) : null;
  if (own) out.push({ ...own, txHash: hash });
  // No pointer (its write failed): the record still carries the hash.
  if (out.length === 0) for (const r of sealedClaimsForTx(scanClaimKeys(), hash)) out.push(r);
  const legacy = parseSealedClaims(read(LEGACY_LIST_KEY));
  if (legacy.ok) {
    for (const r of sealedClaimsForTx(legacy.list, txHash)) if (!out.some((o) => o.id === r.id)) out.push(r);
  }
  return out;
}
