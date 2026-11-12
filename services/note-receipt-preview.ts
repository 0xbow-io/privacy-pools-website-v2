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
  const marker = '/import-note';
  // FIRST occurrence, deliberately: a later marker inside a query or fragment
  // must not be allowed to preserve the real payload ahead of it.
  const at = url.indexOf(marker);
  // `/import-note#<payload>`, or `/import-note/<payload>` in older links.
  const separator = url[at + marker.length];
  if (at !== -1 && separator === '?') return previewStellarReceiptUrl(url, at + marker.length);
  if (at === -1 || (separator !== '#' && separator !== '/')) return '…';
  return `${url.slice(0, at + marker.length + 1)}…`;
}

// The only routing params a Stellar link carries (services/stellar/stellar-link.ts),
// and the shape of a value they may hold. Anything else is not ours to echo.
const STELLAR_ROUTING_KEYS = new Set(['stellar', 'env']);
const ROUTING_VALUE = /^[A-Za-z0-9-]{1,32}$/;

/**
 * `/import-note?stellar=true&env=prod#<payload>`: the routing params sit
 * between the path and the fragment. Shows everything up to and including the
 * `#` only when every query param is a known routing key with a short plain
 * value. Otherwise fails closed, like the rest of this file. `queryAt` is the
 * index of the `?`.
 */
function previewStellarReceiptUrl(url: string, queryAt: number): string {
  const hashAt = url.indexOf('#', queryAt);
  if (hashAt === -1) return '…';
  const query = url.slice(queryAt + 1, hashAt);
  if (!query) return '…';
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) return '…';
    if (!STELLAR_ROUTING_KEYS.has(pair.slice(0, eq)) || !ROUTING_VALUE.test(pair.slice(eq + 1))) return '…';
  }
  return `${url.slice(0, hashAt + 1)}…`;
}
