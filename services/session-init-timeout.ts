/**
 * A bound on how long any flow may wait for the SDK session to be built.
 *
 * `ensureInitialized()` hands every caller ONE shared in-flight promise, and
 * every await on that path is unbounded: the wallet's `signTypedData` (an
 * extension whose background worker was suspended while the tab sat idle never
 * answers, and never errors either) and the ASP `/entrypoints` request inside
 * `createSession` (a connection reaped while idle stalls rather than failing).
 * So a caller that attaches to a stalled init waits for as long as the page is
 * open, with no message and no way back. QA hit exactly that on Send: idle on
 * the form, then submit, then "Syncing latest pool state..." forever.
 *
 * The cap is deliberately generous, because a legitimate first run can include
 * a human reading a wallet prompt and a cold discovery pass. It is a backstop
 * against a dead end, not a performance budget: the per-request timeouts below
 * it surface a real network failure much sooner.
 */
export const SESSION_INIT_TIMEOUT_MS = 120_000;

/** Says what the user can do, not what stalled underneath. */
export const SESSION_INIT_TIMEOUT_MESSAGE =
  'Preparing your account is taking longer than expected. Check that your wallet is still connected, then try again.';

export class SessionInitTimeoutError extends Error {
  constructor(message: string = SESSION_INIT_TIMEOUT_MESSAGE) {
    super(message);
    this.name = 'SessionInitTimeoutError';
  }
}

export function isSessionInitTimeout(err: unknown): boolean {
  return err instanceof SessionInitTimeoutError
    || (err instanceof Error && err.name === 'SessionInitTimeoutError');
}

type TimeoutOptions = {
  timeoutMs?: number;
  /**
   * Run when the wait is abandoned, so the provider can drop the shared
   * in-flight promise and let the next attempt start a real one instead of
   * attaching to the same stalled work.
   */
  onTimeout?: () => void;
};

/**
 * Resolve/reject with `promise`, or reject with a `SessionInitTimeoutError`
 * once the cap passes.
 *
 * The underlying work is NOT cancelled: it may still be a live wallet prompt
 * the user is about to approve, and the provider commits a late result through
 * its own target/epoch checks. Only this caller's wait ends. The late
 * settlement is swallowed here so abandoning a wait never raises an unhandled
 * rejection.
 */
export function withSessionInitTimeout<T>(
  promise: Promise<T>,
  options: TimeoutOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? SESSION_INIT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        options.onTimeout?.();
      } catch {
        // A cleanup failure must not replace the message the user needs.
      }
      reject(new SessionInitTimeoutError());
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(err);
      },
    );
  });
}
