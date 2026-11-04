/**
 * The user's switch for "self withdrawal", per device.
 *
 * Off by default. On only adds a choice to the withdraw form: a checkbox,
 * unchecked each time, that sends the withdrawal from the user's own wallet
 * instead of the relayer. Nothing changes for a user who never ticks it.
 *
 * Pure over an injected Storage-like object and every storage access is
 * guarded, so a blocked localStorage (or a native build without one) reads as
 * the default and keeps the choice for the session in memory.
 */

const STORAGE_KEY = 'ppv2_self_withdrawal_v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const listeners = new Set<(enabled: boolean) => void>();
let memoryValue: boolean | null = null;

export function readSelfWithdrawalEnabled(storage: StorageLike | undefined = defaultStorage()): boolean {
  if (memoryValue !== null) return memoryValue;
  try {
    return storage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSelfWithdrawalEnabled(enabled: boolean, storage: StorageLike | undefined = defaultStorage()): void {
  memoryValue = enabled;
  try {
    storage?.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Not persisted; the in-memory value and the listeners still hold it.
  }
  for (const listener of listeners) listener(enabled);
}

export function onSelfWithdrawalEnabledChange(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: forget the in-memory value so a fresh read goes to storage. */
export function resetSelfWithdrawalMemory(): void {
  memoryValue = null;
}

/** The menu row label. */
export function selfWithdrawalMenuLabel(enabled: boolean): string {
  return `Self withdrawal: ${enabled ? 'On' : 'Off'}`;
}
