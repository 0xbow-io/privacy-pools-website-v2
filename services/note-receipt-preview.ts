/**
 * A SHOWABLE form of a receipt URL: the verified domain and path, then an
 * ellipsis where the payload would be.
 *
 * The payload is the claim secret, so the screen deliberately never printed the
 * link at all (DEV-216). That made the box look broken, and left no way to see
 * you were about to send the right thing. This is the middle ground (Pat,
 * 2026-08-31): show where the link goes, keep the part that moves money off the
 * display. Getting the real link still means pressing Copy.
 *
 * It shows NO characters of the payload, and that is a correction rather than
 * caution. The first version kept eight, on the theory that they would let a
 * sender tell two receipts apart. They cannot: encodeNoteReceiptForUrl
 * base64url-encodes JSON.stringify(receipt), every producer puts `notes` first,
 * so EVERY real receipt begins `eyJub3Rl` - the encoding of `{"note`. The
 * chain, owner, commitment and secret all change without changing those
 * characters. They were a schema prefix wearing the costume of an identifier,
 * and showing them implied a uniqueness that does not exist. Per-receipt
 * differentiation would need its own privacy review; a commitment or digest is
 * itself note-identifying.
 *
 * Fails CLOSED. Anything that is not recognisably one of our receipt URLs
 * collapses to an opaque ellipsis rather than being echoed back, so this is
 * safe to point at a string whose provenance you have not checked.
 */
export function previewNoteReceiptUrl(url: string): string {
  const marker = '/import-note/';
  // FIRST occurrence, deliberately: a later marker inside a query or fragment
  // must not be allowed to preserve the real payload ahead of it.
  const at = url.indexOf(marker);
  if (at === -1) return '…';
  return `${url.slice(0, at + marker.length)}…`;
}
