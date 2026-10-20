import type { Hash, Hex } from 'viem';

/**
 * Routing for the two per-note contract reads the vendored SDK still issues
 * against the pool, the commitments and spentNullifiers views. Both name a
 * value only the note's owner can compute, so neither may ever reach the RPC
 * provider (docs/privacy-request-discipline.md). They are answered from the
 * bulk OnChainNoteIndex instead, and when the index has not seen the value
 * yet the answer is "not observed" (0), never a forwarded read.
 *
 * Why 0 is safe: every SDK caller of `commitments` goes through
 * `resolveCommitmentTimestamp`, which retries a 0 and then reports the note
 * as unresolved. Discovery keeps an unresolved candidate's block below its
 * cursor and re-scans it on the next pass; persistence skips it and leaves it
 * to discovery. Nothing is deleted on a 0. `spentNullifiers` callers only test
 * `> 0`, so an unseen nullifier reads "not observed spent", which the next
 * bulk status sync corrects if a spend landed a moment ago.
 *
 * The 4-times-per-transfer "RPC saw a commitment in the body" finding of the
 * e2e privacy gate was the previous fall-through to the real read for a
 * just-mined change note. Pure module so bun can pin the rule.
 */
export type PoolReadIndex = {
  hasCommitment(commitment: Hash): boolean;
  commitmentTimestamp(commitment: Hash): Hex | null;
  isNullifierSpent(nullifier: Hash): boolean;
  nullifierSpentAt(nullifier: Hash): Hex | null;
};

export type PoolReadFunction = 'commitments' | 'spentNullifiers';

export type PoolRead = { functionName: PoolReadFunction; value: Hash };

/** The answer for a value the index has not seen: "not observed". */
export const UNSEEN_POOL_READ_ANSWER = 0n;

/**
 * Recognise a `readContract` call that names a commitment or nullifier
 * against the pool. Anything else is not a pool read and may be forwarded.
 */
export function classifyPoolRead(params: unknown, poolAddress: string): PoolRead | null {
  const p = params as { functionName?: unknown; args?: unknown; address?: unknown } | null;
  if (!p || typeof p !== 'object') return null;
  const fn = typeof p.functionName === 'string' ? p.functionName : '';
  if (fn !== 'commitments' && fn !== 'spentNullifiers') return null;
  if (typeof p.address !== 'string' || p.address.toLowerCase() !== poolAddress.toLowerCase()) return null;
  if (!Array.isArray(p.args) || p.args.length !== 1) return null;
  const arg = p.args[0] as bigint | string | number;
  let value: Hash;
  try {
    value = `0x${BigInt(arg).toString(16)}` as Hash;
  } catch {
    return null;
  }
  return { functionName: fn, value };
}

/** Answer from what the index has seen, or `null` when it has not seen the value. */
export function answerFromIndex(index: PoolReadIndex, read: PoolRead): bigint | null {
  if (read.functionName === 'commitments') {
    if (!index.hasCommitment(read.value)) return null;
    // Seen: the verified timestamp, or 0 while it did not reproduce a leaf yet.
    const ts = index.commitmentTimestamp(read.value);
    return ts ? BigInt(ts) : 0n;
  }
  if (!index.isNullifierSpent(read.value)) return null;
  // Spent: when it was spent, or 1 when only the fact is known (callers test > 0).
  const spentAt = index.nullifierSpentAt(read.value);
  return spentAt ? BigInt(spentAt) : 1n;
}

/**
 * Answer a pool read without ever naming the value to the RPC: from the index
 * as built, else after one catch-up, else "not observed".
 */
export async function routePoolRead(
  index: PoolReadIndex,
  read: PoolRead,
  catchUp: () => Promise<void>,
): Promise<bigint> {
  const first = answerFromIndex(index, read);
  if (first !== null) return first;
  await catchUp();
  const second = answerFromIndex(index, read);
  if (second !== null) return second;
  return UNSEEN_POOL_READ_ANSWER;
}
