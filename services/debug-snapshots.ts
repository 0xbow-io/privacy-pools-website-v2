/**
 * Named state snapshots a debug recording takes at Start and at Stop.
 *
 * The debug console only sees what was logged. A recording has to carry the
 * state around it too (Pat, 2026-09-24: "all the info including all spent
 * status of tx in tx table with full personal notes ... including viewing
 * keys"), and that state lives in providers mounted BELOW the debug provider.
 * So each owner registers a function here and the recorder calls them all.
 *
 * That includes the account key and every private key, at Pat's explicit ask
 * ("and even account key, so we can debug for the team"), so a Full recording
 * is a spend-grade secret: the save prompt says so and the file says so
 * (RECORDING_SECRET_WARNING in services/debug-recording.ts). The save prompt
 * removes the spending keys by default (services/debug-redaction.ts). Snapshots are only
 * read when a recording starts or stops, never sent anywhere.
 *
 * PURE module (no react-native imports) so it is bun-testable.
 */
import { jsonSafe } from '@/services/debug-recording';

type SnapshotFn = () => unknown;

const registry = new Map<string, SnapshotFn>();

/** Register a snapshot under `name`; returns the unregister function. */
export function registerDebugSnapshot(name: string, fn: SnapshotFn): () => void {
  registry.set(name, fn);
  return () => {
    if (registry.get(name) === fn) registry.delete(name);
  };
}

/** Every registered snapshot, each JSON-safe; one that throws records its error. */
export function collectDebugSnapshots(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of registry) {
    try {
      out[name] = jsonSafe(fn());
    } catch (err) {
      out[name] = { snapshotError: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}
