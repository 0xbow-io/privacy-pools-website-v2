/**
 * Which registered-wallet payment requests look paid, from the notes this
 * session already holds.
 *
 * A registered (v2) request is paid with an ordinary private transfer, which
 * carries no request tag, so the SDK can never mark it FULFILLED and the card
 * showed every one of them OPEN after it was paid (Mike, 2026-09-24: 1.2 USDC
 * paid, still open). The only evidence is the note itself: a RECEIVED note on
 * the request's chain, in the requested token, for exactly the requested
 * value, that arrived after the request was made. Each note pays at most one
 * request, oldest request first, so two equal requests need two payments.
 *
 * It is evidence, not proof, so an ambiguous match stays OPEN: a request with
 * more than one candidate note (a round amount that also arrived some other
 * way) is left alone rather than shown as paid on a guess.
 *
 * Local data only: nothing here makes a request.
 *
 * PURE module (no react-native imports) so it is bun-testable.
 */

export type SessionRequestLike = {
  requestId: string;
  chainId: number;
  tokenAddress: string;
  /** Hex amount in base units. */
  amount: string;
  createdAtMs: number;
};

export type ReceivedNoteLike = {
  commitment: string;
  tokenId?: unknown;
  value?: unknown;
  /** Healed to unix seconds; a raw block number reads as "no time yet". */
  createdAtBlock?: string | null;
  txHash?: string | null;
};

/** A payment can land a little before the request's own clock reads it. */
const CLOCK_SKEW_MS = 60_000;

function toBig(v: unknown): bigint | null {
  try { return BigInt(String(v)); } catch { return null; }
}

function noteMs(createdAtBlock: string | null | undefined): number {
  const s = toBig(createdAtBlock ?? '0x0');
  if (s === null || s < 1_000_000_000n) return 0;
  return Number(s) * 1000;
}

export function paidSessionRequestIds(
  requests: readonly SessionRequestLike[],
  notes: readonly ReceivedNoteLike[],
  chainId: number,
  /** True for a tx this device made itself (its change, its deposits, its swaps). */
  isOwnTx: (txHash: string) => boolean,
): Set<string> {
  const paid = new Set<string>();
  const used = new Set<string>();
  const candidates = notes.filter((n) => {
    const tx = String(n.txHash ?? '').toLowerCase();
    return !!tx && !isOwnTx(tx) && noteMs(n.createdAtBlock) > 0;
  });
  const ordered = [...requests]
    .filter((r) => r.chainId === chainId)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  for (const r of ordered) {
    const want = toBig(r.amount);
    if (want === null || want <= 0n) continue;
    const token = r.tokenAddress.toLowerCase();
    const matches = candidates.filter((n) => !used.has(n.commitment)
      && String(n.tokenId ?? '').toLowerCase() === token
      && toBig(n.value) === want
      && noteMs(n.createdAtBlock) >= r.createdAtMs - CLOCK_SKEW_MS);
    if (matches.length === 1) {
      used.add(matches[0].commitment);
      paid.add(r.requestId);
    }
  }
  return paid;
}
