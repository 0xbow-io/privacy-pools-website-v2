/**
 * DEV-576: sign-in while wagmi is still reconnecting.
 *
 * MetaMask mobile (in-app browser) injects its provider asynchronously, so a
 * connection restored from storage stays a bare `{ id, name, type, uid }`
 * record until the provider announces itself. Any wagmi action against it in
 * that window throws ConnectorUnavailableReconnectingError
 * ("Connector "MetaMask" unavailable while reconnecting. ... Version:
 * @wagmi/core@x"), which used to reach the unlock sheet verbatim.
 *
 * PURE module: no network, no React. The caller hands in a tiny view of the
 * wagmi store so the wait and the single retry are pinned by tests.
 */

export const WALLET_RECONNECTING_MESSAGE = 'Your wallet is still reconnecting. Try again in a moment.';

/** How long the sign-in waits for wagmi's reconnect before giving up. */
export const RECONNECT_SETTLE_TIMEOUT_MS = 15_000;

export type WagmiStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting';

export type ReconnectStore = {
  getStatus: () => WagmiStatus;
  subscribe: (listener: (status: WagmiStatus) => void) => () => void;
};

export class WalletReconnectingError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(WALLET_RECONNECTING_MESSAGE);
    this.name = 'WalletReconnectingError';
    if (options && 'cause' in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

const isSettled = (status: WagmiStatus) => status !== 'reconnecting' && status !== 'connecting';

/** True for wagmi's reconnecting error (also when wrapped as a cause) or ours. */
export function isWalletReconnectingError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as { name?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
    if (e.name === 'ConnectorUnavailableReconnectingError' || e.name === 'WalletReconnectingError') return true;
    for (const text of [e.shortMessage, e.message, typeof cur === 'string' ? cur : undefined]) {
      if (typeof text === 'string' && /unavailable while reconnecting/i.test(text)) return true;
    }
    cur = e.cause;
  }
  return false;
}

/**
 * Resolves once wagmi is no longer (re)connecting, or after the timeout.
 * Never rejects: the sign attempt that follows is what reports failure.
 */
export function waitForReconnectSettled(
  store: ReconnectStore,
  timeoutMs: number = RECONNECT_SETTLE_TIMEOUT_MS,
): Promise<'settled' | 'timeout'> {
  let status: WagmiStatus;
  try { status = store.getStatus(); } catch { return Promise.resolve('settled'); }
  if (isSettled(status)) return Promise.resolve('settled');
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (result: 'settled' | 'timeout') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { unsubscribe?.(); } catch { /* best effort */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      unsubscribe = store.subscribe((next) => { if (isSettled(next)) finish('settled'); });
      // The status may have moved between the read and the subscription.
      if (isSettled(store.getStatus())) finish('settled');
    } catch {
      finish('settled');
    }
    if (done) { try { unsubscribe?.(); } catch { /* best effort */ } }
  });
}

/**
 * Wait for the reconnect to settle, then sign. If the wallet still answers
 * "unavailable while reconnecting", wait again and retry exactly once. A
 * second failure becomes WalletReconnectingError (plain message, original
 * error as `cause` for the console).
 */
export async function signAfterReconnect<T>(
  sign: () => Promise<T>,
  store: ReconnectStore,
  opts: { timeoutMs?: number; onWait?: (phase: 'before' | 'retry') => void; onRetry?: (err: unknown) => void } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? RECONNECT_SETTLE_TIMEOUT_MS;
  const wait = async (phase: 'before' | 'retry') => {
    let pending = false;
    try { pending = !isSettled(store.getStatus()); } catch { /* unknown: just try */ }
    if (pending) opts.onWait?.(phase);
    await waitForReconnectSettled(store, timeoutMs);
  };
  await wait('before');
  try {
    return await sign();
  } catch (err) {
    if (!isWalletReconnectingError(err)) throw err;
    opts.onRetry?.(err);
    await wait('retry');
    try {
      return await sign();
    } catch (retryErr) {
      if (isWalletReconnectingError(retryErr)) throw new WalletReconnectingError({ cause: retryErr });
      throw retryErr;
    }
  }
}

/**
 * One plain line for the sign-in sheet. A wagmi/viem BaseError message carries
 * "Docs:", "Details:" and "Version:" blocks; only its short message is shown.
 */
export function walletErrorLine(err: unknown): string {
  if (isWalletReconnectingError(err)) return WALLET_RECONNECTING_MESSAGE;
  const e = err as { shortMessage?: unknown; message?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const isDump = /\bVersion: (?:@wagmi\/|viem@|wagmi@)|\n\s*(?:Details|Docs|Request Arguments):/.test(message);
  if (!isDump) return message;
  const short = typeof e?.shortMessage === 'string' && e.shortMessage.trim()
    ? e.shortMessage.trim()
    : message.split('\n')[0].trim();
  return short || 'Sign-in failed. Try again.';
}
