import { SUI_ASP_LABELS_URL } from '@/config/sui-deployment';
import { routedFetch } from '@/services/tor-fetch';

/**
 * Fetch the operator-published ASP **approved set** when a source is configured
 * (`EXPO_PUBLIC_SUI_ASP_LABELS_URL`).
 *
 * The Sui transfer / withdraw spend flow must prove each input note's label
 * against the on-chain ASP Merkle root (ragequit is keystore-only — no ASP
 * proof). To rebuild that tree the client needs the full approved set,
 * oldest-first, in the order the postman inserted it.
 *
 * Two source shapes are supported:
 *  - a bare JSON array of decimal strings — label PREIMAGES (legacy operator
 *    publish); the tree leaves are `Poseidon(label)` (kind: 'labels');
 *  - `{"leaves": [...decimal strings]}` — the 0xBow ASP's
 *    `/association-set/leaves?entrypoint=...&chainId=102` response, whose
 *    values are ALREADY the tree leaves (`Poseidon(label)` hashes) and must
 *    NOT be re-hashed (kind: 'leaves'). Verified against the live ASP: the
 *    tree built directly from these values reproduces the published root.
 *
 * Returns `null` when no source is configured — the caller falls back to the
 * input notes' OWN labels (valid only when the on-chain root commits to exactly
 * that set; `reconstructAspProofs` fails loudly otherwise). A configured-but-
 * failing/malformed source THROWS (loud) rather than silently falling back, so
 * a misconfigured ASP endpoint can't masquerade as the input-labels case.
 */
export interface SuiAspSet {
  /** 'labels' = preimages (hash before building); 'leaves' = pre-hashed leaves. */
  kind: 'labels' | 'leaves';
  values: bigint[];
}

function parseDecimalArray(arr: unknown[], what: string): bigint[] {
  return arr.map((v, i) => {
    if (typeof v !== 'string' || !/^\d+$/.test(v)) {
      throw new Error(`ASP ${what} entry ${i} is not a decimal string`);
    }
    return BigInt(v);
  });
}

export async function fetchSuiApprovedSet(): Promise<SuiAspSet | null> {
  if (!SUI_ASP_LABELS_URL) return null;
  const res = await routedFetch('asp')(SUI_ASP_LABELS_URL);
  if (!res.ok) {
    throw new Error(
      `ASP set fetch failed: ${res.status} ${res.statusText} (${SUI_ASP_LABELS_URL})`,
    );
  }
  const data: unknown = await res.json();
  if (Array.isArray(data)) {
    return { kind: 'labels', values: parseDecimalArray(data, 'label-set') };
  }
  if (data && typeof data === 'object' && Array.isArray((data as { leaves?: unknown[] }).leaves)) {
    return {
      kind: 'leaves',
      values: parseDecimalArray((data as { leaves: unknown[] }).leaves, 'leaf-set'),
    };
  }
  throw new Error(
    'ASP set source must return a JSON array of decimal label strings or {"leaves": [...]}',
  );
}

/**
 * Back-compat wrapper: returns label PREIMAGES or null. Throws if the
 * configured source publishes pre-hashed leaves (callers must use
 * fetchSuiApprovedSet + reconstructAspProofsFromLeaves for that shape).
 */
export async function fetchSuiApprovedLabels(): Promise<bigint[] | null> {
  const set = await fetchSuiApprovedSet();
  if (set === null) return null;
  if (set.kind !== 'labels') {
    throw new Error(
      'ASP source publishes pre-hashed leaves; use fetchSuiApprovedSet with reconstructAspProofsFromLeaves',
    );
  }
  return set.values;
}
