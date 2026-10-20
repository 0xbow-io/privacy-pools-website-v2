// Small, shared string helpers for hex values and addresses.
//
// Both were duplicated across modal providers. Moved verbatim; only the callers
// whose copies were byte-identical now import from here.
//
// Deliberately NOT here: `normalizeHashValue`. Two versions of that name exist in
// the codebase and they disagree — the sdk/pools one pads a decimal value to 64
// hex characters, the withdraw one returns 0x values untouched and does not pad.
// They are different functions wearing the same name, so unifying them is a
// behaviour change to be made on purpose, with the set-membership comparisons
// that depend on them re-checked, not a refactor.
//
// UPDATE 2026-08-28: the comparison that actually depended on the difference —
// association-set LABEL-HASH membership — no longer does. Both surfaces now go
// through services/leaf-gate.ts `normalizeLeafHash`, which is the PADDED form
// (the shape the SDK stores leaves in); the unpadded variant that remains in
// withdraw-modal-provider.tsx is applied to Sui note COMMITMENTS, where it
// never met a leaf. The two are still different functions with one name, so
// the warning above stands for any NEW caller.

/**
 * Lowercase a hex string, preserving null/undefined as null.
 *
 * Only case-folds: no padding, no 0x insertion, no validation. Callers compare
 * the result against other lowercased values.
 */
export function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.toLowerCase();
}

/**
 * `0x1234…abcd` for display.
 *
 * Strings under 10 characters are returned unchanged: slicing 6 from the front
 * and 4 from the back of a shorter value would repeat its middle, which reads as
 * a longer address than it is.
 */
export function truncateAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
