/**
 * Phase the privacy windows against the app's wall-clock grids.
 *
 * Some background traffic runs on a fixed wall-clock grid but cannot be
 * measured by the idle controls: its period is longer than a control, or its
 * request bodies change every time (an eth_getLogs range), so no budget taken
 * from a control can ever match it. The gate's answer is the same for all of
 * them: move the phase, never exempt the URL. A grid instant is kept out of the
 * action window (and `beforeMs` ahead of it, for work the instant starts that
 * runs on), so a request the form causes still lands in the action window with
 * no control to excuse it.
 */
export type GridKeepOut = {
  /** What runs on this grid, for the log. */
  name: string;
  /** Wall-clock period: instants are the multiples of it. */
  periodMs: number;
  /** No instant may fall this long before the action window starts. */
  beforeMs: number;
};

/** Five-minute price feeds: a single quick request at the instant. */
export const PRICE_GRID: GridKeepOut = { name: 'price tick', periodMs: 5 * 60_000, beforeMs: 5_000 };

/**
 * The background discovery pass (components/sdk-provider.tsx) runs each time
 * the event-snapshot feed lands, on its 2-minute grid (EVENT_SNAPSHOT_INTERVAL_MS
 * in services/snapshot-source.ts). It sweeps the chain tail over RPC, so its
 * eth_getLogs bodies name new blocks every pass and no control can budget them.
 * A pass took ~8s on CI (run 38272204833); 30s of headroom before the window.
 */
export const DISCOVERY_GRID: GridKeepOut = { name: 'discovery pass', periodMs: 2 * 60_000, beforeMs: 30_000 };

/**
 * The smallest wait (whole seconds) after which no grid instant falls in
 * [actionStart - beforeMs, actionStart + windowMs), where the action starts
 * `actionOffsetMs` after the wait. Null when no wait up to `maxShiftMs` works.
 */
export function phaseShift(
  now: number,
  actionOffsetMs: number,
  windowMs: number,
  grids: readonly GridKeepOut[],
  maxShiftMs = 10 * 60_000,
): number | null {
  for (const g of grids) {
    if (g.beforeMs + windowMs >= g.periodMs) {
      throw new Error(`${g.name}: a ${windowMs}ms window plus ${g.beforeMs}ms cannot fit between instants ${g.periodMs}ms apart`);
    }
  }
  for (let shift = 0; shift <= maxShiftMs; shift += 1000) {
    const actionStart = now + shift + actionOffsetMs;
    const clear = grids.every((g) => {
      const from = actionStart - g.beforeMs;
      const firstInstant = Math.ceil(from / g.periodMs) * g.periodMs;
      return firstInstant >= actionStart + windowMs;
    });
    if (clear) return shift;
  }
  return null;
}
