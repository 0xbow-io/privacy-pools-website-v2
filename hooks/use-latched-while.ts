import { useState } from 'react';

import { initialLatch, stepLatch, type LatchState } from '@/services/latched-value';

/**
 * Hold `value` steady while `frozen` is true, without touching the query that
 * produced it.
 *
 * Use this instead of a poll interval switched off while busy, or an
 * `enabled: ... && !busy`. Those pause the REQUEST, which tells an RPC or the
 * ASP exactly when this client had a transaction in flight — the poll goes
 * quiet for its duration and resumes when it settles. Keep the cadence fixed
 * and latch the display instead: the wire looks the same whatever the user is
 * doing, and the UI still does not flicker back to a pre-send figure.
 *
 * See services/latched-value.ts for the state machine and its edge behaviour.
 */
export function useLatchedWhile<T>(
  value: T | undefined,
  frozen: boolean,
  /** Whose value this is (address, chain, …). A change resets the latch. */
  identity = '',
): T | undefined {
  // React's documented "adjust state during render" pattern rather than a ref:
  // a ref written during render is unsafe under concurrent rendering, and an
  // effect would let one frame paint the live value before the latch closed —
  // which is the flicker this exists to prevent. `stepLatch` is idempotent, so
  // the immediate re-render settles in one extra pass and cannot loop.
  const [latch, setLatch] = useState<LatchState<T>>(initialLatch<T>);
  const next = stepLatch(latch, value, frozen, identity);
  if (
    next.value !== latch.value
    || next.held !== latch.held
    || next.wasFrozen !== latch.wasFrozen
    || next.identity !== latch.identity
  ) {
    setLatch(next);
  }
  return next.value;
}
