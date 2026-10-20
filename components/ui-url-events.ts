import { Platform } from 'react-native';
import { planUiParamRetire } from '@/services/ui-entry-retire';

/**
 * Guard rail between our URL-encoded UI state (`?panel=`, `?modal=`) and
 * expo-router's web history handling.
 *
 * expo-router's popstate listener (build/fork/useLinking.js) resolves the
 * current entry by the `id` it stores in history.state; when the location
 * doesn't match that record — which is every back/forward across our
 * drawer/modal entries — it falls through to `navigation.resetRoot(...)`,
 * remounting the whole navigator tree. Visually that's a soft refresh: every
 * screen loses state and mount-time prompts (keystore setup, …) fire again.
 *
 * The guard ACTIVATES lazily via installUiUrlGuard(): a plain page load never
 * patches the History API and the dormant listener below is a no-op. The
 * modal bridge installs the guard the first time it actually creates a
 * managed-modal history entry (open or honored deep link); the
 * pushUiParamEntry/rebaseUiParamEntry helpers install it before writing
 * theirs. Once installed, a popstate whose only search-param changes are our
 * managed UI params on the same pathname is stopped before it reaches
 * expo-router, then re-dispatched to our own subscribers (the modal bridge in
 * modal-url-bridge.tsx). Real route changes pass through untouched.
 *
 * index.js loads this module before expo-router/entry, registering the
 * popstate listener before the router starts. Screen imports alone cannot
 * establish that ordering in an optimized production bundle. Until
 * installUiUrlGuard() is called the listener returns immediately.
 *
 * history.pushState/replaceState are wrapped (on install, web only) to keep the
 * "previous URL" snapshot current and synchronously publish managed-param
 * writes, including silent replaceState calls from expo-router itself.
 */

const MANAGED_PARAMS = new Set(['panel', 'modal', 'tx', 'connect', 'notifications']);

export type UiUrlEventSource = 'history' | 'popstate' | 'notify';
export type UiUrlEventIntent = 'panel-user-action' | 'navigation-user-action';

export type UiUrlSnapshot = {
  pathname: string;
  search: string;
};

export type UiUrlEvent = {
  source: UiUrlEventSource;
  intent?: UiUrlEventIntent;
  previous: UiUrlSnapshot;
  current: UiUrlSnapshot;
  changedManagedKeys: string[];
};

// Passing an event remains backward-compatible with the existing zero-argument
// subscribers: JavaScript ignores extra arguments, and TypeScript accepts a
// callback that chooses not to consume them.
type Listener = (event: UiUrlEvent) => void;
const listeners = new Set<Listener>();

export function subscribeUiUrl(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function currentSnapshot(): UiUrlSnapshot {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

// ---------------------------------------------------------------------------
// Generic marked-entry helpers for URL-encoded UI state (e.g. a `?tx=` detail
// modal; the modal bridge predates these and keeps its own).
// ---------------------------------------------------------------------------

const UI_ENTRY_MARKER = '__ppv2UiParamEntry';

function isObjectState(state: unknown): state is Record<string, unknown> {
  return typeof state === 'object' && state !== null && !Array.isArray(state);
}

function pathOf(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Explicitly fire the UI-URL listeners after a PROGRAMMATIC history write.
 *
 * The installed History wrappers already publish the raw URL mutation with a
 * `history` source. Callers use this follow-up `notify` event to identify the
 * write as an intentional UI action and to support writes made before install.
 */
export function notifyUiUrl(intent?: UiUrlEventIntent): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const previous = last ?? currentSnapshot();
  const current = currentSnapshot();
  last = current;
  emitUiUrl({ source: 'notify', intent, previous, current });
}

/**
 * Is the CURRENT history entry one this module pushed for a managed param?
 *
 * The home screen needs this to tell an entry that already exists from one it
 * must create. Without it, a panel opened through pushUiParamEntry (the mobile
 * bar, the connect landing) looked unmanaged to the home screen, which then
 * rebased it into a SECOND entry — leaving a duplicate bare-home stop that made
 * browser Back look broken after closing.
 */
export function isUiParamEntry(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  return isObjectState(window.history.state) && window.history.state[UI_ENTRY_MARKER] === true;
}

export function getUiParam(key: string): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get(key);
}

/** Push a marked history entry with `key=value` added to the current URL. */
export function pushUiParamEntry(key: string, value: string) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  installUiUrlGuard();
  const url = new URL(window.location.href);
  if (url.searchParams.get(key) === value) return;
  url.searchParams.set(key, value);
  const state = { ...(isObjectState(window.history.state) ? window.history.state : {}), [UI_ENTRY_MARKER]: true };
  window.history.pushState(state, '', pathOf(url));
}

/**
 * Set `key` to `value`: PUSH when the key is absent, REPLACE when it is already
 * present. Switching one panel for another must not stack a second entry — that
 * is what made the close button walk backwards through panels instead of
 * closing.
 */
export function setUiParamEntry(key: string, value: string) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  installUiUrlGuard();
  const url = new URL(window.location.href);
  const had = url.searchParams.get(key);
  if (had === value) return;
  url.searchParams.set(key, value);
  const state = { ...(isObjectState(window.history.state) ? window.history.state : {}), [UI_ENTRY_MARKER]: true };
  if (had === null) window.history.pushState(state, '', pathOf(url));
  else window.history.replaceState(state, '', pathOf(url));
}

/**
 * Restore a missing managed param on the CURRENT entry without growing the
 * history stack. This is for invariant repair after an external replaceState
 * silently strips UI state from an entry we already own. The wrapped history
 * call emits a `history` event; callers should follow it with notifyUiUrl() to
 * publish the semantic repair through the explicit channel as well.
 */
export function replaceMissingUiParam(key: string, value: string): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  installUiUrlGuard();
  const url = new URL(window.location.href);
  if (url.searchParams.has(key)) return false;
  url.searchParams.set(key, value);
  const state = { ...(isObjectState(window.history.state) ? window.history.state : {}), [UI_ENTRY_MARKER]: true };
  window.history.replaceState(state, '', pathOf(url));
  return true;
}

/** Retire the entry for `key`: pop it if we pushed it, else rewrite in place. */
export function retireUiParamEntry(key: string, opts?: { followedByAction?: boolean }) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const plan = planUiParamRetire({
    hasKey: url.searchParams.has(key),
    state: window.history.state,
    marker: UI_ENTRY_MARKER,
    followedByAction: opts?.followedByAction,
  });
  if (plan.kind === 'none') return;
  if (plan.kind === 'back') {
    window.history.back();
    return;
  }
  url.searchParams.delete(key);
  window.history.replaceState(plan.state, '', pathOf(url));
}

/**
 * Deep-link re-base: when `key` is present on an entry we didn't push (first
 * load), rewrite it to [url-without-key, url-with-key] so browser back peels
 * the UI state off instead of leaving the app.
 */
export function rebaseUiParamEntry(key: string) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.get(key)) return;
  installUiUrlGuard();
  if (isObjectState(window.history.state) && window.history.state[UI_ENTRY_MARKER] === true) return;
  const without = new URL(window.location.href);
  without.searchParams.delete(key);
  const baseState = isObjectState(window.history.state) ? window.history.state : {};
  window.history.replaceState(baseState, '', pathOf(without));
  window.history.pushState({ ...baseState, [UI_ENTRY_MARKER]: true }, '', pathOf(url));
}

function changedParamKeys(prevSearch: string, nextSearch: string): string[] {
  const prev = new URLSearchParams(prevSearch);
  const next = new URLSearchParams(nextSearch);
  const keys = new Set([...prev.keys(), ...next.keys()]);
  const changed: string[] = [];
  for (const key of keys) {
    if (prev.get(key) !== next.get(key)) changed.push(key);
  }
  return changed;
}

function emitUiUrl({
  source,
  intent,
  previous,
  current,
  changedKeys = changedParamKeys(previous.search, current.search),
}: {
  source: UiUrlEventSource;
  intent?: UiUrlEventIntent;
  previous: UiUrlSnapshot;
  current: UiUrlSnapshot;
  changedKeys?: string[];
}): void {
  const event: UiUrlEvent = {
    source,
    intent,
    previous,
    current,
    changedManagedKeys: changedKeys.filter((key) => MANAGED_PARAMS.has(key)),
  };
  listeners.forEach((listener) => listener(event));
}

let guardInstalled = false;
let last: UiUrlSnapshot | null = null;

function snapshot() {
  last = currentSnapshot();
}

/**
 * Activate the guard: snapshot the URL and wrap pushState/replaceState so
 * managed-param writes are observable as well as classifiable on popstate.
 * Idempotent, web only. Deliberately NOT run at module evaluation: with no
 * managed history entry ever created, a prod page load keeps the pristine
 * History API and expo-router's behavior is untouched. Callers must invoke
 * it BEFORE creating the first managed entry so the guard is live when the
 * user first presses back/forward across it.
 */
export function installUiUrlGuard(): void {
  if (guardInstalled) return;
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  guardInstalled = true;

  snapshot();

  // Keep the snapshot current across every history write, whoever makes it.
  const origPushState = window.history.pushState.bind(window.history);
  window.history.pushState = (...args: Parameters<History['pushState']>) => {
    const previous = currentSnapshot();
    origPushState(...args);
    const current = currentSnapshot();
    last = current;
    const changedKeys = changedParamKeys(previous.search, current.search);
    if (previous.pathname !== current.pathname || changedKeys.some((key) => MANAGED_PARAMS.has(key))) {
      emitUiUrl({ source: 'history', previous, current, changedKeys });
    }
  };
  const origReplaceState = window.history.replaceState.bind(window.history);
  window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
    const previous = currentSnapshot();
    origReplaceState(...args);
    const current = currentSnapshot();
    last = current;
    const changedKeys = changedParamKeys(previous.search, current.search);
    if (previous.pathname !== current.pathname || changedKeys.some((key) => MANAGED_PARAMS.has(key))) {
      emitUiUrl({ source: 'history', previous, current, changedKeys });
    }
  };
}

if (Platform.OS === 'web' && typeof window !== 'undefined') {
  // index.js guarantees this registration runs before expo-router/entry.
  window.addEventListener('popstate', (e) => {
    if (!guardInstalled || last === null) return;
    const prev = last;
    const next = currentSnapshot();
    last = next;
    const changed = changedParamKeys(prev.search, next.search);
    const uiOnly =
      prev.pathname === next.pathname &&
      changed.length > 0 &&
      changed.every((key) => MANAGED_PARAMS.has(key));
    if (uiOnly) {
      // Drawer/modal-only transition: expo-router must not resetRoot on it.
      e.stopImmediatePropagation();
    }
    emitUiUrl({ source: 'popstate', previous: prev, current: next, changedKeys: changed });
  });
}
