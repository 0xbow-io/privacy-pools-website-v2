/**
 * AbortSignal helpers that also work on React Native.
 *
 * React Native installs abort-controller 3.0.0 as AbortSignal, which has no
 * throwIfAborted(), AbortSignal.timeout(), AbortSignal.any() or `reason`. On a
 * device the first throwIfAborted() threw a TypeError: every connection Test
 * came back "Could not start the anon-rpc client", and every ASP feed request
 * failed before it was sent. These use the platform versions where they exist
 * and plain AbortController equivalents where they do not.
 */

/** The signal's reason, or an AbortError where the platform gives none. */
export function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export function anySignal(signals: AbortSignal[]): AbortSignal {
  return composeSignals(signals).signal;
}

/**
 * anySignal with a way to let go. The fallback hangs a listener on every
 * input, and one input (a sender's lifetime) outlives every request, so a
 * per-request composition must be released or each RPC stays referenced for
 * the sender's life. The platform AbortSignal.any needs no release.
 */
export function composeSignals(signals: AbortSignal[]): { signal: AbortSignal; release: () => void } {
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(signals), release: () => {} };
  const controller = new AbortController();
  const detach: (() => void)[] = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      break;
    }
    const onAbort = () => controller.abort(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    detach.push(() => signal.removeEventListener('abort', onAbort));
  }
  return { signal: controller.signal, release: () => detach.forEach((fn) => fn()) };
}
