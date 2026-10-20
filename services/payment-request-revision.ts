// Payment-request store revision signal. The persisted request store is
// mutated from several places that don't share React state — the SDK's
// discovery marking a request FULFILLED, the create flow persisting a new
// record, backup/import merges, and the storage-shape migration. Consumers
// (the Payment Requests card) subscribe and reload; mutators bump. Pure and
// dependency-free so services can import it without dragging in react.

let revision = 0;
const listeners = new Set<() => void>();

/** Call after any write to a payment-request store. */
export function bumpPaymentRequestRevision(): void {
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One consumer's error must not starve the others.
    }
  }
}

/** Snapshot for useSyncExternalStore. */
export function getPaymentRequestRevision(): number {
  return revision;
}

export function subscribePaymentRequestRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
