// What the session's own-account keystore reads do when the bulk registries
// cannot answer yet (services/keystore-registry-reads.ts).
//
// Default (strict): wait, bounded, for the background grid, then refuse with
// "still syncing". Never a guess, never a per-account chain read.
//
// Spend and exit scope: people can always spend and exit, so a read made on
// their behalf never waits and never refuses. A registry hit still answers
// (the hash is write-once, so a hit is right at any age); only when the local
// copy has nothing to say does the read fall back to the chain, as before.
let depth = 0;

export function chainFallbackAllowed(): boolean {
  return depth > 0;
}

export async function withChainFallback<T>(run: () => Promise<T>): Promise<T> {
  depth += 1;
  try {
    return await run();
  } finally {
    depth -= 1;
  }
}

/** The pool-session methods that spend or exit: they run in the fallback scope. */
export const SPEND_AND_EXIT_METHODS = [
  'prepareTransfer',
  'prepareWithdraw',
  'prepareRageQuit',
  'prepareBatchWithdraw',
  'prepareFulfillPaymentRequest',
  'relayTransfer',
  'relayWithdraw',
  'relayBatchWithdraw',
  'relayWithdrawAndSwap',
  'registerAndWithdraw',
  'fulfillPaymentRequest',
] as const;

/** Run a spend/exit session's methods in the fallback scope. Returns the same object. */
export function scopeSpendAndExitMethods<T extends object>(session: T): T {
  const target = session as unknown as Record<string, unknown>;
  for (const name of SPEND_AND_EXIT_METHODS) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = (...args: unknown[]) => withChainFallback(() => (original as (...a: unknown[]) => Promise<unknown>).apply(session, args));
  }
  return session;
}
