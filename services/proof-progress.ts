// Transact-proof progress bus.
//
// The SDK's BatchWithdrawOrchestrator generates one ZK proof per note group
// with no progress callback, so a full-balance batch withdrawal can sit in
// `prepareBatchWithdraw` for minutes with zero feedback. ppv2's proof service
// wrapper (services/sdk-setup.ts → createProofService) emits one event here
// per completed transact proof; the withdraw modal subscribes for the duration
// of a batch confirm and maps ticks onto a "proof i of N" progress bar.
//
// Events also fire during single withdrawals/transfers — harmless, nobody is
// subscribed then. Only one transact flow runs at a time (all flows are
// modal-driven), so listeners don't need any scoping key.

type ProofProgressListener = () => void;

const listeners = new Set<ProofProgressListener>();

/** Subscribe to transact-proof completions. Returns the unsubscribe fn. */
export function subscribeProofProgress(listener: ProofProgressListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify listeners that one transact proof finished generating. */
export function emitTransactProofGenerated(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken listener must never break proof generation itself.
    }
  }
}
