/**
 * Let React commit and the browser paint before synchronous work continues.
 *
 * A handler that sets state and then does something expensive IN THE SAME TICK
 * never shows that state: React cannot commit, the browser cannot paint, and
 * the control the user pressed looks dead until the work finishes. Pressing
 * Confirm on a swap did exactly that, because `selectApprovedNotes` runs
 * synchronously and can take seconds on a large note set (QA, 2026-09-22).
 *
 * `requestAnimationFrame` resolves after the paint that follows the commit,
 * which is the guarantee wanted. `setTimeout` is the fallback for native and
 * for any environment without rAF; it yields the tick, which is enough for
 * React to flush even if it is not tied to a frame.
 */
export function paintFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      // Two frames, not one: the first fires BEFORE the commit's paint in some
      // browsers, so resolving on it can still land ahead of the pixels.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      return;
    }
    setTimeout(resolve, 0);
  });
}
