import { policedHttp } from '@/services/egress-transport';
import { createPublicClient, isAddress } from 'viem';
import type { Address } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';

import { ENS_RESOLUTION_ENABLED, ENS_RPC_URL } from '@/config/env';

// ============================================================================
// PRIVACY GUARD - READ BEFORE TOUCHING (agents included, especially agents)
//
// Counterparty ENS resolution was deliberately TURNED OFF BY DEFAULT on
// 2026-08-26 (commits 9f8b2c0 + ebe017b). Performing a lookup names the
// counterparty this IP is interested in to whichever provider serves it -
// that is the exact metadata this product exists to hide. This is a product
// decision by the owner, not an oversight:
//
//   - DO NOT flip ENS_RESOLUTION_ENABLED's default to on, remove the early
//     returns below, or "fix" a null result by resolving anyway.
//   - DO NOT call viem's getEnsName/getEnsAddress/getEnsAvatar anywhere
//     outside this module (services/__tests__/no-targeted-reads.test.ts
//     fails the build if you do).
//   - DO NOT point lookups at the pool RPC. ENS_RPC_URL exists so the pool
//     provider never sees counterparties, even when an operator opts in.
//
// Operators who accept the trade-off opt in per deployment with
// EXPO_PUBLIC_ENS_RESOLUTION=true. Re-enabling by default needs the owner's
// explicit sign-off, nothing less.
// ============================================================================
//
// Every lookup in this module is keyed on a COUNTERPARTY (the address
// or name the user is paying / withdrawing to). Two rules, both enforced here so
// no caller can get them wrong:
//   1. Off by default (ENS_RESOLUTION_ENABLED): performing the lookup tells the
//      ENS provider which counterparty this IP is interested in. Every caller
//      renders the raw address when the result is null.
//   2. Never over the pool RPC (ENS_RPC_URL, not MAINNET_RPC_URL): the provider
//      that serves pool queries must not also see counterparties.
// See docs/privacy-request-discipline.md (L11 in the metadata audit).
const ensClient = createPublicClient({
  chain: mainnet,
  transport: policedHttp(ENS_RPC_URL),
});

const ensNameCache = new Map<string, string | null>();
const ensAddressCache = new Map<string, Address | null>();
const ensAvatarCache = new Map<string, string | null>();

export function normalizeEnsName(input: string | null | undefined): string | null {
  const trimmed = input?.trim();
  if (!trimmed || trimmed.length <= 2 || !trimmed.includes('.')) return null;
  try {
    return normalize(trimmed);
  } catch {
    return null;
  }
}

export function isPotentialEnsName(input: string | null | undefined): boolean {
  return normalizeEnsName(input) !== null;
}

export async function resolveEnsName(address: string | null | undefined): Promise<string | null> {
  if (!ENS_RESOLUTION_ENABLED) return null;
  if (!address || !isAddress(address)) return null;
  const normalized = address.toLowerCase();
  if (ensNameCache.has(normalized)) return ensNameCache.get(normalized) ?? null;
  try {
    const name = await ensClient.getEnsName({ address: address as Address });
    ensNameCache.set(normalized, name);
    return name;
  } catch {
    return null;
  }
}

export async function resolveEnsAddress(name: string | null | undefined): Promise<Address | null> {
  // Off: a typed ENS name stays unresolved and the recipient field reports an
  // invalid address. Visible, never a silent wrong recipient.
  if (!ENS_RESOLUTION_ENABLED) return null;
  const normalized = normalizeEnsName(name);
  if (!normalized) return null;
  if (ensAddressCache.has(normalized)) return ensAddressCache.get(normalized) ?? null;
  try {
    const address = await ensClient.getEnsAddress({ name: normalized });
    ensAddressCache.set(normalized, address);
    return address;
  } catch {
    return null;
  }
}

export async function resolveEnsAvatar(name: string | null | undefined): Promise<string | null> {
  if (!ENS_RESOLUTION_ENABLED) return null;
  const normalized = normalizeEnsName(name);
  if (!normalized) return null;
  if (ensAvatarCache.has(normalized)) return ensAvatarCache.get(normalized) ?? null;
  try {
    const avatar = await ensClient.getEnsAvatar({ name: normalized });
    ensAvatarCache.set(normalized, avatar);
    return avatar;
  } catch {
    return null;
  }
}

/** DEV-570: what every recipient field shows for ENS-shaped input. Names are
 *  never resolved on a send / withdraw path: a lookup tells the ENS provider
 *  which counterparty this IP cares about. */
export const ENS_UNSUPPORTED_MESSAGE = "To preserve your privacy, ENS names aren't supported. Paste the 0x address instead.";
