import { useCallback, useRef } from 'react';

/**
 * SYNCHRONOUS double-submit lock for money handlers (codex round 1, P0).
 *
 * React state (isLoading/isBusy + a disabled prop) only takes effect on the
 * NEXT render, so two press events landing in the same tick both enter the
 * handler — two broadcasts, two proofs, or a same-nullifier race. A ref
 * flips synchronously in the same tick; the second press sees it and drops.
 *
 * One lock per provider: mutually exclusive operations in one modal share
 * the same instance, so e.g. "pay via wallet" can't start while "pay via
 * transfer" is mid-flight. The wrapper releases in its own finally, which
 * runs after the wrapped handler's OWN finally blocks — early returns and
 * throws inside the handler all release correctly.
 */
export function useOpLock() {
  const lockedRef = useRef(false);
  return useCallback(
    <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) =>
      async (...args: A): Promise<void> => {
        if (lockedRef.current) return;
        lockedRef.current = true;
        try {
          await fn(...args);
        } finally {
          lockedRef.current = false;
        }
      },
    [],
  );
}
