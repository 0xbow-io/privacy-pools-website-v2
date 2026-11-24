/**
 * The viewing key a Stellar account has published, read from the keystore
 * contract's WHOLE event history rather than asked for by account.
 *
 * A `get_viewing_key(account)` simulation names the account to the RPC
 * provider, which is what the EVM app stopped doing for its own account
 * (services/__tests__/no-targeted-reads.test.ts, services/viewing-key-cache.ts).
 * The keystore emits `ViewingKeySet { #[topic] account, old_viewing_key,
 * viewing_key }` on every `set_viewing_key`, and the ASP archives the
 * keystore's events (GET /:chainId/public/events?contractId=…, the request the
 * SDK's own keystore sync makes). So the latest such event for the account IS
 * its published key, found locally in a page that names nobody.
 *
 * PURE: the ScVal decoder is injected (the SDK's `decodeScVal`).
 */

/** The fields of a StellarLog this reads. */
export type KeystoreEventLike = { id?: string; type?: string; topics: readonly string[]; data: string };

export const ZERO_VIEWING_KEY = `0x${'00'.repeat(32)}`;

/** The contract event's name: the struct's snake_case (soroban `#[contractevent]`). */
const VIEWING_KEY_SET = 'viewing_key_set';

function toHex(value: unknown): string | null {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) return null;
    return `0x${Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  if (typeof value === 'string' && /^(0x)?[0-9a-f]{64}$/i.test(value)) {
    return `0x${value.replace(/^0x/i, '').toLowerCase()}`;
  }
  return null;
}

/**
 * The account's published viewing key (0x hex, 32 bytes), the zero key when it
 * never set one, from the keystore's events in chain order. An event this
 * cannot read is skipped, never guessed at.
 */
export function publishedStellarViewingKey(
  events: readonly KeystoreEventLike[],
  account: string,
  decode: (base64: string) => unknown,
): string {
  let key = ZERO_VIEWING_KEY;
  // Event ids are fixed-width TOIDs, so string order is chain order.
  const ordered = [...events].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
  for (const event of ordered) {
    try {
      const name = event.type ?? String(decode(event.topics[0] ?? ''));
      if (name !== VIEWING_KEY_SET) continue;
      if (String(decode(event.topics[1] ?? '')) !== account) continue;
      const data = decode(event.data) as Record<string, unknown> | null;
      const next = data && typeof data === 'object' ? toHex(data.viewing_key) : null;
      if (next) key = next;
    } catch {
      // Not a ViewingKeySet this build can read.
    }
  }
  return key;
}
