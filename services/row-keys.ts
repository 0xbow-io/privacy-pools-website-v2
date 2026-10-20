// React keys for list rows that stay with the row, not its position. Pure, so
// bun tests can reach it.

/**
 * One key per row from its own identity (`base`), with an occurrence suffix only
 * for a repeated base, so two rows that share a type and id still get distinct
 * keys. Unlike an index suffix, a row keeps its key when a newer row is
 * inserted above it or the list is re-sorted, so React updates it in place
 * instead of remounting it (and restarting its animations).
 */
export function stableRowKeys<T>(rows: readonly T[], base: (row: T) => string): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const b = base(row);
    const n = seen.get(b) ?? 0;
    seen.set(b, n + 1);
    return n === 0 ? b : `${b}#${n}`;
  });
}
