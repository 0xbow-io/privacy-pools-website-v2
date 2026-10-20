/**
 * One account's notes across every chain, each commitment once.
 *
 * The live session holds only its own chain's notes, and every other chain's
 * are in the stored exports. Anything that decides whether a row is MINE reads
 * both, so anything that works out WHAT the row was (direction, amount) has to
 * read the same set, or a row can be mine and still unexplained. That is how an
 * own send on another chain read "Transfer · Private" with no amount (Mike,
 * 2026-09-24).
 *
 * The live copy wins over a stored one of the same commitment: it is the
 * fresher status.
 *
 * PURE module (no react-native imports) so it is bun-testable.
 */
export function mergeNotesByCommitment<T extends { commitment?: unknown }>(
  live: readonly T[],
  stored: ReadonlyArray<readonly T[]>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const add = (n: T) => {
    const key = String(n.commitment ?? '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };
  for (const n of live) add(n);
  for (const list of stored) for (const n of list) add(n);
  return out;
}
