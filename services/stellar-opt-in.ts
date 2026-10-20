/**
 * `?stellar=true` opt-in for the Stellar testnet network.
 *
 * Stellar is offered as one more network in the selector, next to the debug
 * gate (`?debug=1` keeps showing it too). `?stellar=true` turns it on and is
 * remembered in this browser; `?stellar=false` forgets it. Resolved once at
 * module load, so the whole app agrees for the session.
 *
 * Pure: every input is an argument so it can be tested without a DOM.
 */
export const STELLAR_OPT_IN_STORAGE_KEY = 'ppv2_stellar_opt_in_v1';

export interface StellarOptInStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function resolveStellarOptIn(opts: {
  /** `window.location.search`, or undefined off the web. */
  search: string | undefined;
  storage: StellarOptInStorage | undefined;
}): boolean {
  if (opts.search === undefined) return false;
  try {
    const param = new URLSearchParams(opts.search).get('stellar');
    if (param === 'true' || param === '1') {
      // The URL opted in: stay on for this session even if storage refuses.
      try { opts.storage?.setItem(STELLAR_OPT_IN_STORAGE_KEY, '1'); } catch { /* session only */ }
      return true;
    }
    if (param === 'false' || param === '0') {
      try { opts.storage?.removeItem(STELLAR_OPT_IN_STORAGE_KEY); } catch { /* nothing stored */ }
      return false;
    }
    return opts.storage?.getItem(STELLAR_OPT_IN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Binds the resolver to the browser. False on native and in tests. */
export function resolveRuntimeStellarOptIn(): boolean {
  const w = typeof window !== 'undefined' ? window : undefined;
  let storage: StellarOptInStorage | undefined;
  try {
    storage = w?.localStorage ?? undefined;
  } catch {
    storage = undefined;
  }
  return resolveStellarOptIn({ search: w?.location?.search, storage });
}

/**
 * True when THIS page load's URL asks for Stellar (`?stellar=true` / `=1`), so
 * the network selector starts on it. A remembered opt-in alone does not: it
 * keeps Stellar in the list without taking over every later visit.
 */
export function stellarRequestedInUrl(search: string | undefined): boolean {
  if (!search) return false;
  try {
    const param = new URLSearchParams(search).get('stellar');
    return param === 'true' || param === '1';
  } catch {
    return false;
  }
}

/** Binds stellarRequestedInUrl to the browser. False on native and in tests. */
export function runtimeStellarRequestedInUrl(): boolean {
  try {
    return stellarRequestedInUrl(typeof window !== 'undefined' ? window.location?.search : undefined);
  } catch {
    return false;
  }
}
