// A content key for plain data that may hold bigints, so two structurally equal
// values (a note list rebuilt by a poll) compare equal as strings. Pure, so bun
// tests can reach it.

/** Every field, in order, bigints included. Functions and undefined drop out, as JSON does. */
export function contentKey(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v.toString()}n` : v)) ?? '';
}
