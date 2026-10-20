// Per-section collapse persistence for the main-page cards. Pure over an
// injected Storage-like object so it's testable and safe when localStorage
// is unavailable (SSR, native, privacy modes that throw on access).

const STORAGE_KEY_PREFIX = 'ppv2_section_collapsed_v1:';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * A section's collapse state. `defaultCollapsed` applies only when the user has
 * never touched this section — an explicit '0' (they opened it) always wins, so
 * a section that defaults to collapsed still stays open once opened.
 */
export function readCollapsed(
  key: string,
  storage: StorageLike | undefined = defaultStorage(),
  defaultCollapsed = false,
): boolean {
  try {
    const raw = storage?.getItem(STORAGE_KEY_PREFIX + key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return defaultCollapsed;
  } catch {
    return defaultCollapsed;
  }
}

export function writeCollapsed(key: string, collapsed: boolean, storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY_PREFIX + key, collapsed ? '1' : '0');
  } catch {
    // non-fatal — the section simply won't remember its state
  }
}
