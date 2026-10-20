// Storage half of services/anchor-stamps-core.ts. Same shape as
// outgoing-deposits-store: all the logic lives in the core so it is testable,
// this file only reads and writes.
//
// localStorage, NOT sessionStorage - the opposite choice to
// services/unanchored-notes-store.ts, and the difference is deliberate. An
// unanchored flag must die with the tab-scoped note cache it describes. An
// anchor stamp explains a row that is re-derived from CHAIN data on every new
// session, so a tab-scoped stamp would disappear while the row it explains came
// back. A confirmed anchor is also permanent, so nothing here goes stale.
//
// It holds no secrets: a tx hash and a commitment, both already public on
// chain. What it adds is the association to THIS owner, which is why it is
// scoped by owner and chain and never leaves the device.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { envScopedStorageKey } from '@/config/app-environment';

import {
  isAnchorTx,
  parseAnchorStamps,
  selectAnchorTxHashes,
  withAnchorStamps,
  type AnchorStamp,
} from '@/services/anchor-stamps-core';

// Environment-scoped (config/app-environment.ts): prod and staging deploy on the
// same chain ids, so a chain-keyed record must not cross between worlds.
const STORAGE_KEY = envScopedStorageKey('ppv2_anchor_stamps_v1');

// Web: localStorage. Native: SecureStore, like the other device-backed history
// stores (sent-transfers-store, outgoing-deposits-store). This file used to
// return nothing off the web, so a native claim could never record the one
// signal that tells a gasless anchor from a real withdrawal, and its relayer
// fee rendered as a phantom withdrawal (codex, 2026-09-04).
function storageGetItem(key: string): string | null {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  try {
    return SecureStore.getItem(key);
  } catch {
    return null;
  }
}

function read(): AnchorStamp[] {
  try {
    const raw = storageGetItem(STORAGE_KEY);
    return raw ? parseAnchorStamps(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function write(stamps: AnchorStamp[]): void {
  try {
    const value = JSON.stringify(stamps);
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, value);
    } else {
      SecureStore.setItem(STORAGE_KEY, value);
    }
  } catch {
    // A full or blocked store must never break a claim. The anchor already
    // happened on chain; a missing stamp costs a row's label, not the funds.
  }
}

/**
 * Record a CONFIRMED anchor leg.
 *
 * Call once per confirmed transaction with exactly the commitments that
 * transaction spent - for the self-funded path that is the single commitment of
 * that loop iteration, not the whole receipt. See the core for why.
 *
 * Never call this on an unconfirmed or unknown outcome: the stamp's only job is
 * to license a confident label, so a speculative one would license a false one.
 */
export function recordAnchorStamps(
  owner: string | null | undefined,
  chainId: number,
  txHash: string | null | undefined,
  commitments: readonly string[],
): void {
  if (!owner || !txHash || commitments.length === 0) return;
  const before = read();
  const after = withAnchorStamps(before, owner, chainId, txHash, commitments);
  // Compare CONTENT, not length. Length is not a change signal for a capped
  // list: once the store reaches MAX_ANCHOR_STAMPS the core drops the oldest
  // entry for each new one, so a genuine append leaves the length identical and
  // a length test silently discards every stamp from then on. That guard was
  // copied from unanchored-notes-store, which has no cap and where it is fine
  // (codex caught it here). The array is small and bounded, so stringifying is
  // cheaper than the class of bug it removes.
  if (JSON.stringify(after) !== JSON.stringify(before)) write(after);
}

/** Was this transaction one of my confirmed anchors? */
export function isRecordedAnchorTx(
  owner: string | null | undefined,
  chainId: number,
  txHash: string | null | undefined,
): boolean {
  return isAnchorTx(read(), owner, chainId, txHash);
}

/** All my confirmed anchor tx hashes on this chain, lowercase. */
export function readAnchorTxHashes(
  owner: string | null | undefined,
  chainId: number,
): ReadonlySet<string> {
  return selectAnchorTxHashes(read(), owner, chainId);
}

/**
 * The same across several chains, in one read. The transactions table and the
 * event snapshot span every configured chain, so an anchor's row from a chain
 * the user has since switched away from still needs its stamp (codex,
 * 2026-09-04: reading only the default chain left it rendering as a withdrawal).
 */
export function readAnchorTxHashesForChains(
  owner: string | null | undefined,
  chainIds: readonly number[],
): ReadonlySet<string> {
  const stamps = read();
  const out = new Set<string>();
  for (const chainId of chainIds) {
    for (const hash of selectAnchorTxHashes(stamps, owner, chainId)) out.add(hash);
  }
  return out;
}
