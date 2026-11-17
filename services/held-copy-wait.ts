/**
 * Bounded wait on a copy the feed grid holds (DEV-808).
 *
 * Reading a grid-owned payload never sends a request, but when nothing is held
 * yet it joins the grid's refresh in flight. With the ASP hanging rather than
 * refusing, that refresh only fails at the ASP client's own timeout, and an
 * exit proof sat behind it the whole time even though the chain can answer the
 * same question. Past `ms` the caller stops waiting and reads the chain. The
 * refresh itself is not cancelled: it is the grid's, and the grid keeps its
 * own schedule. Nothing here sends anything.
 *
 * Resolves to the payload, or null on timeout or failure.
 */
export function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * How long a spend proof waits on the held keystore leaves before it sweeps the
 * keystore's events from the chain instead. The keystore tree is small next to
 * the state tree, so the chain sweep is cheap; the state tree's leaves keep waiting
 * for the grid's refresh, because sweeping that one over RPC is the expensive fallback.
 */
export const KEYSTORE_HELD_LEAVES_WAIT_MS = 10_000;
