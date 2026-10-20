/**
 * One token, however it is spelled.
 *
 * EVM addresses are case-insensitive, and the notes an account holds do not
 * all spell the same token the same way: one ppUSDT note can carry the
 * checksummed address and another the lowercase one, depending on which path
 * created it. The note selectors grouped by the raw string, so those two notes
 * landed in separate groups and one proof could only spend one of them (Mike,
 * 2026-09-24: a swap over two approved notes covered 18.97 of 36.5 ppUSDT,
 * with a message blaming the 5-note cap).
 *
 * The SDK compared input `tokenId`s with raw equality in the same way
 * (PoolSession.getNotesTokenId), which is why the selectors mirrored it. The
 * vendored SDK now compares them case-insensitively, so selection groups by
 * this key.
 *
 * PURE module (no react-native imports) so it is bun-testable.
 */

/** The grouping key for a note's token: the address, lowercased. */
export function tokenKey(note: { tokenId?: unknown }): string {
  return String(note.tokenId ?? '').toLowerCase();
}
