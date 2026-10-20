// Map-aware JSON (de)serialization, shared by sdk-storage and the backup
// envelopes. Pure and dependency-free (no react-native) so bun tests can
// round-trip payment-request state through the exact serializers the
// backup/restore paths use.
//
// PaymentRequestRecord carries a `noteSecretsMap: Map<Hash, Secret>` and
// the SDK's Zod schema (`PaymentRequestServiceStateSchema`) validates it
// as a real `Map`. `JSON.stringify(new Map(...))` returns `'{}'`, so a
// naive stringify→parse roundtrip silently drops the slot map and the
// next `loadFromStorage()` rejects the persisted state. We tag Maps
// during stringify and reconstruct them on parse so the SDK gets back
// what it expects.

const MAP_MARKER = '__sdkMap__';

export function stringifyWithMaps(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v instanceof Map) {
      return { [MAP_MARKER]: Array.from(v.entries()) };
    }
    return v;
  });
}

export function parseWithMaps(raw: string): unknown {
  return JSON.parse(raw, (_key, v) => {
    if (
      v
      && typeof v === 'object'
      && !Array.isArray(v)
      && Array.isArray((v as Record<string, unknown>)[MAP_MARKER])
    ) {
      return new Map((v as Record<string, [unknown, unknown][]>)[MAP_MARKER]);
    }
    return v;
  });
}
