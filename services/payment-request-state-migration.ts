// v2.0 migration: pure, dependency-free (no react-native) upgrade of a
// persisted payment-request state blob written by the pre-v2.0 SDK to the
// v2.0 stored shape. Kept out of sdk-storage.ts so tests and non-RN contexts
// can import it without dragging in the react-native Platform module.

/**
 * Upgrade a persisted payment-request state blob written by the pre-v2.0 SDK
 * to the v2.0 stored shape: records gained a required `noteAddressHashes`
 * array (the public slot list). It is exactly the `noteSecretsMap` keys, so
 * we backfill it.
 *
 * A pre-v2.0 record's `paymentPrivKey` is deliberately RETAINED. The old SDK
 * generated a RANDOM ephemeral keypair and persisted the private half; the
 * current SDK derives the key from the viewing key + paymentId instead, so
 * for legacy records the stored key is the ONLY copy that pairs with the
 * published `paymentPubKey` — deleting it would permanently break discovery
 * of payments made against those old links. The SDK's runtime schema STRIPS
 * the extra field when it parses adapter reads (Zod strip semantics, not
 * reject), while ppv2's schema mirror and backup paths keep it, so raw
 * storage and backups preserve the key. Records created by the v2.0 SDK
 * never persist a key (it is re-derived on load).
 *
 * Pure and shape-tolerant (`noteSecretsMap` may arrive as a Map, an
 * array-of-entries, or a plain object depending on which serializer wrote
 * it). Returns the input untouched (same reference) when nothing needs
 * upgrading.
 */
export function upgradeLegacyPaymentRequestState<T>(state: T): T {
  if (!state || typeof state !== 'object') return state;
  const requests = (state as { requests?: unknown }).requests;
  if (!Array.isArray(requests) || requests.length === 0) return state;

  let changed = false;
  const upgraded = requests.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const record = entry as Record<string, unknown>;
    const hashes = record.noteAddressHashes;
    const needsHashes = !Array.isArray(hashes) || hashes.length === 0;
    if (!needsHashes) return entry;

    const m = record.noteSecretsMap;
    const keys: unknown[] = m instanceof Map
      ? Array.from(m.keys())
      : Array.isArray(m)
        ? m.map((e) => (Array.isArray(e) ? e[0] : undefined)).filter((k) => k !== undefined)
        : m && typeof m === 'object'
          ? Object.keys(m)
          : [];

    changed = true;
    return { ...record, noteAddressHashes: keys };
  });

  if (!changed) return state;
  return { ...(state as object), requests: upgraded } as T;
}
