// Storage half of services/unanchored-notes-core.ts. Same shape as
// outgoing-deposits-store: the pure list logic lives in the core so it is
// testable, this file only reads and writes it.
//
// Why it exists: Pat, 2026-09-01. He imported a transfer receipt device-only,
// went to My balances, and saw the value with no way to act on it. The claim
// callout there asks "is this wallet unregistered?"
// (components/pools/my-privacy-pools.tsx) and he WAS registered, so it stayed
// hidden while his note remained reachable only through the link. Close that tab
// without the link and the balance is unreachable, with nothing on screen ever
// having said so.
//
// sessionStorage, deliberately, matching the note cache in
// components/sdk-provider.tsx: the flag must live exactly as long as the note it
// describes. A new tab has neither, so there is nothing to flag and nothing about
// the user's holdings outlives the tab that held them.
import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';

import {
  parseUnanchoredEntries,
  selectUnanchoredCommitments,
  withUnanchoredNotes,
  withoutUnanchoredNotes,
  type UnanchoredEntry,
} from '@/services/unanchored-notes-core';

// Environment-scoped (config/app-environment.ts): prod and staging deploy on the
// same chain ids, so a chain-keyed record must not cross between worlds.
const STORAGE_KEY = envScopedStorageKey('ppv2_unanchored_notes_v1');

function read(): UnanchoredEntry[] {
  if (Platform.OS !== 'web') return [];
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? parseUnanchoredEntries(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function write(entries: UnanchoredEntry[]): void {
  if (Platform.OS !== 'web') return;
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // A full or blocked store must never break an import. The note itself is
    // already saved; a missing flag costs the callout, not the funds.
  }
}

/** Record that these commitments reached the device WITHOUT being anchored. */
export function recordUnanchoredNotes(
  owner: string | null | undefined,
  chainId: number,
  commitments: readonly string[],
): void {
  if (!owner || commitments.length === 0) return;
  const before = read();
  const after = withUnanchoredNotes(before, owner, chainId, commitments);
  if (after.length !== before.length) write(after);
}

/** Clear the flag. ONLY on a positively confirmed anchor (see the core's note). */
export function clearUnanchoredNotes(
  owner: string | null | undefined,
  chainId: number,
  commitments: readonly string[],
): void {
  if (!owner || commitments.length === 0) return;
  const before = read();
  const after = withoutUnanchoredNotes(before, owner, chainId, commitments);
  if (after.length !== before.length) write(after);
}

/** Commitments this owner holds on this chain that are link-only, lowercase. */
export function readUnanchoredCommitments(
  owner: string | null | undefined,
  chainId: number,
): ReadonlySet<string> {
  return selectUnanchoredCommitments(read(), owner, chainId);
}
