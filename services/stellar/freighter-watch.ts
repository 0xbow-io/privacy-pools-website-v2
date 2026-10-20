/**
 * Follows the connected Freighter account and network.
 *
 * Not freighter-api's WatchWalletChanges: Freighter answers getAddress with "" both when it is
 * locked and when it does not reply within 2 s (freighter-api resolves that timeout as an empty
 * key with no error, e.g. while a proof keeps the page busy), and WatchWalletChanges also reports
 * every failed read as a switch to "". Taken as a disconnect, one slow read signed the user out.
 * Here an empty, failed or slow read changes nothing. A different account or network is reported,
 * and a site Freighter no longer allows is reported as revoked. Watching goes on until stop(), so
 * an unlock or a re-allow is picked up again.
 *
 * Pure module (no react-native) so it is bun-testable.
 */
type FreighterReads = Pick<typeof import('@stellar/freighter-api'), 'getAddress' | 'getNetworkDetails' | 'isAllowed'>;

export interface FreighterAccount {
  address: string | null;
  passphrase: string | null;
}

const READ_TIMEOUT_MS = 5_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function watchFreighter(
  api: FreighterReads,
  current: FreighterAccount,
  on: { change: (account: { address: string; passphrase: string | null }) => void; revoked: () => void },
  intervalMs: number,
  readTimeoutMs: number = READ_TIMEOUT_MS,
): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let { address, passphrase } = current;

  const tick = async () => {
    const key = await within(api.getAddress(), readTimeoutMs);
    if (stopped) return;
    if (key && !key.error && key.address) {
      const net = await within(api.getNetworkDetails(), readTimeoutMs);
      if (stopped) return;
      const nextPassphrase = net && !net.error ? net.networkPassphrase : passphrase;
      if (key.address !== address || nextPassphrase !== passphrase) {
        address = key.address;
        passphrase = nextPassphrase;
        on.change({ address, passphrase });
      }
    } else if (key && !key.error && address !== null) {
      // "" without an error: locked, timed out, or no longer allowed. Only the last disconnects.
      const allowed = await within(api.isAllowed(), readTimeoutMs);
      if (stopped) return;
      if (allowed && !allowed.error && !allowed.isAllowed) {
        address = null;
        on.revoked();
      }
    }
    timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
