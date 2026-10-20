// Pure logic for the paid-requests record. Split from paid-requests-store.ts
// so it is testable: the store imports react-native's Platform for the
// web/native storage split, which does not load under `bun test` — which is
// why the sibling sent-transfers-store has no tests at all. Everything with a
// decision in it lives here; the store is only the storage adapter.

export interface PaidRequest {
  /** Deposit transaction hash, lowercase. */
  txHash: string;
  /** Who was actually paid (0x, original case for display). */
  recipient: string;
  /** Hex bigint in smallest units, matching the request's amount. */
  rawAmount: string;
  tokenAddress: string;
  chainId: number;
  /** The request this settled, for reconciliation in the UI. */
  requestId: string;
  timestamp: number;
  /**
   * Which request shape was paid. 'sdk' and 'v2' auto-discover (no receipt
   * exists for them); 'v1' pays out-of-band and the fields below rebuild its
   * one-time receipt link at any time. Optional: entries written before
   * 2026-08-25 carry none of this.
   */
  requestKind?: 'v1' | 'v2' | 'sdk';
  /** v1 only: everything the receipt payload needs beyond this record. */
  noteAddressHash?: string;
  commitment?: string;
  label?: string;
}

/**
 * Lowercase the two fields that are COMPARED (tx hash, token) and leave the
 * recipient's case alone — it is displayed, and checksummed addresses are how
 * users recognise them.
 */
export function normalizePaidRequest(entry: PaidRequest): PaidRequest {
  return {
    ...entry,
    txHash: entry.txHash.toLowerCase(),
    tokenAddress: entry.tokenAddress.toLowerCase(),
  };
}

/**
 * Insert or replace by txHash. Idempotent on purpose: a retry, a re-render or
 * a double-submit must not leave two records for one payment.
 */
export function upsertPaidRequest(all: PaidRequest[], entry: PaidRequest): PaidRequest[] {
  const normalized = normalizePaidRequest(entry);
  return [...all.filter((t) => t.txHash !== normalized.txHash), normalized];
}

/**
 * Parse whatever was in storage, tolerating absent/corrupt/wrong-shaped data —
 * INCLUDING a well-formed array of malformed entries. `'[{}]'` used to pass the
 * Array.isArray check and then throw in toPaidRequestTxHashSet
 * (undefined.toLowerCase()), which ran inside pools-provider's balance memo: one
 * corrupt localStorage value crashed rendering. Entries are validated
 * individually, and garbage ones are dropped rather than trusted or fatal.
 */
export function parsePaidRequests(raw: string | null): PaidRequest[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PaidRequest =>
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as PaidRequest).txHash === 'string'
      && (entry as PaidRequest).txHash.length > 0
      // Every field a consumer dereferences must be validated HERE — the
      // txHash-only check fixed one crash (cd1e773) and the viewer filter then
      // crashed on `recipient` for the same class of input (codex, round 2).
      && typeof (entry as PaidRequest).recipient === 'string',
    );
  } catch {
    return [];
  }
}

export function findPaidRequestIn(all: PaidRequest[], txHash: string | null | undefined): PaidRequest | null {
  if (!txHash) return null;
  const needle = txHash.toLowerCase();
  return all.find((t) => t.txHash === needle) ?? null;
}

/**
 * The set the balance fallback subtracts. Lowercase, because callers compare
 * against ASP feed hashes which they lowercase at the call site.
 *
 * Pass the viewer's address to keep SELF-payments out of the exclusion: paying
 * a request whose recipient is your own account is a deposit you DO own, and
 * excluding it hid the payer's own pending balance (codex finding). With no
 * address every stamped payment is excluded — the old, payer-only behaviour.
 */
export function toPaidRequestTxHashSet(
  all: PaidRequest[],
  viewerAddress?: string | null,
): Set<string> {
  const viewer = viewerAddress ? viewerAddress.toLowerCase() : null;
  return new Set(
    all
      // A record with no usable recipient cannot be proven a self-payment, so
      // it stays excluded (the pre-viewer behaviour) rather than crashing.
      .filter((t) => viewer === null
        || typeof t.recipient !== 'string'
        || t.recipient.toLowerCase() !== viewer)
      .map((t) => t.txHash.toLowerCase()),
  );
}
