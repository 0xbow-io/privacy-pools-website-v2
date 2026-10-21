/**
 * The user's switch for anonymous error reports, per device.
 *
 * On by default. Off means nothing is sent: the reporter is not started on
 * the next load, and an already started one drops every event (see
 * `enabled` in services/error-reports-event.ts). Pure over an injected
 * Storage-like object, and every storage access is guarded, so a blocked
 * localStorage reads as the default.
 */

const STORAGE_KEY = 'ppv2_error_reports_v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const listeners = new Set<(enabled: boolean) => void>();

export function readErrorReportsEnabled(storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeErrorReportsEnabled(enabled: boolean, storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Not persisted; the in-memory listeners still hear it.
  }
  for (const listener of listeners) listener(enabled);
}

export function onErrorReportsEnabledChange(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The menu row label. */
export function errorReportsMenuLabel(enabled: boolean): string {
  return `Anonymous error reports: ${enabled ? 'On' : 'Off'}`;
}
