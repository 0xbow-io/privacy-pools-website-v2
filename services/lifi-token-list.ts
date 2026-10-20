// LiFi's token list for one chain, reduced to the addresses LiFi marks
// `verified`. Every row carries a `verificationStatus` ('verified' | 'flagged'),
// so a wallet token LiFi can route AND vouches for is the second keep-signal
// next to Alchemy's price (services/token-spam-filter).
//
// The whole chain list is fetched, never a per-token lookup, so the request
// says nothing about which tokens the wallet holds. It runs on the public feed
// grid (services/public-feeds.ts), so its timing says nothing either. The
// reduced set is kept in localStorage, so a returning visitor has it at once
// and the ~550 KB download happens at most once per interval, in the
// background.
import { Platform } from 'react-native';

import { envScopedStorageKey } from '@/config/app-environment';
import { LIFI_API_KEY, NATIVE_ASSET_ADDRESS } from '@/config/intent-swaps';

const LIFI_NATIVE = '0x0000000000000000000000000000000000000000';

interface LifiTokenRow {
  address?: unknown;
  chainId?: unknown;
  verificationStatus?: unknown;
}

/** Lowercase addresses LiFi verifies on `chainId`; native is reported as our 0xeee sentinel. */
export function parseLifiVerifiedTokens(body: unknown, chainId: number): Set<string> {
  const out = new Set<string>();
  const rows = (body as { tokens?: Record<string, unknown> } | null)?.tokens?.[String(chainId)];
  if (!Array.isArray(rows)) return out;
  for (const row of rows as LifiTokenRow[]) {
    if (row?.verificationStatus !== 'verified' || typeof row.address !== 'string') continue;
    if (row.chainId !== undefined && row.chainId !== chainId) continue;
    const address = row.address.toLowerCase();
    out.add(address === LIFI_NATIVE ? NATIVE_ASSET_ADDRESS.toLowerCase() : address);
  }
  return out;
}

export const feedLifiVerifiedTokens = (chainId: number) => `lifi-verified-tokens:${chainId}`;

/** The list changes slowly and is large, so a good copy is kept this long. */
export const LIFI_VERIFIED_TOKENS_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * The grid tick. Much shorter than the max age so a failed download is retried
 * soon; a tick with a fresh copy in hand makes no request.
 */
export const LIFI_VERIFIED_TOKENS_INTERVAL_MS = 15 * 60_000;

const inMemory = new Map<number, { at: number; verified: Set<string> }>();

const storageKey = (chainId: number) => envScopedStorageKey(`ppv2_lifi_verified_v1_${chainId}`);

interface StoredList {
  at: number;
  /** Addresses without the 0x prefix, comma-joined: about 40 bytes per token. */
  addresses: string;
}

export function encodeVerifiedTokens(verified: ReadonlySet<string>, at: number): string {
  return JSON.stringify({ at, addresses: [...verified].map((a) => a.slice(2)).join(',') } satisfies StoredList);
}

export function decodeVerifiedTokens(
  raw: string | null,
  now: number,
  maxAgeMs: number,
): { at: number; verified: Set<string> } | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredList>;
    if (typeof stored.at !== 'number' || typeof stored.addresses !== 'string') return null;
    if (now - stored.at > maxAgeMs || stored.at > now) return null;
    const verified = new Set(
      stored.addresses.split(',').filter((a) => /^[0-9a-f]{40}$/.test(a)).map((a) => `0x${a}`),
    );
    return verified.size > 0 ? { at: stored.at, verified } : null;
  } catch {
    return null;
  }
}

function readStored(chainId: number): { at: number; verified: Set<string> } | null {
  if (Platform.OS !== 'web') return null;
  try {
    if (typeof localStorage === 'undefined') return null;
    return decodeVerifiedTokens(localStorage.getItem(storageKey(chainId)), Date.now(), LIFI_VERIFIED_TOKENS_MAX_AGE_MS);
  } catch {
    return null;
  }
}

function writeStored(chainId: number, verified: ReadonlySet<string>): void {
  if (Platform.OS !== 'web') return;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey(chainId), encodeVerifiedTokens(verified, Date.now()));
  } catch {
    // Quota or blocked storage: the next tick fetches again.
  }
}

/**
 * For the feed grid (services/public-feeds.ts): the copy in memory or storage
 * while it is fresh, else a fetch. Throws so the grid keeps the last good list.
 */
export async function fetchLifiVerifiedTokens(chainId: number): Promise<Set<string>> {
  const held = inMemory.get(chainId);
  const now = Date.now();
  // `held.at` must not be in the FUTURE either: after the clock moves
  // backwards a stale entry's age (now - held.at) goes negative and would
  // stay "fresh" forever, keeping an old verified set usable indefinitely.
  // Matches the same guard `decodeVerifiedTokens` applies to the stored copy.
  if (held && held.at <= now && now - held.at <= LIFI_VERIFIED_TOKENS_MAX_AGE_MS) return held.verified;
  const stored = readStored(chainId);
  if (stored) {
    inMemory.set(chainId, stored);
    return stored.verified;
  }
  const res = await fetch(`https://li.quest/v1/tokens?chains=${chainId}`, {
    headers: LIFI_API_KEY ? { 'x-lifi-api-key': LIFI_API_KEY } : undefined,
    signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(30_000) : undefined,
  });
  if (!res.ok) throw new Error(`LiFi tokens ${res.status}`);
  const verified = parseLifiVerifiedTokens(await res.json(), chainId);
  if (verified.size === 0) throw new Error(`LiFi lists no verified tokens on ${chainId}`);
  inMemory.set(chainId, { at: Date.now(), verified });
  writeStored(chainId, verified);
  return verified;
}
